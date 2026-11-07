import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import type { ProvisionResult } from "../types.js";
import { addDays } from "../db.js";

export interface ProvisionRequest {
  /** Имя пользователя в Marzban: `tg_<telegramId>` для подписок из бота. */
  marzbanUsername: string;
  planCode: string;
  days: number;
  /** `null` — безлимитный трафик. */
  trafficLimitGb: number | null;
  /** Продление: не сбрасывать уже использованный трафик. */
  extendFrom?: string | null;
}

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

export async function revokeSubscription(telegramId: number): Promise<void> {
  await deleteSubscription(`tg_${telegramId}`);
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
  const username = request.marzbanUsername;
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
  const username = request.marzbanUsername;
  const expire = Math.floor(
    new Date(addDays(new Date(), request.days)).getTime() / 1000,
  );
  const payload = {
    username,
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

  const existing = await marzbanRequest(
    "GET",
    `/api/user/${encodeURIComponent(username)}`,
  ).catch(() => undefined);

  const result = (
    existing
      ? await marzbanRequest("PUT", `/api/user/${encodeURIComponent(username)}`, payload)
      : await marzbanRequest("POST", "/api/user", payload)
  ) as MarzbanUserResponse;

  return {
    username: result.username,
    subscriptionUrl: result.subscription_url,
    expiresAt: new Date((result.expire ?? expire) * 1000).toISOString(),
    trafficLimitGb: request.trafficLimitGb,
  };
}
