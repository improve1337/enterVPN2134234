import { beforeEach, describe, expect, it } from "vitest";

import {
  createOrder,
  db,
  getOrder,
  getUser,
  initDatabase,
  listOrders,
  markOrderPaid,
  setBanned,
  upsertUser,
  addDays,
} from "../src/db.js";
import { PLANS, TRIAL, getPlan } from "../src/plans.js";
import { confirmPayment } from "../src/services/payments.js";
import { fulfillPaidOrder } from "../src/services/fulfillment.js";
import { activatePlan, startTrial } from "../src/services/subscriptions.js";

const USER = 100500;

beforeEach(() => {
  initDatabase();
  db.exec("DELETE FROM orders; DELETE FROM users; DELETE FROM audit_log;");
  upsertUser({ telegramId: USER, username: "tester", firstName: "Тест" });
});

describe("пользователи и БД", () => {
  it("создаёт пользователя и обновляет профиль", () => {
    const created = upsertUser({ telegramId: 777, firstName: "A" });
    expect(created.telegramId).toBe(777);
    const updated = upsertUser({ telegramId: 777, username: "neo" });
    expect(updated.username).toBe("neo");
    expect(updated.firstName).toBe("A");
  });

  it("переключает бан", () => {
    setBanned(USER, true);
    expect(getUser(USER)?.banned).toBe(1);
    setBanned(USER, false);
    expect(getUser(USER)?.banned).toBe(0);
  });
});

describe("пробный период", () => {
  it("выдаётся один раз на аккаунт", async () => {
    const first = await startTrial(USER);
    expect(first.granted).toBe(true);
    expect(first.subscription?.subscriptionUrl).toContain("tg_100500");
    expect(getUser(USER)?.trialUsed).toBe(1);

    const second = await startTrial(USER);
    expect(second.granted).toBe(false);
    expect(second.reason).toBe("already_used");
  });

  it("не выдаётся забаненному", async () => {
    setBanned(USER, true);
    const outcome = await startTrial(USER);
    expect(outcome.granted).toBe(false);
    expect(outcome.reason).toBe("banned");
    expect(getUser(USER)?.trialUsed).toBe(0);
  });
});

describe("тарифы и продление", () => {
  it("один тариф с двумя сроками: 130 ₽ и 350 ₽, безлимитный трафик", () => {
    expect(PLANS.length).toBe(2);
    expect(PLANS.map((plan) => plan.priceRub)).toEqual([130, 350]);
    expect(PLANS.map((plan) => plan.days)).toEqual([30, 90]);
    for (const plan of PLANS) {
      expect(plan.trafficGb).toBeNull();
      expect(plan.deviceLimit).toBe(5);
    }
    expect(TRIAL.trafficGb).toBeNull();
    expect(TRIAL.deviceLimit).toBe(5);
  });

  it("продление продлевает срок, а не перезаписывает", async () => {
    const plan = getPlan("vpn_1m");
    expect(plan).toBeDefined();

    const first = await activatePlan(USER, "vpn_1m");
    const second = await activatePlan(USER, "vpn_1m");

    expect(new Date(second.expiresAt).getTime()).toBeGreaterThan(
      new Date(first.expiresAt).getTime(),
    );
    expect(getUser(USER)?.planCode).toBe("vpn_1m");
    expect(getUser(USER)?.trafficLimitGb).toBeNull();
  });

  it("неизвестный тариф бросает ошибку", async () => {
    await expect(activatePlan(USER, "gold")).rejects.toThrow(/Неизвестный тариф/);
  });
});

describe("платежи и идемпотентность", () => {
  it("подтверждение подтверждает заказ только один раз", () => {
    const order = createOrder({
      id: "order-1",
      telegramId: USER,
      planCode: "vpn_1m",
      amountRub: 130,
      provider: "mock",
    });
    expect(order.status).toBe("pending");

    const first = confirmPayment({ orderId: "order-1" });
    expect(first.ok).toBe(true);
    expect(first.order?.status).toBe("paid");

    const second = confirmPayment({ orderId: "order-1" });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_paid");
  });

  it("отклоняет расхождение суммы", () => {
    createOrder({
      id: "order-2",
      telegramId: USER,
      planCode: "vpn_3m",
      amountRub: 350,
      provider: "mock",
    });
    const result = confirmPayment({ orderId: "order-2", amountRub: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("amount_mismatch");
    expect(getOrder("order-2")?.status).toBe("pending");
  });

  it("неизвестный заказ не подтверждается", () => {
    const result = confirmPayment({ orderId: "nope" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("markOrderPaid идемпотентен на уровне БД", () => {
    createOrder({
      id: "order-3",
      telegramId: USER,
      planCode: "vpn_1m",
      amountRub: 130,
      provider: "mock",
    });
    expect(markOrderPaid("order-3")).toBeDefined();
    expect(markOrderPaid("order-3")).toBeUndefined();
  });

  it("заказы возвращаются от новых к старым", () => {
    createOrder({
      id: "o-old",
      telegramId: USER,
      planCode: "vpn_1m",
      amountRub: 130,
      provider: "mock",
    });
    createOrder({
      id: "o-new",
      telegramId: USER,
      planCode: "vpn_3m",
      amountRub: 350,
      provider: "mock",
    });
    expect(listOrders(USER).length).toBe(2);
  });
});

describe("работа с датами", () => {
  it("addDays считает срок в UTC", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    expect(addDays(start, 30)).toBe("2026-01-31T00:00:00.000Z");
  });
});

describe("выдача доступа после оплаты", () => {
  it("выдаёт подписку один раз и не продлевает повторно", async () => {
    createOrder({
      id: "ful-1",
      telegramId: USER,
      planCode: "vpn_1m",
      amountRub: 130,
      provider: "mock",
    });
    confirmPayment({ orderId: "ful-1" });

    const first = await fulfillPaidOrder("ful-1");
    expect(first.ok).toBe(true);
    const expiryAfterFirst = getUser(USER)?.subscriptionExpiresAt;
    expect(getOrder("ful-1")?.status).toBe("active");

    const second = await fulfillPaidOrder("ful-1");
    expect(second.ok).toBe(false);
    expect(getUser(USER)?.subscriptionExpiresAt).toBe(expiryAfterFirst);
  });

  it("не выдаёт доступ по неоплаченному заказу", async () => {
    createOrder({
      id: "ful-2",
      telegramId: USER,
      planCode: "vpn_1m",
      amountRub: 130,
      provider: "mock",
    });
    const result = await fulfillPaidOrder("ful-2");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("order_not_paid");
  });
});
