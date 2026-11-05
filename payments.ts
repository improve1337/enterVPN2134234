import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { createOrder, getOrder, markOrderPaid, setOrderPayment } from "../db.js";
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
 * Создаёт заказ в БД и платёж у провайдера. Сначала заказ, потом платёж —
 * чтобы потерянный callback можно было найти по order id.
 */
export async function createPayment(
  input: CreatePaymentInput,
): Promise<CreatePaymentResult> {
  const order = createOrder({
    id: randomUUID(),
    telegramId: input.telegramId,
    planCode: input.planCode,
    amountRub: input.amountRub,
    provider: config.mockMode ? "mock" : "platega",
  });

  if (config.mockMode) {
    const providerTxId = `mock_${order.id.slice(0, 8)}`;
    const payUrl = `https://example.com/mock-pay?order=${order.id}`;
    setOrderPayment(order.id, providerTxId, payUrl);
    return { order, payUrl };
  }

  if (!config.platega.merchantId || !config.platega.secret) {
    throw new Error("PLATEGA_MERCHANT_ID/PLATEGA_SECRET не заданы, а MOCK_MODE=false");
  }

  const response = await fetch("https://app.platega.io/transaction/process", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MerchantId": config.platega.merchantId,
      "X-Secret": config.platega.secret,
    },
    body: JSON.stringify({
      paymentMethod: 2,
      paymentDetails: { amount: input.amountRub, currency: "RUB" },
      description: `${config.brandName} ${input.planCode}, 30 дней`,
      return: `https://t.me/${config.botUsername}?start=paid_${order.id}`,
      failedUrl: `https://t.me/${config.botUsername}?start=fail_${order.id}`,
      payload: order.id,
      orderId: order.id,
    }),
  });
  if (!response.ok) {
    throw new Error(`Platega process: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as {
    redirect?: string;
    transactionId?: string;
    url?: string;
  };
  const payUrl = data.redirect ?? data.url;
  if (!payUrl || !data.transactionId) {
    throw new Error("Platega не вернула redirect/transactionId");
  }
  setOrderPayment(order.id, data.transactionId, payUrl);
  return { order: getOrder(order.id) as OrderRecord, payUrl };
}

export interface ConfirmPaymentResult {
  ok: boolean;
  order?: OrderRecord;
  reason?: "not_found" | "already_paid" | "amount_mismatch";
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
