/**
 * Рендер моушен-обложек EnterVPN (iOS 18 style) в GIF + статичный PNG.
 *
 * Как работает: поднимает headless Chrome, открывает scenes.html, по таймлайну
 * вызывает window.renderAt(t) и снимает кадры через Chrome DevTools Protocol
 * (без puppeteer — встроенный в Node WebSocket). Кадры собираются в GIF через sharp.
 *
 *   node scripts/motion/render.mjs                    # все сцены → в bot/assets, пикчи, supbot
 *   node scripts/motion/render.mjs --scene welcome    # одна сцена
 *   node scripts/motion/render.mjs --out ./preview    # писать только в указанную папку
 *   node scripts/motion/render.mjs --stills           # только PNG (быстрая проверка вёрстки)
 *
 * Переменные: CHROME_PATH — путь к Chrome/Edge, если не найден автоматически.
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

const VIEW_W = 1280;
const VIEW_H = 720;
const GIF_W = 960;
const GIF_H = 540;
const FPS = 25;
const PNG_SCALE = 1.5; // 1920×1080

const SCENES = {
  welcome: {
    png: ["bot/assets/welcome.png", "bot/start image.png", "пикчи/приветствие.png"],
    gif: ["bot/assets/welcome.gif", "пикчи/приветствие.gif"],
  },
  plans: {
    png: ["bot/assets/plans.png", "пикчи/тарифы.png"],
    gif: ["bot/assets/plans.gif", "пикчи/тарифы.gif"],
  },
  support: {
    png: ["bot/assets/support.png", "пикчи/поддержка.png"],
    gif: ["bot/assets/support.gif", "пикчи/поддержка.gif"],
  },
  supbot: {
    png: ["supbot/welcomepic.png"],
    gif: ["supbot/welcomepic.gif"],
  },
};

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyScene = argVal("--scene");
const outDir = argVal("--out") ? resolve(process.cwd(), argVal("--out")) : null;
const stillsOnly = args.includes("--stills");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome/Edge не найден — укажите CHROME_PATH");
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "entervpn-covers-"));
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
    await sleep(150);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
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

async function openScene(cdp, name, scale) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEW_W,
    height: VIEW_H,
    deviceScaleFactor: scale,
    mobile: false,
  });
  const url = `${pathToFileURL(join(__dirname, "scenes.html")).href}?scene=${name}`;
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
  await cdp.evaluate("document.fonts.ready.then(() => true)");
  const fontOk = await cdp.evaluate(`document.fonts.check('700 40px Inter')`);
  if (!fontOk) console.warn("  ! Inter не загрузился — используется системный шрифт");
  return cdp.evaluate("window.SCENE");
}

async function capture(cdp, t) {
  await cdp.evaluate(
    `(window.renderAt(${t}), new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))`,
  );
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  return Buffer.from(data, "base64");
}

function targets(list, ext, name) {
  if (outDir) return [join(outDir, `${name}.${ext}`)];
  return list.map((p) => resolve(rootDir, p));
}

function save(paths, buf) {
  for (const p of paths) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
    console.log(`  → ${p} (${Math.round(buf.length / 1024)} KB)`);
  }
}

async function renderScene(cdp, name, cfg) {
  console.log(`\n[${name}]`);

  // 1) Статичный PNG 1920×1080 — финальная композиция
  const meta = await openScene(cdp, name, PNG_SCALE);
  const still = await capture(cdp, meta.still);
  save(targets(cfg.png, "png", name), await sharp(still).png({ compressionLevel: 9 }).toBuffer());
  if (stillsOnly) return;

  // 2) GIF: снимаем каждый кадр таймлайна
  await openScene(cdp, name, 1);
  const frames = Math.round(meta.duration * FPS);
  const raw = [];
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    const png = await capture(cdp, i / FPS);
    const { data } = await sharp(png)
      .resize(GIF_W, GIF_H, { kernel: "lanczos3" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    raw.push(data);
    if (i % 25 === 0) process.stdout.write(`  кадры ${i}/${frames}\r`);
  }
  console.log(`  кадры ${frames}/${frames} за ${((Date.now() - started) / 1000).toFixed(1)} с`);

  const gif = await sharp(Buffer.concat(raw), {
    raw: { width: GIF_W, height: GIF_H * frames, channels: 3, pageHeight: GIF_H },
  })
    .gif({
      loop: 0,
      delay: Array(frames).fill(Math.round(1000 / FPS)),
      effort: 7,
      dither: 0.8,
      colours: 256,
      // ненулевые значения дают горизонтальные «полосы» на полупрозрачном стекле
      interFrameMaxError: 0,
    })
    .toBuffer();
  save(targets(cfg.gif, "gif", name), gif);
}

async function main() {
  const names = onlyScene ? [onlyScene] : Object.keys(SCENES);
  for (const n of names) if (!SCENES[n]) throw new Error(`Неизвестная сцена: ${n}`);
  const cdp = await launchChrome();
  try {
    for (const n of names) await renderScene(cdp, n, SCENES[n]);
  } finally {
    cdp.close();
  }
  console.log("\nГотово.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
