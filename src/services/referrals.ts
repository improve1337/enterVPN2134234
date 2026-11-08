import { config } from "../config.js";
import {
  addReferralBonusDays,
  createReferral,
  getReferralByInvited,
  getUser,
  listReferralsByInviter,
  markReferralRewarded,
  saveSubscription,
  setReferredBy,
} from "../db.js";
import { errorInfo, logger } from "../logger.js";
import { getPlan } from "../plans.js";
import type { Subscription } from "../types.js";
import { recordSubscriptionKey } from "./keys.js";
import { provisionSubscription } from "./provision.js";

const DAY_MS = 86_400_000;

/** Человекочитаемое название тарифа по коду (для карточки ключа). */
const planLabel = (code: string | null): string => {
  if (!code) return "VPN";
  if (code === "trial") return "Пробный доступ";
  return getPlan(code)?.name ?? "VPN";
};

// --- Привязка ---

export type BindResult =
  | { ok: true; inviterId: number }
  | {
      ok: false;
      reason:
        | "disabled"
        | "self"
        | "unknown_inviter"
        | "unknown_user"
        | "already_referred"
        | "not_new_user";
    };

/**
 * Привязывает приглашённого к пригласившему по ссылке `?start=ref_<id>`.
 * Учитывается только «новый» пользователь — без активной подписки и без
 * использованного пробного доступа, и только один раз. Самоприглашение и
 * повторная привязка отбрасываются.
 */
export function bindReferral(input: {
  invitedId: number;
  inviterId: number;
}): BindResult {
  if (!config.referral.enabled) return { ok: false, reason: "disabled" };
  if (input.invitedId === input.inviterId) return { ok: false, reason: "self" };
  if (!getUser(input.inviterId)) return { ok: false, reason: "unknown_inviter" };

  const invited = getUser(input.invitedId);
  if (!invited) return { ok: false, reason: "unknown_user" };
  if (invited.referredBy !== null) {
    return { ok: false, reason: "already_referred" };
  }
  if (invited.trialUsed || invited.subscriptionExpiresAt) {
    return { ok: false, reason: "not_new_user" };
  }

  if (!setReferredBy(input.invitedId, input.inviterId)) {
    return { ok: false, reason: "already_referred" };
  }
  createReferral({
    inviterId: input.inviterId,
    invitedId: input.invitedId,
    bonusDays: config.referral.bonusDays,
  });
  return { ok: true, inviterId: input.inviterId };
}

// --- Награда ---

export interface RewardOutcome {
  rewarded: boolean;
  inviterId?: number;
  days?: number;
  /** `true` — дни сразу добавлены к активной подписке, `false` — отложены в запас. */
  appliedImmediately?: boolean;
}

/**
 * Начисляет пригласившему бонус, когда приглашённый впервые получает платную
 * подписку. Идемпотентно: повторный вызов для того же приглашённого ничего не
 * делает. Вызывается из активации тарифа, а не из пробного доступа.
 */
export async function rewardReferrer(invitedId: number): Promise<RewardOutcome> {
  if (!config.referral.enabled) return { rewarded: false };
  const referral = getReferralByInvited(invitedId);
  if (!referral || referral.status !== "pending") return { rewarded: false };

  const marked = markReferralRewarded(invitedId);
  if (!marked) return { rewarded: false };

  const appliedImmediately = await grantBonusDays(
    referral.inviterId,
    referral.bonusDays,
  );
  const outcome: RewardOutcome = {
    rewarded: true,
    inviterId: referral.inviterId,
    days: referral.bonusDays,
    appliedImmediately,
  };
  await notifyReward(outcome, invitedId);
  return outcome;
}

/**
 * Выдаёт бонусные дни пригласившему. Если у него активная подписка — продлевает
 * её сразу; иначе копит дни и применяет при следующей оплате.
 */
