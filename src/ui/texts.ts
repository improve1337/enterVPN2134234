import { config } from "../config.js";
import { PLANS, TRIAL, getPlan, trafficLabel } from "../plans.js";
import type {
  KeyRecord,
  KeyStatus,
  OrderRecord,
  RequestRecord,
  UserRecord,
} from "../types.js";

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

export const planListText = (paymentsEnabled = true): string => {
  const lines = PLANS.map(
    (plan) =>
      `• *${plan.name}* — ${plan.priceRub} ₽\n   ${trafficLabel(plan.trafficGb)} · до ${plan.deviceLimit} устройств`,
  );
  return [
    "💎 *Тарифы*",
    "",
    ...lines,
    "",
    paymentsEnabled
      ? "Выберите тариф кнопкой ниже — оплата и выдача автоматические."
      : "Оплата пока недоступна: выберите тариф и оставьте заявку — доступ выдадим вручную.",
  ].join("\n");
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
}, vpn?: VpnStatsView): string => {
  const lines = [
    "🛠 *Статистика*",
    "",
    "*Бот*",
    `Пользователей: *${data.users}*`,
    `Активных подписок: *${data.activeSubscriptions}*`,
    `Оплаченных заказов: *${data.paidOrders}*`,
    `Ожидают оплаты: *${data.pendingOrders}*`,
    `Админов в панели: *${data.admins}*`,
  ];
  if (vpn) {
    const names = vpn.online.slice(0, 10).map((user) => `\`${user.username}\``);
    const rest = vpn.online.length - names.length;
    lines.push(
      "",
      "*VPN (Marzban)*",
      `Пользователей: *${vpn.totalUsers}*`,
      `Активных: *${vpn.activeUsers}*`,
      `Онлайн (5 мин): *${vpn.online.length}*${
        names.length ? ` — ${names.join(", ")}${rest > 0 ? ` и ещё ${rest}` : ""}` : ""
      }`,
      `Трафик всего: *${formatBytes(vpn.totalTrafficBytes)}*`,
    );
  } else {
    lines.push("", "*VPN (Marzban)*", "нет данных — панель недоступна");
  }
  return lines.join("\n");
};

/** Данные VPN для экрана статистики. */
export interface VpnStatsView {
  totalUsers: number;
  activeUsers: number;
  online: Array<{ username: string }>;
  totalTrafficBytes: number;
}

/** Человекочитаемый размер: 1536 → «1.5 КБ». */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  const digits = index === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
};

// --- Заявки и оплата ---

export const paymentsPanelText = (enabled: boolean): string =>
  [
    "💳 *Оплата*",
    "",
    enabled
      ? "Статус: *включена* — пользователи покупают тарифы сами, выдача автоматическая."
      : "Статус: *выключена* — вместо покупки пользователи оставляют заявку, вы обрабатываете её вручную.",
    "",
    enabled
      ? "Нажмите кнопку ниже, чтобы выключить оплату и перейти на заявки."
      : "Нажмите кнопку ниже, чтобы включить оплату (нужна настроенная платёжка).",
  ].join("\n");

export const requestSubmittedText = (planName: string): string =>
  [
    "📨 *Заявка отправлена*",
    "",
    `Тариф: *${planName}*`,
    "",
    "Мы получили заявку и выдадим доступ вручную — ссылка придёт сюда же.",
  ].join("\n");

export const requestDuplicateText = (planName: string): string =>
  [
    "⏳ *Заявка уже отправлена*",
    "",
    `Тариф: *${planName}*`,
    "",
    "Она ждёт обработки. Как только доступ выдадут — придёт ссылка.",
  ].join("\n");

export const requestApprovedToUserText = (
  planName: string,
  subscriptionUrl: string,
  expiresAt: string,
): string =>
  [
    "✅ *Заявка одобрена — доступ выдан!*",
    "",
    `Тариф: *${planName}*`,
    `Активен до: *${fmtDate(expiresAt)}*`,
    "",
    "🔗 Ссылка-подписка:",
    `\`${subscriptionUrl}\``,
    "",
    "Импортируйте её в клиент и подключайтесь.",
  ].join("\n");

export const requestRejectedToUserText = (): string =>
  ["❌ *Заявка отклонена*", "", "Если это ошибка — напишите в поддержку."].join(
    "\n",
  );

export const adminRequestsText = (requests: readonly RequestRecord[]): string => {
  if (requests.length === 0) {
    return ["📨 *Заявки*", "", "Новых заявок нет."].join("\n");
  }
  const lines = requests.map((request) => {
    const who = request.username
      ? `@${request.username}`
      : `ID \`${request.telegramId}\``;
    return [
      `• ${who} — *${planNameByCode(request.planCode)}*`,
      `   ${fmtDate(request.createdAt)}`,
      ...(request.comment ? [`   💬 ${request.comment}`] : []),
    ].join("\n");
  });
  return [
    `📨 *Заявки* (${requests.length})`,
    "",
    ...lines,
    "",
    "✅ — выдать доступ, ❌ — отклонить.",
  ].join("\n");
};

