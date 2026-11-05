import { config } from "../config.js";
import { PLANS, TRIAL, getPlan, trafficLabel } from "../plans.js";
import type { OrderRecord, UserRecord } from "../types.js";

const brand = config.brandName;

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const daysLeft = (iso: string | null): number => {
  if (!iso) return 0;
  const diff = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
};

/** Человекочитаемое название тарифа по коду подписки. */
export const planNameByCode = (code: string | null): string => {
  if (!code) return "—";
  if (code === "trial") return "Пробный доступ";
  return getPlan(code)?.name ?? code;
};

export const welcomeText = (name: string | null): string =>
  [
    `👋 Привет${name ? `, ${name}` : ""}! Это ${brand}.`,
    "",
    "Быстрый VPN без сложной настройки: выдаём ссылку-подписку, вставляете её в клиент — и всё работает.",
    "",
    `🎁 Пробный доступ: ${TRIAL.days} дня, ${trafficLabel(TRIAL.trafficGb).toLowerCase()}, до ${TRIAL.deviceLimit} устройств — один раз на аккаунт.`,
    "",
    "Выберите действие в меню ниже.",
  ].join("\n");

export const helpText = (): string =>
  [
    "❓ *Как подключиться*",
    "",
    "1. Нажмите «🎁 Пробный доступ» или купите тариф.",
    "2. Скопируйте ссылку-подписку.",
    "3. Установите клиент:",
    "   • iOS — Streisand, v2rayTun",
    "   • Android — v2rayNG, Hiddify",
    "   • Windows — Hiddify, v2rayN",
    "   • macOS — Hiddify, FoXray",
    "4. Импортируйте подписку по ссылке и включите подключение.",
    "",
    "Если что-то не работает — напишите сюда через «💬 Поддержка».",
  ].join("\n");

export const planListText = (): string => {
  const lines = PLANS.map(
    (plan) =>
      `• *${plan.name}* — ${plan.priceRub} ₽\n   ${trafficLabel(plan.trafficGb)} · до ${plan.deviceLimit} устройств`,
  );
  return ["💎 *Тарифы*", "", ...lines, "", "Выберите тариф кнопкой ниже."].join(
    "\n",
  );
};

export const subscriptionText = (
  user: UserRecord | undefined,
  orders: OrderRecord[],
): string => {
  if (!user || !user.subscriptionExpiresAt || !user.subscriptionUrl) {
    return [
      "📦 *Моя подписка*",
      "",
      "Активной подписки нет.",
      "",
      "Возьмите пробный доступ или оформите тариф.",
    ].join("\n");
  }
  const active =
    new Date(user.subscriptionExpiresAt).getTime() > Date.now();
  const status = user.banned
    ? "🚫 Заблокирована"
    : active
      ? "✅ Активна"
      : "⌛ Истекла";
  const renew = user.autoRenew ? "включено" : "выключено";
  const lastPayments = orders
    .filter((order) => order.status !== "pending")
    .slice(0, 3)
    .map(
      (order) =>
        `• ${fmtDate(order.paidAt ?? order.createdAt)} — ${order.amountRub} ₽ (${order.status})`,
    );

  return [
    "📦 *Моя подписка*",
    "",
    `Тариф: *${planNameByCode(user.planCode)}*`,
    `Статус: ${status}`,
    `Действует до: *${fmtDate(user.subscriptionExpiresAt)}* (осталось ${daysLeft(user.subscriptionExpiresAt)} дн.)`,
    `Трафик: ${trafficLabel(user.trafficLimitGb)}`,
    `Автопродление: ${renew}`,
    "",
    "🔗 *Ссылка-подписка:*",
    `\`${user.subscriptionUrl}\``,
    "",
    "Скопируйте ссылку и вставьте её в клиент.",
    ...(lastPayments.length
      ? ["", "🧾 *Последние платежи:*", ...lastPayments]
      : []),
  ].join("\n");
};

export const trialGrantedText = (subscriptionUrl: string, expiresAt: string): string =>
  [
    "🎉 *Пробный доступ активирован!*",
    "",
    `Действует до: *${fmtDate(expiresAt)}*`,
    "",
    "🔗 Ваша ссылка-подписка:",
    `\`${subscriptionUrl}\``,
    "",
    "Установите клиент и импортируйте подписку по ссылке.",
  ].join("\n");

