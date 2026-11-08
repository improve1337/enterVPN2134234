import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  isCoinsoConfigured,
  verifyCoinsoSignature,
} from "../src/services/payments.js";

const SECRET = process.env.COINSO_SECRET_KEY as string;
const sign = (body: Buffer): string =>
  createHmac("sha256", SECRET).update(body).digest("hex");

describe("подпись вебхука Coinso", () => {
  const body = Buffer.from(
    JSON.stringify({ event: "payment.success", custom: "order-1" }),
  );

  it("принимает верную подпись", () => {
    expect(verifyCoinsoSignature(body, sign(body))).toBe(true);
  });

  it("отклоняет неверную или отсутствующую подпись", () => {
    expect(verifyCoinsoSignature(body, "deadbeef")).toBe(false);
    expect(verifyCoinsoSignature(body, undefined)).toBe(false);
    expect(verifyCoinsoSignature(body, "")).toBe(false);
  });

  it("подпись привязана к телу запроса", () => {
    const other = Buffer.from(JSON.stringify({ event: "payment.failed" }));
    expect(verifyCoinsoSignature(other, sign(body))).toBe(false);
  });

  it("Coinso считается настроенным при заданных ключах", () => {
    expect(isCoinsoConfigured()).toBe(true);
  });
});
