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
