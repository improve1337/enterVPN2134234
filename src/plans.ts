import type { Plan } from "./types.js";

export const PLANS: readonly Plan[] = [
  {
    code: "vpn_1m",
    name: "VPN · 1 месяц",
    priceRub: 130,
    days: 30,
    trafficGb: 100,
    deviceLimit: 5,
    description: "100 ГБ трафика, до 5 устройств",
    active: true,
  },
  {
    code: "vpn_3m",
    name: "VPN · 3 месяца",
    priceRub: 350,
    days: 90,
    trafficGb: 400,
    deviceLimit: 5,
    description: "400 ГБ трафика, до 5 устройств",
    active: true,
  },
] as const;

export const TRIAL = {
  days: 3,
  trafficGb: 10,
  deviceLimit: 5,
} as const;

export const getPlan = (code: string): Plan | undefined =>
  PLANS.find((plan) => plan.code === code && plan.active);

/** `null` — безлимитный трафик. */
export const trafficLabel = (gb: number | null): string =>
  gb === null ? "Безлимит" : `${gb} ГБ`;

export const planLabel = (plan: Plan): string =>
  `${plan.name} — ${plan.priceRub} ₽ / ${plan.days} дн · ${trafficLabel(plan.trafficGb)} · до ${plan.deviceLimit} устр.`;
