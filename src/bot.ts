import {
  Bot,
  GrammyError,
  HttpError,
  InputFile,
  InlineKeyboard,
  type Context,
} from "grammy";
import { existsSync } from "node:fs";
import { allAdminIds, isAdmin, isEnvAdmin } from "./admins.js";
import { createMessageTracker } from "./chat-cleanup.js";
import { config } from "./config.js";
import {
  addAdmin,
  audit,
  clearUserState,
  findSupportUserId,
  getOrder,
  getUser,
  getUserState,
  listAdminIds,
  listOrders,
  removeAdmin,
  saveSupportMessage,
  setAutoRenew,
  setBanned,
  setUserState,
  stats,
  upsertUser,
} from "./db.js";
import { errorInfo, logger } from "./logger.js";
import { getPlan } from "./plans.js";
import { fulfillPaidOrder } from "./services/fulfillment.js";
import { confirmPayment, createPayment } from "./services/payments.js";
import { activatePlan, startTrial } from "./services/subscriptions.js";
import { buildClientOptions } from "./telegram.js";
import {
  ADMIN_MENU_LABEL,
  adminKeyboard,
  adminsKeyboard,
  isMainMenuLabel,
  mainKeyboard,
  payKeyboard,
  plansKeyboard,
} from "./ui/keyboards.js";
import {
  adminAddPromptText,
  adminAddedText,
  adminListText,
  adminPanelText,
  adminStatsText,
  helpText,
  paymentCreatedText,
  paymentSuccessText,
  planListText,
  subscriptionText,
  supportPromptText,
  supportSentText,
  supportTicketText,
  trialDeniedText,
  trialGrantedText,
  welcomeText,
} from "./ui/texts.js";

/** Поля ответа Telegram, по которым узнаётся отправленное сообщение. */
interface SentMessage {
  chat?: { id?: number };
  message_id?: number;
}

