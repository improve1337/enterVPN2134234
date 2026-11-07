import { audit, getOrder, setOrderStatus } from "../db.js";
import { logger } from "../logger.js";
import { activatePlan } from "./subscriptions.js";
import { getPlan } from "../plans.js";
import type { Subscription } from "../types.js";

export type FulfillResult =
  | { ok: true; subscription: Subscription; telegramId: number }
  | { ok: false; reason: "order_not_paid" | "plan_missing" | "provision_failed" };

/**
 * Выдача доступа после подтверждённой оплаты. Идемпотентность обеспечивается
 * статусом заказа: повторный вызов для уже выданного заказа не продлевает срок.
 */
export async function fulfillPaidOrder(
  orderId: string,
): Promise<FulfillResult> {
  const order = getOrder(orderId);
  if (!order) return { ok: false, reason: "order_not_paid" };
  if (order.status === "active") {
    logger.info({ orderId }, "заказ уже выдан, пропускаем");
    return { ok: false, reason: "order_not_paid" };
  }
  if (order.status !== "paid" && order.status !== "provisioning") {
    return { ok: false, reason: "order_not_paid" };
  }
  const plan = getPlan(order.planCode);
  if (!plan) return { ok: false, reason: "plan_missing" };

  setOrderStatus(orderId, "provisioning");
  try {
    const subscription = await activatePlan(order.telegramId, order.planCode, {
      orderId: order.id,
    });
    setOrderStatus(orderId, "active");
    audit(order.telegramId, "subscription_activated", `${orderId}:${order.planCode}`);
    return { ok: true, subscription, telegramId: order.telegramId };
  } catch (error) {
    logger.error({ err: error, orderId }, "не удалось выдать доступ после оплаты");
    return { ok: false, reason: "provision_failed" };
  }
}
