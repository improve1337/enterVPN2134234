import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");
const require = createRequire(resolve(rootDir, "site/package.json"));
const sharp = require("sharp");

const W = 1672;
const H = 941;

const GIF_W = 880;
const GIF_H = 495;
const FRAMES = 24;
const FRAME_DELAY_MS = 50; // 20 fps, 1.2s seamless loop

const TAU = Math.PI * 2;
const FONT_DISPLAY = "'Segoe UI Variable Display', 'Segoe UI', Arial, sans-serif";
const FONT_TEXT = "'Segoe UI Variable Text', 'Segoe UI', Arial, sans-serif";
const FONT_MONO = "'Consolas', 'Courier New', monospace";

/**
 * Shared SVG definitions following EnterVPN Design System (--bg #04060B,
 * --surface #0C111A, --surface-2 #131B28, --surface-3 #1A2436, --line #1A2331,
 * --accent #00EFA5 <= 5% of screen) + iOS 18 Dark Mode Glass Craft.
 */
function sharedDefs(t) {
  const angle = t * TAU;
  const orb1X = Math.round(1220 + Math.cos(angle) * 75);
  const orb1Y = Math.round(310 + Math.sin(angle) * 55);
  const orb2X = Math.round(480 + Math.sin(angle) * 70);
  const orb2Y = Math.round(660 + Math.cos(angle) * 50);

  const shimmerX1 = Math.round(-30 + ((t * 160) % 160));
  const shimmerX2 = shimmerX1 + 45;

  return `
  <defs>
    
    <linearGradient id="bgCanvas" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#04060B"/>
      <stop offset="55%" stop-color="#070B13"/>
      <stop offset="100%" stop-color="#04060B"/>
    </linearGradient>

    
    <radialGradient id="orbSlate" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#1E293B" stop-opacity="0.42"/>
      <stop offset="60%" stop-color="#0F172A" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#04060B" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="orbSubtleMint" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#00EFA5" stop-opacity="0.09"/>
      <stop offset="55%" stop-color="#00EFA5" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="#00EFA5" stop-opacity="0"/>
    </radialGradient>

    
    <radialGradient id="gridMaskGrad" cx="52%" cy="48%" r="54%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.75"/>
      <stop offset="65%" stop-color="#FFFFFF" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <mask id="gridMask">
      <rect width="${W}" height="${H}" fill="url(#gridMaskGrad)"/>
    </mask>

    
    <linearGradient id="surface1" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0E1420"/>
      <stop offset="100%" stop-color="#0A0F18"/>
    </linearGradient>

    
    <linearGradient id="surface2" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#162030"/>
      <stop offset="100%" stop-color="#121A27"/>
    </linearGradient>

    
    <linearGradient id="surface3" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1E2A3E"/>
      <stop offset="100%" stop-color="#172131"/>
    </linearGradient>

    
    <linearGradient id="rimNeutral" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.24"/>
      <stop offset="40%" stop-color="#263244" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#1A2331" stop-opacity="0.9"/>
    </linearGradient>

    
    <linearGradient id="rimSpecular" x1="${shimmerX1}%" y1="0%" x2="${shimmerX2}%" y2="100%">
      <stop offset="0%" stop-color="#263244"/>
      <stop offset="50%" stop-color="#EEF2F7" stop-opacity="0.65"/>
      <stop offset="100%" stop-color="#263244"/>
    </linearGradient>

    
    <linearGradient id="titleGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="70%" stop-color="#EEF2F7"/>
      <stop offset="100%" stop-color="#94A1B5"/>
    </linearGradient>

    
    <filter id="cardShadow" x="-10%" y="-10%" width="120%" height="124%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>

  
  <rect width="${W}" height="${H}" fill="url(#bgCanvas)"/>

  
  <circle cx="${orb1X}" cy="${orb1Y}" r="480" fill="url(#orbSlate)"/>
  <circle cx="${orb2X}" cy="${orb2Y}" r="460" fill="url(#orbSubtleMint)"/>

  
  <g mask="url(#gridMask)" stroke="#1A2331" stroke-opacity="0.55" stroke-width="1">
    ${Array.from({ length: 20 }, (_, i) => `<line x1="${i * 88}" y1="0" x2="${i * 88}" y2="${H}"/>`).join("")}
    ${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 88}" x2="${W}" y2="${i * 88}"/>`).join("")}
  </g>
  `;
}

/** Top iOS 18 Dynamic Island Pill (Neutral Titanium + single 6px live mint dot) */
function dynamicIsland(t, rightLabel = "VLESS · REALITY") {
  const angle = t * TAU;
  const bars = [0, 1, 2, 3].map((idx) => {
    const h = Math.round(7 + Math.abs(Math.sin(angle + idx * 1.15)) * 11);
    const y = Math.round(52 - h / 2);
    const x = 1024 + idx * 6.5;
    return `<rect x="${x}" y="${y}" width="3" height="${h}" rx="1.5" fill="#94A1B5"/>`;
  });

  return `
  <g filter="url(#cardShadow)">
    <rect x="606" y="28" width="460" height="48" rx="24" fill="#080C14" stroke="#263244" stroke-width="1"/>
    <line x1="640" y1="28.5" x2="1032" y2="28.5" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="1"/>

    
    <path d="M636 42 L644 45.5 V51.5 C644 56.5 640.5 60 636 61.5 C631.5 60 628 56.5 628 51.5 V45.5 Z" fill="none" stroke="#EEF2F7" stroke-width="1.8"/>
    <text x="656" y="58" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="17" letter-spacing="-0.3">EnterVPN</text>

    <line x1="752" y1="40" x2="752" y2="64" stroke="#1A2331" stroke-width="1"/>

    
    <circle cx="774" cy="52" r="4" fill="#00EFA5"/>
    <text x="788" y="57" fill="#94A1B5" font-family="${FONT_MONO}" font-weight="600" font-size="13" letter-spacing="0.5">${rightLabel}</text>

    ${bars.join("")}
  </g>
  `;
}

/** 1. WELCOME COVER ("ДОБРО ПОЖАЛОВАТЬ") */
function renderWelcomeSvg(t) {
  const angle = t * TAU;
  const floatY = (Math.sin(angle) * 5).toFixed(1);

  // Traveling packet along horizontal route inside --surface-2 window
  const p1 = t;
  const p2 = (t + 0.5) % 1;
  const packetX = (p) => Math.round(986 + p * 468);

  const activeClientIdx = Math.floor(t * 4) % 4;
  const clients = [
    { name: "Streisand", os: "iOS · macOS" },
    { name: "v2rayTun", os: "iOS · Android" },
    { name: "Hiddify", os: "Win · Mac · Android" },
    { name: "v2rayNG", os: "Android · ПК" },
  ];

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    ${sharedDefs(t)}
    ${dynamicIsland(t, "VLESS · REALITY")}

    
    <g transform="translate(96, 188)">
      
      <text x="2" y="0" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="14" letter-spacing="2">ENTERVPN · ДОСТУП ПО ОДНОЙ ССЫЛКЕ</text>

      
      <text x="-4" y="106" fill="url(#titleGrad)" font-family="${FONT_DISPLAY}" font-weight="800" font-size="92" letter-spacing="-2.8">ДОБРО</text>
      <text x="-4" y="198" fill="url(#titleGrad)" font-family="${FONT_DISPLAY}" font-weight="800" font-size="84" letter-spacing="-2.8">ПОЖАЛОВАТЬ</text>

      
      <text x="2" y="262" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="24">Выдаём ссылку-подписку: вставляете её в клиент —</text>
      <text x="2" y="296" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="24">маршруты и обход белых списков настраиваются сами.</text>

      
      <g transform="translate(0, 356)">
        <rect x="0" y="0" width="666" height="128" rx="14" fill="url(#surface1)" stroke="#263244" stroke-width="1"/>
        <line x1="222" y1="18" x2="222" y2="110" stroke="#1A2331" stroke-width="1"/>
        <line x1="444" y1="18" x2="444" y2="110" stroke="#1A2331" stroke-width="1"/>

        
        <text x="28" y="38" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="12" letter-spacing="1">ПРОБНЫЙ ПЕРИОД</text>
        <text x="28" y="78" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="28" letter-spacing="-0.5">3 дня · 10 ГБ</text>
        <text x="28" y="104" fill="#94A1B5" font-family="${FONT_TEXT}" font-size="15">0 ₽ на аккаунт</text>

        
        <text x="250" y="38" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="12" letter-spacing="1">ЛИМИТ УСТРОЙСТВ</text>
        <text x="250" y="78" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="28" letter-spacing="-0.5">До 5 устр.</text>
        <text x="250" y="104" fill="#94A1B5" font-family="${FONT_TEXT}" font-size="15">Одновременно</text>

        
        <text x="472" y="38" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="12" letter-spacing="1">ПОДПИСКА</text>
        <text x="472" y="78" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="28" letter-spacing="-0.5">130 ₽ / мес</text>
        <text x="472" y="104" fill="#94A1B5" font-family="${FONT_TEXT}" font-size="15">100 ГБ · 30 дней</text>
      </g>
    </g>

    
    <g transform="translate(0, ${floatY})" filter="url(#cardShadow)">
      
      <rect x="852" y="168" width="724" height="584" rx="14" fill="url(#surface1)" stroke="url(#rimSpecular)" stroke-width="1.2"/>
      <line x1="872" y1="168.6" x2="1556" y2="168.6" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="1"/>

      
      <g transform="translate(892, 206)">
        
        <rect x="0" y="0" width="72" height="72" rx="14" fill="url(#surface2)" stroke="#263244" stroke-width="1"/>
        <path d="M36 18 L52 25 V37 C52 47.5 45 54.5 36 58 C27 54.5 20 47.5 20 37 V25 Z" fill="none" stroke="#EEF2F7" stroke-width="2.2"/>
        <path d="M30 37 L34.5 41.5 L43 32.5" fill="none" stroke="#EEF2F7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>

        <text x="94" y="34" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="26" letter-spacing="-0.4">Маршрут подключения</text>
        
        <circle cx="100" cy="58" r="4" fill="#00EFA5"/>
        <text x="112" y="63" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="500" font-size="16">Активен · Работает при белых списках</text>

        
        <g transform="translate(550, 12)">
          <rect x="0" y="0" width="94" height="48" rx="24" fill="#00EFA5"/>
          <circle cx="70" cy="24" r="20" fill="#04060B"/>
        </g>
      </g>

      
      <g transform="translate(892, 312)">
        <rect x="0" y="0" width="644" height="236" rx="14" fill="url(#surface2)" stroke="#263244" stroke-width="1"/>

        
        <text x="28" y="38" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="12" letter-spacing="1">СХЕМА КАНАЛА · VLESS + CDN RELAY</text>
        <text x="616" y="38" text-anchor="end" fill="#94A1B5" font-family="${FONT_MONO}" font-weight="600" font-size="12">PORT 443 · TLS 1.3</text>
        <line x1="0" y1="54" x2="644" y2="54" stroke="#1A2331" stroke-width="1"/>

        
        <line x1="94" y1="126" x2="550" y2="126" stroke="#263244" stroke-width="2"/>
        <line x1="94" y1="126" x2="550" y2="126" stroke="#94A1B5" stroke-opacity="0.35" stroke-width="2" stroke-dasharray="6 6"/>

        
        <g transform="translate(-892, -312)">
          <circle cx="${packetX(p1)}" cy="438" r="9" fill="#00EFA5" opacity="0.22"/>
          <circle cx="${packetX(p1)}" cy="438" r="4.5" fill="#00EFA5"/>
          <circle cx="${packetX(p2)}" cy="438" r="7" fill="#EEF2F7" opacity="0.2"/>
          <circle cx="${packetX(p2)}" cy="438" r="3.5" fill="#EEF2F7"/>
        </g>

        
        <circle cx="94" cy="126" r="14" fill="#1A2436" stroke="#94A1B5" stroke-width="1.5"/>
        <circle cx="94" cy="126" r="4" fill="#EEF2F7"/>
        <text x="94" y="168" text-anchor="middle" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="16">Устройство</text>
        <text x="94" y="190" text-anchor="middle" fill="#5E6A7D" font-family="${FONT_MONO}" font-size="12">iOS · Android · ПК</text>

        
        <circle cx="322" cy="126" r="14" fill="#1A2436" stroke="#EEF2F7" stroke-width="1.5"/>
        <circle cx="322" cy="126" r="4" fill="#00EFA5"/>
        <text x="322" y="168" text-anchor="middle" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="16">RU · Транзит</text>
        <text x="322" y="190" text-anchor="middle" fill="#94A1B5" font-family="${FONT_MONO}" font-size="12">Белые списки</text>

        
        <circle cx="550" cy="126" r="14" fill="#1A2436" stroke="#94A1B5" stroke-width="1.5"/>
        <circle cx="550" cy="126" r="4" fill="#EEF2F7"/>
        <text x="550" y="168" text-anchor="middle" fill="#EEF2F7" font-family="${FONT_MONO}" font-weight="700" font-size="16">DE · NL · FI</text>
        <text x="550" y="190" text-anchor="middle" fill="#5E6A7D" font-family="${FONT_MONO}" font-size="12">Внешний узел</text>
      </g>

      
      <g transform="translate(892, 578)">
        <text x="2" y="18" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="12" letter-spacing="1">КЛИЕНТЫ ДЛЯ ПОДКЛЮЧЕНИЯ</text>
        <rect x="0" y="32" width="644" height="96" rx="14" fill="url(#surface2)" stroke="#263244" stroke-width="1"/>
        
        <rect x="${activeClientIdx * 161 + 4}" y="36" width="153" height="88" rx="10" fill="url(#surface3)" stroke="#2E3D52" stroke-width="1"/>

        ${[1, 2, 3]
          .map(
            (i) =>
              `<line x1="${i * 161}" y1="46" x2="${i * 161}" y2="114" stroke="#1A2331" stroke-width="1"/>`,
          )
          .join("")}

        ${clients
          .map((c, idx) => {
            const cx = idx * 161 + 80;
            const isAct = idx === activeClientIdx;
            return `
            <text x="${cx}" y="76" text-anchor="middle" fill="${isAct ? "#FFFFFF" : "#EEF2F7"}" font-family="${FONT_DISPLAY}" font-weight="700" font-size="17">${c.name}</text>
            <text x="${cx}" y="100" text-anchor="middle" fill="${isAct ? "#94A1B5" : "#5E6A7D"}" font-family="${FONT_MONO}" font-size="12">${c.os}</text>
            `;
          })
          .join("")}
      </g>
    </g>
  </svg>`;
}

