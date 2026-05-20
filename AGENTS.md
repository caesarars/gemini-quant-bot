# AGENTS.md — Gemini Quant Bot

This file is for AI coding agents. It describes the project architecture, conventions, and commands so you can work effectively without prior context.

---

## Project Overview

**Gemini Quant Bot** (frontend branded as *NEXUSBOT.v4*) is an AI-assisted cryptocurrency futures trading bot. It scans multiple Binance USDM Futures assets in real-time, runs three concurrent trading strategies, and can auto-execute market orders with native Take-Profit and Trailing-Stop-Loss orders. Without Binance API keys, it falls back to a simulation/mock mode.

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4 + Recharts
- **Backend**: Express.js in a single TypeScript file (`server.ts`)
- **Database**: PostgreSQL (schema in `db/init.sql`)
- **Exchange**: Binance USDM Futures via CCXT
- **AI**: DeepSeek API (`deepseek-chat`) for trade confirmation
- **Deployment**: Docker multi-stage build + Docker Compose + GitHub Actions VPS deploy

---

## Technology Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 20 |
| Frontend Framework | React 19, React Router DOM 7 |
| Build Tool | Vite 6 |
| Bundler (server) | esbuild |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Charts | Recharts |
| Icons | Lucide React |
| Animation | `motion` (Framer Motion) |
| Server | Express 4 |
| DB Driver | `pg` (PostgreSQL) |
| Exchange SDK | CCXT |
| WebSocket | `ws` |
| AI Client | DeepSeek REST API |
| Dev Runner | `tsx` |

---

## Project Structure

