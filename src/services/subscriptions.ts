import {
  addDays,
  clearReferralBonusDays,
  getUser,
  markTrialUsed,
  saveSubscription,
  upsertUser,
} from "../db.js";
import { config } from "../config.js";
import { errorInfo, logger } from "../logger.js";
import { TRIAL, getPlan } from "../plans.js";
import type { Subscription } from "../types.js";
import { recordSubscriptionKey } from "./keys.js";
import { provisionSubscription } from "./provision.js";
import { rewardReferrer } from "./referrals.js";

export interface TrialOutcome {
  granted: boolean;
  reason?: "already_used" | "banned";
  subscription?: Subscription;
}

export async function startTrial(telegramId: number): Promise<TrialOutcome> {
  const user = getUser(telegramId);
  if (!user) throw new Error("Пользователь не найден");
  if (user.banned) return { granted: false, reason: "banned" };
  if (user.trialUsed) return { granted: false, reason: "already_used" };

  // Приглашённый по реферальной ссылке получает удлинённый пробный период.
  const trialDays =
    TRIAL.days + (user.referredBy ? config.referral.inviteeDays : 0);
  const result = await provisionSubscription({
    telegramId,
    username: user.username,
    previousMarzbanUsername: user.marzbanUsername,
    planCode: "trial",
    days: trialDays,
    trafficLimitGb: TRIAL.trafficGb,
  });
  markTrialUsed(telegramId);
  saveSubscription({
    telegramId,
    planCode: "trial",
    expiresAt: result.expiresAt,
    trafficLimitGb: result.trafficLimitGb,
    marzbanUsername: result.username,
    subscriptionUrl: result.subscriptionUrl,
  });
  const subscription: Subscription = {
    ...result,
    planCode: "trial",
    planName: "Пробный доступ",
  };
  recordSubscriptionKey({
    telegramId,
    planCode: "trial",
    planName: subscription.planName,
    days: trialDays,
    trafficLimitGb: TRIAL.trafficGb,
    subscription,
  });
  return {
    granted: true,
    subscription,
  };
}

export async function activatePlan(
  telegramId: number,
  planCode: string,
  options: { orderId?: string | null } = {},
): Promise<Subscription> {
  const plan = getPlan(planCode);
  if (!plan) throw new Error(`Неизвестный тариф: ${planCode}`);

  const user = getUser(telegramId);
  const currentExpiry = user?.subscriptionExpiresAt ?? null;
  // Отложенные реферальные дни добавляем к оплаченному тарифу.
  const bonusDays = user?.referralBonusDays ?? 0;
  const result = await provisionSubscription({
    telegramId,
    username: user?.username ?? null,
    previousMarzbanUsername: user?.marzbanUsername ?? null,
    planCode,
    days: plan.days + bonusDays,
    trafficLimitGb: plan.trafficGb,
    extendFrom: currentExpiry,
  });
  if (bonusDays > 0) clearReferralBonusDays(telegramId);
  saveSubscription({
    telegramId,
    planCode,
    expiresAt: result.expiresAt,
    trafficLimitGb: result.trafficLimitGb,
    marzbanUsername: result.username,
    subscriptionUrl: result.subscriptionUrl,
  });
  const subscription: Subscription = {
    ...result,
    planCode,
    planName: plan.name,
  };
  recordSubscriptionKey({
    telegramId,
    planCode,
    planName: plan.name,
    days: plan.days,
    trafficLimitGb: plan.trafficGb,
    subscription,
    orderId: options.orderId ?? null,
  });

  // Первая платная подписка приглашённого — награждаем того, кто его позвал.
  try {
    await rewardReferrer(telegramId);
  } catch (error) {
    logger.warn(
      { err: errorInfo(error), telegramId },
      "не удалось начислить реферальный бонус",
    );
  }
  return subscription;
}

/** Создать пользователя, если его ещё нет — вызывается на /start. */
export function ensureUser(input: {
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
}): void {
  upsertUser(input);
}

export { addDays };
