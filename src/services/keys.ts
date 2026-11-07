import { randomInt } from "node:crypto";
import { config } from "../config.js";
import {
  countKeys,
  createKeyRecord,
  findUserByUsername,
  getKey as getKeyRow,
  getUser,
  keyCounts,
  listKeys,
  listKeysByMarzbanUsername,
  listKeysByTarget,
  listKeysByUsername,
  markExpiredKeys,
  saveSubscription,
  setSubscriptionExpiry,
  updateKeyRecord,
  upsertUser,
} from "../db.js";
import { getPlan } from "../plans.js";
import type { KeyRecord, Subscription } from "../types.js";
import { provisionSubscription, setSubscriptionStatus } from "./provision.js";

/**
 * Алфавит без похожих символов (нет `0/O`, `1/I/L`): код диктуют голосом и
 * переписывают руками, поэтому важно исключить неоднозначные знаки.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const randomBlock = (length = 4): string => {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
};

/** Генерирует уникальный код вида `ENT-XXXX-XXXX`. */
export function generateKeyCode(): string {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = `${config.keyCodePrefix}-${randomBlock()}-${randomBlock()}`;
    if (!getKeyRow(code)) return code;
  }
  throw new Error("Не удалось сгенерировать уникальный код ключа");
}

/** `@Nickname` → `nickname`. */
export const normalizeUsername = (value: string): string =>
  value.trim().replace(/^@/, "").toLowerCase();

// --- Создание ---

export interface CreateKeysInput {
  planCode: string;
  createdBy: number | null;
  note?: string | null;
  /** Сколько ключей создать за раз (1–50). */
  count?: number;
}

export function createKeys(input: CreateKeysInput): KeyRecord[] {
  const plan = getPlan(input.planCode);
  if (!plan) throw new Error(`Неизвестный тариф: ${input.planCode}`);
  const count = Math.min(Math.max(input.count ?? 1, 1), 50);
  const keys: KeyRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    keys.push(
      createKeyRecord({
        code: generateKeyCode(),
        planCode: plan.code,
        planName: plan.name,
        days: plan.days,
        trafficLimitGb: plan.trafficGb,
        status: "new",
        note: input.note ?? null,
        createdBy: input.createdBy,
      }),
    );
  }
  return keys;
}

// --- Выдача ---

export type IssueTarget = { telegramId: number } | { username: string };

export type IssueResult =
  | {
      ok: true;
      key: KeyRecord;
      /** Есть, если ключ сразу активирован. */
      subscription?: Subscription;
      /** `true` — получатель ещё не запускал бота, ключ ждёт привязки. */
      pending: boolean;
      telegramId?: number;
    }
  | { ok: false; reason: "not_found" | "revoked" | "invalid_target" };

/**
 * Выдаёт ключ получателю. По Telegram ID — активирует сразу (пользователь
 * создаётся, даже если ни разу не писал боту). По `@username` — активирует,
 * если пользователь уже известен, иначе оставляет ключ в статусе `issued`
 * до первого сообщения получателя.
 */
export async function issueKey(input: {
  code: string;
  target: IssueTarget;
  actor: number | null;
}): Promise<IssueResult> {
  const key = getKey(input.code);
  if (!key) return { ok: false, reason: "not_found" };
  if (key.status === "revoked") return { ok: false, reason: "revoked" };

  if ("telegramId" in input.target) {
    const telegramId = input.target.telegramId;
    if (!Number.isInteger(telegramId) || telegramId <= 0) {
      return { ok: false, reason: "invalid_target" };
    }
    const user = getUser(telegramId) ?? upsertUser({ telegramId });
    const result = await activateBoundKey({
      key,
      telegramId,
      username: user.username,
      actor: input.actor,
    });
    return {
      ok: true,
      key: result.key,
      subscription: result.subscription,
      pending: false,
      telegramId,
    };
  }

  const username = normalizeUsername(input.target.username);
  if (!username) return { ok: false, reason: "invalid_target" };
  const user = findUserByUsername(username);
  if (user) {
    const result = await activateBoundKey({
      key,
      telegramId: user.telegramId,
      username,
      actor: input.actor,
    });
    return {
      ok: true,
      key: result.key,
      subscription: result.subscription,
      pending: false,
      telegramId: user.telegramId,
    };
  }

  updateKeyRecord(key.code, {
    status: "issued",
    targetUsername: username,
    issuedAt: key.issuedAt ?? new Date().toISOString(),
  });
  return { ok: true, key: getKey(key.code) as KeyRecord, pending: true };
}

async function activateBoundKey(input: {
  key: KeyRecord;
  telegramId: number;
  username: string | null;
  actor: number | null;
}): Promise<{ key: KeyRecord; subscription: Subscription }> {
  const { key, telegramId } = input;
  const marzbanUsername = `tg_${telegramId}`;
  const user = getUser(telegramId);
  const result = await provisionSubscription({
    marzbanUsername,
    planCode: key.planCode,
    days: key.days,
    trafficLimitGb: key.trafficLimitGb,
    extendFrom: user?.subscriptionExpiresAt ?? null,
  });
  // Ключ мог быть выдан повторно после отзыва — возвращаем доступ.
  await setSubscriptionStatus(marzbanUsername, "active");
  saveSubscription({
    telegramId,
    planCode: key.planCode,
    expiresAt: result.expiresAt,
    trafficLimitGb: result.trafficLimitGb,
    marzbanUsername,
    subscriptionUrl: result.subscriptionUrl,
  });
  const now = new Date().toISOString();
  updateKeyRecord(key.code, {
    status: "active",
    targetTelegramId: telegramId,
    targetUsername: input.username ?? null,
    marzbanUsername,
    subscriptionUrl: result.subscriptionUrl,
    issuedAt: key.issuedAt ?? now,
    activatedAt: now,
    expiresAt: result.expiresAt,
  });
  return {
    key: getKey(key.code) as KeyRecord,
    subscription: { ...result, planCode: key.planCode, planName: key.planName },
  };
}