```
.
├── server.ts              # Entire backend (~1600 lines): API, strategies, WS, DB, backtest
├── src/
│   ├── App.tsx            # Entire frontend UI (~1300 lines): dashboard, modals, scanner
│   ├── main.tsx           # React entry point (StrictMode)
│   ├── index.css          # Tailwind theme + custom scrollbar + dark trading palette
│   └── lib/
│       └── utils.ts       # `cn(...)` helper merging clsx + tailwind-merge
├── db/
│   └── init.sql           # PostgreSQL schema, indexes, seed data
├── package.json           # npm scripts & dependencies
├── tsconfig.json          # TypeScript (ES2022, bundler, path alias `@/*`)
├── vite.config.ts         # Vite + React + Tailwind; HMR controlled by DISABLE_HMR
├── docker-compose.yml     # App + postgres:16-alpine services
├── Dockerfile             # Multi-stage Node 20 Alpine build
├── .github/workflows/
│   └── deploy.yml         # GitHub Action: SSH to VPS, git pull, docker compose up -d --build
├── .env.example           # Required env vars template
├── BACKEND_DB_GUIDE.md    # Outdated Firestore design doc (not the current implementation)
└── metadata.json          # AI Studio app metadata
```

**Note**: The codebase is intentionally concentrated in two large files (`server.ts` and `src/App.tsx`). There is no formal router file or component folder breakdown.

---

## Build and Run Commands

```bash
# Install dependencies
npm install

# Development (runs server.ts via tsx; Vite SPA middleware is embedded in server.ts)
npm run dev

# Type-check only (no emit)
npm run lint

# Production build
# 1. Vite builds frontend to dist/
# 2. esbuild bundles server.ts to dist/server.cjs
npm run build

# Start production server
npm start

# Clean build artifacts
npm run clean
```

### Local Docker

```bash
# Copy and fill env
cp .env.example .env

# Build and run app + postgres
docker compose up -d --build
```

The app container exposes port `3000` internally; Docker Compose maps host `8080` to container `3000`.

---

## Environment Variables

See `.env.example` for the canonical list:

| Variable | Purpose |
|----------|---------|
| `DEEPSEEK_API_KEY` | DeepSeek AI analysis endpoint |
| `BINANCE_API_KEY` / `BINANCE_SECRET_KEY` | Binance USDM Futures trading. Empty = mock/sim mode. |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | PostgreSQL connection |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional trade notifications |
| `APP_URL` | Optional self-referential URL |

`GEMINI_API_KEY` is also referenced by the Vite config (`process.env.GEMINI_API_KEY`) for the frontend build, but the runtime AI confirmation uses DeepSeek.

---

## Database Schema (PostgreSQL)

The app auto-runs migrations on startup inside `runMigrations()` in `server.ts`. The base schema is in `db/init.sql`.

**Tables**:
- `trades` — executed trades (OPEN / CLOSED), with `symbol`, `type`, `entry_price`, `exit_price`, `pnl`, `amount`, `strategy`, `leverage`, `fee_usdt`, `timestamp`
- `pnl_snapshots` — hourly portfolio snapshots (`timestamp`, `total_value`, `pnl_percent`)
- `bot_settings` — single-row config (`id = 'bot_config'`) storing `is_auto_pilot`, `risk_level`, `max_slippage`, `leverage`, `take_profit_pct`, `stop_loss_pct`, `atr_sl_mult`, `atr_tp_mult`, `arb_sl_mult`, `arb_tp_mult`, `mr_sl_mult`, `mr_tp_mult`, `active_strategies`, `symbols`
- `ohlcv` — persisted candles per `symbol` + `timeframe` (`1m`, `5m`, `15m`)

---

## Code Organization

### Backend (`server.ts`)

Organized top-to-bottom in these sections:
1. **Database** — `Pool` setup, `runMigrations()`
2. **Exchange** — CCXT `binanceusdm` client init
3. **AI** — `callDeepSeek()` helper
4. **Technical Indicators** — `calcEMA`, `calcRSI`, `calcMACD`, `calcBollingerBands`, `calcATR`, `calcVolumeRatio`, `calcVWAP`
5. **Strategy Signals** — `calculateSignal` (1m ULTRA-SCALP), `calculateMomentumSignal` (5m), `calculateMeanRevSignal` (15m)
6. **OHLCV Persistence** — `saveOHLCV()`
7. **Scanner State** — in-memory buffers (`candleBuffer`, `momentumBuffer`, `trendBuffer`), action trackers, `activeStrategies` Set
8. **Trend Filter** — EMA200 on 15m (`getTrend`)
9. **Risk / Context** — `safeTpPrice`, `calcContextMultipliers`
10. **Auto-Execution** — `checkAutoExecute()` with volume, funding, fear & greed, OI, L/S ratio, cooldown filters
11. **WebSocket** — Binance Futures kline stream (`initWebSocket`), `seedCandleBuffer()`
12. **Mock Trade Monitor** — simulates TP/SL when no API keys (`runMockTradeMonitor`)
13. **Market Context** — `fetchFundingRates`, `fetchFearGreed`, `fetchFuturesData` (OI + L/S ratio)
14. **Telegram** — `sendTelegram()`
15. **Position Sync** — `syncPositionsFromBinance()` reconciles DB with actual exchange positions
16. **PnL Snapshot** — `takePnLSnapshot()`
17. **API Routes** — Express routes (see below)
18. **Backtest Engine** — walk-forward backtest on persisted 1m OHLCV (`/api/backtest`)
19. **Startup** — `startServer()` connects DB, loads markets, seeds buffers, starts WS and intervals

### Key API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/scan` | Real-time scanner results per symbol |
| GET | `/api/market-context` | Funding rates, F&G, OI, L/S ratios |
| GET | `/api/cooldown-status` | Per-symbol/strategy cooldown state |
| GET | `/api/open-positions` | DB open positions enriched with live prices |
| POST | `/api/close-position/:id` | Close one position (market order if live) |
| POST | `/api/close-all-positions` | Close all open positions |
| POST | `/api/sync-positions` | Manual Binance position sync trigger |
| GET / POST | `/api/settings` | Read / update bot settings |
| GET | `/api/balance` | Futures balance (mock = 10k USDT if no keys) |
| GET | `/api/pnl-history` | Portfolio snapshots for chart |
| DELETE | `/api/pnl-history` | Clear PnL history (optional `?above=`) |
| GET | `/api/trade-history` | Last 50 trades |
| POST | `/api/execute` | Manually record a trade |
| POST | `/api/ai-confirm` | Ask DeepSeek for a BUY/SELL/WAIT verdict |
| GET | `/api/ohlcv/:symbol` | Historical candles from DB |
| GET | `/api/backtest` | Walk-forward backtest on DB candles |
| POST | `/api/test-trade` | Force a test order for a symbol/strategy |
| GET | `/api/diagnose` | Real-time per-symbol filter state dump |

### Frontend (`src/App.tsx`)

Single-component dashboard with these major UI areas:
- **Header** — branding, API status, balance, Positions/History/Backtest buttons
- **Left Sidebar** — strategy toggles (ULTRA-SCALP, MOMENTUM-ARB, MEAN-REV), PnL line chart, stat boxes
- **Middle** — scanner grid cards per symbol, each showing 1m/5m/15m signals, funding rate, OI, L/S, VWAP
- **Right Sidebar** — market sentiment (Fear & Greed, avg funding), bot activity log, auto-pilot toggle, emergency kill button
- **Modals** — Open Positions (with close/close-all), Trade History, Backtest

State is managed with `useState`/`useEffect`. Data refreshes every 10 seconds via polling.

---

## Trading Strategies

1. **ULTRA-SCALP** (1m)
   - Indicators: RSI, MACD, Bollinger Bands, EMA9/21, Volume Ratio, ATR
   - No trend filter (scalps are too short for 15m trend)
   - Cooldown: 5 minutes per symbol

2. **MOMENTUM-ARB** (5m)
   - Signal: Fresh EMA9/21 crossover confirmed by RSI
   - Trend filter required (UP for BUY, DOWN for SELL)
   - Cooldown: 15 minutes per symbol

3. **MEAN-REV** (15m)
   - Signal: Bollinger Band touch + RSI extreme
   - No trend filter (designed for range/neutral markets)
   - Volume threshold: 0.8× (lower than others)
   - Cooldown: 30 minutes per symbol

All strategies share market context filters: funding rate, Fear & Greed index, Open Interest change, Long/Short ratio, and VWAP discount/premium.

---

## Development Conventions

- **Language**: TypeScript with ES modules (`"type": "module"` in `package.json`).
- **Path alias**: `@/` maps to the project root (`./`). Used in imports like `import App from './App.tsx'` and `@/` for potential root-level imports.
- **Types**: Many variables are typed inline or use `as any` for CCXT responses. Be pragmatic rather than strict when touching exchange data shapes.
- **Comments**: Primarily English, with occasional Indonesian phrases (e.g., `hanya tepat di EMA200`, `Close semua posisi`). Do not assume a single language; keep comments clear and concise.
- **Formatting**: No Prettier or ESLint config is present. The project relies on `tsc --noEmit` for type checking.
- **Monolith preference**: New UI features tend to be added directly into `src/App.tsx`. New backend logic tends to be added into `server.ts` in the relevant section. Avoid creating many small files unless the user explicitly asks for a refactor.

---

## Testing

There is **no test suite** currently configured. The project has no `jest`, `vitest`, or `playwright` setup.

Ways to verify behavior:
- Run `npm run lint` to type-check.
- Use `npm run dev` and inspect the dashboard.
- Use the `/api/diagnose` endpoint to inspect per-symbol filter states.
- Use `POST /api/test-trade` to force a strategy evaluation.

---

## Deployment

### Docker (Production)

The `Dockerfile` uses a two-stage build:
1. **Builder**: `npm ci` → `npm run build`
2. **Runner**: `npm ci --omit=dev` + copy `dist/` → `node dist/server.cjs`

### CI/CD

`.github/workflows/deploy.yml` triggers on push to `master`. It SSHs into a VPS, pulls code, and runs `docker compose up -d --build`.

Required repository secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PROJECT_PATH`.

---

## Security Considerations

- **No built-in auth** on API endpoints. The app assumes it runs in a trusted local or private network. Do not expose port 3000 directly to the public internet without a reverse proxy + auth.
- **API keys** are loaded from `.env`. The file is protected and should never be committed.
- **Binance orders** use `reduceOnly: true` when closing to prevent accidentally flipping direction.
- **Take-profit orders** use `priceProtect: true` and `workingType: "MARK_PRICE"`.
- **Trailing stop** uses `workingType: "MARK_PRICE"`.
- **Position sync** runs every 60 seconds to detect native TP/SL fills and close DB records.

---

## Quick Reference for Agents

- **Need to add an API route?** Add it in the "API Routes" section of `server.ts`.
- **Need to add a UI panel?** Add it inside `src/App.tsx`; follow the existing Tailwind class naming (e.g., `bg-trading-card`, `border-trading-border`).
- **Need to change strategy logic?** Modify the `calculateSignal`, `calculateMomentumSignal`, or `calculateMeanRevSignal` functions in `server.ts`.
- **Need to change DB schema?** Update `db/init.sql` **and** add a corresponding `ALTER TABLE ... IF NOT EXISTS` migration inside `runMigrations()` in `server.ts` so existing deployments auto-migrate.
- **Need to change env vars?** Update `.env.example` and the startup/config code in `server.ts`.
