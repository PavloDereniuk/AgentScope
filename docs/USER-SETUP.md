# USER-SETUP.md

> Все що **ти** маєш зробити руками. Я не маю доступу до браузера, акаунтів, dashboards.
> Кожен крок має чітке «що зробити» → «що скопіювати» → «куди вставити» → «як перевірити».

**Легенда:** `[ ]` чек-лист · `🟢` потрібно зараз (Тиждень 1) · `🟡` Тиждень 5 (деплой) · `🔵` опційно

---

## Швидкий чек-лист (~50 хв сумарно)

```
🟢 Тиждень 1 — щоб я міг почати тестувати з реальними даними:
[ ] 1. Supabase project + DATABASE_URL                       (~10 хв)
[ ] 2. Helius account + Yellowstone gRPC URL/token           (~10 хв)
[ ] 3. Privy app + APP_ID/SECRET                             (~10 хв)
[ ] 4. Telegram bot через @BotFather                          (~5 хв)
[ ] 5. GitHub repo + push                                    (~5 хв)
[ ] 6. Створити .env з усіх кроків + перевірити              (~5 хв)

🟡 Тиждень 5 — деплой (зробимо коли MVP буде готовим):
[ ] 7. Railway: api сервіс
[ ] 8. Railway: ingestion worker
[ ] 9. Railway: cron job
[ ] 10. Vercel: dashboard
[ ] 11. Vercel: landing
[ ] 12. Submission на Colosseum

🔵 Опційно:
[ ] Devnet wallets для demo агентів (зроблю script — ти запустиш)
[ ] Mainnet міграція (наприкінці, якщо все стабільне)
```

---

# 🟢 Тиждень 1 — критичні setup-кроки

## 1. Supabase project (DATABASE_URL)

**Чому:** Postgres-база для агентів, транзакцій, reasoning logs, alerts. Free tier — 500 MB, достатньо для MVP.

### Кроки

1. Іди на **https://supabase.com** → "Start your project" → Sign in (GitHub OAuth найшвидше)
2. Натисни **"New Project"**
3. Заповни:
   - **Organization:** залиш default
   - **Name:** `agentscope`
   - **Database Password:** згенеруй сильний (зберігай у password manager — використається у DATABASE_URL)
   - **Region:** обери найближчий (для України — `eu-central-1` Frankfurt)
   - **Pricing Plan:** **Free**
4. Натисни **"Create new project"** → чекай ~2 хв поки provisioning
5. Коли готово:
   - Зайди у проект → лівий sidebar → **Settings** (іконка шестерні внизу)
   - **Database** → **Connection String** → таб **URI**
   - **Mode:** обери **"Transaction"** (port 6543, pooled — це важливо для serverless)
   - Натисни **"Copy"**
6. Скопіюй URL — це твій `DATABASE_URL`

### Що покласти у `.env`

```bash
DATABASE_URL=postgresql://postgres.xxx:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
```

Заміни `[YOUR-PASSWORD]` на реальний пароль (Supabase інколи лишає placeholder).

### Як перевірити

Запусти у терміналі (Git Bash):
```bash
psql "$(grep DATABASE_URL .env | cut -d'=' -f2-)" -c '\dt'
```
Має повернути порожній список таблиць (`Did not find any relations.`) — це нормально, ми ще не запускали міграції.

Якщо `psql` не встановлено — пропусти, перевірю я при першій міграції.

---

## 2. Helius account (Yellowstone gRPC)

**Чому:** Безкоштовний RPC + Yellowstone gRPC stream для real-time транзакцій з Solana. Free tier ~10 req/s + free Yellowstone gRPC доступ (з обмеженнями).

### Кроки