/** 2. PLANS COVER ("ТАРИФЫ") */
function renderPlansSvg(t) {
  const angle = t * TAU;
  const float1 = (Math.sin(angle) * 4.5).toFixed(1);
  const float2 = (Math.cos(angle) * 4.5).toFixed(1);

  const r = 46;
  const circ = 2 * Math.PI * r;
  const gauge1 = Math.round(circ * (0.35 + Math.sin(angle) * 0.03));
  const gauge2 = Math.round(circ * (0.82 + Math.cos(angle) * 0.04));

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    ${sharedDefs(t)}
    ${dynamicIsland(t, "ТАРИФЫ · АВТОВЫДАЧА")}

    
    <g transform="translate(96, 188)">
      
      <text x="2" y="0" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="14" letter-spacing="2">ENTERVPN · ТАРИФНЫЕ ПЛАНЫ</text>

      <text x="-4" y="114" fill="url(#titleGrad)" font-family="${FONT_DISPLAY}" font-weight="800" font-size="100" letter-spacing="-3">ТАРИФЫ</text>

      <text x="2" y="182" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="24">Оплата и выдача ссылки — автоматически в боте.</text>
      <text x="2" y="216" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="24">При продлении дни прибавляются к текущему сроку.</text>

      
      <g transform="translate(0, 274)">
        <rect x="0" y="0" width="636" height="216" rx="14" fill="url(#surface1)" stroke="#263244" stroke-width="1"/>

        <text x="28" y="48" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="500" font-size="19">Устройств на одну подписку</text>
        <text x="608" y="48" text-anchor="end" fill="#EEF2F7" font-family="${FONT_MONO}" font-weight="700" font-size="18">До 5 устройств</text>
        <line x1="28" y1="72" x2="608" y2="72" stroke="#1A2331" stroke-width="1"/>

        <text x="28" y="118" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="500" font-size="19">Работа при ограничениях сети</text>
        <text x="608" y="118" text-anchor="end" fill="#EEF2F7" font-family="${FONT_MONO}" font-weight="700" font-size="18">Белые списки · VLESS</text>
        <line x1="28" y1="142" x2="608" y2="142" stroke="#1A2331" stroke-width="1"/>

        <text x="28" y="188" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="500" font-size="19">Пробный доступ для новых аккаунтов</text>
        <text x="608" y="188" text-anchor="end" fill="#EEF2F7" font-family="${FONT_MONO}" font-weight="700" font-size="18">3 дня · 10 ГБ · 0 ₽</text>
      </g>
    </g>

    
    
    <g transform="translate(808, ${Math.round(168 + Number(float1))})" filter="url(#cardShadow)">
      <rect x="0" y="0" width="768" height="272" rx="14" fill="url(#surface1)" stroke="#263244" stroke-width="1"/>
      <line x1="548" y1="28" x2="548" y2="244" stroke="#1A2331" stroke-width="1"/>

      <text x="38" y="52" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="13" letter-spacing="1.2">30 ДНЕЙ · БАЗОВЫЙ</text>
      <text x="38" y="102" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="34" letter-spacing="-0.6">VPN · 1 месяц</text>

      <text x="38" y="186" fill="#FFFFFF" font-family="${FONT_DISPLAY}" font-weight="800" font-size="68" letter-spacing="-2">130 ₽</text>
      <text x="232" y="182" fill="#5E6A7D" font-family="${FONT_TEXT}" font-weight="500" font-size="21">/ 30 дней</text>

      <text x="38" y="232" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="18">100 ГБ трафика · До 5 устройств одновременно</text>

      
      <g transform="translate(658, 118)">
        <circle cx="0" cy="0" r="${r}" fill="none" stroke="#1A2331" stroke-width="7"/>
        <circle cx="0" cy="0" r="${r}" fill="none" stroke="#94A1B5" stroke-width="7" stroke-linecap="round" stroke-dasharray="${gauge1} ${Math.round(circ)}" transform="rotate(-90)"/>
        <text x="0" y="6" text-anchor="middle" fill="#EEF2F7" font-family="${FONT_MONO}" font-weight="700" font-size="19">100 ГБ</text>
        <text x="0" y="84" text-anchor="middle" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="600" font-size="12" letter-spacing="0.5">ЛИМИТ ТРАФИКА</text>
      </g>
    </g>

    
    <g transform="translate(808, ${Math.round(472 + Number(float2))})" filter="url(#cardShadow)">
      <rect x="0" y="0" width="768" height="284" rx="14" fill="url(#surface2)" stroke="url(#rimSpecular)" stroke-width="1.5"/>
      <line x1="24" y1="1" x2="744" y2="1" stroke="#FFFFFF" stroke-opacity="0.24" stroke-width="1"/>
      <line x1="548" y1="28" x2="548" y2="256" stroke="#263244" stroke-width="1"/>

      <text x="38" y="54" fill="#94A1B5" font-family="${FONT_MONO}" font-weight="700" font-size="13" letter-spacing="1.2">90 ДНЕЙ · ОПТИМАЛЬНЫЙ</text>

      
      <rect x="262" y="34" width="128" height="28" rx="6" fill="#00EFA5"/>
      <text x="326" y="53" text-anchor="middle" fill="#04060B" font-family="${FONT_MONO}" font-weight="700" font-size="12" letter-spacing="0.5">ВЫГОДА 10%</text>

      <text x="38" y="106" fill="#FFFFFF" font-family="${FONT_DISPLAY}" font-weight="700" font-size="36" letter-spacing="-0.6">VPN · 3 месяца</text>

      <text x="38" y="192" fill="#FFFFFF" font-family="${FONT_DISPLAY}" font-weight="800" font-size="72" letter-spacing="-2">350 ₽</text>
      <text x="246" y="188" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="500" font-size="21">~ 116 ₽ / мес</text>

      <text x="38" y="242" fill="#EEF2F7" font-family="${FONT_TEXT}" font-weight="400" font-size="18">400 ГБ трафика · До 5 устройств · Увеличенный пакет</text>

      
      <g transform="translate(658, 122)">
        <circle cx="0" cy="0" r="${r}" fill="none" stroke="#1E293B" stroke-width="7"/>
        <circle cx="0" cy="0" r="${r}" fill="none" stroke="#EEF2F7" stroke-width="7" stroke-linecap="round" stroke-dasharray="${gauge2} ${Math.round(circ)}" transform="rotate(-90)"/>
        <text x="0" y="6" text-anchor="middle" fill="#FFFFFF" font-family="${FONT_MONO}" font-weight="700" font-size="19">400 ГБ</text>
        <text x="0" y="86" text-anchor="middle" fill="#94A1B5" font-family="${FONT_MONO}" font-weight="600" font-size="12" letter-spacing="0.5">НА 90 ДНЕЙ</text>
      </g>
    </g>
  </svg>`;
}

/** 3. SUPPORT COVER ("ПОДДЕРЖКА" — for main bot and support bot) */
function renderSupportSvg(t, isSupBot = false) {
  const angle = t * TAU;
  const floatY = (Math.sin(angle) * 5).toFixed(1);

  const dotY = (idx) => (Math.sin(angle + idx * 1.1) * 3).toFixed(1);
  const dotOp = (idx) => (0.45 + Math.sin(angle + idx * 1.1) * 0.45).toFixed(2);

  const overline = isSupBot
    ? "ENTERVPN · ТИКЕТ-СИСТЕМА ПОДДЕРЖКИ"
    : "ENTERVPN · СЛУЖБА ПОДДЕРЖКИ";
  const sub1 = isSupBot
    ? "Напишите вопрос одним сообщением прямо в этот чат —"
    : "Отдельный бот поддержки с тикет-системой:";
  const sub2 = isSupBot
    ? "тикет создастся автоматически, оператор ответит здесь же."
    : "поможем с настройкой клиента, оплатой и переносом подписки.";

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    ${sharedDefs(t)}
    ${dynamicIsland(t, "SUPPORT · ТИКЕТЫ")}

    
    <g transform="translate(96, 188)">
      
      <text x="2" y="0" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="14" letter-spacing="2">${overline}</text>

      <text x="-4" y="110" fill="url(#titleGrad)" font-family="${FONT_DISPLAY}" font-weight="800" font-size="88" letter-spacing="-2.8">ПОДДЕРЖКА</text>

      <text x="2" y="178" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="24">${sub1}</text>
      <text x="2" y="212" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="24">${sub2}</text>

      
      <g transform="translate(0, 272)">
        <rect x="0" y="0" width="644" height="222" rx="14" fill="url(#surface1)" stroke="#263244" stroke-width="1"/>

        
        <text x="28" y="48" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="15">01</text>
        <text x="68" y="48" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="19">Опишите проблему одним сообщением</text>
        <text x="68" y="74" fill="#94A1B5" font-family="${FONT_TEXT}" font-size="15">Можно приложить скриншот из приложения или чек оплаты</text>

        <line x1="28" y1="98" x2="616" y2="98" stroke="#1A2331" stroke-width="1"/>

        
        <text x="28" y="136" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="15">02</text>
        <text x="68" y="136" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="19">Получите ответ оператора в этом же чате</text>
        <text x="68" y="162" fill="#94A1B5" font-family="${FONT_TEXT}" font-size="15">Без автоответчиков — каждое обращение ведёт человек</text>

        <line x1="28" y1="182" x2="616" y2="182" stroke="#1A2331" stroke-width="1"/>

        
        <circle cx="36" cy="202" r="4" fill="#00EFA5"/>
        <text x="50" y="207" fill="#94A1B5" font-family="${FONT_MONO}" font-weight="600" font-size="13">Операторы онлайн · @EnterseviceSupport_bot</text>
      </g>
    </g>

    
    <g transform="translate(824, ${Math.round(168 + Number(floatY))})" filter="url(#cardShadow)">
      <rect x="0" y="0" width="752" height="584" rx="14" fill="url(#surface1)" stroke="url(#rimSpecular)" stroke-width="1.2"/>
      <line x1="24" y1="1" x2="728" y2="1" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="1"/>

      
      <g transform="translate(36, 32)">
        <rect x="0" y="0" width="60" height="60" rx="14" fill="url(#surface2)" stroke="#263244" stroke-width="1"/>
        
        <path d="M18 33 V28 C18 21.4 23.4 16 30 16 C36.6 16 42 21.4 42 28 V33" fill="none" stroke="#EEF2F7" stroke-width="2.2" stroke-linecap="round"/>
        <rect x="15" y="29" width="6" height="12" rx="3" fill="#EEF2F7"/>
        <rect x="39" y="29" width="6" height="12" rx="3" fill="#EEF2F7"/>
        <path d="M42 39 C42 44 37 46 31 46" fill="none" stroke="#94A1B5" stroke-width="2" stroke-linecap="round"/>

        <text x="80" y="28" fill="#EEF2F7" font-family="${FONT_DISPLAY}" font-weight="700" font-size="24" letter-spacing="-0.4">Тикет #108 · Подключение</text>
        <text x="80" y="52" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="600" font-size="13">ОТКРЫТ · ОПЕРАТОР НАЗНАЧЕН</text>

        
        <circle cx="596" cy="30" r="4" fill="#00EFA5"/>
        <text x="610" y="35" fill="#EEF2F7" font-family="${FONT_MONO}" font-weight="700" font-size="13">ОНЛАЙН</text>
      </g>

      <line x1="0" y1="118" x2="752" y2="118" stroke="#1A2331" stroke-width="1"/>

      
      <g transform="translate(36, 146)">
        <text x="4" y="0" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="12" letter-spacing="0.8">ПОЛЬЗОВАТЕЛЬ · 21:38</text>
        <rect x="0" y="14" width="536" height="92" rx="14" fill="url(#surface2)" stroke="#263244" stroke-width="1"/>
        <text x="24" y="50" fill="#EEF2F7" font-family="${FONT_TEXT}" font-weight="400" font-size="18">Привет! Получил ссылку-подписку, подскажите</text>
        <text x="24" y="78" fill="#EEF2F7" font-family="${FONT_TEXT}" font-weight="400" font-size="18">как добавить её в Hiddify на Windows и iPhone?</text>
      </g>

      
      <g transform="translate(128, 286)">
        <text x="584" y="0" text-anchor="end" fill="#94A1B5" font-family="${FONT_MONO}" font-weight="700" font-size="12" letter-spacing="0.8">ПОДДЕРЖКА ENTERVPN · 21:39</text>
        <rect x="0" y="14" width="588" height="168" rx="14" fill="url(#surface3)" stroke="#2E3D52" stroke-width="1"/>
        <text x="26" y="50" fill="#FFFFFF" font-family="${FONT_TEXT}" font-weight="600" font-size="18">Здравствуйте! Настройка занимает полминуты:</text>
        <text x="26" y="84" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="17">1. Скопируйте ссылку-подписку из раздела «Моя подписка».</text>
        <text x="26" y="112" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="400" font-size="17">2. В приложении нажмите «+» → «Добавить из буфера».</text>
        <line x1="26" y1="132" x2="562" y2="132" stroke="#263244" stroke-width="1"/>
        <text x="26" y="158" fill="#EEF2F7" font-family="${FONT_MONO}" font-weight="600" font-size="13">✓ Маршрут проверен · Доступ активен</text>
      </g>

      
      <line x1="0" y1="508" x2="752" y2="508" stroke="#1A2331" stroke-width="1"/>
      <g transform="translate(36, 526)">
        <circle cx="14" cy="${Math.round(18 + Number(dotY(0)))}" r="4" fill="#00EFA5" opacity="${dotOp(0)}"/>
        <circle cx="30" cy="${Math.round(18 + Number(dotY(1)))}" r="4" fill="#00EFA5" opacity="${dotOp(1)}"/>
        <circle cx="46" cy="${Math.round(18 + Number(dotY(2)))}" r="4" fill="#00EFA5" opacity="${dotOp(2)}"/>
        <text x="68" y="23" fill="#94A1B5" font-family="${FONT_TEXT}" font-weight="500" font-size="15">Оператор на связи · Готов ответить на ваш вопрос</text>
        <text x="680" y="23" text-anchor="end" fill="#5E6A7D" font-family="${FONT_MONO}" font-weight="700" font-size="13">24/7</text>
      </g>
    </g>
  </svg>`;
}

