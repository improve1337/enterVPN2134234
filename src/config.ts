import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const boolFromString = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return def;
      const v = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) return true;
      if (["0", "false", "no", "off"].includes(v)) return false;
      return def;
    });

const csv = (value: string | undefined): number[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  BOT_TOKEN: z.string().min(10, "BOT_TOKEN is required"),
  BOT_USERNAME: z.string().default(""),
  BRAND_NAME: z.string().default("EnterVPN"),
  ADMIN_IDS: z.string().optional(),
  ADMIN_ID: z.string().optional(),
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_PATH: z.string().default("./data/bot.db"),
  BANNER_PATH: z.string().default("./assets/welcome.png"),
  PLANS_IMAGE_PATH: z.string().default("./assets/plans.png"),
  SUPPORT_IMAGE_PATH: z.string().default("./assets/support.png"),
  PUBLIC_URL: z.string().optional(),
  WEBHOOK_PATH: z.string().default("/telegram/webhook"),
  WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_PROXY: z.string().optional(),
  SUPPORT_URL: z.string().default("https://t.me/EnterseviceSupport_bot"),
  MOCK_MODE: boolFromString(true),
  // Демо-оплата: платёж эмулируется, но подписка выдаётся настоящая (Marzban).
  DEMO_PAYMENTS: boolFromString(false),
  MOCK_LANDING_URL: z.string().default("https://example.com"),
  KEY_CODE_PREFIX: z.string().default("ENT"),
  KEYS_PAGE_SIZE: z.coerce.number().int().min(1).max(20).default(5),
  MARZBAN_URL: z.string().default("http://127.0.0.1:8000"),
  MARZBAN_USERNAME: z.string().optional(),
  MARZBAN_PASSWORD: z.string().optional(),
  PLATEGA_MERCHANT_ID: z.string().optional(),
  PLATEGA_SECRET: z.string().optional(),
  // Coinso — криптопроцессинг (СБП, P2P, карты, крипта). Secret Key — он же
  // ключ подписи вебхука; project_id — числовой ID проекта из кабинета.
  COINSO_SECRET_KEY: z.string().optional(),
  COINSO_PROJECT_ID: z.coerce.number().int().positive().optional(),
  COINSO_API_URL: z.string().default("https://coinso.io"),
  // Создание счёта СБП по h2h у Coinso может занимать до 30 с.
  COINSO_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(40000),
  // Выдавать доступ по тестовым платежам Coinso. Только для локальной отладки:
  // в бою должно быть false, иначе при включённом тест-режиме раздашь подписки.
  COINSO_DELIVER_TEST: boolFromString(false),
  // Реферальная программа: ссылка вида ?start=ref_<telegramId>.
  REFERRAL_ENABLED: boolFromString(true),
  // Сколько дней получает пригласивший за друга, оформившего подписку.
  REFERRAL_BONUS_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  // Сколько дополнительных дней к пробному получает приглашённый.
  REFERRAL_INVITEE_DAYS: z.coerce.number().int().min(0).max(365).default(3),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Некорректная конфигурация окружения:\n${details}`);
}

const env = parsed.data;

const adminIds = Array.from(
  new Set([...csv(env.ADMIN_IDS), ...csv(env.ADMIN_ID)]),
);

export const config = {
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  botToken: env.BOT_TOKEN,
  brandName: env.BRAND_NAME,
  adminIds,
  mode: env.BOT_MODE,
  port: env.PORT,
  host: env.HOST,
  databasePath: env.DATABASE_PATH,
  bannerPath: env.BANNER_PATH,
  plansImagePath: env.PLANS_IMAGE_PATH,
  supportImagePath: env.SUPPORT_IMAGE_PATH,
  mockMode: env.MOCK_MODE,
  demoPayments: env.DEMO_PAYMENTS,
  publicUrl: env.PUBLIC_URL,
  webhookPath: env.WEBHOOK_PATH,
  webhookSecret: env.WEBHOOK_SECRET,
  telegramProxy: env.TELEGRAM_PROXY,
  supportUrl: env.SUPPORT_URL,
  marzban: {
    url: env.MARZBAN_URL,
    username: env.MARZBAN_USERNAME,
    password: env.MARZBAN_PASSWORD,
  },
  platega: {
    merchantId: env.PLATEGA_MERCHANT_ID,
    secret: env.PLATEGA_SECRET,
  },
  coinso: {
    secretKey: env.COINSO_SECRET_KEY,
    projectId: env.COINSO_PROJECT_ID,
    apiUrl: env.COINSO_API_URL.replace(/\/+$/, ""),
    timeoutMs: env.COINSO_TIMEOUT_MS,
    deliverTest: env.COINSO_DELIVER_TEST,
  },
  mockLandingUrl: env.MOCK_LANDING_URL,
  keyCodePrefix: env.KEY_CODE_PREFIX.trim().toUpperCase() || "ENT",
  keysPageSize: env.KEYS_PAGE_SIZE,
  botUsername: env.BOT_USERNAME,
  referral: {
    enabled: env.REFERRAL_ENABLED,
    bonusDays: env.REFERRAL_BONUS_DAYS,
    inviteeDays: env.REFERRAL_INVITEE_DAYS,
  },
} as const;