export const adminNewRequestText = (request: RequestRecord): string => {
  const who = request.username
    ? `@${request.username}`
    : `ID \`${request.telegramId}\``;
  return [
    "📨 *Новая заявка*",
    "",
    `От: ${who}`,
    `Тариф: *${planNameByCode(request.planCode)}*`,
    ...(request.comment ? [`💬 ${request.comment}`] : []),
    "",
    "Обработать: «🛠 Админка» → «📨 Заявки».",
  ].join("\n");
};

// --- Рассылка ---

export const broadcastPromptText = (): string =>
  [
    "📣 *Рассылка*",
    "",
    "Отправьте текст поста — его получат все пользователи бота.",
    "",
    "Можно приложить картинку: тогда текст станет подписью к ней.",
    "",
    "Отмена — любая кнопка меню.",
  ].join("\n");

export const broadcastPreviewText = (recipients: number): string =>
  [
    "📣 *Предпросмотр*",
    "",
    `Получателей: *${recipients}*`,
    "",
    "Ниже — как увидят пользователи. Отправляем?",
  ].join("\n");

export const broadcastEmptyText = (): string =>
  ["📣 *Рассылка*", "", "Пока нет получателей — отправлять некому."].join("\n");

export const broadcastResultText = (result: {
  total: number;
  sent: number;
  failed: number;
}): string =>
  [
    "📣 *Рассылка завершена*",
    "",
    `Всего получателей: *${result.total}*`,
    `Доставлено: *${result.sent}*`,
    ...(result.failed > 0
      ? [`Не доставлено: *${result.failed}* (заблокировали бота или ошибка)`]
      : []),
  ].join("\n");

export const broadcastCancelledText = (): string =>
  "📣 Рассылка отменена.";

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

export const supportLinkText = (): string =>
  [
    "💬 *Поддержка*",
    "",
    "Обращения принимает отдельный бот поддержки: там можно создать тикет,",
    "описать проблему и получить ответ оператора.",
    "",
    "Нажмите кнопку ниже.",
  ].join("\n");

// --- Ключи доступа ---

export const keyStatusLabel = (status: KeyStatus): string => {
  switch (status) {
    case "new":
      return "🆕 новый";
    case "issued":
      return "📤 ждёт получателя";
    case "active":
      return "✅ активен";
    case "revoked":
      return "🚫 отозван";
    case "expired":
      return "⌛ истёк";
  }
};

export const keysPanelText = (summary: {
  total: number;
  fresh: number;
  issued: number;
  active: number;
  revoked: number;
  expired: number;
}): string =>
  [
    "🔑 *Ключи доступа*",
    "",
    `Всего: *${summary.total}*`,
    `• 🆕 новых: ${summary.fresh}`,
    `• 📤 ждут получателя: ${summary.issued}`,
    `• ✅ активных: ${summary.active}`,
    `• ⌛ истёкших: ${summary.expired}`,
    "",
    "Ключ — единица выдачи. Создайте код, затем выдайте его по Telegram ID или `@username`.",
  ].join("\n");

export const keyPlansPromptText = (): string =>
  ["➕ *Новый ключ*", "", "Выберите тариф — срок и лимит берутся из него."].join(
    "\n",
  );

export const keyCreatedText = (keys: readonly KeyRecord[]): string => {
  const lines = keys.map(
    (key) =>
      `\`${key.code}\` — ${key.planName}, ${key.days} дн., ${trafficLabel(key.trafficLimitGb)}`,
  );
  return [
    keys.length === 1 ? "✅ *Ключ создан*" : `✅ *Создано ключей: ${keys.length}*`,
    "",
    ...lines,
    "",
    "Теперь выдайте ключ получателю кнопкой ниже или командой `/key issue <код> <id|@username>`.",
  ].join("\n");
};

export const keyListText = (data: {
  items: readonly KeyRecord[];
  total: number;
  page: number;
  pages: number;
}): string => {
  if (data.total === 0) {
    return ["📋 *Ключи*", "", "Ключей пока нет. Нажмите «➕ Создать ключ»."].join(
      "\n",
    );
  }
  const lines = data.items.map((key) => {
    const target = key.targetTelegramId
      ? `ID \`${key.targetTelegramId}\``
      : key.targetUsername
        ? `\`@${key.targetUsername}\``
        : "—";
    return `• \`${key.code}\` — ${keyStatusLabel(key.status)}\n   ${key.planName} · получатель: ${target}`;
  });
  return [
    `📋 *Ключи* (стр. ${data.page + 1}/${data.pages}, всего ${data.total})`,
    "",
    ...lines,
  ].join("\n");
};

