import { beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { db, getUser, initDatabase, upsertUser } from "../src/db.js";
import {
  bindReferral,
  referralStats,
  rewardReferrer,
} from "../src/services/referrals.js";
import { activatePlan, startTrial } from "../src/services/subscriptions.js";

const INVITER = 500100;
const INVITED = 500200;

const daysUntil = (iso: string): number =>
  (new Date(iso).getTime() - Date.now()) / 86_400_000;

beforeEach(() => {
  initDatabase();
  db.exec(
    "DELETE FROM referrals; DELETE FROM orders; DELETE FROM users; DELETE FROM audit_log; DELETE FROM keys; DELETE FROM user_states;",
  );
  upsertUser({ telegramId: INVITER, username: "inviter", firstName: "Инвайтер" });
  upsertUser({ telegramId: INVITED, username: "invited", firstName: "Друг" });
});

describe("привязка реферала", () => {
  it("привязывает нового пользователя к пригласившему", () => {
    const result = bindReferral({ invitedId: INVITED, inviterId: INVITER });
    expect(result.ok).toBe(true);
    expect(getUser(INVITED)?.referredBy).toBe(INVITER);
  });

  it("самоприглашение отбрасывается", () => {
    const result = bindReferral({ invitedId: INVITER, inviterId: INVITER });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("self");
  });

  it("незнакомый пригласивший не принимается", () => {
    const result = bindReferral({ invitedId: INVITED, inviterId: 123456 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_inviter");
    expect(getUser(INVITED)?.referredBy).toBeNull();
  });

  it("повторная привязка не проходит", () => {
    bindReferral({ invitedId: INVITED, inviterId: INVITER });
    upsertUser({ telegramId: 777777, username: "other" });
    const again = bindReferral({ invitedId: INVITED, inviterId: 777777 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("already_referred");
    expect(getUser(INVITED)?.referredBy).toBe(INVITER);
  });

  it("пользователь с использованным пробным не считается новым", async () => {
    await startTrial(INVITED);
    const result = bindReferral({ invitedId: INVITED, inviterId: INVITER });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_new_user");
  });
});

describe("пробный период приглашённого", () => {
  it("продлевается на бонусные дни", async () => {
    bindReferral({ invitedId: INVITED, inviterId: INVITER });
    const outcome = await startTrial(INVITED);
    expect(outcome.granted).toBe(true);
    const expires = outcome.subscription?.expiresAt;
    expect(expires).toBeDefined();
    expect(daysUntil(expires as string)).toBeCloseTo(
      3 + config.referral.inviteeDays,
      0,
    );
  });
});

describe("награда пригласившему", () => {
  it("начисляется после первой платной подписки приглашённого", async () => {
    bindReferral({ invitedId: INVITED, inviterId: INVITER });
    await activatePlan(INVITED, "vpn_1m");

    expect(getUser(INVITER)?.referralBonusDays).toBe(config.referral.bonusDays);
    const stats = referralStats(INVITER);
    expect(stats.invited).toBe(1);
    expect(stats.converted).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.earnedDays).toBe(config.referral.bonusDays);
  });

  it("не начисляется дважды за одного приглашённого", async () => {
    bindReferral({ invitedId: INVITED, inviterId: INVITER });
    await activatePlan(INVITED, "vpn_1m");
    await activatePlan(INVITED, "vpn_1m");
    expect(getUser(INVITER)?.referralBonusDays).toBe(config.referral.bonusDays);
  });

  it("rewardReferrer идемпотентен", async () => {
    bindReferral({ invitedId: INVITED, inviterId: INVITER });
    const first = await rewardReferrer(INVITED);
    expect(first.rewarded).toBe(true);
    const second = await rewardReferrer(INVITED);
    expect(second.rewarded).toBe(false);
  });

  it("без привязки награда не начисляется", async () => {
    const outcome = await rewardReferrer(INVITED);
    expect(outcome.rewarded).toBe(false);
    expect(getUser(INVITER)?.referralBonusDays).toBe(0);
  });
});

describe("применение бонуса", () => {
  it("запасённые дни добавляются к следующей подписке пригласившего", async () => {
    bindReferral({ invitedId: INVITED, inviterId: INVITER });
    await activatePlan(INVITED, "vpn_1m");
    expect(getUser(INVITER)?.referralBonusDays).toBe(config.referral.bonusDays);

    const subscription = await activatePlan(INVITER, "vpn_1m");
    expect(daysUntil(subscription.expiresAt)).toBeCloseTo(
      30 + config.referral.bonusDays,
      0,
    );
    expect(getUser(INVITER)?.referralBonusDays).toBe(0);
  });

  it("при активной подписке пригласившего дни добавляются сразу", async () => {
    await activatePlan(INVITER, "vpn_1m");
    const before = getUser(INVITER)?.subscriptionExpiresAt as string;

    bindReferral({ invitedId: INVITED, inviterId: INVITER });
    await activatePlan(INVITED, "vpn_1m");

    const after = getUser(INVITER)?.subscriptionExpiresAt as string;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(daysUntil(after)).toBeCloseTo(30 + config.referral.bonusDays, 0);
    expect(getUser(INVITER)?.referralBonusDays).toBe(0);
  });
});

describe("статистика", () => {
  it("считает приглашённых и ожидающих", () => {
    bindReferral({ invitedId: INVITED, inviterId: INVITER });
    const stats = referralStats(INVITER);
    expect(stats.invited).toBe(1);
    expect(stats.converted).toBe(0);
    expect(stats.pending).toBe(1);
    expect(stats.bonusDays).toBe(config.referral.bonusDays);
  });
});
