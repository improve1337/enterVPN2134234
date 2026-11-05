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

/** Кнопка админки — только для админов. */
export const ADMIN_MENU_LABEL = "🛠 Админка";

export const isMainMenuLabel = (text: string): boolean =>
  (MAIN_MENU_LABELS as readonly string[]).includes(text) ||
  text === ADMIN_MENU_LABEL;

export const mainKeyboard = (isAdmin: boolean): Keyboard => {
  const keyboard = new Keyboard()
    .text(MAIN_MENU_LABELS[0])
    .text(MAIN_MENU_LABELS[1])
    .row()
    .text(MAIN_MENU_LABELS[2])
    .text(MAIN_MENU_LABELS[3])
    .row()
    .text(MAIN_MENU_LABELS[4]);
  if (isAdmin) keyboard.row().text(ADMIN_MENU_LABEL);
  return keyboard.resized().persistent();
};

export const adminKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text("👥 Админы", "adm:list")
    .row()
    .text("➕ Добавить админа", "adm:add")
    .row()
    .text("📊 Статистика", "adm:stats");

/** Список снятия прав: админов из ADMIN_IDS убрать нельзя, их тут нет. */
export const adminsKeyboard = (removableIds: readonly number[]): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const id of removableIds) {
    keyboard.text(`➖ ${id}`, `adm:del:${id}`).row();
  }
  return keyboard.text("⬅️ Назад", "adm:panel");
};

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
