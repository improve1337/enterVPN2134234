import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
} from "fastify";
import { webhookCallback } from "grammy";
import type { Bot } from "grammy";
import { config } from "./config.js";
import { errorInfo, logger } from "./logger.js";
import { fulfillPaidOrder } from "./services/fulfillment.js";
import {
  confirmPayment,
  isSimulatedPayment,
  verifyCoinsoSignature,
} from "./services/payments.js";
import { getOrder, getUser, listOrders, stats } from "./db.js";

export function createServer(bot: Bot) {
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
  });

  // Сохраняем сырое тело запроса: подпись вебхука Coinso считается по нему,
  // а не по результату JSON.parse.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      (request as { rawBody?: Buffer }).rawBody = body as Buffer;
      try {
        const text = (body as Buffer).toString("utf8");
        done(null, text.length > 0 ? JSON.parse(text) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.get("/health", async () => ({
    ok: true,
    mode: config.mode,
    mock: config.mockMode,
    uptime: Math.round(process.uptime()),
  }));

  app.get("/api/me/:telegramId", async (request, reply) => {
    const params = request.params as { telegramId: string };
    const telegramId = Number(params.telegramId);
    if (!Number.isInteger(telegramId) || telegramId <= 0) {
      return reply.code(400).send({ error: "invalid telegramId" });
    }
    const user = getUser(telegramId);
    if (!user) return reply.code(404).send({ error: "not found" });
    return {
      telegramId: user.telegramId,
      planCode: user.planCode,
      expiresAt: user.subscriptionExpiresAt,
      trafficLimitGb: user.trafficLimitGb,
      subscriptionUrl: user.subscriptionUrl,
      autoRenew: Boolean(user.autoRenew),
      banned: Boolean(user.banned),
      orders: listOrders(telegramId).map((order) => ({
        id: order.id,
        planCode: order.planCode,
        amountRub: order.amountRub,
        status: order.status,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
      })),
    };
  });

  app.get("/api/stats", async () => stats());

  // Mock-подтверждение оплаты: эмулирует callback платёжки локально.
  app.post("/mock/pay/:orderId", async (request, reply) => {
    if (!isSimulatedPayment()) {
      return reply.code(404).send({ error: "not found" });
    }
    const params = request.params as { orderId: string };
    const result = confirmPayment({ orderId: params.orderId });
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : 409;
      return reply.code(code).send({ ok: false, reason: result.reason });
    }
    const fulfilled = await fulfillPaidOrder(params.orderId);
    return {
      ok: true,
      order: getOrder(params.orderId),
      fulfilled: fulfilled.ok ? fulfilled.subscription : { ok: false, reason: fulfilled.reason },
    };
  });

  // Заглушка Platega-вебхука для прототипа: принимает payload с order id.
  app.post("/webhooks/platega", async (request, reply) => {
    if (config.mockMode) {
      if (config.webhookSecret) {
        const header = request.headers["x-secret"];
        if (header !== config.webhookSecret) {
          logger.warn("Platega webhook: неверный секрет");
          return reply.code(401).send({ ok: false });
        }
      }
      const body = (request.body ?? {}) as {
        payload?: string;
        id?: string;
        amount?: number;
        status?: string;
      };
      logger.info({ status: body.status, id: body.id }, "mock Platega callback");
      if (body.status && body.status !== "CONFIRMED") {
        return { ok: true, ignored: body.status };
      }
      if (!body.payload) return reply.code(400).send({ ok: false });
      const result = confirmPayment({
        orderId: body.payload,
        ...(body.id ? { providerTxId: body.id } : {}),
        ...(typeof body.amount === "number" ? { amountRub: body.amount } : {}),
      });
      if (!result.ok) {
        // Повторный CONFIRMED — обычная ситуация, отвечаем 200 и не выдаём дважды.
        return { ok: true, reason: result.reason ?? null };
      }
      const fulfilled = await fulfillPaidOrder(body.payload);
      return {
        ok: true,
        order: getOrder(body.payload),
        fulfilled: fulfilled.ok ? { username: fulfilled.subscription.username } : { ok: false, reason: fulfilled.reason },
      };
    }
    return reply.code(501).send({ ok: false, error: "Platega не настроена" });
  });

  // Вебхук Coinso: подпись X-Signature = HMAC-SHA256 от сырого тела.
  app.post("/webhooks/coinso", async (request, reply) => {
    const rawBody = (request as { rawBody?: Buffer }).rawBody;
    const signature = request.headers["x-signature"];
    if (
      !rawBody ||
      typeof signature !== "string" ||
      !verifyCoinsoSignature(rawBody, signature)
    ) {
      logger.warn("Coinso webhook: неверная подпись");
      return reply.code(401).send({ ok: false });
    }

    const body = (request.body ?? {}) as {
      event?: string;
      invoice_id?: string;
      transaction_id?: number;
      custom?: string;
      amount?: number | string;
      test_mode?: boolean;
      payment_method?: string;
    };

    if (body.event !== "payment.success") {
      logger.info(
        { event: body.event, invoice: body.invoice_id },
        "Coinso webhook: событие не success",
      );
      return { ok: true, ignored: body.event ?? null };
    }
    if (body.test_mode && !config.coinso.deliverTest) {
      logger.info(
        { invoice: body.invoice_id },
        "Coinso webhook: тестовый платёж — выдачу пропускаем",
      );
      return { ok: true, test: true };
    }
    const orderId = body.custom;
    if (!orderId) return { ok: true, ignored: "no custom" };

    const amount = Number(body.amount);
    const result = confirmPayment({
      orderId,
      ...(Number.isFinite(amount) ? { amountRub: amount } : {}),
    });
    if (!result.ok) {
      // Повторный success — обычная ситуация: Coinso повторяет вебхук.
      return { ok: true, reason: result.reason ?? null };
    }
    const fulfilled = await fulfillPaidOrder(orderId);
    return {
      ok: true,
      fulfilled: fulfilled.ok
        ? { username: fulfilled.subscription.username }
        : { ok: false, reason: fulfilled.reason },
    };
  });

  if (config.mode === "webhook") {
    if (!config.publicUrl && !config.webhookSecret) {
      logger.warn(
        "BOT_MODE=webhook, но PUBLIC_URL/WEBHOOK_SECRET не заданы — регистрация вебхука пропущена",
      );
    }
    app.post(
      config.webhookPath,
      webhookCallback(bot, "fastify", {
        ...(config.webhookSecret ? { secretToken: config.webhookSecret } : {}),
      }),
    );
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    logger.error({ err: errorInfo(error), url: request.url }, "HTTP error");
    reply.code(error.statusCode ?? 500).send({ ok: false });
  });

  return app;
}

export async function registerWebhook(bot: Bot): Promise<void> {
  if (config.mode !== "webhook") return;
  if (!config.publicUrl) {
    logger.warn("PUBLIC_URL не задан — вебхук Telegram не зарегистрирован");
    return;
  }
  const url = `${config.publicUrl.replace(/\/+$/, "")}${config.webhookPath}`;
  await bot.api.setWebhook(url, {
    ...(config.webhookSecret ? { secret_token: config.webhookSecret } : {}),
  });
  logger.info({ url }, "Telegram webhook зарегистрирован");
}

export async function deleteWebhook(bot: Bot): Promise<void> {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (error) {
    logger.warn(
      { err: errorInfo(error) },
      "не удалось удалить вебхук Telegram",
    );
  }
}
