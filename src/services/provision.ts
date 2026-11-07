import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import type { ProvisionResult } from "../types.js";
import { addDays } from "../db.js";

export interface ProvisionRequest {
  telegramId: number;
  /** `@username` из Telegram — из него формируется имя пользователя в Marzban. */
  username?: string | null;
  /** Имя, уже закреплённое за пользователем в базе бота (если было). */
  previousMarzbanUsername?: string | null;
  planCode: string;
  days: number;
  /** `null` — безлимитный трафик. */
  trafficLimitGb: number | null;
  /** Продление: не сбрасывать уже использованный трафик. */
  extendFrom?: string | null;
}

/** Допустимое имя пользователя в Marzban. */
const MARZBAN_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Имя пользователя в Marzban: `@username` из Telegram, а если его нет
 * (или он не подходит по формату) — `tg_<telegramId>`.
 */
export function marzbanUsernameFor(input: {
  telegramId: number;
  username?: string | null;
}): string {
  const handle = (input.username ?? "").trim().replace(/^@/, "").toLowerCase();
  return MARZBAN_NAME_PATTERN.test(handle) ? handle : `tg_${input.telegramId}`;
}

/**
 * Метка владельца в поле `note` пользователя Marzban. По ней бот отличает
 * своих пользователей от чужих с тем же именем.
 */
const ownerNote = (telegramId: number): string => `tg:${telegramId}`;

/**
 * Выдача доступа. В mock-режиме ничего не ходит в сеть и возвращает
 * предсказуемую ссылку — этого достаточно для локального теста сценариев.
 */
export async function provisionSubscription(
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  if (config.mockMode) {
    return mockProvision(request);
  }
  return marzbanProvision(request);
}

/** Полное удаление пользователя в Marzban (например, при отзыве доступа). */
export async function deleteSubscription(
  marzbanUsername: string,
): Promise<void> {
  if (config.mockMode) return;
  await marzbanRequest(
    "DELETE",
    `/api/user/${encodeURIComponent(marzbanUsername)}`,
  );
}

// --- Сводка для админки ---

export interface MarzbanOverview {
  /** Всего пользователей в панели. */
  totalUsers: number;
  /** Пользователи со статусом `active`. */
  activeUsers: number;
  /** Кто был активен за последние `onlineWindowMinutes`. */
  online: Array<{ username: string; usedTrafficBytes: number }>;
  /** Суммарный израсходованный трафик всех пользователей. */
  totalTrafficBytes: number;
}

interface MarzbanUserListResponse {
  users: Array<{
    username: string;
    status: string;
    online_at: string | null;
    used_traffic: number;
  }>;
  total: number;
}

/**
 * Marzban отдаёт время без зоны и с шестью знаками после точки
 * (`2026-11-07T18:57:04.724909`) — приводим к тому, что понимает `Date`,
 * считая такие значения UTC.
 */
function parseMarzbanTime(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\.(\d{3})\d*/, ".$1");
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  const ms = new Date(hasZone ? trimmed : `${trimmed}Z`).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** Сводка по VPN для админки. `undefined` — Marzban недоступен (или mock-режим). */
export async function marzbanOverview(
  onlineWindowMinutes = 5,
): Promise<MarzbanOverview | undefined> {
  if (config.mockMode) return undefined;
  try {
    const data = (await marzbanRequest(
      "GET",
      "/api/users?limit=100",
    )) as MarzbanUserListResponse;
    const users = data.users ?? [];
    const threshold = Date.now() - onlineWindowMinutes * 60_000;
    const online = users.filter((user) => {
      const at = parseMarzbanTime(user.online_at);
      return at !== undefined && at >= threshold;
    });
    return {
      totalUsers: Number(data.total ?? users.length),
      activeUsers: users.filter((user) => user.status === "active").length,
      online: online.map((user) => ({
        username: user.username,
        usedTrafficBytes: Number(user.used_traffic),
      })),
      totalTrafficBytes: users.reduce(
        (sum, user) => sum + Number(user.used_traffic),
        0,
      ),
    };
  } catch {
    return undefined;
  }
}

/**
 * Включает или выключает доступ пользователя в Marzban, не удаляя его:
 * при отзыве ключа подписка ставится в `disabled`, при повторной выдаче — в `active`.
 */
export async function setSubscriptionStatus(
  marzbanUsername: string,
  status: "active" | "disabled",
): Promise<void> {
  if (config.mockMode) return;
  await marzbanRequest(
    "PUT",
    `/api/user/${encodeURIComponent(marzbanUsername)}`,
    { status },
  );
}

