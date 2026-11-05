import { InlineKeyboard, Keyboard } from "grammy";
import { PLANS } from "../plans.js";
import type { OrderRecord } from "../types.js";

export const mainKeyboard = (): Keyboard =>
  new Keyboard()
    .text("🎁 Пробный доступ")
    .text("💎 Тарифы")
    .row()
    .text("📦 Моя подписка")
    .text("❓ Помощь")
    .row()
    .text("💬 Поддержка")
    .resized()
    .persistent();

export const plansKeyboard = (): InlineKeyboard =>
  PLANS.reduce((keyboard, plan) => {
    return keyboard.text(
      `${plan.name} — ${plan.priceRub} ₽`,
      `buy:${plan.code}`,
    );
  }, new InlineKeyboard().row()).row();

export const payKeyboard = (order: OrderRecord): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  if (order.paymentUrl) {
    keyboard.url("💳 Перейти к оплате", order.paymentUrl);
  }
  keyboard.row().text("🔄 Проверить оплату", `check:${order.id}`);
  return keyboard;
};

export const subscriptionKeyboard = (subscriptionUrl: string): InlineKeyboard =>
  new InlineKeyboard()
    .url("📲 Клиенты", "https://github.com/hiddify/hiddify-app/releases")
    .row()
    .text("💎 Продлить", "buy-menu");

export const backKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text("⬅️ Назад", "back:main");