export const keyCardText = (key: KeyRecord): string => {
  const target = key.targetTelegramId
    ? `ID \`${key.targetTelegramId}\``
    : key.targetUsername
      ? `\`@${key.targetUsername}\``
      : "не выдан";
  const expiry = key.expiresAt
    ? `${fmtDate(key.expiresAt)} (осталось ${daysLeft(key.expiresAt)} дн.)`
    : "—";
  return [
    `🔑 *Ключ* \`${key.code}\``,
    "",
    `Тариф: *${key.planName}* (${key.days} дн., ${trafficLabel(key.trafficLimitGb)})`,
    `Статус: ${keyStatusLabel(key.status)}`,
    `Получатель: ${target}`,
    `Выдан: ${fmtDate(key.issuedAt)}`,
    `Активирован: ${fmtDate(key.activatedAt)}`,
    `Действует до: ${expiry}`,
    ...(key.marzbanUsername ? [`Marzban: \`${key.marzbanUsername}\``] : []),
    ...(key.orderId ? [`Заказ: \`${key.orderId}\``] : []),
    ...(key.note ? [`Заметка: ${key.note}`] : []),
    "",
    ...(key.subscriptionUrl
      ? ["🔗 *Ссылка-подписка:*", `\`${key.subscriptionUrl}\``]
      : ["Ссылки пока нет — ключ не активирован."]),
  ].join("\n");
};

export const keyLookupPromptText = (): string =>
  [
    "🔎 *Поиск ключа*",
    "",
    "Отправьте код ключа (например `ENT-AB12-CD34`).",
    "",
    "Отмена — любая кнопка меню.",
  ].join("\n");

export const keyIssueCodePromptText = (): string =>
  [
    "📤 *Выдача ключа*",
    "",
    "Отправьте код ключа, который нужно выдать.",
    "",
    "Отмена — любая кнопка меню.",
  ].join("\n");

export const keyIssueTargetPromptText = (code: string): string =>
  [
    `📤 *Выдача ключа* \`${code}\``,
    "",
    "Кому выдать? Отправьте Telegram ID (числом) или `@username`.",
    "",
    "Если получатель ещё не запускал бота, ключ будет ждать его первого сообщения.",
  ].join("\n");

export const keyIssuedText = (result: {
  key: KeyRecord;
  pending: boolean;
  telegramId?: number;
}): string => {
  if (result.pending) {
    return [
      "📤 *Ключ выдан*",
      "",
      `Код: \`${result.key.code}\``,
      `Получатель: \`@${result.key.targetUsername}\``,
      "",
      "Пользователь ещё не запускал бота — ключ активируется автоматически при первом сообщении.",
    ].join("\n");
  }
  return [
    "✅ *Ключ выдан и активирован*",
    "",
    `Код: \`${result.key.code}\``,
    `Получатель: ID \`${result.telegramId ?? result.key.targetTelegramId}\``,
    `Действует до: *${fmtDate(result.key.expiresAt)}*`,
    "",
    ...(result.key.subscriptionUrl
      ? ["🔗 Ссылка-подписка:", `\`${result.key.subscriptionUrl}\``]
      : []),
  ].join("\n");
};

export const keyIssuedToUserText = (key: KeyRecord): string =>
  [
    "🎉 *Вам выдан доступ!*",
    "",
    `Тариф: *${key.planName}*`,
    `Ключ: \`${key.code}\``,
    `Активен до: *${fmtDate(key.expiresAt)}*`,
    "",
    "🔗 Ссылка-подписка:",
    `\`${key.subscriptionUrl ?? "—"}\``,
    "",
    "Импортируйте её в клиент и подключайтесь.",
  ].join("\n");

export const keyRevokedToUserText = (key: KeyRecord): string =>
  [
    "🚫 Доступ по вашему ключу отключён.",
    "",
    `Ключ: \`${key.code}\``,
    "",
    "Если это ошибка — напишите в поддержку.",
  ].join("\n");

export const keyRevokeConfirmText = (key: KeyRecord): string =>
  [
    `🗑 *Удалить ключ* \`${key.code}\`?`,
    "",
    "Запись исчезнет из списка, а доступ в Marzban выключится, если у пользователя не осталось других активных ключей.",
    "Вернуть можно только новой выдачей.",
  ].join("\n");

export const keyRevokedText = (result: {
  key: KeyRecord;
  disabledAccess: boolean;
}): string =>
  [
    "🗑 *Ключ удалён*",
    "",
    `Код: \`${result.key.code}\``,
    result.disabledAccess
      ? "Доступ в Marzban выключен."
      : "У пользователя остались другие активные ключи — доступ сохранён.",
  ].join("\n");

