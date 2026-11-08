import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      BOT_TOKEN: "123456:TEST-TOKEN",
      MOCK_MODE: "true",
      DATABASE_PATH: ":memory:",
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      COINSO_SECRET_KEY: "test-secret-key",
      COINSO_PROJECT_ID: "1",
    },
    pool: "forks",
  },
});
