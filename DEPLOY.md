# Деплой бота EnterVPN

Прототип на `MOCK_MODE=true`: реальные платежи и Marzban не нужны, бот отдаёт
демо-подписки. Для запуска на хостинге достаточно токена бота.

---

## 1. Что нужно задать в окружении

Обязательное — только `BOT_TOKEN`. Остальное имеет разумные значения по умолчанию.

| Переменная | Хостинг (Docker) | Локально | Зачем |
|---|---|---|---|
| `BOT_TOKEN` | **обязательно** | обязательно | Токен от @BotFather |
| `ADMIN_IDS` | ваш Telegram ID | ваш ID | Доступ к админ-командам |
| `BOT_USERNAME` | `enterservice_bot` | то же | Показывается в текстах |
| `BRAND_NAME` | `EnterVPN` | то же | Название в интерфейсе |
| `NODE_ENV` | **`production`** | `development` | Влияет на формат логов |
| `BOT_MODE` | `polling` | `polling` | Входящие порты не нужны |
| `PORT` | `3000` | `3000` | Только для `/health` и `/api/*` |
| `LOG_LEVEL` | `info` | `info` | Подробность логов |
| `DATABASE_PATH` | **`/app/data/bot.db`** | `./data/bot.db` | См. предупреждение ниже |
| `BANNER_PATH` | `/usr/src/app/assets/welcome.png` | `./assets/welcome.png` | Картинка на `/start` |
| `MOCK_MODE` | `true` | `true` | Демо-режим без платежей |
| `TELEGRAM_PROXY` | пусто | пусто | Нужен, если Telegram заблокирован |

> **Главная ловушка.** `DATABASE_PATH` обязан указывать на постоянный том
> (`/app/data/bot.db`). Если оставить `./data/bot.db`, база окажется внутри
> контейнера и **сотрётся при каждом передеплое** — вместе со всеми
> пользователями и заказами.

Файл `.env` на хостинг **не заливайте** — он в `.dockerignore` и `.gitignore`.
Значения вбиваются в панель окружения хостинга.

---

## 2. Вариант A — Bothost (Docker)

В проекте уже есть `Dockerfile`, рассчитанный на Bothost: он собирает
TypeScript в `dist/` и держит данные в `/app/data`.

1. Загрузите архив с проектом (или подключите репозиторий) — корнем должен быть
   каталог `bot/`, то есть `Dockerfile` лежит в корне.
2. В панели окружения задайте переменные из таблицы выше. Минимум:
   `BOT_TOKEN`, `ADMIN_IDS`, `NODE_ENV=production`, `MOCK_MODE=true`.
3. Убедитесь, что каталог `/app/data` подключён как постоянный том.
4. Запустите сборку и деплой.
5. Откройте логи — должно появиться `Telegram доступен` и `HTTP-сервер мониторинга запущен`.

Проверить живость: откройте `https://<ваш-домен>/health` — должен вернуться
`{"ok":true,...}`.

> Шаги именно для панели Bothost я **не смог проверить**: поиск в интернете
> отдаёт 403, а доступа к их документации у меня нет. Названия кнопок сверьте
> сами — логика выше универсальна для Docker-хостингов.

---

## 3. Вариант B — VPS через Docker Compose

```bash
# 1. Node и Docker
sudo apt update && sudo apt install -y docker.io docker-compose-v2

# 2. Код
sudo mkdir -p /opt/entervpn-bot && cd /opt/entervpn-bot
# скопируйте сюда содержимое каталога bot/

# 3. Окружение
cp .env.example .env
nano .env          # BOT_TOKEN, ADMIN_IDS, NODE_ENV=production, MOCK_MODE=true

# 4. Запуск
docker compose up -d --build
docker compose logs -f
```

Проверка:

```bash
curl http://127.0.0.1:3000/health
```

`DATABASE_PATH` в compose уже переопределён на `/app/data/bot.db` и лежит в
именованном томе `bot-data`, поэтому переживает пересборку.

---

## 4. Вариант C — VPS без Docker (systemd)

Нужен **Node.js ≥ 22.5** — на более старых версиях нет модуля `node:sqlite`.

```bash
node --version        # должно быть v22.5+ (проверено на v24)
```

```bash
cd /opt/entervpn-bot
npm ci                # ставит и devDependencies — они нужны для сборки
npm run build         # TypeScript -> dist/
cp .env.example .env && nano .env
```

Юнит `/etc/systemd/system/entervpn-bot.service`:

```ini
[Unit]
Description=EnterVPN Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/entervpn-bot
EnvironmentFile=/opt/entervpn-bot/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now entervpn-bot
sudo journalctl -u entervpn-bot -f
```

`DATABASE_PATH=./data/bot.db` здесь резолвится от `WorkingDirectory`,
то есть в `/opt/entervpn-bot/data/bot.db`. Этот каталог должен переживать
обновления кода.

---

## 5. Проверка после деплоя

> **Про задержку старта.** Сначала бот проверяет доступ к Telegram (`getMe`,
> таймаут 15 с), и только потом поднимает HTTP-сервер. Если Telegram недоступен,
> `/health` появится не сразу, а через ~15 секунд. Если у хостинга healthcheck
> с коротким таймаутом — увеличьте его до 30 с.

1. В логах есть `Telegram доступен` с именем бота — значит токен верный и
   Telegram отвечает.
2. `GET /health` возвращает `{"ok":true,...}`.
3. В Telegram: `/start` → приходит картинка и клавиатура.
4. `/start` → «Тарифы» → покупка → в демо-режиме доступ выдаётся сразу.

---

## 6. Если Telegram недоступен

При старте бот делает предпроверку `getMe` и в логе пишет причину.

- **`401` / неверный токен** — перепроверьте `BOT_TOKEN`.
- **`Telegram Bot API недоступен`** — сервер не видит `api.telegram.org`.
  Лечится прокси:

  ```
  TELEGRAM_PROXY=socks5://user:pass@host:1080
  ```

  Поддерживаются `http`, `https`, `socks4`, `socks5`.

Бот при этом не падает: HTTP-сервер поднимается, `/health` отвечает, а в логе
висит предупреждение. Но сообщения он получать не будет.

---

## 7. Частые ошибки

| Симптом | Причина | Решение |
|---|---|---|
| `Cannot find module 'node:sqlite'` | Node < 22.5 | Обновить Node или собирать через Dockerfile |
| `tsx: not found` | `npm start` без devDependencies | Уже исправлено: `tsx` перенесён в `dependencies` |
| `SYNC ERROR: unable to determine transport target for "pino-pretty"` | `NODE_ENV` ≠ `production` без devDependencies | Уже исправлено: логгер сам откатывается на JSON |
| После передеплоя пропали пользователи | `DATABASE_PATH` не на постоянном томе | Указать `/app/data/bot.db` |
| Порт занят | Локально уже запущен бот | `npm run stop` |

---

## 8. Что осталось непроверенным

Честно, чтобы не было сюрпризов:

- **Шаги панели Bothost** — не проверял (нет доступа к их докам, поиск отдаёт 403).
- **Реальный деплой на хостинг** — не выполнял, проверял только локально:
  сборка, 24 теста, запуск.
- **Доступность `api.telegram.org` с серверов Bothost** — узнаете по логу
  первого запуска. Если будет `недоступен` — нужен `TELEGRAM_PROXY`.
- **Сколько RAM даёт тариф** — в скриншоте не читалось; боту нужно ~150–200 МБ.