async function grantBonusDays(
  telegramId: number,
  days: number,
): Promise<boolean> {
  if (days <= 0) return false;
  const user = getUser(telegramId);
  if (!user) return false;

  const expiryMs = user.subscriptionExpiresAt
    ? new Date(user.subscriptionExpiresAt).getTime()
    : 0;
  const active = expiryMs > Date.now() && Boolean(user.marzbanUsername);
  if (!active) {
    addReferralBonusDays(telegramId, days);
    return false;
  }

  // Итоговый срок считаем сами: при продлении Marzban отсчитывает срок от
  // «сейчас», поэтому передаём суммарное число дней, а не только бонус.
  const remainingDays = Math.max(
    0,
    Math.ceil((expiryMs - Date.now()) / DAY_MS),
  );
  const totalDays = remainingDays + days;
  const planCode = user.planCode ?? "bonus";
  try {
    const result = await provisionSubscription({
      telegramId,
      username: user.username,
      previousMarzbanUsername: user.marzbanUsername,
      planCode,
      days: totalDays,
      trafficLimitGb: user.trafficLimitGb,
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
      planName: planLabel(user.planCode),
    };
    recordSubscriptionKey({
      telegramId,
      planCode,
      planName: subscription.planName,
      days: totalDays,
      trafficLimitGb: result.trafficLimitGb,
      subscription,
    });
    return true;
  } catch (error) {
    logger.warn(
      { err: errorInfo(error), telegramId, days },
      "не удалось продлить подписку за реферал — копим дни",
    );
    addReferralBonusDays(telegramId, days);
    return false;
  }
}

// --- Уведомление пригласившего ---

export type ReferralRewardNotifier = (info: {
  inviterId: number;
  invitedId: number;
  days: number;
  appliedImmediately: boolean;
}) => void | Promise<void>;

let rewardNotifier: ReferralRewardNotifier | null = null;

/**
 * Регистрирует отправку уведомления о награде. Бот подставляет сюда отправку
 * сообщения; в тестах уведомление не нужно и остаётся отключённым.
 */
export function setReferralRewardNotifier(
  notifier: ReferralRewardNotifier | null,
): void {
  rewardNotifier = notifier;
}

async function notifyReward(
  outcome: RewardOutcome,
  invitedId: number,
): Promise<void> {
  if (!rewardNotifier) return;
  if (outcome.inviterId === undefined || outcome.days === undefined) return;
  try {
    await rewardNotifier({
      inviterId: outcome.inviterId,
      invitedId,
      days: outcome.days,
      appliedImmediately: outcome.appliedImmediately ?? false,
    });
  } catch (error) {
    logger.warn(
      { err: errorInfo(error), inviterId: outcome.inviterId },
      "не удалось уведомить о реферальной награде",
    );
  }
}

// --- Статистика ---

export interface ReferralStats {
  /** Ссылка-приглашение; `null`, если не задан `BOT_USERNAME`. */
  link: string | null;
  invited: number;
  converted: number;
  pending: number;
  earnedDays: number;
  /** Отложенные дни, которые применятся при следующей оплате. */
  pendingDays: number;
  bonusDays: number;
  inviteeDays: number;
}

export function referralLink(telegramId: number): string | null {
  if (!config.botUsername) return null;
  return `https://t.me/${config.botUsername}?start=ref_${telegramId}`;
}

export function referralStats(telegramId: number): ReferralStats {
  const referrals = listReferralsByInviter(telegramId);
  const converted = referrals.filter((item) => item.status === "rewarded");
  const user = getUser(telegramId);
  return {
    link: referralLink(telegramId),
    invited: referrals.length,
    converted: converted.length,
    pending: referrals.length - converted.length,
    earnedDays: converted.reduce((sum, item) => sum + item.bonusDays, 0),
    pendingDays: user?.referralBonusDays ?? 0,
    bonusDays: config.referral.bonusDays,
    inviteeDays: config.referral.inviteeDays,
  };
}
