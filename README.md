# EnterVPN — Telegram-бот (локальный прототип)

Бот на TypeScript + grammY + Fastify. По умолчанию работает в `MOCK_MODE`:
платежи и выдача подписки эмулируются, внешние сервисы (Marzban, Platega) не нужны.
Данные хранятся в SQLite через встроенный `node:sqlite` (Node.js ≥ 22.5, проверено на 24).

## Запуск

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev               # tsx watch, автоперезапуск
```

Проверка, что всё поднялось:

- `http://127.0.0.1:3000/health` — статус и режим
- `http://127.0.0.1:3000/api/stats` — агрегированная статистика

## Команды npm

| Команда | Что делает |
|---|---|
| `npm run dev` | запуск с автоперезапуском (`tsx watch`) |
| `npm start` | однократный запуск (`tsx`) |
| `npm run stop` | остановить запущенного бота (работает и как `npm stop`) |
| `npm run build` | компиляция в `dist/` (`tsc`) |
| `npm run start:prod` | запуск собранного `dist/index.js` |
| `npm run typecheck` | проверка типов без сборки |
| `npm test` | тесты ядра (vitest) |

### Остановка бота

```bash
npm run stop      # или: npm stop
```

При старте бот пишет `data/bot.pid` (PID + PID родителя). `npm run stop` читает этот файл
и гасит процесс вместе с обёрткой (`tsx watch` / `npm`) — иначе watcher перезапустил бы бота.
Если файла нет или процесс уже мёртв, скрипт просто сообщит об этом.

## Что умеет бот

- `/start` — приветствие с картинкой (`BANNER_PATH`), deep links `?start=plan_<code>` и `?start=paid_<order>`.
- 🎁 Пробный доступ — 3 дня, безлимитный трафик, до 5 устройств, один раз на Telegram ID.
- 💎 Тарифы — один тариф VPN: **1 месяц — 130 ₽**, **3 месяца — 350 ₽**; безлимитный трафик, до 5 устройств.
- 📦 Моя подписка — статус, срок, трафик, ссылка-подписка, история платежей, автопродление.
- 💬 Поддержка / ❓ Помощь.
- Админка (только для `ADMIN_IDS`): `/admin`, `/user <id>`, `/ban <id>`, `/unban <id>`, `/grant <id> [plan]`.

Коды тарифов для `/grant` и deep links: `vpn_1m` (1 месяц) и `vpn_3m` (3 месяца).

## Локальный тест оплаты

В `MOCK_MODE=true` у сообщения с оплатой есть кнопка **«💳 Оплатить (демо)»**.
Она эмулирует callback платёжки. То же самое можно вызвать по HTTP:

```bash
curl -X POST http://127.0.0.1:3000/mock/pay/<orderId>
```

Или отправить имитацию вебхука Platega (так проверишь боевой путь):

```bash
curl -X POST http://127.0.0.1:3000/webhooks/platega \
  -H "Content-Type: application/json" \
  -d '{"payload":"<orderId>","id":"tx-1","status":"CONFIRMED","amount":130}'
```

Повторный `CONFIRMED` для того же заказа отвечает `{"ok":true,"reason":"already_paid"}` и **не продлевает** подписку.

## Если бот не отвечает: `api.telegram.org` заблокирован

Бот работает через **исходящие** запросы к `api.telegram.org`. Если провайдер режет этот хост
(типичная ситуация для РФ), бот не получит ни одного сообщения — при этом код исправен.

Проверить блокировку:

```powershell
curl.exe -m 10 https://api.telegram.org/          # ожидаем код 000 / таймаут при блокировке
Test-NetConnection api.telegram.org -Port 443     # TcpTestSucceeded: False при блокировке
```

При старте бот сам делает preflight-проверку (`getMe`) и пишет в лог одну из причин:
недоступен хост / неверный токен. Если хост недоступен, бот продолжает работать,
`/health` отвечает, и он сам переподключится, когда сеть появится.

Решения:

1. **Включить VPN/прокси на ПК** и перезапустить бота.
2. **Указать прокси в `.env`** — тогда бот пойдёт в Telegram через него:

   ```env
   TELEGRAM_PROXY=socks5://127.0.0.1:1080
   # или
   TELEGRAM_PROXY=http://user:pass@127.0.0.1:8080
   ```

   Поддерживаются `http`, `https`, `socks4`, `socks5`. Если у вас локальный
   sing-box/Xray с SOCKS-инбаундом — подойдёт `socks5://127.0.0.1:<порт>`.
3. **Перенести бота на сервер**, где Telegram доступен (сервер в ЕС из вашего плана).

> Российский хостинг проблему не гарантирует решает: блокировки применяются к каналу,
> а не к стране сервера. Надёжнее сразу ЕС.

## Стоит ли заливать на хостинг сейчас

Хостинг — это правильный финал, но не способ отладки: пока ни один живой сценарий
(кнопки, тексты, выдача подписки) не проверен на реальном Telegram, отлаживать
это по логам на удалённой машине дороже. Порядок такой:

1. Локально через VPN/прокси (`TELEGRAM_PROXY`) пройти сценарий: `/start` → пробный → покупка → выдача.
2. Затем залить на ЕС-сервер (`Dockerfile` уже готов, `docker compose up -d`).
3. На сервере `TELEGRAM_PROXY` не нужен — там Telegram доступен напрямую.

Бот живёт на EU-1 по вашему плану (`vpn-service-structure.md`, раздел 8.6): отдельный
хостинг не нужен, он едет вместе с панелью.

## Переключение на боевой режим

1. `MOCK_MODE=false` в `.env`.
2. Заполни `MARZBAN_URL` / `MARZBAN_USERNAME` / `MARZBAN_PASSWORD`.
3. Заполни `PLATEGA_MERCHANT_ID` / `PLATEGA_SECRET`.
4. Укажи `PUBLIC_URL` и `WEBHOOK_SECRET`, поставь `BOT_MODE=webhook` — Telegram и платёжка будут
   ходить на `POST /telegram/webhook` и `POST /webhooks/platega`.

## Структура

```
src/
  index.ts        точка входа: БД, бот, сервер, polling/webhook
  config.ts       zod-валидация env
  bot.ts          команды, кнопки, админка
  server.ts       Fastify: /health, /api/*, вебхуки
  db.ts           SQLite-схема и запросы
  plans.ts        тарифы и пробный период
  pid.ts          PID-файл для `npm run stop`
  services/
    provision.ts    выдача/отзыв доступа (mock + Marzban)
    payments.ts     создание и подтверждение платежа
    subscriptions.ts пробный доступ, активация и продление
    fulfillment.ts   выдача доступа после оплаты (идемпотентно)
  ui/             тексты и клавиатуры
scripts/stop.mjs  остановка бота
assets/welcome.png картинка приветствия (/start)
tests/            тесты ядра
```

## Docker

```bash
docker build -t entervpn-bot .
docker run --rm -p 3000:3000 --env-file .env -v entervpn-data:/app/data entervpn-bot
```

Полная инструкция по выкладке на хостинг — в [DEPLOY.md](./DEPLOY.md).
Там же разобраны переменные окружения, systemd-юнит и типовые ошибки.
