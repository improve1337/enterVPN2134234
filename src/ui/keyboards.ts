import { InlineKeyboard, Keyboard } from "grammy";
import { PLANS } from "../plans.js";
import type {
  KeyRecord,
  KeyStatus,
  OrderRecord,
  RequestRecord,
} from "../types.js";

/** Подписи кнопок главного меню: используются и в клавиатуре, и в чистке чата. */
export const OFFER_MENU_LABEL = "📄 Оферта и правила";

export const MAIN_MENU_LABELS = [
  "🎁 Пробный доступ",
  "💎 Тарифы",
  "📦 Моя подписка",
  "❓ Помощь",
  "💬 Поддержка",
  OFFER_MENU_LABEL,
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
    .text(MAIN_MENU_LABELS[4])
    .text(MAIN_MENU_LABELS[5]);
  if (isAdmin) keyboard.row().text(ADMIN_MENU_LABEL);
  return keyboard.resized().persistent();
};

export const adminKeyboard = (pendingRequests = 0): InlineKeyboard =>
  new InlineKeyboard()
    .text("👥 Админы", "adm:list")
    .row()
    .text("➕ Добавить админа", "adm:add")
    .row()
    .text("📊 Статистика", "adm:stats")
    .row()
    .text("🔑 Ключи", "key:panel")
    .row()
    .text(
      `📨 Заявки${pendingRequests > 0 ? ` (${pendingRequests})` : ""}`,
      "adm:requests",
    )
    .row()
    .text("💳 Оплата", "adm:payments");

/** Панель оплаты: переключатель «включить/выключить». */
export const paymentsKeyboard = (enabled: boolean): InlineKeyboard =>
  new InlineKeyboard()
    .text(
      enabled ? "🔴 Выключить оплату" : "🟢 Включить оплату",
      "adm:payments:toggle",
    )
    .row()
    .text("⬅️ Назад", "adm:panel");

/** Заявки: по строке на заявку — одобрить и отклонить. */
export const requestsKeyboard = (
  requests: readonly RequestRecord[],
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const request of requests) {
    const who = request.username ? `@${request.username}` : String(request.telegramId);
    keyboard
      .text(`✅ ${who}`, `req:ok:${request.id}`)
      .text("❌", `req:no:${request.id}`)
      .row();
  }
  return keyboard.text("⬅️ Назад", "adm:panel");
};

/** Панель управления ключами. */
export const keysKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text("➕ Создать ключ", "key:new")
    .row()
    .text("📤 Выдать ключ", "key:issue")
    .row()
    .text("📋 Список ключей", "key:list:0")
    .row()
    .text("🔎 Найти ключ", "key:find")
    .row()
    .text("⬅️ Назад", "adm:panel");

/** Выбор тарифа при создании ключа. */
export const keyPlansKeyboard = (): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const plan of PLANS) {
    keyboard.text(`${plan.name} — ${plan.priceRub} ₽`, `key:create:${plan.code}`).row();
  }
  return keyboard.text("⬅️ Назад", "key:panel");
};

/** Действия над конкретным ключом. */
export const keyCardKeyboard = (
  code: string,
  status: KeyStatus,
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  if (status !== "revoked") {
    keyboard.text("📤 Выдать / перевыдать", `key:issue:${code}`).row();
  }
  if (status === "active" || status === "issued" || status === "new") {
    keyboard.text("🗑 Удалить", `key:revoke:${code}`).row();
  }
  return keyboard.text("⬅️ К ключам", "key:panel");
};

export const keyRevokeConfirmKeyboard = (code: string): InlineKeyboard =>
  new InlineKeyboard()
    .text("🗑 Да, удалить", `key:revokeok:${code}`)
    .row()
    .text("⬅️ Отмена", `key:view:${code}`);

/** Список ключей с навигацией по страницам. */
export const keyListKeyboard = (
  items: readonly KeyRecord[],
  page: number,
  pages: number,
  statusLabel: (status: KeyStatus) => string,
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const key of items) {
    keyboard
      .text(`${key.code} · ${statusLabel(key.status)}`, `key:view:${key.code}`)
      .row();
  }
  if (pages > 1) {
    if (page > 0) keyboard.text("⬅️", `key:list:${page - 1}`);
    if (page < pages - 1) keyboard.text("➡️", `key:list:${page + 1}`);
    keyboard.row();
  }
  return keyboard.text("⬅️ К ключам", "key:panel");
};

/** Список снятия прав: админов из ADMIN_IDS убрать нельзя, их тут нет. */
export const adminsKeyboard = (removableIds: readonly number[]): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const id of removableIds) {
    keyboard.text(`➖ ${id}`, `adm:del:${id}`).row();
  }
  return keyboard.text("⬅️ Назад", "adm:panel");
};

/**
 * Кнопки тарифов. Если оплата выключена, вместо покупки — заявка: пока
 * платёжка не подключена, доступ выдаёт админ вручную.
 */
export const plansKeyboard = (paymentsEnabled = true): InlineKeyboard =>
  PLANS.reduce((keyboard, plan) => {
    const label = `${plan.name} — ${plan.priceRub} ₽`;
    return keyboard.text(
      paymentsEnabled ? label : `📨 ${label}`,
      paymentsEnabled ? `buy:${plan.code}` : `req:${plan.code}`,
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

/** Кнопка-ссылка на отдельный бот поддержки. */
export const supportKeyboard = (supportUrl: string): InlineKeyboard =>
  new InlineKeyboard().url("💬 Открыть поддержку", supportUrl);