function mockProvision(request: ProvisionRequest): ProvisionResult {
  const username = marzbanUsernameFor(request);
  const token = randomBytes(9).toString("hex");
  const base = config.mockLandingUrl.replace(/\/+$/, "");
  const start = request.extendFrom ? new Date(request.extendFrom) : new Date();
  const from = start.getTime() > Date.now() ? start : new Date();
  return {
    username,
    subscriptionUrl: `${base}/sub/${username}/${token}`,
    expiresAt: addDays(from, request.days),
    trafficLimitGb: request.trafficLimitGb,
  };
}

// --- Marzban ---

let cachedToken: { value: string; expiresAt: number } | null = null;

interface MarzbanTokenResponse {
  access_token: string;
}

interface MarzbanUserResponse {
  username: string;
  subscription_url: string;
  expire: number | null;
  note?: string | null;
}

async function marzbanLogin(): Promise<string> {
  if (!config.marzban.username || !config.marzban.password) {
    throw new Error("MARZBAN_USERNAME/PASSWORD не заданы, а MOCK_MODE=false");
  }
  const body = new URLSearchParams({
    username: config.marzban.username,
    password: config.marzban.password,
  });
  const response = await fetch(`${config.marzban.url}/api/admin/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Marzban token: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as MarzbanTokenResponse;
  return data.access_token;
}

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const value = await marzbanLogin();
  cachedToken = { value, expiresAt: Date.now() + 30 * 60_000 };
  return value;
}

async function marzbanRequest(
  method: string,
  path: string,
  body?: unknown,
  retry = true,
): Promise<unknown> {
  const token = await getToken();
  const response = await fetch(`${config.marzban.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401 && retry) {
    cachedToken = null;
    return marzbanRequest(method, path, body, false);
  }
  if (!response.ok) {
    throw new Error(
      `Marzban ${method} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  if (response.status === 204) return undefined;
  return response.json();
}

async function marzbanProvision(
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const note = ownerNote(request.telegramId);
  const { username, existing } = await resolveMarzbanUsername(
    request,
    note,
    `tg_${request.telegramId}`,
  );
  const expire = Math.floor(
    new Date(addDays(new Date(), request.days)).getTime() / 1000,
  );
  const payload = {
    username,
    note,
    proxies: { vless: {} },
    // VLESS Reality — рабочий профиль; VLESS XHTTP CDN — обход белых списков (RU LTE).
    inbounds: { vless: ["VLESS Reality", "VLESS XHTTP CDN"] },
    expire,
    // В Marzban data_limit = 0 означает «без лимита».
    data_limit:
      request.trafficLimitGb === null
        ? 0
        : request.trafficLimitGb * 1024 ** 3,
    data_limit_reset_strategy: "no_reset",
    status: "active" as const,
  };

  const result = (
    existing
      ? await marzbanRequest("PUT", `/api/user/${encodeURIComponent(username)}`, payload)
      : await marzbanRequest("POST", "/api/user", payload)
  ) as MarzbanUserResponse;

  // Продление: у пользователя остался израсходованный трафик прошлого периода —
  // обнуляем, чтобы новый лимит считался с нуля.
  if (existing) {
    await marzbanRequest(
      "POST",
      `/api/user/${encodeURIComponent(username)}/reset`,
    ).catch(() => undefined);
  }

  return {
    username: result.username,
    subscriptionUrl: result.subscription_url,
    expiresAt: new Date((result.expire ?? expire) * 1000).toISOString(),
    trafficLimitGb: request.trafficLimitGb,
  };
}

/**
 * Выбирает имя пользователя в Marzban, не затирая чужих:
 *
 * 1. имя, ранее закреплённое за этим пользователем (стабильность при смене `@username`);
 * 2. имя из текущего `@username`;
 * 3. `tg_<telegramId>` — если предыдущие варианты заняты чужими пользователями.
 *
 * «Свой» пользователь определяется по метке `note` = `tg:<telegramId>`.
 */
async function resolveMarzbanUsername(
  request: ProvisionRequest,
  note: string,
  fallback: string,
): Promise<{ username: string; existing?: MarzbanUserResponse }> {
  const candidates = [
    request.previousMarzbanUsername,
    marzbanUsernameFor(request),
    fallback,
  ]
    .map((value) => (value ?? "").trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);

  let last: { username: string; existing?: MarzbanUserResponse } | undefined;
  for (const candidate of candidates) {
    const existing = (await marzbanRequest(
      "GET",
      `/api/user/${encodeURIComponent(candidate)}`,
    ).catch(() => undefined)) as MarzbanUserResponse | undefined;
    if (!existing) return { username: candidate };
    if (existing.note === note) return { username: candidate, existing };
    last = { username: candidate, existing };
  }
  return last ?? { username: fallback };
}