1. Іди на **https://helius.dev** → **"Start for Free"** / **"Sign Up"**
2. Sign in (GitHub OAuth найзручніше)
3. Після створення акаунта → **Dashboard**
4. **API Key:** скопіюй (формат `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
5. У лівому меню знайди **"gRPC"** або **"Yellowstone"** (інколи у "Streaming" чи "Geyser") — Helius по-різному називає у різних версіях UI:
   - Якщо є вкладка **"Geyser/gRPC"** → там endpoint URL та token (XToken або Bearer)
   - Якщо немає → перевір Pricing tab чи Yellowstone доступний на free. Якщо ні — fallback на звичайний WebSocket RPC (повільніше, але працює).

### Що покласти у `.env`

```bash
HELIUS_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
SOLANA_NETWORK=devnet
YELLOWSTONE_GRPC_URL=https://devnet.helius-rpc.com  # або реальний gRPC endpoint від Helius
YELLOWSTONE_GRPC_TOKEN=                              # x-token або Bearer, якщо Helius його видає
```

### Як перевірити

Зайди на **https://helius.dev** → Dashboard → бачиш свій request count = 0. Це OK.

⚠️ Якщо **Yellowstone gRPC недоступний на free tier** — повідом мені. Я зроблю fallback на стандартний JSON-RPC + WebSocket subscription (трохи повільніше, але працює без gRPC).

---

## 3. Privy app (Auth)

**Чому:** Web3-friendly auth для дашборду. Безкоштовно до 1000 MAU.

### Кроки

1. Іди на **https://dashboard.privy.io** → **"Sign In"** → GitHub OAuth
2. Натисни **"Create new app"**
3. Заповни:
   - **App name:** `AgentScope`
   - **Type:** обери **Web App**
4. Після створення → **Settings** → копіюй:
   - **App ID** (формат `cl....`)
   - **App Secret** (показується ОДИН раз, скопіюй негайно у password manager)
5. **Login methods** (sidebar) → увімкни:
   - ✅ Email
   - ✅ Embedded Wallets (Solana)
   - (опційно) Google OAuth
6. **Allowed origins** (sidebar) → додай:
   - `http://localhost:5173` (Vite dev server)
   - Пізніше додамо Vercel URL після деплою

### Що покласти у `.env`

```bash
PRIVY_APP_ID=cl1234567890abcdef
PRIVY_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Frontend (експонується у dashboard build)
VITE_PRIVY_APP_ID=cl1234567890abcdef
```

⚠️ `PRIVY_APP_SECRET` — це **сервер-сайд секрет**, **НІКОЛИ** не клади у `VITE_*` змінні (вони експонуються у browser bundle).

### Як перевірити

У dashboard.privy.io бачиш свій app зі статусом «Live» і MAU = 0.

---

## 4. Telegram bot (@BotFather)

**Чому:** Канал alerting'у у MVP (Discord/Slack — post-MVP).

### Кроки

1. Відкрий Telegram → знайди **`@BotFather`** (офіційний, з blue check)
2. Натисни **Start** → введи `/newbot`
3. На питання:
   - **"Alright, a new bot. How are we going to call it?"** → введи: `AgentScope Alerts` (або інше display name)
   - **"What about a username?"** → введи унікальний, має закінчуватися на `bot`, наприклад: `agentscope_alerts_bot` або `your_nick_agentscope_bot`
4. BotFather видасть повідомлення з **Token** (формат `123456789:ABCdef...`) → скопіюй
5. Тепер створи власний "personal" chat з ботом для тестів:
   - Натисни на лінк бота (BotFather дасть `t.me/your_bot_name`)
   - Натисни **Start**
   - Це створить chat
6. **Отримай свій chat_id:**
   - Відкрий у браузері (заміни TOKEN на свій): `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Знайди у JSON `"chat": {"id": 123456789, ...}` — це твій chat_id

### Що покласти у `.env`

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_DEFAULT_CHAT_ID=123456789
```

### Як перевірити

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -d "chat_id=<CHAT_ID>" \
  -d "text=AgentScope test"
```

Якщо у Telegram у боті прийшло "AgentScope test" — все працює.

---

## 5. GitHub repo

**Чому:** Версійний контроль, CI, місце для хакатонського submission.

### Кроки

1. Іди на **https://github.com/new**
2. Заповни:
   - **Repository name:** `agentscope`
   - **Description:** `Datadog for Solana AI agents — observability platform`
   - **Visibility:** **Public** (для submission має бути public)
   - **НЕ** додавай README, .gitignore, License (вони вже є локально)
3. Натисни **"Create repository"**
4. Скопіюй URL (наприклад `https://github.com/your-user/agentscope.git`)

### Що зробити локально

У терміналі з папки `C:\Users\Pasha\Desktop\AgentScope`:

```bash
git remote add origin https://github.com/your-user/agentscope.git
git push -u origin main
```

### Як перевірити

1. Зайди на `https://github.com/your-user/agentscope` → бачиш всі файли
2. Натисни **Actions** tab → CI workflow має запуститися автоматично
3. Якщо CI впав — повідом мені, я подивлюся

---

## 6. Створити `.env`

**Чому:** Один файл з усіма секретами (вже є `.gitignore`, не закомітиться).

### Кроки

```bash
cp .env.example .env
```

Відкрий `.env` у редакторі, заповни всі значення з кроків 1-4 вище.

**Перевірка:** має бути заповнено:
- `DATABASE_URL`
- `HELIUS_API_KEY` + `YELLOWSTONE_GRPC_URL` + `YELLOWSTONE_GRPC_TOKEN`
- `PRIVY_APP_ID` + `PRIVY_APP_SECRET` + `VITE_PRIVY_APP_ID`
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_DEFAULT_CHAT_ID`

`AGENTSCOPE_*_THRESHOLD` — лиши defaults з `.env.example`.

### Як перевірити

```bash
grep -v "^#" .env | grep -v "^$" | wc -l
```
Має бути ~10-12 рядків з заповненими значеннями.

---

# 🟡 Тиждень 5 — деплой (E9 у TASKS.md)

> Робимо коли MVP готовий і працює локально. Я допоможу з налаштуванням, ти просто клікаєш у dashboards.

## 7. Railway: API сервіс

**Чому:** Hosting для Hono API. Free tier: $5 credit/місяць (вистачає на MVP).

### Кроки

1. **https://railway.app** → Sign in з GitHub
2. **New Project** → **Deploy from GitHub repo** → обери `agentscope`
3. Після створення Railway автоматично спробує deploy. Він впаде, бо це monorepo. Налаштуй:
   - **Settings** → **Service** → **Root Directory:** `apps/api`
   - **Settings** → **Build** → **Build Command:** `pnpm install --frozen-lockfile && pnpm --filter @agentscope/api... build`
   - **Settings** → **Deploy** → **Start Command:** `node apps/api/dist/index.js`
4. **Variables** tab → Add all з твого `.env`:
   - `NODE_ENV=production`
   - `DATABASE_URL=...`
   - `HELIUS_API_KEY=...`
   - `YELLOWSTONE_GRPC_URL=...`
   - `YELLOWSTONE_GRPC_TOKEN=...`
   - `PRIVY_APP_ID=...`
   - `PRIVY_APP_SECRET=...`
   - `TELEGRAM_BOT_TOKEN=...`
   - `TELEGRAM_DEFAULT_CHAT_ID=...`
   - усі `AGENTSCOPE_*_THRESHOLD`
5. **Settings** → **Networking** → **Generate Domain** → отримаєш `agentscope-api.up.railway.app`

### Як перевірити

```bash
curl https://agentscope-api.up.railway.app/health
```
Має повернути `{"ok":true,...}`.

---

## 8. Railway: Ingestion worker

**Чому:** Background worker для Yellowstone gRPC — не має HTTP, лише читає stream і пише у БД.

### Кроки

1. У тому ж проекті Railway → **+ New** → **Empty Service**
2. **Service name:** `agentscope-ingestion`
3. **Settings** → **Source** → **Connect Repo** → той самий `agentscope`
4. **Settings** → **Service** → **Root Directory:** `apps/ingestion`
5. **Build Command:** `pnpm install --frozen-lockfile && pnpm --filter @agentscope/ingestion... build`
6. **Start Command:** `node apps/ingestion/dist/index.js`
7. **Variables:** скопіюй ті самі що у API сервісі (можна через "Shared Variables" у Project settings)

### Як перевірити

**Logs** tab → бачиш `ingestion worker started` та `received slot N`.

---

## 9. Railway: Cron job (alert evaluator)

**Чому:** Time-based правила (drawdown, error_rate, stale) запускаються раз на хвилину.

### Кроки

1. Той самий проект → **+ New** → **Empty Service**
2. **Service name:** `agentscope-cron`
3. **Settings** → **Source** → той самий repo, **Root Directory:** `apps/ingestion`
4. **Settings** → **Cron Schedule:** `*/1 * * * *` (кожна хвилина)
5. **Start Command:** `node apps/ingestion/dist/cron.js`
6. **Variables:** ті самі.

---

## 10. Vercel: Dashboard

**Чому:** Hosting для React SPA.

### Кроки

1. **https://vercel.com** → Sign in з GitHub
2. **Add New** → **Project** → Import `agentscope` repo
3. **Configure Project:**
   - **Framework Preset:** Vite
   - **Root Directory:** `apps/dashboard`
   - **Build Command:** `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @agentscope/dashboard... build`
   - **Output Directory:** `dist`
4. **Environment Variables:**
   - `VITE_API_BASE_URL=https://agentscope-api.up.railway.app`
   - `VITE_PRIVY_APP_ID=cl...`
5. **Deploy**
6. Після deploy → отримаєш `agentscope-dashboard.vercel.app`
7. **Поверни у Privy dashboard** → Allowed origins → додай `https://agentscope-dashboard.vercel.app`

### Як перевірити

Відкрий URL → побачиш login сторінку → залогінься через Privy → побачиш порожній agent list (бо ще не реєстрував агентів).

---

## 11. Vercel: Landing page

**Чому:** Окремий деплой, окремий repo path. Astro static site.

### Кроки

1. Vercel → **Add New** → **Project** → знову той самий `agentscope` repo (так, можна двічі)
2. **Framework Preset:** Astro
3. **Root Directory:** `apps/landing`
4. **Build Command:** `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @agentscope/landing... build`
5. **Output Directory:** `dist`
6. **Project Name:** `agentscope-landing` (щоб URL був `agentscope.vercel.app` або `agentscope-landing.vercel.app`)
7. **Deploy**

---

## 12. Submission на Colosseum

**Чому:** Це і є мета.

### Кроки (за день до дедлайну, 2026-05-10 → 11)

1. Перевір що все працює end-to-end
2. Іди на **https://colosseum.org** → твій акаунт → **Submit**
3. Заповни форму:
   - **Project name:** AgentScope
   - **Tagline:** Datadog for Solana AI agents
   - **Description:** (з `docs/SPEC.md` §1-2)
   - **Track:** AI
   - **Demo video:** YouTube URL з 9.10
   - **GitHub repo:** `https://github.com/your-user/agentscope`
   - **Live demo:** `https://agentscope.vercel.app`
   - **Pitch deck:** Google Drive PDF з 9.12
4. **Submit**

---

# 🔵 Опційні / пізніше

## Devnet wallets для demo агентів (Тиждень 5)

Я напишу `scripts/setup-devnet-wallets.ts`. Ти запустиш:
```bash
pnpm tsx scripts/setup-devnet-wallets.ts
```
- Згенерує 3 keypair у `wallets/` (вже у `.gitignore`)
- Зробить airdrop devnet SOL з https://faucet.solana.com (інколи rate-limited)

## Mainnet міграція

**Робимо ТІЛЬКИ після того як на devnet все стабільне ≥ 24 год.**

1. У `.env` → `SOLANA_NETWORK=mainnet`
2. Заміни `YELLOWSTONE_GRPC_URL` на mainnet endpoint від Helius
3. Перезапусти ingestion worker
4. Зареєструй РЕАЛЬНИЙ агент (свій або тестовий)
5. Спостерігай 1 годину → якщо OK, готово до пітчу

⚠️ **НЕ деплой реальних агентів з реальними коштами без явного дозволу.** На demo вистачить тестових агентів зі стандартними сумами (0.001 SOL = ~$0.20).

## npm publish (post-hackathon)

Поки `@agentscope/elizaos-plugin` встановлюється через GitHub:
```bash
pnpm add github:your-user/agentscope#main/packages/elizaos-plugin
```

Після хакатону, якщо є інтерес — створимо npm org `@agentscope` і опублікуємо.

---

# Безпека (важливо!)

- **НІКОЛИ** не комітай `.env`, `*.keypair.json`, паролі. `.gitignore` це enforce, але перевіряй `git status` перед `git push`.
- **НЕ викладай** Privy `App Secret` ніде окрім server-side env vars. Він дає повний доступ до твого Privy app.
- **Telegram bot token** — якщо втік, негайно через `@BotFather` → `/revoke` → новий.
- **Database password** — якщо втік, Supabase Dashboard → Settings → Database → **Reset password**.
- **Helius API key** — Dashboard → API Keys → **Revoke** → новий.

---

# Що мені сказати після setup

Коли все зроблено, напиши мені:
> «Setup готовий, .env заповнений»

Я перевірю і запущу тестове підключення до Supabase (через `db:push`) щоб переконатися, що все працює.

---

**Питання чи не вдається якийсь крок?** — пиши, розберемось разом.