export const trialDeniedText = (reason: "already_used" | "banned"): string =>
  reason === "banned"
    ? "🚫 Ваш аккаунт заблокирован. Напишите в поддержку."
    : "Вы уже использовали пробный доступ. Оформите тариф — это займёт минуту.";

export const paymentCreatedText = (
  planName: string,
  amountRub: number,
  payUrl: string,
): string =>
  [
    `Оформляем *${planName}* за ${amountRub} ₽.`,
    "",
    "Ссылка на оплату:",
    payUrl,
    "",
    "После оплаты доступ активируется автоматически.",
  ].join("\n");

export const paymentSuccessText = (
  planName: string,
  subscriptionUrl: string,
  expiresAt: string,
): string =>
  [
    "✅ *Оплата получена!*",
    "",
    `Тариф: *${planName}*`,
    `Активен до: *${fmtDate(expiresAt)}*`,
    "",
    "🔗 Ссылка-подписка:",
    `\`${subscriptionUrl}\``,
    "",
    "Импортируйте её в клиент и подключайтесь.",
  ].join("\n");

export const adminStatsText = (data: {
  users: number;
  activeSubscriptions: number;
  pendingOrders: number;
  paidOrders: number;
  admins: number;
  supportTickets: number;
}): string =>
  [
    "🛠 *Статистика*",
    "",
    `Пользователей: *${data.users}*`,
    `Активных подписок: *${data.activeSubscriptions}*`,
    `Оплаченных заказов: *${data.paidOrders}*`,
    `Ожидают оплаты: *${data.pendingOrders}*`,
    `Админов в панели: *${data.admins}*`,
    `Обращений в поддержку: *${data.supportTickets}*`,
  ].join("\n");

export const adminPanelText = (): string =>
  [
    "🛠 *Админка*",
    "",
    "• 👥 Админы — посмотреть список, добавить и снять права",
    "• 📊 Статистика — пользователи, подписки, заказы",
    "",
    "Обращения из поддержки приходят сюда отдельными сообщениями.",
    "Чтобы ответить — сделайте *ответ* на сообщение с обращением.",
  ].join("\n");

export const adminListText = (
  envIds: readonly number[],
  dbIds: readonly number[],
): string =>
  [
    "👥 *Админы*",
    "",
    ...(envIds.length
      ? [
          "Из `ADMIN_IDS` — снять через панель нельзя:",
          ...envIds.map((id) => `• \`${id}\``),
          "",
        ]
      : []),
    ...(dbIds.length
      ? ["Назначены через панель:", ...dbIds.map((id) => `• \`${id}\``)]
      : ["Назначенных через панель пока нет."]),
  ].join("\n");

export const adminAddPromptText = (): string =>
  [
    "➕ *Новый админ*",
    "",
    "Отправьте числовой Telegram ID — пользователь сразу получит доступ к админ-панели.",
    "",
    "Отмена — любая кнопка меню.",
  ].join("\n");

export const adminAddedText = (telegramId: number): string =>
  `✅ Пользователь \`${telegramId}\` теперь админ.`;

export const supportPromptText = (): string =>
  [
    "💬 *Поддержка*",
    "",
    "Напишите сообщение — передам оператору, ответ придёт сюда же.",
    "",
    "Чтобы выйти из режима поддержки, нажмите любую кнопку меню.",
  ].join("\n");

export const supportSentText = (): string =>
  "✅ Передал оператору. Ответ придёт сюда — можно продолжать писать.";

export const supportTicketText = (user: {
  id: number;
  firstName: string | null;
  username: string | null;
}): string =>
  [
    "📨 *Обращение в поддержку*",
    "",
    `От: ${user.firstName ?? "без имени"}${
      user.username ? ` (@${user.username})` : ""
    }`,
    `ID: \`${user.id}\``,
    "",
    "Чтобы ответить — сделайте *ответ* на это сообщение или на следующее.",
  ].join("\n");

export { fmtDate, daysLeft };
