/**
 * Рендер аватарок бота EnterVPN и бота поддержки по ТЗ (пикчи/АВАТАРКА-ТЗ.md):
 *   - пикчи/аватар.png (1024×1024, без прозрачности)
 *   - пикчи/аватар-640.png (640×640, для BotFather /setuserpic)
 *   - пикчи/аватар-поддержка.png (1024×1024, для @EnterseviceSupport_bot)
 *   - пикчи/аватар-превью.png (1200×400, проверка в кругах 512 / 160 / 64 / 40 px на тёмном и светлом фоне)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");
const require = createRequire(resolve(rootDir, "site/package.json"));
const sharp = require("sharp");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome/Edge не найден — укажите CHROME_PATH");
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "entervpn-avatar-"));
  const proc = spawn(
    findChrome(),
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--allow-file-access-from-files",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(120);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {
      /* ждём запуска */
    }
  }
  if (!wsUrl) throw new Error("Не удалось подключиться к Chrome DevTools");

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      listeners.get(msg.method).forEach((fn) => fn(msg.params));
      listeners.delete(msg.method);
    }
  };

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const msgId = ++id;
      pending.set(msgId, { res, rej });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const once = (method) =>
    new Promise((res) => {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(res);
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "JS error");
    return r.result.value;
  };
  const close = () => {
    try { ws.close(); } catch { /* noop */ }
    proc.kill();
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ } }, 800);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  return { send, once, evaluate, close };
}

async function captureVariant(cdp, variant) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 1024,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const url = `${pathToFileURL(join(__dirname, "avatar.html")).href}?variant=${variant}`;
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
  await cdp.evaluate("document.fonts.ready.then(() => true)");
  await cdp.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  return Buffer.from(data, "base64");
}

/** Вырезает круглую маску заданного диаметра D из буфера 1024×1024 */
async function makeCircleCrop(pngBuffer, d) {
  const resized = await sharp(pngBuffer)
    .resize(d, d, { kernel: "lanczos3" })
    .ensureAlpha()
    .toBuffer();

  const circleSvg = Buffer.from(
    `<svg width="${d}" height="${d}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#ffffff"/>
    </svg>`,
  );

  return sharp(resized)
    .composite([{ input: circleSvg, blend: "dest-in" }])
    .png()
    .toBuffer();
}

/**
 * Собирает контрольный лист 1200×400:
 * слева (600×400) — тёмный фон Telegram (#0E141F) с кругами 512 (масштабирован в 260), 160, 64, 40 px;
 * справа (600×400) — светлый фон Telegram (#F4F6F9) с кругами + вариантом поддержки.
 */
async function buildPreviewSheet(mainBuf, supBuf) {
  const W = 1200;
  const H = 400;

  const bgSvg = Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <!-- Тёмная панель слева -->
      <rect x="0" y="0" width="660" height="${H}" fill="#090D14"/>
      <line x1="660" y1="0" x2="660" y2="${H}" stroke="#1E293B" stroke-width="1"/>
      <!-- Светлая панель справа -->
      <rect x="660" y="0" width="540" height="${H}" fill="#F3F6FA"/>

      <!-- Подписи секций -->
      <text x="36" y="34" fill="#94A1B5" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="13" letter-spacing="0.5">DARK MODE · TELEGRAM CIRCLE MASK (512 / 160 / 64 / 40 PX)</text>
      <text x="692" y="34" fill="#4B5565" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="13" letter-spacing="0.5">LIGHT MODE + SUPPORT BOT VARIANT</text>

      <!-- Подписи размеров слева -->
      <text x="166" y="366" text-anchor="middle" fill="#64748B" font-family="Consolas, monospace" font-size="12">Main · 512px (scaled)</text>
      <text x="404" y="294" text-anchor="middle" fill="#64748B" font-family="Consolas, monospace" font-size="12">160px</text>
      <text x="536" y="246" text-anchor="middle" fill="#64748B" font-family="Consolas, monospace" font-size="12">64px</text>
      <text x="608" y="234" text-anchor="middle" fill="#64748B" font-family="Consolas, monospace" font-size="12">40px</text>

      <!-- Подписи справа -->
      <text x="790" y="314" text-anchor="middle" fill="#64748B" font-family="Consolas, monospace" font-size="12">Main · 160px</text>
      <text x="932" y="246" text-anchor="middle" fill="#64748B" font-family="Consolas, monospace" font-size="12">64px</text>
      <text x="1002" y="234" text-anchor="middle" fill="#64748B" font-family="Consolas, monospace" font-size="12">40px</text>
      <text x="1110" y="314" text-anchor="middle" fill="#64748B" font-family="Consolas, monospace" font-size="12">Support · 128px</text>
    </svg>
  `);

  // Генерируем 512px круг и уменьшаем до 260px для размещения на холсте 400px высотой
  const c512 = await sharp(await makeCircleCrop(mainBuf, 512)).resize(260, 260, { kernel: "lanczos3" }).png().toBuffer();
  const c160 = await makeCircleCrop(mainBuf, 160);
  const c64 = await makeCircleCrop(mainBuf, 64);
  const c40 = await makeCircleCrop(mainBuf, 40);
  const sup128 = await makeCircleCrop(supBuf, 128);

  return sharp(bgSvg)
    .composite([
      // Левая тёмная половина
      { input: c512, left: 36, top: 74 },
      { input: c160, left: 324, top: 108 },
      { input: c64, left: 504, top: 156 },
      { input: c40, left: 588, top: 168 },
      // Правая светлая половина
      { input: c160, left: 710, top: 124 },
      { input: c64, left: 900, top: 156 },
      { input: c40, left: 982, top: 168 },
      { input: sup128, left: 1046, top: 156 },
    ])
    .flatten({ background: "#090D14" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function saveFile(relPath, buf) {
  const full = resolve(rootDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buf);
  console.log(`  → ${full} (${Math.round(buf.length / 1024)} KB)`);
}

async function main() {
  const cdp = await launchChrome();
  try {
    console.log("Рендер аватарок EnterVPN (iOS 18 Dark)...");
    const rawMain = await captureVariant(cdp, "main");
    const rawSup = await captureVariant(cdp, "support");

    // Без прозрачности (flatten на #04060B)
    const main1024 = await sharp(rawMain)
      .flatten({ background: "#04060B" })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const main640 = await sharp(main1024)
      .resize(640, 640, { kernel: "lanczos3" })
      .flatten({ background: "#04060B" })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const sup1024 = await sharp(rawSup)
      .flatten({ background: "#04060B" })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const sup640 = await sharp(sup1024)
      .resize(640, 640, { kernel: "lanczos3" })
      .flatten({ background: "#04060B" })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const preview = await buildPreviewSheet(main1024, sup1024);

    saveFile("пикчи/аватар.png", main1024);
    saveFile("пикчи/аватар-640.png", main640);
    saveFile("пикчи/аватар-поддержка.png", sup1024);
    saveFile("пикчи/аватар-поддержка-640.png", sup640);
    saveFile("пикчи/аватар-превью.png", preview);

    // Дублируем в bot/assets и supbot для удобства
    saveFile("bot/assets/avatar.png", main640);
    saveFile("supbot/avatar.png", sup640);
  } finally {
    cdp.close();
  }
  console.log("Готово!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
