# AgentScope — повний опис проекту

> **Datadog для Solana AI агентів**
> Платформа моніторингу та observability для on-chain AI агентів на Solana.

---

## 1. Загальна інформація

| Параметр | Значення |
|---|---|
| **Назва** | AgentScope |
| **Трек** | AI |
| **Хакатон** | Solana Frontier (Colosseum) |
| **Складність** | Medium |
| **TOTAL Score** | **85.6 / 100** |
| **Run** | Run_5 (2026-04-03) |
| **Risk (Copilot Scan)** | LOW (top similarity 0.047) |
| **Конкурентів знайдено** | 6 (жодних переможців серед них) |

### Оцінки суддів

| Критерій | Бал | Коментар |
|---|---|---|
| **Innovation** | 82 | Solana-специфічний AI agent monitoring — нова концепція. Поєднання on-chain transaction traces з AI reasoning logs ніхто не зробив. |
| **Vibe-coding fit** | 88 | Yellowstone gRPC та React dashboards — стандартні задачі. ElizaOS та Solana Agent Kit добре задокументовані. PostgreSQL + TypeScript = stable stack. |
| **Prize fit** | 85 | Ідеально відповідає AI track та 2026 narrative (agent economy). Demo візуально вражаюче навіть для не-технічних суддів. |
| **Market** | 90 | 9000+ агентів вже задеплоєно, $45M breach через відсутність моніторингу, ElizaOS 17,600+ GitHub stars. |
| **Competition** | 82 | Solana-специфічного monitoring не існує. Ризик: інші команди можуть бачити ту саму можливість. |
| **Post-Hackathon** | 88 | Datadog/New Relic модель для нового computing paradigm. Datadog сягнула $40B+ market cap. |

---

## 2. Проблема

**Критична прогалина в інфраструктурі Solana AI agent економіки:**

- **9000+ AI агентів** вже задеплоєно на Solana (Alchemy, 2026)
- **Solana Foundation exec прогнозує**: 99.99% on-chain транзакцій у майбутньому виконуватимуть агенти (Cryptobriefing, 2026)
- **77% x402 транзакцій** на Solana вже від агентів (Alchemy, 2026)
- **$45M breach** AI Trading Agent через відсутність моніторингу (KuCoin, 2026)
- **ElizaOS** має 17,600+ GitHub stars — масова adoption фреймворку

**Аналогія**: Це як мати Kubernetes без Prometheus та Grafana.

Існуючі AI observability інструменти (**Braintrust, Langfuse, Arize**) моніторять LLM calls, але **не on-chain транзакції**. Solana Agent Registry запущено на mainnet, але **жодного моніторинг-шару** для нього не існує.

---

## 3. Рішення — AgentScope

**Платформа моніторингу та observability для AI агентів на Solana**, яка надає:

1. **Реєстр агентів** — кожен агент отримує унікальний ідентифікатор
2. **Трасування on-chain дій** — усі транзакції, свапи, deposits, NFT операції
3. **Аналіз reasoning chains** — логи прийнятих агентом рішень
4. **Metrics & costs** — газ, fees, success rate, latency
5. **Алертинг аномальної поведінки** — webhook сповіщення про підозрілі патерни
6. **Dashboard продуктивності** — Grafana-рівень візуалізації для agent економіки

### Підтримувані фреймворки

- **ElizaOS** — автоматична інструментація через plugin
- **Solana Agent Kit** — SDK integration
- **Custom agents** — через REST/SDK API

---

## 4. Технічна архітектура

### Стек

| Шар | Технологія | Призначення |
|---|---|---|
| **Backend** | TypeScript / Node.js | API, обробка подій, бізнес-логіка |
| **On-chain stream** | Yellowstone gRPC | Real-time transaction streaming |
| **Database** | PostgreSQL | Зберігання traces, агентів, метрик |
| **Frontend** | React + Recharts | Дашборди, графіки, leaderboards |
| **Alerting** | Webhooks (Discord/Telegram/Slack) | Сповіщення про аномалії |
| **SDK** | Solana Agent Kit, ElizaOS plugins | Збір reasoning logs |

### Високорівнева архітектура

```
┌──────────────┐    ┌──────────────────┐    ┌─────────────┐
│  Solana RPC  │───▶│  Yellowstone     │───▶│  Ingestion  │
│  (mainnet)   │    │  gRPC stream     │    │  Worker     │
└──────────────┘    └──────────────────┘    └──────┬──────┘
                                                    │
       ┌────────────────────────────────────────────┤
       ▼                                            ▼
┌─────────────┐                            ┌──────────────┐
│ ElizaOS /   │  reasoning logs (HTTPS)    │  PostgreSQL  │
│ Agent Kit   │───────────────────────────▶│  (traces)    │
│ plugins     │                            └──────┬───────┘
└─────────────┘                                   │
                                                  ▼
                      ┌────────────────┐  ┌──────────────┐
                      │  Anomaly       │  │  React       │
                      │  Detector      │  │  Dashboard   │
                      └───────┬────────┘  └──────────────┘
                              │
                              ▼
                      ┌────────────────┐
                      │  Webhook       │
                      │  Alerts        │
                      └────────────────┘
```