/** Render static high-res PNG (1672x941) and animated looping GIF (880x495) */
async function buildCover({ name, renderFn, pngPaths, gifPaths }) {
  console.log(`Rendering [${name}]...`);

  // 1. High-res static PNG
  const staticSvg = renderFn(0.28);
  const pngBuffer = await sharp(Buffer.from(staticSvg))
    .resize(W, H)
    .png({ compressionLevel: 8 })
    .toBuffer();

  for (const outPath of pngPaths) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, pngBuffer);
    console.log(`  -> PNG saved: ${outPath} (${Math.round(pngBuffer.length / 1024)} KB)`);
  }

  // 2. Animated motion-graphics GIF (fast effort=3)
  const rawFrames = [];
  for (let i = 0; i < FRAMES; i++) {
    const t = i / FRAMES;
    const svg = renderFn(t);
    const { data } = await sharp(Buffer.from(svg))
      .resize(GIF_W, GIF_H)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    rawFrames.push(data);
  }

  const stackedRaw = Buffer.concat(rawFrames);
  const gifBuffer = await sharp(stackedRaw, {
    raw: {
      width: GIF_W,
      height: GIF_H * FRAMES,
      channels: 4,
      pageHeight: GIF_H,
    },
  })
    .gif({
      loop: 0,
      delay: Array(FRAMES).fill(FRAME_DELAY_MS),
      effort: 3,
      dither: 0.65,
    })
    .toBuffer();

  for (const outPath of gifPaths) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, gifBuffer);
    console.log(`  -> GIF saved: ${outPath} (${Math.round(gifBuffer.length / 1024)} KB)`);
  }
}

