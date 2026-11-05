#!/usr/bin/env node
/**
 * Останавливает запущенного бота: `npm run stop` (или `npm stop`).
 *
 * Читает PID-файл рядом с базой, который пишет `src/pid.ts`. Если бот запущен
 * через `tsx watch`/`npm`, останавливается и процесс-обёртка, иначе она
 * перезапустит бота сразу после выхода.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

loadEnv();

const databasePath = process.env.DATABASE_PATH ?? "./data/bot.db";
const pidFile = join(dirname(databasePath), "bot.pid");

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Имя процесса: node.exe / npm.cmd / bash и т.п. Пустая строка, если неизвестно. */
const processName = (pid) => {
  try {
    if (process.platform === "win32") {
      const res = spawnSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8" },
      );
      const line = (res.stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
      const match = line.match(/^"([^"]+)"/);
      return match ? match[1] : "";
    }
    const res = spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
    });
    return (res.stdout ?? "").trim();
  } catch {
    return "";
  }
};

const isNodeLike = (name) => /^(node|npm|npx|tsx|ts-node)/i.test(name);

const killTree = (pid) => {
  if (process.platform === "win32") {
    const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "inherit",
    });
    return res.status === 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  return true;
};

if (!existsSync(pidFile)) {
  console.log(`Бот не запущен: файл ${pidFile} не найден.`);
  process.exit(0);
}

let record;
try {
  record = JSON.parse(readFileSync(pidFile, "utf8"));
} catch {
  console.error(`Не удалось прочитать ${pidFile}. Удаляю файл.`);
  rmSync(pidFile, { force: true });
  process.exit(1);
}

const pid = Number(record?.pid);
const ppid = Number(record?.ppid);

if (!Number.isInteger(pid) || pid <= 0) {
  console.error(`Некорректный PID в ${pidFile}. Удаляю файл.`);
  rmSync(pidFile, { force: true });
  process.exit(1);
}

if (!isAlive(pid)) {
  console.log(`Процесс ${pid} уже не работает. Удаляю ${pidFile}.`);
  rmSync(pidFile, { force: true });
  process.exit(0);
}

const ownName = processName(pid);
if (ownName && !isNodeLike(ownName)) {
  console.error(
    `PID ${pid} занят другим процессом (${ownName}) — не трогаю его. Удаляю ${pidFile}.`,
  );
  rmSync(pidFile, { force: true });
  process.exit(1);
}

// Обёртка (tsx watch / npm) перезапустила бы бота, поэтому гасим и её.
let target = pid;
if (Number.isInteger(ppid) && ppid > 0 && ppid !== pid && isAlive(ppid)) {
  const parentName = processName(ppid);
  if (isNodeLike(parentName)) {
    target = ppid;
  }
}

console.log(
  target === pid
    ? `Останавливаю PID ${pid}...`
    : `Останавливаю PID ${target} (обёртка) вместе с ботом PID ${pid}...`,
);
const ok = killTree(target);

rmSync(pidFile, { force: true });

if (!ok) {
  console.error("Не удалось остановить процесс.");
  process.exit(1);
}

console.log("Бот остановлен.");