### Ключові компоненти

#### 4.1 Ingestion Worker
- Підписка на Yellowstone gRPC stream
- Фільтрація транзакцій від зареєстрованих агентів (за wallet/programId)
- Парсинг instruction data, balance changes, logs
- Запис у PostgreSQL (партиціонована таблиця `agent_transactions`)

#### 4.2 Agent Registry
- Реєстрація агента (wallet pubkey + metadata)
- Інтеграція з Solana Agent Registry (on-chain)
- Tagging: framework (ElizaOS / Agent Kit / custom), тип (trader / yield / NFT)

#### 4.3 Reasoning Collector
- HTTP endpoint для прийому reasoning logs з агента
- Кореляція reasoning_id ↔ on-chain tx signature
- Зберігання chain-of-thought, model prompts, decision trees

#### 4.4 Anomaly Detector
- Базові правила: spike у gas usage, незвичайні протоколи, drawdown thresholds
- Phase 2: ML-модель на історичних даних
- Виклик webhook при тригері

#### 4.5 React Dashboard
- Список агентів + статуси (live / stale / failed)
- Per-agent view: timeline транзакцій, reasoning chain, metrics
- Real-time updates через Server-Sent Events або WebSocket
- Recharts для time series графіків

---

## 5. Бізнес-модель

### Freemium SaaS

| Тариф | Ціна | Ліміти |
|---|---|---|
| **Free** | $0 | До 10 агентів, 7 днів історії, базові алерти |
| **Pro** | $49/міс | До 100 агентів, 90 днів історії, custom алерти, API |
| **Enterprise** | $499/міс | Unlimited агенти, 1 рік історії, SSO, SLA, dedicated support |

### Додаткові потоки

- **Партнерство з ElizaOS / Solana Agent Kit** — офіційний моніторинг-партнер
- **API для страхових протоколів** — agent risk scoring як платний endpoint
- **Decentralized version** — потенційний токен для on-chain reputation layer

---

## 6. WOW-демо для суддів

**Сценарій live демо (3-4 хвилини):**

1. **Запускаємо 3 тестових агента** на devnet:
   - Trading agent (свапи на Jupiter)
   - Yield farming agent (Kamino / MarginFi deposits)
   - NFT buyer (Tensor / Magic Eden)

2. **Real-time дашборд** показує:
   - Кожен свап у момент виконання
   - Reasoning chain під кожною транзакцією
   - Газ, slippage, P&L

3. **Симуляція аномалії**: один з агентів починає робити некоректні свапи (бажаний slippage 50%)

4. **AgentScope моментально**:
   - Підсвічує агента червоним
   - Шле webhook у Discord
   - Показує root cause: "Slippage 50x exceeds threshold"

5. **Висновок**: судді бачать **Grafana-рівень observability для agent економіки**.

---

## 7. Pitch (для жюрі)

> **AgentScope — Datadog для Solana AI агентів.**
>
> Коли 99% on-chain транзакцій виконуватимуть агенти, observability стає критичною інфраструктурою. $45M хак через відсутність моніторингу — ми це виправляємо.

---

## 8. Чому Solana?

| Причина | Деталі |
|---|---|
| **Лідер AI agent економіки** | 77% x402 транзакцій (Alchemy, 2026) |
| **Agent Registry на mainnet** | Унікальна Solana-only інфраструктура |
| **Sub-400ms finality** | Real-time моніторинг без затримок |
| **Паралельне виконання** | Унікальні патерни агент-транзакцій (multi-tx batching) |
| **Yellowstone gRPC** | Найкраща в індустрії стрімінгова інфраструктура |

---

## 9. Конкуренти

### Прямі (загальні AI observability)
- **Braintrust** — LLM evaluations, без on-chain
- **Langfuse** — LLM tracing, без blockchain context
- **Arize** — ML monitoring, не Solana-aware

### Непрямі (Solana explorers)
- **Solana Explorer / Solscan / Helius Explorer** — бачать транзакції, але не розуміють контекст агентів та не корелюють з reasoning chains

### З Copilot Scan (similarity)
| Конкурент | Хакатон | Sim | Опис |
|---|---|---|---|
| Solaigent | Renaissance | 0.047 | AI agent для real-time on-chain даних та smart contract assist (це **інше**: dev tooling, не monitoring) |
| AgentRunner | Cypherpunk | 0.032 | Agentic orchestration для DeFi (це **інше**: execution, не observability) |
| Solana DEV AI Helper | Breakout | 0.032 | AI dev assistant (це **інше**: developer tool, не runtime monitoring) |

