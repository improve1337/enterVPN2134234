import { beforeEach, describe, expect, it } from "vitest";
import type { Api } from "grammy";

import { db, initDatabase, setBanned, upsertUser } from "../src/db.js";
import { broadcastMessage } from "../src/services/broadcast.js";

interface SentCall {
  method: "sendMessage" | "sendPhoto";
  chatId: number;
  text?: string;
  photo?: string;
  caption?: string;
}

/** Заглушка Telegram API: пишет вызовы и умеет «падать» для выбранных чатов. */
function stubApi(calls: SentCall[], failFor: ReadonlySet<number> = new Set()): Api {
  return {
    sendMessage: async (chatId: number, text: string) => {
      if (failFor.has(chatId)) throw new Error("403: bot was blocked by the user");
      calls.push({ method: "sendMessage", chatId, text });
      return { message_id: calls.length };
    },
    sendPhoto: async (
      chatId: number,
      photo: string,
      options?: { caption?: string },
    ) => {
      if (failFor.has(chatId)) throw new Error("403: bot was blocked by the user");
      calls.push({
        method: "sendPhoto",
        chatId,
        photo,
        ...(options?.caption === undefined ? {} : { caption: options.caption }),
      });
      return { message_id: calls.length };
    },
  } as unknown as Api;
}

beforeEach(() => {
  initDatabase();
  db.exec("DELETE FROM users; DELETE FROM audit_log;");
  upsertUser({ telegramId: 1, username: "one" });
  upsertUser({ telegramId: 2, username: "two" });
  upsertUser({ telegramId: 3, username: "three" });
});

describe("рассылка", () => {
  it("отправляет всем незабаненным", async () => {
    setBanned(3, true);
    const calls: SentCall[] = [];
    const result = await broadcastMessage(
      stubApi(calls),
      { text: "привет" },
      { delayMs: 0 },
    );
    expect(result).toEqual({ total: 2, sent: 2, failed: 0 });
    expect(calls.map((call) => call.chatId).sort()).toEqual([1, 2]);
  });

  it("считает недоставленные", async () => {
    const calls: SentCall[] = [];
    const result = await broadcastMessage(
      stubApi(calls, new Set([2])),
      { text: "привет" },
      { delayMs: 0 },
    );
    expect(result).toEqual({ total: 3, sent: 2, failed: 1 });
  });

  it("отправляет фото с подписью", async () => {
    const calls: SentCall[] = [];
    await broadcastMessage(
      stubApi(calls),
      { text: "пост", photoFileId: "FILEID" },
      { delayMs: 0 },
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.method === "sendPhoto")).toBe(true);
    expect(calls[0]?.photo).toBe("FILEID");
    expect(calls[0]?.caption).toBe("пост");
  });

  it("фото без текста уходит без подписи", async () => {
    const calls: SentCall[] = [];
    await broadcastMessage(
      stubApi(calls),
      { text: "", photoFileId: "FILEID" },
      { delayMs: 0 },
    );
    expect(calls[0]?.caption).toBeUndefined();
  });

  it("сообщает прогресс по каждому получателю", async () => {
    const calls: SentCall[] = [];
    const progress: number[] = [];
    await broadcastMessage(stubApi(calls), { text: "x" }, {
      delayMs: 0,
      onProgress: (done) => progress.push(done),
    });
    expect(progress).toEqual([1, 2, 3]);
  });

  it("пустая база — отправлять некому", async () => {
    db.exec("DELETE FROM users;");
    const calls: SentCall[] = [];
    const result = await broadcastMessage(
      stubApi(calls),
      { text: "x" },
      { delayMs: 0 },
    );
    expect(result).toEqual({ total: 0, sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});
