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
  getOrder,
  getUser,
  getUserState,
  listAdminIds,
  listBroadcastRecipients,
  listOrders,
  removeAdmin,
  setAutoRenew,
  setBanned,
  setUserState,
  stats,
  upsertUser,
} from "./db.js";
import { errorInfo, logger } from "./logger.js";
import { PLANS, getPlan } from "./plans.js";
import { fulfillPaidOrder } from "./services/fulfillment.js";
import {
  createKeys,
  getKey,
  issueKey,
  keysSummary,
  listKeysPage,
  resolvePendingKeys,
  revokeKey,
  type IssueResult,
  type IssueTarget,
} from "./services/keys.js";
import {
  confirmPayment,
  createPayment,
  isSimulatedPayment,
  verifyPayment,
} from "./services/payments.js";
import { marzbanOverview } from "./services/provision.js";
import { broadcastMessage } from "./services/broadcast.js";
import {
  bindReferral,
  referralStats,
  setReferralRewardNotifier,
} from "./services/referrals.js";
import {
  approveRequest,
  pendingRequests,
  pendingRequestsCount,
  rejectRequest,
  submitRequest,
} from "./services/requests.js";
import { isPaymentsEnabled, setPaymentsEnabled } from "./services/settings.js";
import { activatePlan, startTrial } from "./services/subscriptions.js";
import { buildClientOptions, syncChatCommands } from "./telegram.js";
import {
  ADMIN_MENU_LABEL,
  OFFER_MENU_LABEL,
  REFERRAL_MENU_LABEL,
  adminKeyboard,
  adminsKeyboard,
  isMainMenuLabel,
  keyCardKeyboard,
  keyListKeyboard,
  keyPlansKeyboard,
  keyRevokeConfirmKeyboard,
  mainKeyboard,
  offerKeyboard,
  payKeyboard,
  paymentsKeyboard,
  plansKeyboard,
  referralKeyboard,
  requestsKeyboard,
  broadcastPreviewKeyboard,
  supportKeyboard,
  keysKeyboard,
} from "./ui/keyboards.js";
import {
  adminAddPromptText,
  adminAddedText,
  adminListText,
  adminNewRequestText,
  adminPanelText,
  adminRequestsText,
  adminStatsText,
  broadcastCancelledText,
  broadcastEmptyText,
  broadcastPreviewText,
  broadcastPromptText,
  broadcastResultText,
  helpText,
  keyCardText,
  keyCreatedText,
  keyHelpText,
  keyIssueCodePromptText,
  keyIssueTargetPromptText,
  keyIssuedText,
  keyIssuedToUserText,
  keyListText,
  keyLookupPromptText,
  keyNotFoundText,
  keyPlansPromptText,
  keyRevokeConfirmText,
  keyRevokedText,
  keyRevokedToUserText,
  keyStatusLabel,
  keysPanelText,
  offerText,
  paymentCreatedText,
  paymentSuccessText,
  paymentsPanelText,
  planListText,
  privacyText,
  referralJoinedText,
  referralRewardText,
  referralText,
  requestApprovedToUserText,
  requestDuplicateText,
  requestRejectedToUserText,
  requestSubmittedText,
  subscriptionText,
  supportLinkText,
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

  // Уведомляем пригласившего, когда за приглашённого начислена награда.
  setReferralRewardNotifier(async (info) => {
    await bot.api
      .sendMessage(info.inviterId, referralRewardText(info), {
        parse_mode: "Markdown",
      })
      .catch(() => undefined);
  });

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

  /**
   * Привязка «висящих» ключей. Ключ, выданный по `@username`, ждёт первого
   * появления получателя: здесь мы узнаём его Telegram ID и активируем доступ.
   */
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from?.username) {
      upsertUser({
        telegramId: from.id,
        username: from.username,
        firstName: from.first_name ?? null,
      });
      try {
        const bound = await resolvePendingKeys({
          telegramId: from.id,
          username: from.username,
        });
        for (const key of bound) {
          audit(from.id, "key_bound", key.code);
          await ctx.api
            .sendMessage(from.id, keyIssuedToUserText(key), {
              parse_mode: "Markdown",
            })
            .catch(() => undefined);
        }
      } catch (error) {
        logger.warn(
          { err: errorInfo(error) },
          "не удалось привязать ключ по @username",
        );
      }
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

  /** Шлёт сообщение всем админам: окружение + назначенные в панели. */
  const notifyAdmins = async (ctx: Context, text: string): Promise<void> => {
    for (const adminId of allAdminIds()) {
      await ctx.api
        .sendMessage(adminId, text, { parse_mode: "Markdown" })
        .catch(() => undefined);
    }
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
   * Ответ с HTML-разметкой. Нужен для текстов с юзернеймами: `_` в Markdown
   * ломает разметку, а в HTML безопасен.
   */
  const replyHtml = (
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<unknown> =>
    ctx.reply(text, {
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });

  /**
   * Telegram режет сообщения длиннее 4096 символов. Правовые документы длинные,
   * поэтому бьём их по абзацам; клавиатуру вешаем на последнее сообщение.
   */
  const sendLongHtml = async (
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> => {
    const limit = 3900;
    const parts: string[] = [];
    let current = "";
    for (const block of text.split("\n\n")) {
      if (current.length > 0 && current.length + block.length + 2 > limit) {
        parts.push(current);
        current = block;
      } else {
        current = current.length > 0 ? `${current}\n\n${block}` : block;
      }
    }
    if (current.length > 0) parts.push(current);
    for (const [index, part] of parts.entries()) {
      const isLast = index === parts.length - 1;
      await replyHtml(ctx, part, isLast ? keyboard : undefined);
    }
  };

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

  /**
   * Экран с картинкой. Telegram не переиспользует загруженный файл по пути,
   * поэтому запоминаем `file_id` первого фото и дальше шлём его — иначе каждый
   * показ экрана заливал бы картинку заново.
   */
  const photoFileIds = new Map<string, string>();

  /** Черновики рассылки: админ → пост, который он собирается отправить. */
  const broadcastDrafts = new Map<
    number,
    { text: string; photoFileId?: string }
  >();

  const sendPhotoScreen = async (
    ctx: Context,
    imagePath: string,
    caption: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> => {
    const options = {
      caption,
      parse_mode: "Markdown" as const,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    };
    const cached = photoFileIds.get(imagePath);
    if (cached) {
      try {
        await ctx.replyWithPhoto(cached, options);
        return;
      } catch (error) {
        photoFileIds.delete(imagePath);
        logger.warn(
          { err: errorInfo(error), path: imagePath },
          "не удалось отправить фото по file_id",
        );
      }
    }
    if (existsSync(imagePath)) {
      try {
        const sent = await ctx.replyWithPhoto(new InputFile(imagePath), options);
        const sizes = sent.photo;
        const fileId = sizes?.[sizes.length - 1]?.file_id;
        if (fileId) photoFileIds.set(imagePath, fileId);
        return;
      } catch (error) {
        logger.warn(
          { err: errorInfo(error), path: imagePath },
          "не удалось отправить картинку, отправляю текст",
        );
      }
    } else {
      logger.warn({ path: imagePath }, "файл картинки не найден");
    }
    await replyMarkdown(ctx, caption, keyboard);
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

  bot.command("start", async (ctx) => {
    track(ctx);
    const payload = ctx.match.trim();

    if (payload.startsWith("ref_")) {
      const inviterId = Number(payload.slice("ref_".length));
      if (ctx.from && Number.isInteger(inviterId) && inviterId > 0) {
        const result = bindReferral({ invitedId: ctx.from.id, inviterId });
        if (result.ok) {
          audit(ctx.from.id, "referral_bound", String(inviterId));
          await replyMarkdown(
            ctx,
            referralJoinedText(config.referral.inviteeDays),
          );
        }
      }
    }

    if (payload.startsWith("paid_")) {
      const orderId = payload.slice("paid_".length);
      const order = getOrder(orderId);
      if (order && ctx.from && order.telegramId === ctx.from.id) {
        // Возврат покупателя — не доказательство оплаты: спрашиваем статус
        // у провайдера (или подтверждаем mock-платёж).
        const result = await verifyPayment(orderId);
        if (result.ok && result.order) {
          await grantPaidOrder(ctx, result.order.id, result.order.planCode);
          return;
        }
        if (result.reason === "pending") {
          await replyMarkdown(
            ctx,
            "⏳ Платёж ещё не подтверждён. Если вы оплатили только что — подождите минуту и откройте «📦 Моя подписка».",
          );
          return;
        }
        if (result.reason === "already_paid") {
          await replyMarkdown(
            ctx,
            "Доступ по этому заказу уже выдан. Откройте «📦 Моя подписка».",
          );
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

  bot.command("offer", (ctx) => sendLongHtml(ctx, offerText(), offerKeyboard()));

  bot.command("privacy", (ctx) => sendLongHtml(ctx, privacyText()));

  bot.command("menu", async (ctx) => {
    track(ctx);
    const keyboard = mainKeyboard(isAdmin(fromId(ctx)));
    await sendMenu(ctx, () =>
      ctx.reply("Главное меню:", { reply_markup: keyboard }),
    );
  });

  bot.command("ref", async (ctx) => {
    track(ctx);
    await sendReferral(ctx);
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
    await sendPhotoScreen(
      ctx,
      config.plansImagePath,
      planListText(isPaymentsEnabled()),
      plansKeyboard(isPaymentsEnabled()),
    );
  });

  bot.hears("📦 Моя подписка", async (ctx) => {
    track(ctx);
    await sendSubscription(ctx);
  });

  bot.hears(REFERRAL_MENU_LABEL, async (ctx) => {
    track(ctx);
    await sendReferral(ctx);
  });

  bot.hears("❓ Помощь", (ctx) => replyMarkdown(ctx, helpText()));

  bot.hears("💬 Поддержка", async (ctx) => {
    track(ctx);
    await sendPhotoScreen(
      ctx,
      config.supportImagePath,
      supportLinkText(),
      supportKeyboard(config.supportUrl),
    );
  });

  bot.hears(OFFER_MENU_LABEL, (ctx) =>
    sendLongHtml(ctx, offerText(), offerKeyboard()),
  );

  bot.callbackQuery("offer:privacy", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendLongHtml(ctx, privacyText());
  });

  bot.hears(ADMIN_MENU_LABEL, async (ctx) => {
    track(ctx);
    if (!(await requireAdmin(ctx))) return;
    await replyMarkdown(
      ctx,
      adminPanelText(),
      adminKeyboard(pendingRequestsCount()),
    );
  });

  // --- Админ-панель ---
  bot.callbackQuery("adm:panel", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyMarkdown(
      ctx,
      adminPanelText(),
      adminKeyboard(pendingRequestsCount()),
    );
  });

  bot.callbackQuery("adm:stats", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    const vpn = await marzbanOverview();
    await replyMarkdown(
      ctx,
      adminStatsText(stats(), vpn),
      adminKeyboard(pendingRequestsCount()),
    );
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
    await syncChatCommands(ctx.api, target, false);
    await ctx.answerCallbackQuery({ text: `Права сняты: ${target}` });
    await replyMarkdown(
      ctx,
      adminListText(config.adminIds, listAdminIds()),
      adminsKeyboard(listAdminIds()),
    );
  });

  bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isPaymentsEnabled()) {
      await replyMarkdown(
        ctx,
        "💳 Оплата сейчас выключена.\n\nВыберите тариф и оставьте заявку — доступ выдадим вручную.",
        plansKeyboard(false),
      );
      return;
    }
    await startCheckout(ctx, ctx.match[1] ?? "");
  });

  // --- Заявки на подписку (когда оплата выключена) ---
  // Префикс `req:plan:` намеренно отличается от `req:ok:` / `req:no:` —
  // иначе этот обработчик перехватывал бы кнопки выдачи и отклонения.
  bot.callbackQuery(/^req:plan:(.+)$/, async (ctx) => {
    const planCode = ctx.match[1] ?? "";
    const plan = getPlan(planCode);
    if (!plan) {
      await ctx.answerCallbackQuery({
        text: "Тариф не найден",
        show_alert: true,
      });
      return;
    }
    const user = getUser(fromId(ctx));
    if (user?.banned) {
      await ctx.answerCallbackQuery({
        text: "Аккаунт заблокирован",
        show_alert: true,
      });
      return;
    }
    const result = submitRequest({
      telegramId: fromId(ctx),
      username: user?.username ?? ctx.from?.username ?? null,
      planCode,
    });
    if (!result.ok && result.reason === "already_pending") {
      await ctx.answerCallbackQuery();
      await replyMarkdown(
        ctx,
        requestDuplicateText(plan.name),
        plansKeyboard(false),
      );
      return;
    }
    if (!result.ok) {
      await ctx.answerCallbackQuery({
        text: "Не удалось создать заявку",
        show_alert: true,
      });
      return;
    }
    audit(fromId(ctx), "request_created", `${result.request.id}:${planCode}`);
    await ctx.answerCallbackQuery({ text: "Заявка отправлена" });
    await replyMarkdown(ctx, requestSubmittedText(plan.name));
    await notifyAdmins(ctx, adminNewRequestText(result.request));
  });

  bot.callbackQuery("adm:requests", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    const requests = pendingRequests();
    await replyMarkdown(
      ctx,
      adminRequestsText(requests),
      requestsKeyboard(requests),
    );
  });

  bot.callbackQuery(/^req:ok:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const id = ctx.match[1] ?? "";
    const result = await approveRequest({ id, actor: fromId(ctx) });
    if (!result.ok) {
      await ctx.answerCallbackQuery({
        text:
          result.reason === "already_resolved"
            ? "Заявка уже обработана"
            : result.reason === "provision_failed"
              ? "Не удалось выдать доступ — проверьте логи"
              : "Заявка не найдена",
        show_alert: true,
      });
      return;
    }
    audit(fromId(ctx), "request_approved", `${id}:${result.request.planCode}`);
    await ctx.answerCallbackQuery({ text: "Доступ выдан" });
    const requests = pendingRequests();
    await replyMarkdown(
      ctx,
      adminRequestsText(requests),
      requestsKeyboard(requests),
    );
    await ctx.api
      .sendMessage(
        result.request.telegramId,
        requestApprovedToUserText(
          result.subscription.planName,
          result.subscription.subscriptionUrl,
          result.subscription.expiresAt,
        ),
        { parse_mode: "Markdown" },
      )
      .catch(() => undefined);
  });

  bot.callbackQuery(/^req:no:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const id = ctx.match[1] ?? "";
    const result = rejectRequest({ id, actor: fromId(ctx) });
    if (!result.ok) {
      await ctx.answerCallbackQuery({
        text:
          result.reason === "already_resolved"
            ? "Заявка уже обработана"
            : "Заявка не найдена",
        show_alert: true,
      });
      return;
    }
    audit(fromId(ctx), "request_rejected", id);
    await ctx.answerCallbackQuery({ text: "Заявка отклонена" });
    const requests = pendingRequests();
    await replyMarkdown(
      ctx,
      adminRequestsText(requests),
      requestsKeyboard(requests),
    );
    await ctx.api
      .sendMessage(
        result.request.telegramId,
        requestRejectedToUserText(),
        { parse_mode: "Markdown" },
      )
      .catch(() => undefined);
  });

  bot.callbackQuery("adm:payments", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    const enabled = isPaymentsEnabled();
    await replyMarkdown(
      ctx,
      paymentsPanelText(enabled),
      paymentsKeyboard(enabled),
    );
  });

  bot.callbackQuery("adm:payments:toggle", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const next = !isPaymentsEnabled();
    setPaymentsEnabled(next);
    audit(fromId(ctx), next ? "payments_enabled" : "payments_disabled");
    await ctx.answerCallbackQuery({
      text: next ? "Оплата включена" : "Оплата выключена",
    });
    await replyMarkdown(ctx, paymentsPanelText(next), paymentsKeyboard(next));
  });

  // --- Рассылка ---
  bot.callbackQuery("adm:broadcast", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    setUserState(fromId(ctx), "broadcast_compose");
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, broadcastPromptText());
  });

  bot.callbackQuery("bc:cancel", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    broadcastDrafts.delete(fromId(ctx));
    await ctx.answerCallbackQuery({ text: "Отменено" });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await replyMarkdown(
      ctx,
      broadcastCancelledText(),
      adminKeyboard(pendingRequestsCount()),
    );
  });

  bot.callbackQuery("bc:send", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const actor = fromId(ctx);
    const draft = broadcastDrafts.get(actor);
    if (!draft) {
      await ctx.answerCallbackQuery({
        text: "Черновик не найден — начните заново",
        show_alert: true,
      });
      return;
    }
    broadcastDrafts.delete(actor);
    await ctx.answerCallbackQuery({ text: "Отправляю…" });
    await ctx.editMessageReplyMarkup().catch(() => undefined);

    const recipients = listBroadcastRecipients().length;
    const started = await ctx.reply(`📣 Отправляю ${recipients} получателям…`);
    const result = await broadcastMessage(ctx.api, draft);
    audit(actor, "broadcast", `sent=${result.sent}/${result.total}`);
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      await ctx.api
        .editMessageText(chatId, started.message_id, broadcastResultText(result), {
          parse_mode: "Markdown",
        })
        .catch(() => undefined);
    }
  });

  // --- Ключи доступа ---
  bot.callbackQuery("key:panel", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, keysPanelText(keysSummary()), keysKeyboard());
  });

  bot.callbackQuery("key:new", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, keyPlansPromptText(), keyPlansKeyboard());
  });

  bot.callbackQuery(/^key:create:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const planCode = ctx.match[1] ?? "";
    let created: ReturnType<typeof createKeys>;
    try {
      created = createKeys({ planCode, createdBy: fromId(ctx), count: 1 });
    } catch {
      await ctx.answerCallbackQuery({
        text: "Неизвестный тариф",
        show_alert: true,
      });
      return;
    }
    const key = created[0];
    if (!key) return;
    audit(fromId(ctx), "key_created", `${key.code}:${planCode}`);
    await ctx.answerCallbackQuery({ text: "Ключ создан" });
    await replyMarkdown(
      ctx,
      keyCreatedText(created),
      keyCardKeyboard(key.code, key.status),
    );
  });

  bot.callbackQuery(/^key:list:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await showKeyList(ctx, Number(ctx.match[1] ?? 0));
  });

  bot.callbackQuery(/^key:view:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery();
    await showKeyCard(ctx, ctx.match[1] ?? "");
  });

  bot.callbackQuery("key:find", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    setUserState(fromId(ctx), "key_lookup");
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, keyLookupPromptText());
  });

  bot.callbackQuery("key:issue", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    setUserState(fromId(ctx), "key_issue_code");
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, keyIssueCodePromptText());
  });

  bot.callbackQuery(/^key:issue:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const code = ctx.match[1] ?? "";
    if (!getKey(code)) {
      await ctx.answerCallbackQuery({
        text: "Ключ не найден",
        show_alert: true,
      });
      return;
    }
    setUserState(fromId(ctx), `key_issue_target:${code}`);
    await ctx.answerCallbackQuery();
    await replyMarkdown(ctx, keyIssueTargetPromptText(code));
  });

  bot.callbackQuery(/^key:revoke:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const key = getKey(ctx.match[1] ?? "");
    if (!key) {
      await ctx.answerCallbackQuery({
        text: "Ключ не найден",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await replyMarkdown(
      ctx,
      keyRevokeConfirmText(key),
      keyRevokeConfirmKeyboard(key.code),
    );
  });

  bot.callbackQuery(/^key:revokeok:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const code = ctx.match[1] ?? "";
    const result = await revokeKey({ code, actor: fromId(ctx) });
    if (!result.ok) {
      await ctx.answerCallbackQuery({
        text: "Ключ не найден",
        show_alert: true,
      });
      return;
    }
    audit(fromId(ctx), "key_revoked", code);
    await ctx.answerCallbackQuery({ text: "Ключ удалён" });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await replyMarkdown(ctx, keyRevokedText(result), keysKeyboard());
    if (result.key.targetTelegramId) {
      await ctx.api
        .sendMessage(
          result.key.targetTelegramId,
          keyRevokedToUserText(result.key),
          { parse_mode: "Markdown" },
        )
        .catch(() => undefined);
    }
  });

  bot.callbackQuery("sub:renew", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPhotoScreen(
      ctx,
      config.plansImagePath,
      planListText(isPaymentsEnabled()),
      plansKeyboard(isPaymentsEnabled()),
    );
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
    const result = await verifyPayment(order.id);
    if (result.ok && result.order) {
      await ctx.answerCallbackQuery({ text: "Оплата подтверждена" });
      await grantPaidOrder(ctx, result.order.id, result.order.planCode);
      return;
    }
    await ctx.answerCallbackQuery({
      text:
        result.reason === "already_paid"
          ? "Оплата уже подтверждена"
          : "Платёж ещё не подтверждён. Попробуйте через минуту.",
      show_alert: true,
    });
  });

  // Демонстрационная оплата: доступна только в MOCK_MODE.
  bot.callbackQuery(/^mockpay:(.+)$/, async (ctx) => {
    if (!isSimulatedPayment()) {
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

  bot.command("key", async (ctx) => {
    if (!isAdmin(fromId(ctx))) return;
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const action = parts[0] ?? "";
    const rest = parts.slice(1);

    switch (action) {
      case "": {
        await replyMarkdown(ctx, keyHelpText());
        return;
      }
      case "new": {
        const planCode = rest[0] ?? "";
        const note = rest.slice(1).join(" ") || null;
        let created: ReturnType<typeof createKeys>;
        try {
          created = createKeys({
            planCode,
            createdBy: fromId(ctx),
            note,
            count: 1,
          });
        } catch {
          await replyMarkdown(
            ctx,
            `Неизвестный тариф: \`${planCode}\`. Доступные: ${PLANS.map((plan) => `\`${plan.code}\``).join(", ")}.`,
          );
          return;
        }
        const key = created[0];
        if (!key) return;
        audit(fromId(ctx), "key_created", `${key.code}:${planCode}`);
        await replyMarkdown(
          ctx,
          keyCreatedText(created),
          keyCardKeyboard(key.code, key.status),
        );
        return;
      }
      case "list": {
        await showKeyList(ctx, 0);
        return;
      }
      case "info": {
        await showKeyCard(ctx, rest[0] ?? "");
        return;
      }
      case "issue": {
        const code = rest[0] ?? "";
        const raw = rest[1] ?? "";
        if (!code || !raw) {
          await replyMarkdown(
            ctx,
            "Использование: `/key issue <код> <telegram_id|@username>`",
          );
          return;
        }
        const target: IssueTarget = /^\d+$/.test(raw)
          ? { telegramId: Number(raw) }
          : { username: raw };
        await performKeyIssue(ctx, code, target);
        return;
      }
      case "revoke": {
        const code = rest[0] ?? "";
        const result = await revokeKey({ code, actor: fromId(ctx) });
        if (!result.ok) {
          await replyMarkdown(ctx, keyNotFoundText(code));
          return;
        }
        audit(fromId(ctx), "key_revoked", code);
        await replyMarkdown(ctx, keyRevokedText(result), keysKeyboard());
        if (result.key.targetTelegramId) {
          await ctx.api
            .sendMessage(
              result.key.targetTelegramId,
              keyRevokedToUserText(result.key),
              { parse_mode: "Markdown" },
            )
            .catch(() => undefined);
        }
        return;
      }
      case "link": {
        const key = getKey(rest[0] ?? "");
        if (!key) {
          await replyMarkdown(ctx, keyNotFoundText(rest[0] ?? ""));
          return;
        }
        if (!key.subscriptionUrl) {
          await replyMarkdown(
            ctx,
            `Ключ \`${key.code}\` ещё не активирован — ссылки нет.`,
          );
          return;
        }
        await replyMarkdown(ctx, `🔗 \`${key.subscriptionUrl}\``);
        return;
      }
      default: {
        await replyMarkdown(ctx, keyHelpText());
      }
    }
  });

  /**
   * Сообщения, которые не являются командами или кнопками меню: обращения
   * в поддержку, ввод ID нового админа и шаги выдачи ключа.
   */
  bot.on("message", async (ctx) => {
    const message = ctx.message;
    const from = ctx.from;
    if (!message || !from) return;

    const state = getUserState(from.id);

    if (state === "key_lookup") {
      clearUserState(from.id);
      if (!isAdmin(from.id)) return;
      await showKeyCard(ctx, (message.text ?? "").trim());
      return;
    }

    if (state === "key_issue_code") {
      clearUserState(from.id);
      if (!isAdmin(from.id)) return;
      const code = (message.text ?? "").trim();
      const key = getKey(code);
      if (!key) {
        await replyMarkdown(ctx, keyNotFoundText(code), keysKeyboard());
        return;
      }
      setUserState(from.id, `key_issue_target:${key.code}`);
      await replyMarkdown(ctx, keyIssueTargetPromptText(key.code));
      return;
    }

    if (state?.startsWith("key_issue_target:")) {
      clearUserState(from.id);
      if (!isAdmin(from.id)) return;
      const code = state.slice("key_issue_target:".length);
      const raw = (message.text ?? "").trim();
      const target: IssueTarget = /^\d+$/.test(raw)
        ? { telegramId: Number(raw) }
        : { username: raw };
      await performKeyIssue(ctx, code, target);
      return;
    }

    if (state === "broadcast_compose") {
      clearUserState(from.id);
      if (!isAdmin(from.id)) return;
      const text = (message.text ?? message.caption ?? "").trim();
      const sizes = message.photo;
      const photoFileId = sizes?.[sizes.length - 1]?.file_id;
      if (!text && !photoFileId) {
        await replyMarkdown(
          ctx,
          "Нужен текст или картинка с подписью. Начните заново: «🛠 Админка» → «📣 Рассылка».",
        );
        return;
      }
      const recipients = listBroadcastRecipients();
      if (recipients.length === 0) {
        await replyMarkdown(
          ctx,
          broadcastEmptyText(),
          adminKeyboard(pendingRequestsCount()),
        );
        return;
      }
      broadcastDrafts.set(from.id, {
        text,
        ...(photoFileId ? { photoFileId } : {}),
      });
      await replyMarkdown(
        ctx,
        broadcastPreviewText(recipients.length),
        broadcastPreviewKeyboard(recipients.length),
      );
      if (photoFileId) {
        await ctx
          .replyWithPhoto(photoFileId, {
            ...(text ? { caption: text, parse_mode: "Markdown" as const } : {}),
          })
          .catch(() => undefined);
      } else {
        await replyMarkdown(ctx, text);
      }
      return;
    }

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
      await syncChatCommands(ctx.api, target, true);
      await replyMarkdown(
        ctx,
        adminAddedText(target),
        adminKeyboard(pendingRequestsCount()),
      );
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

    const keyboard = isSimulatedPayment()
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
        : plansKeyboard(isPaymentsEnabled());
    await replyMarkdown(ctx, text, keyboard);
  }

  async function sendReferral(ctx: Context): Promise<void> {
    const data = referralStats(fromId(ctx));
    await replyMarkdown(
      ctx,
      referralText(data),
      data.link ? referralKeyboard(data.link) : undefined,
    );
  }

  bot.callbackQuery("sub:show", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSubscription(ctx);
  });

  async function showKeyList(ctx: Context, page: number): Promise<void> {
    const data = listKeysPage(page);
    await replyMarkdown(
      ctx,
      keyListText(data),
      keyListKeyboard(data.items, data.page, data.pages, keyStatusLabel),
    );
  }

  async function showKeyCard(ctx: Context, code: string): Promise<void> {
    const key = getKey(code);
    if (!key) {
      await replyMarkdown(ctx, keyNotFoundText(code), keysKeyboard());
      return;
    }
    await replyMarkdown(
      ctx,
      keyCardText(key),
      keyCardKeyboard(key.code, key.status),
    );
  }

  async function performKeyIssue(
    ctx: Context,
    code: string,
    target: IssueTarget,
  ): Promise<void> {
    const actor = fromId(ctx);
    let result: IssueResult;
    try {
      result = await issueKey({ code, target, actor });
    } catch (error) {
      logger.error({ err: errorInfo(error), code }, "не удалось выдать ключ");
      await replyMarkdown(
        ctx,
        "⚠️ Не удалось выдать ключ — ошибка Marzban. Проверьте логи.",
        keysKeyboard(),
      );
      return;
    }
    if (!result.ok) {
      const text =
        result.reason === "not_found"
          ? keyNotFoundText(code)
          : result.reason === "revoked"
            ? `🚫 Ключ \`${code}\` отозван — выдать нельзя.`
            : "Некорректный получатель. Укажите Telegram ID или `@username`.";
      await replyMarkdown(ctx, text, keysKeyboard());
      return;
    }
    audit(
      actor,
      "key_issued",
      `${code}:${
        result.pending
          ? (result.key.targetUsername ?? "username")
          : (result.telegramId ?? "unknown")
      }`,
    );
    await replyMarkdown(
      ctx,
      keyIssuedText(result),
      keyCardKeyboard(result.key.code, result.key.status),
    );
    const recipient = result.telegramId;
    if (recipient !== undefined && !result.pending) {
      await ctx.api
        .sendMessage(recipient, keyIssuedToUserText(result.key), {
          parse_mode: "Markdown",
        })
        .catch((error) => {
          logger.warn(
            { err: errorInfo(error), telegramId: recipient },
            "не удалось уведомить получателя ключа",
          );
        });
    }
  }

  return bot;
}
