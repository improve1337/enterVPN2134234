import { getSetting, setSetting } from "../db.js";

const PAYMENTS_KEY = "payments_enabled";

/**
 * Включена ли оплата. По умолчанию — нет: пока платёжка не подключена, доступ
 * выдаётся по заявке, которую админ обрабатывает вручную.
 */
export const isPaymentsEnabled = (): boolean =>
  getSetting(PAYMENTS_KEY) === "true";

export const setPaymentsEnabled = (enabled: boolean): void =>
  setSetting(PAYMENTS_KEY, enabled ? "true" : "false");
