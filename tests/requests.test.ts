import { beforeEach, describe, expect, it } from "vitest";

import {
  db,
  getUser,
  initDatabase,
  listKeysByTarget,
  upsertUser,
} from "../src/db.js";
import {
  approveRequest,
  pendingRequests,
  pendingRequestsCount,
  rejectRequest,
  submitRequest,
} from "../src/services/requests.js";
import {
  isPaymentsEnabled,
  setPaymentsEnabled,
} from "../src/services/settings.js";
import { plansKeyboard } from "../src/ui/keyboards.js";

const USER = 400900;

beforeEach(() => {
  initDatabase();
  db.exec(
    "DELETE FROM orders; DELETE FROM users; DELETE FROM audit_log; DELETE FROM keys; DELETE FROM user_states; DELETE FROM requests; DELETE FROM settings;",
  );
  upsertUser({ telegramId: USER, username: "requester", firstName: "Тест" });
});

describe("кнопки тарифов", () => {
  const callbackData = (paymentsEnabled: boolean): string[] =>
    plansKeyboard(paymentsEnabled)
      .inline_keyboard.flat()
      .map((button) => button.callback_data ?? "");

  it("заявка не конфликтует с одобрением и отклонением", () => {
    const data = callbackData(false);
    expect(data.length).toBeGreaterThan(0);
    for (const value of data) {
      expect(value.startsWith("req:plan:")).toBe(true);
      expect(value.startsWith("req:ok:")).toBe(false);
      expect(value.startsWith("req:no:")).toBe(false);
    }
  });

  it("при включённой оплате кнопки ведут на покупку", () => {
    const data = callbackData(true);
    expect(data.length).toBeGreaterThan(0);
    for (const value of data) expect(value.startsWith("buy:")).toBe(true);
  });
});

describe("оплата: переключатель", () => {
  it("по умолчанию выключена", () => {
    expect(isPaymentsEnabled()).toBe(false);
  });

  it("включается и выключается", () => {
    setPaymentsEnabled(true);
    expect(isPaymentsEnabled()).toBe(true);
    setPaymentsEnabled(false);
    expect(isPaymentsEnabled()).toBe(false);
  });
});

describe("заявки на подписку", () => {
  it("создаётся и попадает в список", () => {
    const result = submitRequest({
      telegramId: USER,
      username: "requester",
      planCode: "vpn_1m",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe("pending");
    expect(result.request.username).toBe("requester");
    expect(pendingRequestsCount()).toBe(1);
    expect(pendingRequests()[0]?.planCode).toBe("vpn_1m");
  });

  it("повторная заявка не создаётся", () => {
    submitRequest({ telegramId: USER, planCode: "vpn_1m" });
    const second = submitRequest({ telegramId: USER, planCode: "vpn_3m" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("already_pending");
    expect(pendingRequestsCount()).toBe(1);
  });

  it("неизвестный тариф не принимается", () => {
    const result = submitRequest({ telegramId: USER, planCode: "gold" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_plan");
    expect(pendingRequestsCount()).toBe(0);
  });

  it("одобрение выдаёт подписку и ключ", async () => {
    const created = submitRequest({ telegramId: USER, planCode: "vpn_1m" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const approved = await approveRequest({ id: created.request.id, actor: 1 });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    expect(approved.subscription.subscriptionUrl).toContain("requester");
    expect(getUser(USER)?.planCode).toBe("vpn_1m");
    expect(getUser(USER)?.trafficLimitGb).toBe(100);
    expect(listKeysByTarget(USER)).toHaveLength(1);
    expect(pendingRequestsCount()).toBe(0);
  });

  it("повторное одобрение не проходит", async () => {
    const created = submitRequest({ telegramId: USER, planCode: "vpn_1m" });
    if (!created.ok) return;
    await approveRequest({ id: created.request.id, actor: 1 });
    const again = await approveRequest({ id: created.request.id, actor: 1 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("already_resolved");
  });

  it("отклонение закрывает заявку без выдачи", () => {
    const created = submitRequest({ telegramId: USER, planCode: "vpn_3m" });
    if (!created.ok) return;

    const rejected = rejectRequest({ id: created.request.id, actor: 1 });
    expect(rejected.ok).toBe(true);
    expect(pendingRequestsCount()).toBe(0);
    expect(getUser(USER)?.planCode).toBeNull();
    expect(listKeysByTarget(USER)).toHaveLength(0);
  });

  it("неизвестная заявка не одобряется и не отклоняется", async () => {
    const approved = await approveRequest({ id: "nope", actor: 1 });
    expect(approved.ok).toBe(false);
    const rejected = rejectRequest({ id: "nope", actor: 1 });
    expect(rejected.ok).toBe(false);
  });
});
