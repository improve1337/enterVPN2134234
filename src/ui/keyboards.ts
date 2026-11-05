import { InlineKeyboard, Keyboard } from "grammy";
import { PLANS } from "../plans.js";
import type { OrderRecord } from "../types.js";

/** Подписи кнопок главного меню: используются и в клавиатуре, и в чистке чата. */
export const MAIN_MENU_LABELS = [
  "🎁 Пробный доступ",
  "💎 Тарифы",
  "📦 Моя подписка",
  "❓ Помощь",
  "💬 Поддержка",
] as const;

export const isMainMenuLabel = (text: string): boolean =>
  (MAIN_MENU_LABELS as readonly string[]).includes(text);

export const mainKeyboard = (): Keyboard =>
  new Keyboard()
    .text(MAIN_MENU_LABELS[0])
    .text(MAIN_MENU_LABELS[1])
    .row()
    .text(MAIN_MENU_LABELS[2])
    .text(MAIN_MENU_LABELS[3])
    .row()
    .text(MAIN_MENU_LABELS[4])
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
