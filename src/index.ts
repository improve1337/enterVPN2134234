import type { Bot } from "grammy";
import { config } from "./config.js";
import { allAdminIds } from "./admins.js";
import { createBot } from "./bot.js";
import { initDatabase, closeDatabase } from "./db.js";
import { errorInfo, logger } from "./logger.js";
import { removePidFile, writePidFile } from "./pid.js";
import {
  createServer,
  deleteWebhook,
  registerWebhook,
} from "./server.js";
import {
  describePreflightFailure,
  preflight,
  registerCommands,
} from "./telegram.js";

async function main(): Promise<void> {
  initDatabase();
  writePidFile();
  const bot = createBot();

  logger.info(
    {
      mode: config.mode,
      mock: config.mockMode,
      admins: allAdminIds(),
      db: config.databasePath,
      proxy: config.telegramProxy ? "включён" : "нет",
    },
    `${config.brandName}: запуск`,
  );

  if (allAdminIds().length === 0) {
    logger.warn(
      "Нет ни одного админа: кнопка «🛠 Админка» никому не показывается. Задайте ADMIN_IDS в переменных окружения хостинга.",
    );
  }

  const check = await preflight(bot);
  if (!check.ok) {
    logger.error(describePreflightFailure(check));
    if (check.reason === "unauthorized") {
      closeDatabase();
      process.exit(1);
    }
    logger.warn(
      "Продолжаю запуск: HTTP-сервер и /health будут доступны, но бот не сможет получать сообщения.",
    );
  } else {
    logger.info({ bot: `@${check.username}` }, "Telegram доступен");
    await registerCommands(bot.api, allAdminIds());
  }

  if (config.mode === "webhook") {
    const app = createServer(bot);
    await bot.init();
    await registerWebhook(bot);
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port }, "HTTP-сервер запущен");
  } else {
    // Polling не требует HTTP, но health-сервер полезен для хостинга.
    const app = createServer(bot);
    await app.listen({ port: config.port, host: config.host });
    await deleteWebhook(bot);
    logger.info({ port: config.port }, "HTTP-сервер мониторинга запущен");
    await startPolling(bot);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "остановка");
    try {
      await bot.stop();
    } catch {
      // Бот мог ещё не стартовать.
    }
    removePidFile();
    closeDatabase();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: errorInfo(error) }, "фатальная ошибка запуска");
  process.exit(1);
});

/**
 * Long polling с восстановлением после сбоев.
 *
 * При пересоздании контейнера хостингом старый и новый инстанс на пару секунд
 * опрашивают один токен одновременно — Telegram отвечает `409 Conflict`.
 * Раньше это валило процесс (`process.exit(1)`), и бот уходил в цикл
 * перезапусков. Теперь ошибки polling (кроме неверного токена) приводятся
 * к повтору с нарастающей паузой.
 */
async function startPolling(bot: Bot): Promise<void> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await bot.start();
      return;
    } catch (error) {
      const info = errorInfo(error);
      const haystack = `${info.message} ${info.code ?? ""}`;
      if (/401|unauthorized/i.test(haystack)) {
        logger.error(
          { err: info },
          "polling: Telegram отклонил токен (401) — останавливаюсь",
        );
        process.exit(1);
      }
      const retryInMs = Math.min(30_000, 2_000 * attempt);
      logger.warn(
        { attempt, err: info, retryInMs },
        "polling прервался, перезапускаю",
      );
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
}
