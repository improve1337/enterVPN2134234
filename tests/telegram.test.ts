import { describe, expect, it } from "vitest";

import { errorInfo, sanitize } from "../src/logger.js";
import { createTelegramAgent } from "../src/telegram.js";

describe("sanitize", () => {
  it("вырезает токен бота из строки", () => {
    const text =
      "request to https://api.telegram.org/bot1234567890:AAFakeTokenForTestsOnly0000000000/getMe failed";
    const result = sanitize(text);
    expect(result).not.toContain("AAFakeTokenForTestsOnly0000000000");
    expect(result).toContain("bot<redacted>");
  });

  it("не трогает строки без токена", () => {
    expect(sanitize("обычное сообщение")).toBe("обычное сообщение");
  });
});

describe("errorInfo", () => {
  it("собирает сообщения по цепочке error/cause и скрывает токен", () => {
    const inner = Object.assign(
      new Error("connect ETIMEDOUT 149.154.166.110:443"),
      { code: "ETIMEDOUT" },
    );
    const outer = Object.assign(
      new Error(
        "request to https://api.telegram.org/bot123456:AAsecretTOKENvalue/deleteWebhook failed",
      ),
      { error: inner },
    );

    const info = errorInfo(outer);
    expect(info.code).toBe("ETIMEDOUT");
    expect(info.message).toContain("ETIMEDOUT 149.154.166.110:443");
    expect(info.message).not.toContain("AAsecretTOKENvalue");
    expect(info.message).toContain("bot<redacted>");
  });

  it("не зацикливается на циклической ссылке", () => {
    const a: { message: string; cause?: unknown } = { message: "a" };
    a.cause = a;
    const info = errorInfo(a);
    expect(info.message).toContain("a");
  });

  it("переживает не-Error значения", () => {
    expect(errorInfo("просто строка").message).toBe("просто строка");
    expect(errorInfo(undefined).name).toBe("Error");
  });
});

describe("createTelegramAgent", () => {
  it("создаёт агент для socks5", () => {
    const agent = createTelegramAgent("socks5://127.0.0.1:1080");
    expect(agent).toBeDefined();
  });

  it("создаёт агент для http-прокси", () => {
    const agent = createTelegramAgent("http://user:pass@127.0.0.1:8080");
    expect(agent).toBeDefined();
  });

  it("отклоняет неподдерживаемую схему", () => {
    expect(() => createTelegramAgent("ftp://127.0.0.1:21")).toThrow(
      /Неподдерживаемая схема/,
    );
  });

  it("отклоняет мусорный url", () => {
    expect(() => createTelegramAgent("не url")).toThrow(/неверный формат/);
  });
});
