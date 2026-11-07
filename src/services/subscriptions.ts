import {
  addDays,
  getUser,
  markTrialUsed,
  saveSubscription,
  upsertUser,
} from "../db.js";
import { TRIAL, getPlan } from "../plans.js";
import type { Subscription } from "../types.js";
import { recordSubscriptionKey } from "./keys.js";
import { provisionSubscription } from "./provision.js";

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

  const result = await provisionSubscription({
    telegramId,
    username: user.username,
    previousMarzbanUsername: user.marzbanUsername,
    planCode: "trial",
    days: TRIAL.days,
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
    days: TRIAL.days,
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
  const result = await provisionSubscription({
    telegramId,
    username: user?.username ?? null,
    previousMarzbanUsername: user?.marzbanUsername ?? null,
    planCode,
    days: plan.days,
    trafficLimitGb: plan.trafficGb,
    extendFrom: currentExpiry,
  });
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
