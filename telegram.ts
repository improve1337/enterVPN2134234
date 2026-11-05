import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Bot } from "grammy";
import { config } from "./config.js";
import { errorInfo, logger } from "./logger.js";

const SOCKS_SCHEMES = new Set([
  "socks",
  "socks4",
  "socks4a",
  "socks5",
  "socks5h",
]);

/** Создаёт агент для HTTP(S)- или SOCKS-прокси по URL. */
export function createTelegramAgent(proxyUrl: string): Agent {
  let scheme: string;
  try {
    scheme = new URL(proxyUrl).protocol.replace(":", "").toLowerCase();
  } catch {
    throw new Error(
      `TELEGRAM_PROXY имеет неверный формат: "${proxyUrl}". Пример: socks5://127.0.0.1:1080`,
    );
  }
  if (scheme === "http" || scheme === "https") {
    return new HttpsProxyAgent(proxyUrl);
  }
  if (SOCKS_SCHEMES.has(scheme)) {
    return new SocksProxyAgent(proxyUrl);
  }
  throw new Error(
    `Неподдерживаемая схема прокси "${scheme}". Поддерживаются http, https, socks4, socks5.`,
  );
}

/**
 * Опции клиента grammY. Без прокси возвращает пустой объект — тогда grammY
 * использует свои значения по умолчанию (keep-alive, сжатие).
 */
export function buildClientOptions(): {
  baseFetchConfig?: {
    agent: Agent;
    compress: boolean;
    duplex: "half";
  };
} {
  if (!config.telegramProxy) return {};
  const agent = createTelegramAgent(config.telegramProxy);
  logger.info(
    { proxy: redactProxy(config.telegramProxy) },
    "Telegram Bot API через прокси",
  );
  return { baseFetchConfig: { agent, compress: true, duplex: "half" } };
}

/** Скрывает логин/пароль прокси в логах. */
function redactProxy(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return "<невалидный url>";
  }
}

export type PreflightResult =
  | { ok: true; username: string }
  | { ok: false; reason: "unreachable" | "unauthorized" | "unknown"; message: string };

/**
 * Проверка доступа к Telegram до старта polling: иначе бот молча висит,
 * а причина (блокировка, неверный токен) остаётся невидимой.
 */
export async function preflight(
  bot: Bot,
  timeoutMs = 15_000,
): Promise<PreflightResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // grammY типизирует signal через пакет `abort-controller`, мы передаём
    // встроенный AbortSignal из Node — в рантайме они совместимы (node-fetch
    // использует только `aborted` и addEventListener("abort")).
    const me = await bot.api.getMe(controller.signal as never);
    return { ok: true, username: me.username ?? String(me.id) };
  } catch (error) {
    const info = errorInfo(error);
    const haystack = `${info.message} ${info.code ?? ""}`;
    if (/401|unauthorized/i.test(haystack)) {
      return { ok: false, reason: "unauthorized", message: info.message };
    }
    if (
      /abort|timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPROTO|socket hang up|fetch failed|network request/i.test(
        haystack,
      )
    ) {
      return { ok: false, reason: "unreachable", message: info.message };
    }
    return { ok: false, reason: "unknown", message: info.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Понятный текст для лога при недоступности Telegram. */
export function describePreflightFailure(result: PreflightResult): string {
  if (result.ok) return "";
  if (result.reason === "unauthorized") {
    return "Telegram ответил 401 — неверный BOT_TOKEN. Проверьте значение в .env.";
  }
  if (result.reason === "unreachable") {
    return [
      "Telegram Bot API недоступен с этой машины (соединение не устанавливается).",
      "Скорее всего, api.telegram.org блокируется провайдером.",
      "Решения:",
      "  1) включить VPN/прокси на ПК и перезапустить бота;",
      "  2) указать прокси в .env: TELEGRAM_PROXY=socks5://127.0.0.1:1080",
      "     (или http://user:pass@host:port);",
      "  3) запустить бота на сервере в ЕС, где Telegram доступен.",
      "Проверить блокировку: curl.exe -m 10 https://api.telegram.org/",
    ].join("\n");
  }
  return `Не удалось связаться с Telegram: ${result.message}`;
}
