import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";

/**
 * PID-файл рядом с базой. Родительский PID нужен, чтобы `npm run stop`
 * остановил и обёртку (`tsx watch` / `npm`), иначе она перезапустит бота.
 */
export interface PidRecord {
  pid: number;
  ppid: number;
}

export const pidFilePath = (): string =>
  join(dirname(config.databasePath), "bot.pid");

export function writePidFile(): void {
  mkdirSync(dirname(pidFilePath()), { recursive: true });
  const record: PidRecord = { pid: process.pid, ppid: process.ppid };
  writeFileSync(pidFilePath(), JSON.stringify(record), "utf8");
}

export function removePidFile(): void {
  rmSync(pidFilePath(), { force: true });
}
