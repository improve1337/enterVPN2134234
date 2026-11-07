import { beforeEach, describe, expect, it } from "vitest";

import {
  createOrder,
  db,
  findUserByUsername,
  getKey as getKeyRow,
  getUser,
  initDatabase,
  listKeysByTarget,
  updateKeyRecord,
  upsertUser,
} from "../src/db.js";
import { getPlan } from "../src/plans.js";
import { fulfillPaidOrder } from "../src/services/fulfillment.js";
import {
  createKeys,
  generateKeyCode,
  getKey,
  issueKey,
  keysSummary,
  listKeysPage,
  normalizeUsername,
  resolvePendingKeys,
  revokeKey,
} from "../src/services/keys.js";
import { confirmPayment } from "../src/services/payments.js";

const USER = 200700;

beforeEach(() => {
  initDatabase();
  db.exec(
    "DELETE FROM orders; DELETE FROM users; DELETE FROM audit_log; DELETE FROM keys; DELETE FROM user_states;",
  );
  upsertUser({ telegramId: USER, username: "buyer", firstName: "Тест" });
});

describe("генерация кодов", () => {
  it("код соответствует формату и уникален", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const code = generateKeyCode();
      expect(code).toMatch(/^ENT-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(50);
  });

  it("нормализует @username", () => {
    expect(normalizeUsername("@Nick_Name")).toBe("nick_name");
    expect(normalizeUsername("  Nick  ")).toBe("nick");
  });
});

describe("создание ключей", () => {
  it("берёт срок и лимит из тарифа", () => {
    const plan = getPlan("vpn_3m");
    expect(plan).toBeDefined();
    const [key] = createKeys({ planCode: "vpn_3m", createdBy: 1 });
    expect(key).toBeDefined();
    expect(key?.status).toBe("new");
    expect(key?.days).toBe(plan?.days);
    expect(key?.trafficLimitGb).toBe(plan?.trafficGb);
    expect(key?.planName).toBe(plan?.name);
    expect(key?.createdBy).toBe(1);
  });

  it("создаёт пачку ключей", () => {
    const keys = createKeys({ planCode: "vpn_1m", createdBy: 1, count: 3 });
    expect(keys).toHaveLength(3);
    expect(new Set(keys.map((key) => key.code)).size).toBe(3);
  });

  it("неизвестный тариф бросает ошибку", () => {
    expect(() => createKeys({ planCode: "gold", createdBy: 1 })).toThrow(
      /Неизвестный тариф/,
    );
  });
});