async function main() {
  await buildCover({
    name: "welcome (ДОБРО ПОЖАЛОВАТЬ)",
    renderFn: (t) => renderWelcomeSvg(t),
    pngPaths: [
      resolve(rootDir, "bot/assets/welcome.png"),
      resolve(rootDir, "bot/start image.png"),
      resolve(rootDir, "пикчи/приветствие.png"),
    ],
    gifPaths: [
      resolve(rootDir, "bot/assets/welcome.gif"),
      resolve(rootDir, "пикчи/приветствие.gif"),
    ],
  });

  await buildCover({
    name: "plans (ТАРИФЫ)",
    renderFn: (t) => renderPlansSvg(t),
    pngPaths: [
      resolve(rootDir, "bot/assets/plans.png"),
      resolve(rootDir, "пикчи/тарифы.png"),
    ],
    gifPaths: [
      resolve(rootDir, "bot/assets/plans.gif"),
      resolve(rootDir, "пикчи/тарифы.gif"),
    ],
  });

  await buildCover({
    name: "support (ПОДДЕРЖКА)",
    renderFn: (t) => renderSupportSvg(t, false),
    pngPaths: [
      resolve(rootDir, "bot/assets/support.png"),
      resolve(rootDir, "пикчи/поддержка.png"),
    ],
    gifPaths: [
      resolve(rootDir, "bot/assets/support.gif"),
      resolve(rootDir, "пикчи/поддержка.gif"),
    ],
  });

  await buildCover({
    name: "supbot welcome (ПОДДЕРЖКА БОТ)",
    renderFn: (t) => renderSupportSvg(t, true),
    pngPaths: [resolve(rootDir, "supbot/welcomepic.png")],
    gifPaths: [resolve(rootDir, "supbot/welcomepic.gif")],
  });

  console.log("All covers generated successfully!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
