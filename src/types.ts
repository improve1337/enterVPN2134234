export type OrderStatus =
  | "pending"
  | "paid"
  | "provisioning"
  | "active"
  | "canceled"
  | "expired";

export interface Plan {
  /** Стабильный код варианта тарифа, например "vpn_1m". */
  code: string;
  name: string;
  priceRub: number;
  days: number;
  /** Лимит трафика в ГБ; `null` — безлимит. */
  trafficGb: number | null;
  deviceLimit: number;
  description: string;
  active: boolean;
}

export interface UserRecord {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  createdAt: string;
  banned: number;
  trialUsed: number;
  /** Код тарифа, привязанный к текущей/последней подписке. */
  planCode: string | null;
  subscriptionExpiresAt: string | null;
  trafficLimitGb: number | null;
  marzbanUsername: string | null;
  subscriptionUrl: string | null;
  autoRenew: number;
  /** Кто пригласил пользователя (Telegram ID), если он пришёл по реферальной ссылке. */
  referredBy: number | null;
  /** Накопленные, но ещё не применённые дни реферального бонуса. */
  referralBonusDays: number;
}

export interface OrderRecord {
  id: string;
  telegramId: number;
  planCode: string;
  amountRub: number;
  status: OrderStatus;
  provider: string;
  providerTxId: string | null;
  paymentUrl: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface TrialResult {
  ok: boolean;
  reason?: "already_used" | "banned";
  expiresAt?: string;
}

export interface ProvisionResult {
  username: string;
  subscriptionUrl: string;
  expiresAt: string;
  /** `null` — безлимит. */
  trafficLimitGb: number | null;
}

export interface Subscription extends ProvisionResult {
  planCode: string;
  planName: string;
}

/**
 * Статус ключа доступа:
 * - `new`     — создан админом, никому не выдан;
 * - `issued`  — выдан по `@username`, но получатель ещё не запускал бота;
 * - `active`  — привязан к Telegram ID, подписка выдана;
 * - `revoked` — отозван админом (доступ в Marzban выключен);
 * - `expired` — срок истёк.
 */
export type KeyStatus = "new" | "issued" | "active" | "revoked" | "expired";

export interface KeyRecord {
  /** Человекочитаемый код вида `ENT-XXXX-XXXX`. */
  code: string;
  planCode: string;
  /** Название тарифа на момент выдачи (снапшот). */
  planName: string;
  /** Срок в днях на момент выдачи (снапшот). */
  days: number;
  /** Лимит трафика в ГБ; `null` — безлимит (снапшот). */
  trafficLimitGb: number | null;
  status: KeyStatus;
  note: string | null;
  createdBy: number | null;
  createdAt: string;
  targetTelegramId: number | null;
  /** `@username` без собаки, в нижнем регистре. */
  targetUsername: string | null;
  marzbanUsername: string | null;
  subscriptionUrl: string | null;
  issuedAt: string | null;
  activatedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: number | null;
  /** Заказ, если ключ появился из оплаты. */
  orderId: string | null;
}

/** Статус заявки на подписку (когда оплата выключена). */
export type RequestStatus = "pending" | "approved" | "rejected";

export interface RequestRecord {
  id: string;
  telegramId: number;
  /** `@username` без собаки на момент заявки. */
  username: string | null;
  planCode: string;
  /** Комментарий пользователя (необязателен). */
  comment: string | null;
  status: RequestStatus;
  createdAt: string;
  resolvedAt: string | null;
  /** Кто из админов обработал заявку. */
  resolvedBy: number | null;
}

/** Статус реферала: `pending` — ждём первый платёж, `rewarded` — бонус начислен. */
export type ReferralStatus = "pending" | "rewarded";

export interface ReferralRecord {
  id: number;
  /** Кто пригласил. */
  inviterId: number;
  /** Кого пригласили. */
  invitedId: number;
  status: ReferralStatus;
  /** Сколько дней получает пригласивший. */
  bonusDays: number;
  createdAt: string;
  rewardedAt: string | null;
}
