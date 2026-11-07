import type { Api } from "grammy";
import { listBroadcastRecipients } from "../db.js";
import { errorInfo, logger } from "../logger.js";

/** Что рассылаем: текст и, если есть, фото (по `file_id`). */
export interface BroadcastPayload {
  text: string;
  photoFileId?: string;
}

export interface BroadcastResult {
  total: number;
  sent: number;
  failed: number;
}

export interface BroadcastOptions {
  /** Пауза между сообщениями, мс. Telegram держит ~30 сообщений в секунду. */
  delayMs?: number;
  /** Вызывается после каждой отправки — для прогресса. */
  onProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `retry_after` из ошибки Telegram, если это 429. */
function retryAfterSeconds(error: unknown): number | undefined {
  const candidate = error as {
    error?: { error_code?: number; parameters?: { retry_after?: number } };
    parameters?: { retry_after?: number };
  };
  const code = candidate?.error?.error_code;
  const value =
    candidate?.error?.parameters?.retry_after ?? candidate?.parameters?.retry_after;
  if (code === 429 && typeof value === "number") return value;
  return undefined;
}

/**
 * Рассылка поста всем пользователям бота.
 *
 * Отправляет по одному сообщению с паузой, чтобы не упереться в лимиты Telegram,
 * считает успешные и неуспешные отправки (заблокировавшие бота дают ошибку) и
 * один раз повторяет отправку, если Telegram попросил подождать (`retry_after`).
 */
export async function broadcastMessage(
  api: Api,
  payload: BroadcastPayload,
  options: BroadcastOptions = {},
): Promise<BroadcastResult> {
  const recipients = listBroadcastRecipients();
  const delayMs = options.delayMs ?? 50;
  let sent = 0;
  let failed = 0;
  let done = 0;

  const send = async (chatId: number): Promise<void> => {
    if (payload.photoFileId) {
      await api.sendPhoto(chatId, payload.photoFileId, {
        ...(payload.text
          ? { caption: payload.text, parse_mode: "Markdown" as const }
          : {}),
      });
      return;
    }
    await api.sendMessage(chatId, payload.text, { parse_mode: "Markdown" });
  };

  for (const chatId of recipients) {
    try {
      await send(chatId);
      sent += 1;
    } catch (error) {
      const retryAfter = retryAfterSeconds(error);
      if (retryAfter !== undefined && retryAfter <= 60) {
        await sleep((retryAfter + 1) * 1000);
        try {
          await send(chatId);
          sent += 1;
        } catch (retryError) {
          failed += 1;
          logger.warn(
            { err: errorInfo(retryError), chatId },
            "рассылка: повторная отправка не удалась",
          );
        }
      } else {
        failed += 1;
        logger.debug({ err: errorInfo(error), chatId }, "рассылка: не доставлено");
      }
    }
    done += 1;
    options.onProgress?.(done, recipients.length);
    if (delayMs > 0 && done < recipients.length) await sleep(delayMs);
  }

  logger.info(
    { total: recipients.length, sent, failed },
    "рассылка завершена",
  );
  return { total: recipients.length, sent, failed };
}