export function createBot(): Bot {
  const bot = new Bot(config.botToken, { client: buildClientOptions() });

  const tracker = createMessageTracker();

  /** Удаляет сообщения, отправленные на прошлом шаге. */
  const cleanupChat = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const ids = tracker.take(chatId);
    if (ids.length === 0) return;
    await Promise.allSettled(
      ids.map((messageId) => ctx.api.deleteMessage(chatId, messageId)),
    );
  };

  // Запоминаем всё, что бот отправляет, чтобы убрать это при следующем действии.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (response.ok) {
      // Не все методы возвращают сообщение: copyMessage отдаёт только его id,
      // sendMediaGroup — массив, остальные — true. Проверяем форму ответа.
      const sent = response.result as unknown as SentMessage | undefined;
      const chatId = sent?.chat?.id;
      if (typeof chatId === "number" && typeof sent?.message_id === "number") {
        tracker.remember(chatId, sent.message_id);
      }
    }
    return response;
  });

  /**
   * Перед каждой командой, кнопкой меню или инлайн-кнопкой убираем сообщения
   * прошлого шага и запоминаем сообщение пользователя, чтобы удалить его в
   * следующий раз. `sub:autorenew` исключён — он редактирует сообщение на месте.
   */
  bot.use(async (ctx, next) => {
    const callbackData = ctx.callbackQuery?.data;
    const text = ctx.message?.text;
    const isMenuAction =
      callbackData !== undefined
        ? callbackData !== "sub:autorenew"
        : text !== undefined && (text.startsWith("/") || isMainMenuLabel(text));

    if (isMenuAction) {
      await cleanupChat(ctx);
      const chatId = ctx.chat?.id;
      if (chatId !== undefined && ctx.message !== undefined) {
        tracker.remember(chatId, ctx.message.message_id);
      }
      // Кнопка меню всегда выходит из режима поддержки и ввода ID админа.
      const userId = ctx.from?.id;
      if (userId !== undefined) clearUserState(userId);
    }
    await next();
  });

  const track = (ctx: Context): void => {
    if (!ctx.from) return;
    upsertUser({
      telegramId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    });
  };

  /** id отправителя; апдейты без `from` (каналы) для этого бота не ожидаются. */
  const fromId = (ctx: Context): number => {
    const from = ctx.from;
    if (!from) throw new Error("Апдейт без отправителя");
    return from.id;
  };

  /** Пропускает дальше только админов; остальным отвечает отказом. */
  const requireAdmin = async (ctx: Context): Promise<boolean> => {
    if (isAdmin(fromId(ctx))) return true;
    if (ctx.callbackQuery) {
      await ctx
        .answerCallbackQuery({ text: "Нет доступа", show_alert: true })
        .catch(() => undefined);
    } else {
      await ctx
        .reply("Команда доступна только администраторам.")
        .catch(() => undefined);
    }
    return false;
  };

  const replyMarkdown = (
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<unknown> =>
    ctx.reply(text, {
      parse_mode: "Markdown",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });

  /**
   * Отправляет экран с главной клавиатурой. Такое сообщение нельзя удалять:
   * вместе с ним Telegram убирает и reply-клавиатуру. Поэтому старый экран
   * меню удаляем сами, а новый помечаем якорем и исключаем из общей чистки.
   */
  const sendMenu = async (
    ctx: Context,
    send: () => Promise<{ message_id: number }>,
  ): Promise<void> => {
    const chatId = ctx.chat?.id;
    const previous = chatId === undefined ? undefined : tracker.anchor(chatId);
    const sent = await send();
    if (chatId === undefined) return;
    tracker.setAnchor(chatId, sent.message_id);
    if (previous !== undefined && previous !== sent.message_id) {
      await ctx.api.deleteMessage(chatId, previous).catch(() => undefined);
    }
  };

  /** Приветствие с баннером; если файла нет — обычный текст. */
  const sendWelcome = async (ctx: Context, name: string | null): Promise<void> => {
    const caption = welcomeText(name);
    const keyboard = mainKeyboard(ctx.from ? isAdmin(ctx.from.id) : false);
    if (existsSync(config.bannerPath)) {
      try {
        await sendMenu(ctx, () =>
          ctx.replyWithPhoto(new InputFile(config.bannerPath), {
            caption,
            parse_mode: "Markdown",
            reply_markup: keyboard,
          }),
        );
        return;
      } catch (error) {
        logger.warn(
          { err: errorInfo(error) },
          "не удалось отправить баннер, отправляю текст",
        );
      }
    } else {
      logger.warn({ path: config.bannerPath }, "файл баннера не найден");
    }
    await sendMenu(ctx, () => ctx.reply(caption, { reply_markup: keyboard }));
  };

  /**
   * Ответ админа на обращение. Проверяется раньше кнопок меню: админ может
   * ответить текстом, который случайно совпадает с подписью кнопки.
   */
  bot.filter(
    (ctx) =>
      Boolean(ctx.message?.reply_to_message) &&
      isAdmin(ctx.from?.id ?? 0),
    async (ctx) => {
      const message = ctx.message;
      const from = ctx.from;
      if (!message || !from || !message.reply_to_message) return;
      const target = findSupportUserId(from.id, message.reply_to_message.message_id);
      if (target === undefined) return;
      try {
        await ctx.api.copyMessage(target, from.id, message.message_id);
        audit(from.id, "support_reply", String(target));
        await ctx.reply(`✅ Ответ отправлен пользователю ${target}.`);
      } catch (error) {
        logger.warn(
          { err: errorInfo(error), target },
          "не удалось отправить ответ в поддержку",
        );
        await ctx.reply(
          "⚠️ Не удалось отправить ответ: возможно, пользователь заблокировал бота.",
        );
      }
    },
  );

  bot.command("start", async (ctx) => {
    track(ctx);
    const payload = ctx.match.trim();

    if (payload.startsWith("paid_")) {
      const order = getOrder(payload.slice("paid_".length));
      if (
        order &&
        ctx.from &&
        order.telegramId === ctx.from.id &&
        order.status === "pending"
      ) {
        const result = confirmPayment({ orderId: order.id });
        if (result.ok && result.order) {
          await grantPaidOrder(ctx, result.order.id, result.order.planCode);
          return;
        }
      }
    }

    if (payload.startsWith("plan_")) {
      await startCheckout(ctx, payload.slice("plan_".length));
      return;
    }

    const user = ctx.from ? getUser(ctx.from.id) : undefined;
    await sendWelcome(ctx, ctx.from?.first_name ?? null);
    if (user?.banned) {
      await ctx.reply("🚫 Ваш аккаунт заблокирован. Напишите в поддержку.");
    }
  });

  bot.command("help", (ctx) => replyMarkdown(ctx, helpText()));

  bot.command("menu", async (ctx) => {
    track(ctx);
    const keyboard = mainKeyboard(isAdmin(fromId(ctx)));
    await sendMenu(ctx, () =>
      ctx.reply("Главное меню:", { reply_markup: keyboard }),
    );
  });

  bot.hears("🎁 Пробный доступ", async (ctx) => {
    track(ctx);
    const outcome = await startTrial(fromId(ctx));
    if (!outcome.granted || !outcome.subscription) {
      await ctx.reply(trialDeniedText(outcome.reason ?? "already_used"));
      return;
    }
    audit(fromId(ctx), "trial_granted");
    await replyMarkdown(
      ctx,
      trialGrantedText(
        outcome.subscription.subscriptionUrl,
        outcome.subscription.expiresAt,
      ),
      new InlineKeyboard().text("💎 Продлить", "sub:renew"),
    );
  });

  bot.hears("💎 Тарифы", async (ctx) => {
    track(ctx);
    await replyMarkdown(ctx, planListText(), plansKeyboard());
  });

  bot.hears("📦 Моя подписка", async (ctx) => {
    track(ctx);
    await sendSubscription(ctx);
  });

  bot.hears("❓ Помощь", (ctx) => replyMarkdown(ctx, helpText()));

  bot.hears("💬 Поддержка", async (ctx) => {
    track(ctx);
    setUserState(fromId(ctx), "support");
    await replyMarkdown(ctx, supportPromptText());
  });

  bot.hears(ADMIN_MENU_LABEL, async (ctx) => {
    track(ctx);
    if (!(await requireAdmin(ctx))) return;
    await replyMarkdown(ctx, adminPanelText(), adminKeyboard());
  });

  // --- Админ-панель ---
  bot.callbackQuery("adm:panel", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, adminPanelText(), adminKeyboard());
  });

  bot.callbackQuery("adm:stats", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, adminStatsText(stats()), adminKeyboard());
  });

  bot.callbackQuery("adm:list", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyMarkdown(
      ctx,
      adminListText(config.adminIds, listAdminIds()),
      adminsKeyboard(listAdminIds()),
    );
  });

  bot.callbackQuery("adm:add", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    setUserState(fromId(ctx), "admin_add");
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, adminAddPromptText());
  });

  bot.callbackQuery(/^adm:del:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const actor = fromId(ctx);
    const target = Number(ctx.match[1]);
    if (isEnvAdmin(target)) {
      await ctx.answerCallbackQuery({
        text: "Этот админ задан в ADMIN_IDS — снять нельзя",
        show_alert: true,
      });
      return;
    }
    removeAdmin(target);
    audit(actor, "admin_removed", String(target));
    await ctx.answerCallbackQuery({ text: `Права сняты: ${target}` });
    await replyMarkdown(
      ctx,
      adminListText(config.adminIds, listAdminIds()),
      adminsKeyboard(listAdminIds()),
    );
  });

  bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await startCheckout(ctx, ctx.match[1] ?? "");
  });

  bot.callbackQuery("sub:renew", async (ctx) => {
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, planListText(), plansKeyboard());
  });

  bot.callbackQuery("sub:autorenew", async (ctx) => {
    const id = fromId(ctx);
    const user = getUser(id);
    if (!user) {
      await ctx.answerCallbackQuery();
      return;
    }
    setAutoRenew(id, !user.autoRenew);
    await ctx.answerCallbackQuery({
      text: user.autoRenew ? "Автопродление выключено" : "Автопродление включено",
    });
    await ctx
      .editMessageText(subscriptionText(getUser(id), listOrders(id)), {
        parse_mode: "Markdown",
      })
      .catch(() => undefined);
  });

  bot.callbackQuery(/^check:(.+)$/, async (ctx) => {
    const order = getOrder(ctx.match[1] ?? "");
    if (!order || order.telegramId !== fromId(ctx)) {
      await ctx.answerCallbackQuery({ text: "Заказ не найден", show_alert: true });
      return;
    }
    if (order.status === "pending") {
      await ctx.answerCallbackQuery({
        text: "Платёж ещё не подтверждён. Попробуйте через минуту.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Оплата подтверждена" });
    await grantPaidOrder(ctx, order.id, order.planCode);
  });

  // Демонстрационная оплата: доступна только в MOCK_MODE.
  bot.callbackQuery(/^mockpay:(.+)$/, async (ctx) => {
    if (!config.mockMode) {
      await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true });
      return;
    }
    const order = getOrder(ctx.match[1] ?? "");
    if (!order || order.telegramId !== fromId(ctx)) {
      await ctx.answerCallbackQuery({ text: "Заказ не найден", show_alert: true });
      return;
    }
    const result = confirmPayment({ orderId: order.id, amountRub: order.amountRub });
    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: "Этот заказ уже оплачен" });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Оплата принята" });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await grantPaidOrder(ctx, order.id, order.planCode);
  });

  // --- Админка ---
  bot.command("admin", async (ctx) => {
    if (!isAdmin(fromId(ctx))) return;
    await replyMarkdown(ctx, adminStatsText(stats()));
  });

  bot.command("user", async (ctx) => {
    if (!isAdmin(fromId(ctx))) return;
    const id = Number(ctx.match.trim());
    if (!Number.isInteger(id) || id <= 0) {
      await ctx.reply("Использование: /user <telegram_id>");
      return;
    }
    const user = getUser(id);
    if (!user) {
      await ctx.reply("Пользователь не найден.");
      return;
    }
    await replyMarkdown(
      ctx,
      [
        `👤 *${id}*`,
        `Тариф: ${user.planCode ?? "—"}`,
        `До: ${user.subscriptionExpiresAt ?? "—"}`,
        `Пробный: ${user.trialUsed ? "использован" : "нет"}`,
        `Бан: ${user.banned ? "да" : "нет"}`,
      ].join("\n"),
    );
  });

  const toggleBan = async (ctx: Context, banned: boolean): Promise<void> => {
    if (!isAdmin(fromId(ctx))) return;
    const id = Number((ctx.match as string).trim());
    if (!Number.isInteger(id) || id <= 0) {
      await ctx.reply(`Использование: /${banned ? "ban" : "unban"} <telegram_id>`);
      return;
    }
    setBanned(id, banned);
    audit(fromId(ctx), banned ? "ban" : "unban", String(id));
    await ctx.reply(
      banned ? `🚫 Пользователь ${id} заблокирован.` : `✅ Пользователь ${id} разблокирован.`,
    );
  };

  bot.command("ban", (ctx) => toggleBan(ctx, true));
  bot.command("unban", (ctx) => toggleBan(ctx, false));

  bot.command("grant", async (ctx) => {
    if (!isAdmin(fromId(ctx))) return;
    const [rawId, rawPlan] = ctx.match.trim().split(/\s+/);
    const id = Number(rawId);
    const planCode = rawPlan || "standard";
    if (!Number.isInteger(id) || id <= 0) {
      await ctx.reply("Использование: /grant <telegram_id> [plan_code]");
      return;
    }
    if (!getUser(id)) {
      await ctx.reply("Пользователь не найден — пусть сначала напишет боту /start.");
      return;
    }
    const plan = getPlan(planCode);
    if (!plan) {
      await ctx.reply(`Неизвестный тариф: ${planCode}`);
      return;
    }
    const subscription = await activatePlan(id, planCode);
    audit(fromId(ctx), "grant", `${id}:${planCode}`);
    await ctx.reply(`✅ Выдан ${plan.name} пользователю ${id} до ${subscription.expiresAt}.`);
    try {
      await ctx.api.sendMessage(
        id,
        paymentSuccessText(
          plan.name,
          subscription.subscriptionUrl,
          subscription.expiresAt,
        ),
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      logger.warn(
        { err: errorInfo(error) },
        "не удалось уведомить пользователя о выдаче доступа",
      );
    }
  });

  /**
   * Сообщения, которые не являются командами или кнопками меню: обращения
   * в поддержку и ввод ID нового админа.
   */
  bot.on("message", async (ctx) => {
    const message = ctx.message;
    const from = ctx.from;
    if (!message || !from) return;

    const state = getUserState(from.id);

    if (state === "admin_add") {
      clearUserState(from.id);
      if (!isAdmin(from.id)) return;
      const target = Number((message.text ?? "").trim());
      if (!Number.isInteger(target) || target <= 0) {
        await ctx.reply(
          "Нужен числовой Telegram ID. Попробуйте снова через «🛠 Админка».",
        );
        return;
      }
      addAdmin(target, from.id);
      audit(from.id, "admin_added", String(target));
      await replyMarkdown(ctx, adminAddedText(target), adminKeyboard());
      try {
        const notice = await ctx.api.sendMessage(
          target,
          "🛠 Вам выдали доступ к админ-панели. Отправьте /start — в меню появится кнопка «🛠 Админка».",
        );
        // Уведомление не должно исчезнуть при первом же действии нового админа.
        tracker.forget(target, notice.message_id);
      } catch (error) {
        logger.warn(
          { err: errorInfo(error), target },
          "не удалось уведомить нового админа",
        );
      }
      return;
    }

    if (state === "support") {
      await forwardToAdmins(ctx);
    }
  });

  bot.catch((error) => {
    logger.error(
      { updateId: error.ctx.update.update_id, err: errorInfo(error.error) },
      "ошибка обработки апдейта",
    );
    if (error.error instanceof GrammyError) {
      logger.error({ description: error.error.description }, "Telegram API");
    } else if (error.error instanceof HttpError) {
      logger.error({ cause: errorInfo(error.error.error) }, "сеть Telegram");
    }
  });

  /** Пересылает обращение пользователя всем админам и запоминает связь. */
  async function forwardToAdmins(ctx: Context): Promise<void> {
    const from = ctx.from;
    const message = ctx.message;
    const chat = ctx.chat;
    if (!from || !message || !chat) return;

    const admins = allAdminIds();
    if (admins.length === 0) {
      await ctx.reply("Оператор пока недоступен — напишите позже.");
      return;
    }

    let delivered = 0;
    for (const adminId of admins) {
      try {
        const header = await ctx.api.sendMessage(
          adminId,
          supportTicketText({
            id: from.id,
            firstName: from.first_name ?? null,
            username: from.username ?? null,
          }),
          { parse_mode: "Markdown" },
        );
        // Обращение должно остаться в чате админа: исключаем его из чистки.
        tracker.forget(adminId, header.message_id);
        saveSupportMessage(adminId, header.message_id, from.id);

        const copied = await ctx.api.copyMessage(
          adminId,
          chat.id,
          message.message_id,
        );
        saveSupportMessage(adminId, copied.message_id, from.id);
        delivered += 1;
      } catch (error) {
        logger.warn(
          { err: errorInfo(error), adminId },
          "не удалось передать обращение админу",
        );
      }
    }

    if (delivered === 0) {
      await ctx.reply("Не удалось передать обращение. Попробуйте позже.");
      return;
    }
    audit(from.id, "support_message");
    await ctx.reply(supportSentText());
  }

  async function startCheckout(ctx: Context, planCode: string): Promise<void> {
    const id = fromId(ctx);
    const plan = getPlan(planCode);
    if (!plan) {
      await ctx.reply("Тариф не найден.");
      return;
    }
    const user = getUser(id);
    if (user?.banned) {
      await ctx.reply("🚫 Ваш аккаунт заблокирован. Напишите в поддержку.");
      return;
    }
    const { order, payUrl } = await createPayment({
      telegramId: id,
      planCode: plan.code,
      amountRub: plan.priceRub,
    });
    audit(id, "order_created", order.id);

    const keyboard = config.mockMode
      ? new InlineKeyboard()
          .text("💳 Оплатить (демо)", `mockpay:${order.id}`)
          .row()
          .text("🔄 Проверить оплату", `check:${order.id}`)
      : payKeyboard(order);

    await replyMarkdown(
      ctx,
      paymentCreatedText(plan.name, plan.priceRub, payUrl),
      keyboard,
    );
  }

  async function grantPaidOrder(
    ctx: Context,
    orderId: string,
    planCode: string,
  ): Promise<void> {
    const id = fromId(ctx);
    const plan = getPlan(planCode);
    if (!plan) {
      await ctx.reply("Тариф из заказа недоступен. Напишите в поддержку.");
      return;
    }
    const result = await fulfillPaidOrder(orderId);
    if (result.ok) {
      await replyMarkdown(
        ctx,
        paymentSuccessText(
          plan.name,
          result.subscription.subscriptionUrl,
          result.subscription.expiresAt,
        ),
        new InlineKeyboard().text("📦 Моя подписка", "sub:show"),
      );
      return;
    }
    if (result.reason === "order_not_paid") {
      await ctx.reply(
        "Доступ по этому заказу уже выдан. Откройте «📦 Моя подписка».",
      );
      return;
    }
    if (result.reason === "provision_failed") {
      await ctx.reply(
        "⚠️ Оплата получена, но выдача доступа задержалась. Мы уже разбираемся — напишите в поддержку, если не заработает в течение 15 минут.",
      );
    }
  }

  async function sendSubscription(ctx: Context): Promise<void> {
    const id = fromId(ctx);
    const user = getUser(id);
    const orders = listOrders(id);
    const text = subscriptionText(user, orders);
    const keyboard =
      user?.subscriptionUrl && !user.banned
        ? new InlineKeyboard()
            .text("💎 Продлить", "sub:renew")
            .row()
            .text(
              `🔄 Автопродление: ${user.autoRenew ? "вкл" : "выкл"}`,
              "sub:autorenew",
            )
        : plansKeyboard();
    await replyMarkdown(ctx, text, keyboard);
  }

  bot.callbackQuery("sub:show", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSubscription(ctx);
  });

  return bot;
}
