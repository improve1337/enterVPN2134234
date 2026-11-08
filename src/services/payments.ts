import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { createOrder, getOrder, markOrderPaid, setOrderPayment } from "../db.js";
import { errorInfo, logger } from "../logger.js";
import type { OrderRecord } from "../types.js";

export interface CreatePaymentInput {
  telegramId: number;
  planCode: string;
  amountRub: number;
}

export interface CreatePaymentResult {
  order: OrderRecord;
  payUrl: string;
}

/**
 * Платёж эмулируется, если включён `MOCK_MODE` (полностью демо) или
 * `DEMO_PAYMENTS` (платёж демо, но подписка выдаётся настоящая — из Marzban).
 */
export const isSimulatedPayment = (): boolean =>
  config.mockMode || config.demoPayments;

/** Настроен ли реальный приём платежей через Coinso. */
export const isCoinsoConfigured = (): boolean =>
  Boolean(config.coinso.secretKey && config.coinso.projectId);

/**
 * Создаёт заказ в БД и платёж у провайдера. Сначала заказ, потом платёж —
 * чтобы потерянный callback можно было найти по order id.
 */
export async function createPayment(
  input: CreatePaymentInput,
): Promise<CreatePaymentResult> {
  const simulated = isSimulatedPayment();
  const order = createOrder({
    id: randomUUID(),
    telegramId: input.telegramId,
    planCode: input.planCode,
    amountRub: input.amountRub,
    provider: config.mockMode ? "mock" : simulated ? "demo" : "coinso",
  });

  if (simulated) {
    const providerTxId = `mock_${order.id.slice(0, 8)}`;
    const payUrl = `https://example.com/mock-pay?order=${order.id}`;
    setOrderPayment(order.id, providerTxId, payUrl);
    return { order, payUrl };
  }

  if (!isCoinsoConfigured()) {
    throw new Error(
      "COINSO_SECRET_KEY/COINSO_PROJECT_ID не заданы, а MOCK_MODE=false",
    );
  }
  return createCoinsoInvoice(order, input);
}

export interface ConfirmPaymentResult {
  ok: boolean;
  order?: OrderRecord;
  reason?: "not_found" | "already_paid" | "amount_mismatch" | "pending";
}

/** Идемпотентное подтверждение оплаты по order id из payload. */
export function confirmPayment(input: {
  orderId: string;
  providerTxId?: string;
  amountRub?: number;
}): ConfirmPaymentResult {
  const order = getOrder(input.orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status !== "pending") {
    return { ok: false, order, reason: "already_paid" };
  }
  if (
    typeof input.amountRub === "number" &&
    input.amountRub !== order.amountRub
  ) {
    return { ok: false, order, reason: "amount_mismatch" };
  }
  const paid = markOrderPaid(order.id);
  if (!paid) return { ok: false, order, reason: "already_paid" };
  return { ok: true, order: paid };
}

// --- Coinso ---

interface CoinsoCreateResponse {
  success?: boolean;
  invoice_id?: string;
  payment_url?: string;
  message?: string;
}

interface CoinsoStatusResponse {
  success?: boolean;
  status?: string;
  amount?: string | number;
}

/**
 * Создаёт счёт в Coinso. В ответ приходит ссылка на платёжную страницу —
 * её и отправляем пользователю. Способ оплаты выбирает сам плательщик на
 * странице Coinso (СБП, карта, крипта, P2P).
 */
async function createCoinsoInvoice(
  order: OrderRecord,
  input: CreatePaymentInput,
): Promise<CreatePaymentResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.coinso.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.coinso.apiUrl}/api/payment/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.coinso.secretKey ?? ""}`,
      },
      body: JSON.stringify({
        project_id: config.coinso.projectId,
        amount: input.amountRub,
        description: `${config.brandName}: ${input.planCode}`,
        custom: order.id,
        client_telegram_id: String(input.telegramId),
        client_user_id: String(input.telegramId),
        success_url: `https://t.me/${config.botUsername}?start=paid_${order.id}`,
        fail_url: `https://t.me/${config.botUsername}?start=fail_${order.id}`,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const data = (await response.json().catch(() => ({}))) as CoinsoCreateResponse;
  if (!response.ok || !data.success || !data.invoice_id || !data.payment_url) {
    throw new Error(
      `Coinso create: ${response.status} ${data.message ?? "нет invoice_id/payment_url"}`,
    );
  }
  setOrderPayment(order.id, data.invoice_id, data.payment_url);
  return { order: getOrder(order.id) as OrderRecord, payUrl: data.payment_url };
}

/**
 * Подтверждает оплату, спрашивая статус у Coinso. Возврат покупателя по
 * `success_url` — не доказательство оплаты, поэтому доступ выдаём только по
 * ответу `GET /payment/status` (или по вебхуку).
 */
export async function verifyPayment(
  orderId: string,
): Promise<ConfirmPaymentResult> {
  const order = getOrder(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status !== "pending") return { ok: false, order, reason: "already_paid" };
  if (isSimulatedPayment()) return confirmPayment({ orderId });
  if (!order.providerTxId) return { ok: false, order, reason: "pending" };

  const status = await fetchCoinsoStatus(order.providerTxId);
  if (!status || status.status !== "paid") {
    return { ok: false, order, reason: "pending" };
  }
  const amount = Number(status.amount);
  return confirmPayment({
    orderId,
    ...(Number.isFinite(amount) ? { amountRub: amount } : {}),
  });
}

async function fetchCoinsoStatus(
  invoiceId: string,
): Promise<CoinsoStatusResponse | undefined> {
  try {
    const response = await fetch(
      `${config.coinso.apiUrl}/api/payment/status?uuid=${encodeURIComponent(invoiceId)}`,
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as CoinsoStatusResponse;
    return data.success ? data : undefined;
  } catch (error) {
    logger.warn(
      { err: errorInfo(error), invoiceId },
      "не удалось получить статус платежа Coinso",
    );
    return undefined;
  }
}

/**
 * Проверяет подпись вебхука Coinso: `X-Signature` = HMAC-SHA256 от сырого
 * тела запроса, ключ — Secret Key проекта. Сравнение — постоянного времени.
 */
export function verifyCoinsoSignature(
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  if (!config.coinso.secretKey || !signature) return false;
  const expected = createHmac("sha256", config.coinso.secretKey)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