describe("выдача ключа", () => {
  it("по Telegram ID активирует сразу", async () => {
    const [key] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    const result = await issueKey({
      code: key!.code,
      target: { telegramId: USER },
      actor: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending).toBe(false);
    expect(result.key.status).toBe("active");
    expect(result.key.marzbanUsername).toBe("buyer");
    expect(result.key.subscriptionUrl).toContain("buyer");
    expect(result.subscription?.expiresAt).toBe(result.key.expiresAt);

    const user = getUser(USER);
    expect(user?.planCode).toBe("vpn_1m");
    expect(user?.subscriptionUrl).toBe(result.key.subscriptionUrl);
  });

  it("по неизвестному @username ждёт получателя", async () => {
    const [key] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    const result = await issueKey({
      code: key!.code,
      target: { username: "@Future_User" },
      actor: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending).toBe(true);
    expect(result.key.status).toBe("issued");
    expect(result.key.targetUsername).toBe("future_user");
    expect(result.key.subscriptionUrl).toBeNull();
  });

  it("по известному @username активирует сразу", async () => {
    const [key] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    const result = await issueKey({
      code: key!.code,
      target: { username: "buyer" },
      actor: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending).toBe(false);
    expect(result.key.status).toBe("active");
  });

  it("удалённый ключ выдать нельзя", async () => {
    const [key] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    await revokeKey({ code: key!.code, actor: 1 });
    const result = await issueKey({
      code: key!.code,
      target: { telegramId: USER },
      actor: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("неизвестный код не выдаётся", async () => {
    const result = await issueKey({
      code: "ENT-XXXX-XXXX",
      target: { telegramId: USER },
      actor: 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("привязка по @username", () => {
  it("активируется, когда получатель появляется в боте", async () => {
    const [key] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    await issueKey({
      code: key!.code,
      target: { username: "@future_user" },
      actor: 1,
    });

    const newUser = 300800;
    upsertUser({ telegramId: newUser, username: "future_user" });
    const bound = await resolvePendingKeys({
      telegramId: newUser,
      username: "future_user",
    });

    expect(bound).toHaveLength(1);
    expect(bound[0]?.status).toBe("active");
    expect(bound[0]?.targetTelegramId).toBe(newUser);
    expect(getUser(newUser)?.subscriptionUrl).toContain("future_user");
    expect(findUserByUsername("future_user")?.telegramId).toBe(newUser);
  });
});

describe("отзыв ключа", () => {
  it("удаляет ключ, выключает доступ и обнуляет срок подписки", async () => {
    const [key] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    await issueKey({ code: key!.code, target: { telegramId: USER }, actor: 1 });

    const result = await revokeKey({ code: key!.code, actor: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Возвращается снимок ключа, а из базы запись уже удалена.
    expect(result.key.status).toBe("active");
    expect(result.disabledAccess).toBe(true);
    expect(getKey(key!.code)).toBeUndefined();
    expect(listKeysByTarget(USER)).toHaveLength(0);

    const expires = getUser(USER)?.subscriptionExpiresAt;
    expect(expires).toBeDefined();
    expect(new Date(expires as string).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("оставляет доступ, если есть другой активный ключ", async () => {
    const [first] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    const [second] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    await issueKey({ code: first!.code, target: { telegramId: USER }, actor: 1 });
    await issueKey({ code: second!.code, target: { telegramId: USER }, actor: 1 });

    const result = await revokeKey({ code: first!.code, actor: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disabledAccess).toBe(false);
    expect(getKey(second!.code)?.status).toBe("active");
  });

  it("повторный отзыв не проходит", async () => {
    const [key] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    await revokeKey({ code: key!.code, actor: 1 });
    const again = await revokeKey({ code: key!.code, actor: 1 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("not_found");
  });
});

describe("ключ из оплаты", () => {
  it("создаётся один раз и продлевается повторной покупкой", async () => {
    createOrder({
      id: "key-order-1",
      telegramId: USER,
      planCode: "vpn_1m",
      amountRub: 130,
      provider: "mock",
    });
    confirmPayment({ orderId: "key-order-1" });
    const first = await fulfillPaidOrder("key-order-1");
    expect(first.ok).toBe(true);

    const keys = listKeysByTarget(USER);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.status).toBe("active");
    expect(keys[0]?.orderId).toBe("key-order-1");
    expect(keys[0]?.planCode).toBe("vpn_1m");
    const firstExpiry = keys[0]?.expiresAt;

    createOrder({
      id: "key-order-2",
      telegramId: USER,
      planCode: "vpn_1m",
      amountRub: 130,
      provider: "mock",
    });
    confirmPayment({ orderId: "key-order-2" });
    const second = await fulfillPaidOrder("key-order-2");
    expect(second.ok).toBe(true);

    const after = listKeysByTarget(USER);
    expect(after).toHaveLength(1);
    expect(after[0]?.orderId).toBe("key-order-2");
    expect(
      new Date(after[0]?.expiresAt as string).getTime(),
    ).toBeGreaterThan(new Date(firstExpiry as string).getTime());
  });
});

describe("список и статусы", () => {
  it("пагинация и счётчики", () => {
    createKeys({ planCode: "vpn_1m", createdBy: 1, count: 7 });
    const page = listKeysPage(0, 5);
    expect(page.total).toBe(7);
    expect(page.pages).toBe(2);
    expect(page.items).toHaveLength(5);
    const last = listKeysPage(1, 5);
    expect(last.items).toHaveLength(2);

    const summary = keysSummary();
    expect(summary.total).toBe(7);
    expect(summary.fresh).toBe(7);
  });

  it("истёкший ключ помечается expired при чтении", () => {
    const [key] = createKeys({ planCode: "vpn_1m", createdBy: 1 });
    const past = new Date(Date.now() - 86_400_000).toISOString();
    updateKeyRecord(key!.code, { status: "active", expiresAt: past });
    expect(getKey(key!.code)?.status).toBe("expired");
    expect(getKeyRow(key!.code)?.status).toBe("expired");
  });
});
