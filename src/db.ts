import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type {
  KeyRecord,
  KeyStatus,
  OrderRecord,
  OrderStatus,
  UserRecord,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id           INTEGER PRIMARY KEY,
  username              TEXT,
  first_name            TEXT,
  created_at            TEXT NOT NULL,
  banned                INTEGER NOT NULL DEFAULT 0,
  trial_used            INTEGER NOT NULL DEFAULT 0,
  plan_code             TEXT,
  subscription_expires_at TEXT,
  traffic_limit_gb      INTEGER,
  marzban_username      TEXT,
  subscription_url      TEXT,
  auto_renew            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  telegram_id   INTEGER NOT NULL,
  plan_code     TEXT NOT NULL,
  amount_rub    INTEGER NOT NULL,
  status        TEXT NOT NULL,
  provider      TEXT NOT NULL,
  provider_tx_id TEXT,
  payment_url   TEXT,
  created_at    TEXT NOT NULL,
  paid_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(telegram_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  telegram_id INTEGER PRIMARY KEY,
  added_by    INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_states (
  telegram_id INTEGER PRIMARY KEY,
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  code               TEXT PRIMARY KEY,
  plan_code          TEXT NOT NULL,
  plan_name          TEXT NOT NULL,
  days               INTEGER NOT NULL,
  traffic_limit_gb   INTEGER,
  status             TEXT NOT NULL,
  note               TEXT,
  created_by         INTEGER,
  created_at         TEXT NOT NULL,
  target_telegram_id INTEGER,
  target_username    TEXT,
  marzban_username   TEXT,
  subscription_url   TEXT,
  issued_at          TEXT,
  activated_at       TEXT,
  expires_at         TEXT,
  revoked_at         TEXT,
  revoked_by         INTEGER,
  order_id           TEXT
);

CREATE INDEX IF NOT EXISTS idx_keys_status ON keys(status);
CREATE INDEX IF NOT EXISTS idx_keys_target ON keys(target_telegram_id);
CREATE INDEX IF NOT EXISTS idx_keys_username ON keys(target_username);
CREATE INDEX IF NOT EXISTS idx_keys_marzban ON keys(marzban_username);

`;

/** Путь к БД может лежать в ещё не созданной папке (./data). */
function ensureDatabaseDir(): void {
  if (config.databasePath === ":memory:") return;
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

ensureDatabaseDir();

const raw = new DatabaseSync(config.databasePath);

export function initDatabase(): void {
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(SCHEMA);
}

const nowIso = (): string => new Date().toISOString();

export function addDays(base: Date, days: number): string {
  const next = new Date(base.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

interface UserRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  created_at: string;
  banned: number;
  trial_used: number;
  plan_code: string | null;
  subscription_expires_at: string | null;
  traffic_limit_gb: number | null;
  marzban_username: string | null;
  subscription_url: string | null;
  auto_renew: number;
}

interface OrderRow {
  id: string;
  telegram_id: number;
  plan_code: string;
  amount_rub: number;
  status: string;
  provider: string;
  provider_tx_id: string | null;
  payment_url: string | null;
  created_at: string;
  paid_at: string | null;
}

const toUser = (row: UserRow): UserRecord => ({
  telegramId: Number(row.telegram_id),
  username: row.username,
  firstName: row.first_name,
  createdAt: row.created_at,
  banned: Number(row.banned),
  trialUsed: Number(row.trial_used),
  planCode: row.plan_code,
  subscriptionExpiresAt: row.subscription_expires_at,
  trafficLimitGb:
    row.traffic_limit_gb === null ? null : Number(row.traffic_limit_gb),
  marzbanUsername: row.marzban_username,
  subscriptionUrl: row.subscription_url,
  autoRenew: Number(row.auto_renew),
});

const toOrder = (row: OrderRow): OrderRecord => ({
  id: row.id,
  telegramId: Number(row.telegram_id),
  planCode: row.plan_code,
  amountRub: Number(row.amount_rub),
  status: row.status as OrderStatus,
  provider: row.provider,
  providerTxId: row.provider_tx_id,
  paymentUrl: row.payment_url,
  createdAt: row.created_at,
  paidAt: row.paid_at,
});

interface KeyRow {
  code: string;
  plan_code: string;
  plan_name: string;
  days: number;
  traffic_limit_gb: number | null;
  status: string;
  note: string | null;
  created_by: number | null;
  created_at: string;
  target_telegram_id: number | null;
  target_username: string | null;
  marzban_username: string | null;
  subscription_url: string | null;
  issued_at: string | null;
  activated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: number | null;
  order_id: string | null;
}

const toKey = (row: KeyRow): KeyRecord => ({
  code: row.code,
  planCode: row.plan_code,
  planName: row.plan_name,
  days: Number(row.days),
  trafficLimitGb:
    row.traffic_limit_gb === null ? null : Number(row.traffic_limit_gb),
  status: row.status as KeyStatus,
  note: row.note,
  createdBy: row.created_by === null ? null : Number(row.created_by),
  createdAt: row.created_at,
  targetTelegramId:
    row.target_telegram_id === null ? null : Number(row.target_telegram_id),
  targetUsername: row.target_username,
  marzbanUsername: row.marzban_username,
  subscriptionUrl: row.subscription_url,
  issuedAt: row.issued_at,
  activatedAt: row.activated_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  revokedBy: row.revoked_by === null ? null : Number(row.revoked_by),
  orderId: row.order_id,
});

export function audit(actor: number | null, action: string, entity?: string): void {
  raw
    .prepare(
      "INSERT INTO audit_log (actor, action, entity, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(actor, action, entity ?? null, nowIso());
}

export function upsertUser(input: {
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
}): UserRecord {
  const existing = getUser(input.telegramId);
  if (existing) {
    raw
      .prepare(
        "UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?",
      )
      .run(
        input.username ?? existing.username,
        input.firstName ?? existing.firstName,
        input.telegramId,
      );
    return getUser(input.telegramId) as UserRecord;
  }

  raw
    .prepare(
      `INSERT INTO users (telegram_id, username, first_name, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.telegramId,
      input.username ?? null,
      input.firstName ?? null,
      nowIso(),
    );
  return getUser(input.telegramId) as UserRecord;
}

export function getUser(telegramId: number): UserRecord | undefined {
  const row = raw
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

/** Поиск пользователя по `@username` (без собаки, регистр не важен). */
export function findUserByUsername(username: string): UserRecord | undefined {
  const normalized = username.trim().replace(/^@/, "").toLowerCase();
  if (!normalized) return undefined;
  const row = raw
    .prepare("SELECT * FROM users WHERE lower(username) = ? LIMIT 1")
    .get(normalized) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function markTrialUsed(telegramId: number): void {
  raw
    .prepare("UPDATE users SET trial_used = 1 WHERE telegram_id = ?")
    .run(telegramId);
}

export function setBanned(telegramId: number, banned: boolean): void {
  raw
    .prepare("UPDATE users SET banned = ? WHERE telegram_id = ?")
    .run(banned ? 1 : 0, telegramId);
}

export function setAutoRenew(telegramId: number, value: boolean): void {
  raw
    .prepare("UPDATE users SET auto_renew = ? WHERE telegram_id = ?")
    .run(value ? 1 : 0, telegramId);
}

export interface SubscriptionUpdate {
  telegramId: number;
  planCode: string;
  expiresAt: string;
  /** `null` — безлимитный трафик. */
  trafficLimitGb: number | null;
  marzbanUsername: string;
  subscriptionUrl: string;
}

export function saveSubscription(update: SubscriptionUpdate): void {
  raw
    .prepare(
      `UPDATE users SET
         plan_code = ?,
         subscription_expires_at = ?,
         traffic_limit_gb = ?,
         marzban_username = ?,
         subscription_url = ?
       WHERE telegram_id = ?`,
    )
    .run(
      update.planCode,
      update.expiresAt,
      update.trafficLimitGb,
      update.marzbanUsername,
      update.subscriptionUrl,
      update.telegramId,
    );
}

/** Меняет только срок подписки (например, при отзыве всех ключей). */
export function setSubscriptionExpiry(
  telegramId: number,
  expiresAt: string,
): void {
  raw
    .prepare("UPDATE users SET subscription_expires_at = ? WHERE telegram_id = ?")
    .run(expiresAt, telegramId);
}

export function createOrder(input: {
  id: string;
  telegramId: number;
  planCode: string;
  amountRub: number;
  provider: string;
}): OrderRecord {
  raw
    .prepare(
      `INSERT INTO orders (id, telegram_id, plan_code, amount_rub, status, provider, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      input.id,
      input.telegramId,
      input.planCode,
      input.amountRub,
      input.provider,
      nowIso(),
    );
  return getOrder(input.id) as OrderRecord;
}

export function getOrder(id: string): OrderRecord | undefined {
  const row = raw
    .prepare("SELECT * FROM orders WHERE id = ?")
    .get(id) as OrderRow | undefined;
  return row ? toOrder(row) : undefined;
}

export function getOrderByTxId(providerTxId: string): OrderRecord | undefined {
  const row = raw
    .prepare("SELECT * FROM orders WHERE provider_tx_id = ?")
    .get(providerTxId) as OrderRow | undefined;
  return row ? toOrder(row) : undefined;
}

export function listOrders(telegramId: number, limit = 5): OrderRecord[] {
  const rows = raw
    .prepare(
      "SELECT * FROM orders WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(telegramId, limit) as unknown as OrderRow[];
  return rows.map(toOrder);
}

export function setOrderPayment(
  id: string,
  providerTxId: string,
  paymentUrl: string,
): void {
  raw
    .prepare(
      "UPDATE orders SET provider_tx_id = ?, payment_url = ? WHERE id = ?",
    )
    .run(providerTxId, paymentUrl, id);
}

/**
 * Идемпотентная отметка оплаты. Возвращает true только если заказ реально
 * изменил статус (то есть повторный CONFIRMED не выдаёт доступ дважды).
 */
export function markOrderPaid(id: string): OrderRecord | undefined {
  const result = raw
    .prepare(
      `UPDATE orders SET status = 'paid', paid_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(nowIso(), id);
  if (Number(result.changes) === 0) return undefined;
  return getOrder(id);
}

export function setOrderStatus(id: string, status: OrderStatus): void {
  raw.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, id);
}

export function stats(): {
  users: number;
  activeSubscriptions: number;
  pendingOrders: number;
  paidOrders: number;
  admins: number;
} {
  const one = (sql: string, ...params: (string | number)[]): number => {
    const row = raw.prepare(sql).get(...params) as { c: number } | undefined;
    return row ? Number(row.c) : 0;
  };
  return {
    users: one("SELECT COUNT(*) AS c FROM users"),
    activeSubscriptions: one(
      `SELECT COUNT(*) AS c FROM users
       WHERE subscription_expires_at IS NOT NULL
         AND subscription_expires_at > ?`,
      nowIso(),
    ),
    pendingOrders: one("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'"),
    paidOrders: one(
      "SELECT COUNT(*) AS c FROM orders WHERE status IN ('paid','active')",
    ),
    admins: one("SELECT COUNT(*) AS c FROM admins"),
  };
}

// --- Админы, состояния диалога и обращения в поддержку ---

/**
 * Состояние диалога: чего бот ждёт от следующего сообщения пользователя.
 * Состояния выдачи ключа несут код в самом значении — `key_issue_target:ENT-…`.
 */
export type UserState =
  | "support"
  | "admin_add"
  | "key_lookup"
  | "key_issue_code"
  | `key_issue_target:${string}`;

export function addAdmin(telegramId: number, addedBy: number | null): void {
  raw
    .prepare(
      `INSERT INTO admins (telegram_id, added_by, created_at) VALUES (?, ?, ?)
       ON CONFLICT(telegram_id) DO NOTHING`,
    )
    .run(telegramId, addedBy, nowIso());
}

export function removeAdmin(telegramId: number): void {
  raw.prepare("DELETE FROM admins WHERE telegram_id = ?").run(telegramId);
}

export function isDbAdmin(telegramId: number): boolean {
  const row = raw
    .prepare("SELECT 1 AS ok FROM admins WHERE telegram_id = ?")
    .get(telegramId) as { ok: number } | undefined;
  return row !== undefined;
}

/** ID админов, назначенных через панель (без учёта ADMIN_IDS из окружения). */
export function listAdminIds(): number[] {
  const rows = raw
    .prepare("SELECT telegram_id FROM admins ORDER BY created_at")
    .all() as unknown as { telegram_id: number }[];
  return rows.map((row) => Number(row.telegram_id));
}

export function setUserState(telegramId: number, state: UserState): void {
  raw
    .prepare(
      `INSERT INTO user_states (telegram_id, state, created_at) VALUES (?, ?, ?)
       ON CONFLICT(telegram_id)
       DO UPDATE SET state = excluded.state, created_at = excluded.created_at`,
    )
    .run(telegramId, state, nowIso());
}

export function getUserState(telegramId: number): UserState | undefined {
  const row = raw
    .prepare("SELECT state FROM user_states WHERE telegram_id = ?")
    .get(telegramId) as { state: string } | undefined;
  return row ? (row.state as UserState) : undefined;
}

export function clearUserState(telegramId: number): void {
  raw.prepare("DELETE FROM user_states WHERE telegram_id = ?").run(telegramId);
}

// --- Ключи доступа ---

export interface KeyCreateInput {
  code: string;
  planCode: string;
  planName: string;
  days: number;
  trafficLimitGb: number | null;
  status: KeyStatus;
  note?: string | null;
  createdBy?: number | null;
  targetTelegramId?: number | null;
  targetUsername?: string | null;
  marzbanUsername?: string | null;
  subscriptionUrl?: string | null;
  issuedAt?: string | null;
  activatedAt?: string | null;
  expiresAt?: string | null;
  orderId?: string | null;
}

export function createKeyRecord(input: KeyCreateInput): KeyRecord {
  raw
    .prepare(
      `INSERT INTO keys (
         code, plan_code, plan_name, days, traffic_limit_gb, status, note,
         created_by, created_at, target_telegram_id, target_username,
         marzban_username, subscription_url, issued_at, activated_at,
         expires_at, order_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.code,
      input.planCode,
      input.planName,
      input.days,
      input.trafficLimitGb,
      input.status,
      input.note ?? null,
      input.createdBy ?? null,
      nowIso(),
      input.targetTelegramId ?? null,
      input.targetUsername ?? null,
      input.marzbanUsername ?? null,
      input.subscriptionUrl ?? null,
      input.issuedAt ?? null,
      input.activatedAt ?? null,
      input.expiresAt ?? null,
      input.orderId ?? null,
    );
  return getKey(input.code) as KeyRecord;
}

/** Поля ключа, которые можно обновить. `undefined` — не трогать. */
export interface KeyUpdate {
  planCode?: string;
  planName?: string;
  days?: number;
  trafficLimitGb?: number | null;
  status?: KeyStatus;
  note?: string | null;
  targetTelegramId?: number | null;
  targetUsername?: string | null;
  marzbanUsername?: string | null;
  subscriptionUrl?: string | null;
  issuedAt?: string | null;
  activatedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: number | null;
  orderId?: string | null;
}

const KEY_COLUMNS: Record<keyof KeyUpdate, string> = {
  planCode: "plan_code",
  planName: "plan_name",
  days: "days",
  trafficLimitGb: "traffic_limit_gb",
  status: "status",
  note: "note",
  targetTelegramId: "target_telegram_id",
  targetUsername: "target_username",
  marzbanUsername: "marzban_username",
  subscriptionUrl: "subscription_url",
  issuedAt: "issued_at",
  activatedAt: "activated_at",
  expiresAt: "expires_at",
  revokedAt: "revoked_at",
  revokedBy: "revoked_by",
  orderId: "order_id",
};

export function updateKeyRecord(code: string, patch: KeyUpdate): void {
  const entries = Object.entries(patch).filter(
    ([, value]) => value !== undefined,
  ) as [keyof KeyUpdate, unknown][];
  if (entries.length === 0) return;
  const assignments = entries.map(([field]) => `${KEY_COLUMNS[field]} = ?`);
  const values = entries.map(([, value]) => value as string | number | null);
  raw
    .prepare(`UPDATE keys SET ${assignments.join(", ")} WHERE code = ?`)
    .run(...values, code);
}

export function getKey(code: string): KeyRecord | undefined {
  const row = raw
    .prepare("SELECT * FROM keys WHERE code = ?")
    .get(code.trim().toUpperCase()) as KeyRow | undefined;
  return row ? toKey(row) : undefined;
}

export function listKeys(limit = 5, offset = 0): KeyRecord[] {
  const rows = raw
    .prepare(
      "SELECT * FROM keys ORDER BY created_at DESC, code DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as unknown as KeyRow[];
  return rows.map(toKey);
}

export function countKeys(): number {
  const row = raw.prepare("SELECT COUNT(*) AS c FROM keys").get() as
    | { c: number }
    | undefined;
  return row ? Number(row.c) : 0;
}

export function listKeysByTarget(telegramId: number): KeyRecord[] {
  const rows = raw
    .prepare(
      "SELECT * FROM keys WHERE target_telegram_id = ? ORDER BY created_at DESC",
    )
    .all(telegramId) as unknown as KeyRow[];
  return rows.map(toKey);
}

export function listKeysByUsername(username: string): KeyRecord[] {
  const normalized = username.trim().replace(/^@/, "").toLowerCase();
  const rows = raw
    .prepare(
      "SELECT * FROM keys WHERE target_username = ? ORDER BY created_at DESC",
    )
    .all(normalized) as unknown as KeyRow[];
  return rows.map(toKey);
}

export function listKeysByMarzbanUsername(
  marzbanUsername: string,
): KeyRecord[] {
  const rows = raw
    .prepare(
      "SELECT * FROM keys WHERE marzban_username = ? ORDER BY created_at DESC",
    )
    .all(marzbanUsername) as unknown as KeyRow[];
  return rows.map(toKey);
}

/** Переводит активные ключи с истёкшим сроком в статус `expired`. */
export function markExpiredKeys(): number {
  const result = raw
    .prepare(
      `UPDATE keys SET status = 'expired'
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .run(nowIso());
  return Number(result.changes);
}

export function keyCounts(): {
  total: number;
  fresh: number;
  issued: number;
  active: number;
  revoked: number;
  expired: number;
} {
  const one = (status: KeyStatus): number => {
    const row = raw
      .prepare("SELECT COUNT(*) AS c FROM keys WHERE status = ?")
      .get(status) as { c: number } | undefined;
    return row ? Number(row.c) : 0;
  };
  return {
    total: countKeys(),
    fresh: one("new"),
    issued: one("issued"),
    active: one("active"),
    revoked: one("revoked"),
    expired: one("expired"),
  };
}

export function closeDatabase(): void {
  raw.close();
}

export { raw as db };