/**
 * Привязывает «висящие» ключи, выданные по `@username`, когда этот пользователь
 * впервые появляется в боте. Вызывается на каждом апдейте.
 */
export async function resolvePendingKeys(input: {
  telegramId: number;
  username: string;
}): Promise<KeyRecord[]> {
  const username = normalizeUsername(input.username);
  if (!username) return [];
  const pending = listKeysByUsername(username).filter(
    (key) => key.status === "issued",
  );
  const bound: KeyRecord[] = [];
  for (const key of pending) {
    try {
      const result = await activateBoundKey({
        key,
        telegramId: input.telegramId,
        username,
        actor: null,
      });
      bound.push(result.key);
    } catch {
      // Оставляем ключ в `issued` — попробуем при следующем апдейте.
    }
  }
  return bound;
}

// --- Отзыв ---

export type RevokeResult =
  | { ok: true; key: KeyRecord; disabledAccess: boolean }
  | { ok: false; reason: "not_found" | "already_revoked" };

/**
 * Отзывает ключ. Доступ в Marzban выключается только если у пользователя не
 * осталось других действующих ключей (подписка Marzban общая на Telegram ID).
 */
export async function revokeKey(input: {
  code: string;
  actor: number | null;
}): Promise<RevokeResult> {
  const key = getKey(input.code);
  if (!key) return { ok: false, reason: "not_found" };
  if (key.status === "revoked") return { ok: false, reason: "already_revoked" };

  const now = new Date().toISOString();
  updateKeyRecord(key.code, {
    status: "revoked",
    revokedAt: now,
    revokedBy: input.actor,
  });

  let disabledAccess = false;
  if (key.marzbanUsername) {
    const others = listKeysByMarzbanUsername(key.marzbanUsername).filter(
      (other) =>
        other.code !== key.code &&
        (other.status === "active" || other.status === "issued"),
    );
    if (others.length === 0) {
      await setSubscriptionStatus(key.marzbanUsername, "disabled");
      disabledAccess = true;
      if (key.targetTelegramId) {
        setSubscriptionExpiry(key.targetTelegramId, now);
      }
    }
  }
  return { ok: true, key: getKey(key.code) as KeyRecord, disabledAccess };
}

// --- Ключ из оплаты/пробного ---

/**
 * Заводит или обновляет «личный» ключ пользователя после активации подписки.
 * Один пользователь — один ключ: повторные покупки продлевают его, а не плодят
 * новые записи. Ключи, выданные админом вручную, живут отдельными записями.
 */
export function recordSubscriptionKey(input: {
  telegramId: number;
  planCode: string;
  planName: string;
  days: number;
  trafficLimitGb: number | null;
  subscription: Subscription;
  orderId?: string | null;
}): KeyRecord {
  const now = new Date().toISOString();
  const existing = listKeysByTarget(input.telegramId).find(
    (key) =>
      key.status === "active" || key.status === "issued" || key.status === "new",
  );
  if (existing) {
    updateKeyRecord(existing.code, {
      planCode: input.planCode,
      planName: input.planName,
      days: input.days,
      trafficLimitGb: input.trafficLimitGb,
      status: "active",
      marzbanUsername: input.subscription.username,
      subscriptionUrl: input.subscription.subscriptionUrl,
      issuedAt: existing.issuedAt ?? now,
      activatedAt: existing.activatedAt ?? now,
      expiresAt: input.subscription.expiresAt,
      orderId: input.orderId ?? existing.orderId,
    });
    return getKey(existing.code) as KeyRecord;
  }
  return createKeyRecord({
    code: generateKeyCode(),
    planCode: input.planCode,
    planName: input.planName,
    days: input.days,
    trafficLimitGb: input.trafficLimitGb,
    status: "active",
    note: input.orderId ? `Оплата, заказ ${input.orderId}` : "Автоматически",
    createdBy: null,
    targetTelegramId: input.telegramId,
    marzbanUsername: input.subscription.username,
    subscriptionUrl: input.subscription.subscriptionUrl,
    issuedAt: now,
    activatedAt: now,
    expiresAt: input.subscription.expiresAt,
    orderId: input.orderId ?? null,
  });
}

// --- Чтение ---

/** Читает ключ и лениво помечает истёкшие. */
export function getKey(code: string): KeyRecord | undefined {
  const key = getKeyRow(code);
  if (!key) return undefined;
  if (
    key.status === "active" &&
    key.expiresAt &&
    new Date(key.expiresAt).getTime() <= Date.now()
  ) {
    updateKeyRecord(key.code, { status: "expired" });
    return getKeyRow(key.code);
  }
  return key;
}

export interface KeyListPage {
  items: KeyRecord[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export function listKeysPage(
  page = 0,
  pageSize = config.keysPageSize,
): KeyListPage {
  markExpiredKeys();
  const total = countKeys();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 0), pages - 1);
  return {
    items: listKeys(pageSize, safePage * pageSize),
    total,
    page: safePage,
    pageSize,
    pages,
  };
}

export const keysSummary = (): ReturnType<typeof keyCounts> => {
  markExpiredKeys();
  return keyCounts();
};

export const userKeys = (telegramId: number): KeyRecord[] =>
  listKeysByTarget(telegramId);
