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
  BANNER_PATH: z.string().default("./assets/banner.png"),
  PUBLIC_URL: z.string().optional(),
  WEBHOOK_PATH: z.string().default("/telegram/webhook"),
  WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_PROXY: z.string().optional(),
  SUPPORT_URL: z.string().default("https://t.me/EnterseviceSupport_bot"),
  MOCK_MODE: boolFromString(true),
  MOCK_LANDING_URL: z.string().default("https://example.com"),
  MARZBAN_URL: z.string().default("http://127.0.0.1:8000"),
  MARZBAN_USERNAME: z.string().optional(),
  MARZBAN_PASSWORD: z.string().optional(),
  PLATEGA_MERCHANT_ID: z.string().optional(),
  PLATEGA_SECRET: z.string().optional(),
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
  mockMode: env.MOCK_MODE,
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
  mockLandingUrl: env.MOCK_LANDING_URL,
  botUsername: env.BOT_USERNAME,
} as const;