**Висновок**: жоден прямий конкурент не існує. Risk = LOW.

---

## 10. Дорожня карта розробки (5 тижнів до хакатону)

### Тиждень 1 — Foundation
- [ ] Налаштування репо, monorepo (Turborepo / pnpm workspaces)
- [ ] PostgreSQL schema: `agents`, `transactions`, `reasoning_logs`, `alerts`
- [ ] Yellowstone gRPC підключення (devnet + mainnet)
- [ ] Базовий Ingestion Worker — запис raw транзакцій у БД
- [ ] CI/CD pipeline (GitHub Actions)

### Тиждень 2 — Backend Core
- [ ] Agent Registry API (CRUD)
- [ ] Парсинг інструкцій основних протоколів (Jupiter, Kamino, Tensor, Marinade)
- [ ] Reasoning Collector HTTP endpoint
- [ ] Кореляція reasoning ↔ tx
- [ ] Базові метрики: success rate, gas spend, P&L tracking

### Тиждень 3 — Dashboard MVP
- [ ] React app + Tailwind + Recharts
- [ ] Список агентів + статуси
- [ ] Per-agent timeline (транзакції + reasoning)
- [ ] Real-time updates (SSE)
- [ ] Auth (Privy / Supabase)

### Тиждень 4 — Alerting + Integrations
- [ ] Anomaly Detector (rule-based)
- [ ] Webhook delivery (Discord, Telegram, Slack)
- [ ] **ElizaOS plugin** для авто-інструментації
- [ ] **Solana Agent Kit** SDK helper
- [ ] Документація + quickstart guide

### Тиждень 5 — Polish + Demo
- [ ] Тестові агенти для демо (trader / yield / NFT)
- [ ] Записаний live-демо ролик (3-4 хв)
- [ ] Landing page
- [ ] Pitch deck (10 слайдів)
- [ ] Submission на Colosseum

---

## 11. Структура репозиторію

```
agentscope/
├── apps/
│   ├── ingestion/         # Yellowstone gRPC worker
│   ├── api/               # REST API (Fastify / Hono)
│   ├── dashboard/         # React frontend
│   └── docs/              # Mintlify docs site
├── packages/
│   ├── db/                # Drizzle ORM schemas + migrations
│   ├── parser/            # Solana instruction parsers
│   ├── detector/          # Anomaly detection rules
│   ├── elizaos-plugin/    # ElizaOS integration
│   └── agent-kit-sdk/     # Solana Agent Kit helpers
├── infra/
│   ├── docker-compose.yml
│   └── terraform/         # (post-hackathon)
├── .github/workflows/
└── README.md
```

---

## 12. Key Risks & Mitigation

| Ризик | Mitigation |
|---|---|
| Інші команди роблять схоже на хакатоні | Швидкий реліз ElizaOS plugin, акцент на DX |
| Yellowstone rate limits на free plan | Helius / Triton як backup, кешування |
| Складність парсингу всіх протоколів | Покрити TOP-5 (Jupiter, Kamino, MarginFi, Tensor, Marinade) на хакатоні |
| Reasoning logs schema варіюється | Гнучкий JSON schema + опціональні поля |
| Cold start (мало агентів спочатку) | Партнерство з ElizaOS до запуску, demo agents |

---

## 13. Метрики успіху

### Хакатон
- **MVP працює** з 3+ реальними агентами на mainnet
- **Demo video** ≤ 4 хв з WOW-моментом
- **GitHub repo** з документацією та quickstart < 5 хв
- **TOP-10** на AI track Colosseum Frontier

### Post-hackathon (3-6 місяців)
- 100+ зареєстрованих агентів
- 10+ paying customers ($49+)
- Офіційне партнерство з ElizaOS або Solana Agent Kit
- $250K seed grant (Colosseum accelerator)

---

## 14. Джерела (для пітч-деку та research)

- **Alchemy 2026 Solana AI Report**: 9000+ агентів, 77% x402
- **Cryptobriefing 2026**: Solana Foundation exec — 99.99% tx by agents
- **KuCoin 2026**: $45M AI Trading Agent breach
- **ElizaOS GitHub**: 17,600+ stars
- **Solana Agent Registry**: mainnet launch (2026)

---

## 15. Наступні кроки (конкретні дії)

1. **Створити репо** `agentscope` (monorepo, pnpm + Turborepo)
2. **PostgreSQL schema** — `agents`, `transactions`, `reasoning_logs`, `alerts`
3. **Yellowstone gRPC POC** — підписатися на devnet, логувати tx у консоль
4. **Зареєструватися на Colosseum Frontier** як solo team
5. **Створити Discord / X для проекту** (для community building)
6. **Звернутися до ElizaOS team** щодо partnership (Discord / X DM)

---

*Згенеровано на основі: `output/excel/colosseum-frontier/Копія results_2026-04-03.xlsx` (Run_5, 2026-04-03)*