export const keyNotFoundText = (code: string): string =>
  code
    ? `🔎 Ключ \`${code}\` не найден.`
    : "🔎 Укажите код ключа.";

export const keyHelpText = (): string =>
  [
    "🔑 *Ключи — команды*",
    "",
    "• `/key` — эта справка",
    "• `/key new <тариф> [заметка]` — создать ключ (`vpn_1m`, `vpn_3m`)",
    "• `/key list` — список ключей",
    "• `/key info <код>` — карточка ключа",
    "• `/key issue <код> <telegram_id|@username>` — выдать ключ",
    "• `/key revoke <код>` — отозвать ключ",
    "• `/key link <код>` — прислать ссылку-подписку",
    "",
    "Всё то же доступно кнопками в «🛠 Админка» → «🔑 Ключи».",
  ].join("\n");

/**
 * Короткая оферта для кнопки «📄 Оферта и правила» и команды `/offer`.
 * Отправляется с `parse_mode: "HTML"` — в юзернейме поддержки есть `_`,
 * который в Markdown ломает разметку.
 */
export const offerText = (): string => {
  const plans = PLANS.map(
    (plan) =>
      `• ${plan.name} — ${plan.priceRub} ₽ (${trafficLabel(plan.trafficGb)})`,
  ).join("\n");
  const support = config.supportUrl.replace("https://t.me/", "@");
  return [
    `<b>📄 Оферта и правила ${brand}</b>`,
    "",
    "Оплачивая подписку, вы соглашаетесь с условиями сервиса.",
    "",
    "<b>💎 Тарифы</b>",
    plans,
    `До ${TRIAL.deviceLimit} устройств. Пробный доступ — ${TRIAL.days} дня бесплатно (безлимит), один раз на аккаунт.`,
    "",
    "<b>🛒 Оплата</b>",
    "Оплата — на защищённой странице платёжного партнёра (СБП, карты, криптовалюта). Данные карты не хранятся.",
    "",
    "<b>⚡ Сроки выдачи</b>",
    "Доступ активируется автоматически после оплаты — обычно 1–5 минут. Ссылка-подписка приходит в этот чат. Если доступа нет 30 минут — напишите в поддержку.",
    "",
    "<b>↩️ Возврат</b>",
    "Полный возврат — в течение 3 дней с оплаты, если использовано менее 10% трафика. Обращение рассматриваем до 3 рабочих дней, деньги возвращаем тем же способом за 5–10 рабочих дней. Пробный доступ возврату не подлежит.",
    "",
    `<b>💬 Поддержка:</b> ${support}`,
  ].join("\n");
};

// --- Реферальная программа ---

export const referralText = (data: {
  link: string | null;
  invited: number;
  converted: number;
  pending: number;
  earnedDays: number;
  pendingDays: number;
  bonusDays: number;
  inviteeDays: number;
}): string => {
  const blocks: string[] = [
    "👥 *Пригласить друзей*",
    "",
    `За каждого друга, который оформит подписку, вы получаете *+${data.bonusDays}* дн. к своему доступу.`,
  ];
  if (data.inviteeDays > 0) {
    blocks.push(
      `Друг получает *+${data.inviteeDays}* дн. к пробному периоду.`,
    );
  }
  blocks.push(
    "",
    "📊 *Статистика*",
    `• Приглашено: *${data.invited}*`,
    `• Оформили подписку: *${data.converted}*`,
    `• Начислено дней: *${data.earnedDays}*`,
  );
  if (data.pendingDays > 0) {
    blocks.push(
      `• В запасе: *${data.pendingDays}* дн. — добавим при следующей оплате.`,
    );
  }
  blocks.push("");
  if (data.link) {
    blocks.push(
      "🔗 *Ваша ссылка:*",
      `\`${data.link}\``,
      "",
      "Отправьте её другу — бонус зачтётся автоматически.",
    );
  } else {
    blocks.push("Ссылка недоступна: не задан `BOT_USERNAME` в настройках.");
  }
  return blocks.join("\n");
};

export const referralJoinedText = (days: number): string =>
  days > 0
    ? `🎁 Вы пришли по приглашению — пробный доступ продлён на *${days}* дн.`
    : "🎁 Вы пришли по приглашению друга.";

export const referralRewardText = (info: {
  days: number;
  appliedImmediately: boolean;
}): string =>
  [
    "🎉 *Награда за друга!*",
    "",
    `Ваш друг оформил подписку — вам начислено *+${info.days}* дн.`,
    info.appliedImmediately
      ? "Дни уже добавлены к вашей подписке."
      : "Дни добавятся к подписке при следующей оплате.",
  ].join("\n");

export { fmtDate, daysLeft };
