# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A much more detailed agent guide already exists at [AGENTS.md](AGENTS.md) — read it for full architecture, API route inventory, and trading-strategy specifics. This file only highlights what is most load-bearing day-to-day.

## Commands

```bash
npm install            # install deps
npm run dev            # run dev server (tsx server.ts) — Vite SPA middleware is embedded in server.ts, so this is the only process for both API and frontend
npm run lint           # tsc --noEmit — the only available check, there is no test suite
npm run build          # vite build (dist/) + esbuild bundles server.ts -> dist/server.cjs
npm start              # node dist/server.cjs (production)
npm run clean          # rm -rf dist server.js

docker compose up -d --build   # local stack: app + postgres:16-alpine, host port 8080 -> container 3000
```

There is no test runner, linter, or formatter configured. `tsc --noEmit` is the only verification step. For UI changes, run `npm run dev` and inspect the dashboard in a browser — there is no automated way to confirm the bot's behavior.

## Architecture — the two big files

The codebase is **intentionally a monolith**. Almost everything lives in two files:

- [server.ts](server.ts) (~2.3k lines) — entire backend: Postgres pool + `runMigrations()`, CCXT `binanceusdm` client, DeepSeek AI client, technical indicator math, three strategy `calculate*Signal` functions, in-memory candle buffers fed by a Binance Futures WebSocket kline stream, market-context fetchers (funding / F&G / OI / L:S ratio), `checkAutoExecute()` filter chain, mock-trade monitor for keyless mode, position sync against Binance, PnL snapshots, Express API routes, and a walk-forward backtest engine.
- [src/App.tsx](src/App.tsx) (~2k lines) — entire dashboard UI: header, strategy toggles, scanner grid, PnL chart, market sentiment, activity log, auto-pilot toggle, plus Positions / History / Backtest modals. State is `useState` + 10-second polling. No router, no component folder.

When adding features, follow the monolith preference: new API routes go into the "API Routes" section of `server.ts`, new UI goes into `App.tsx`. Do not break these up into many small files unless the user explicitly asks for a refactor.

## Three strategies, one signal pipeline

Three concurrent strategies run per-symbol on different timeframes — see `calculateSignal` (1m ULTRA-SCALP), `calculateMomentumSignal` (5m MOMENTUM-ARB), and `calculateMeanRevSignal` (15m MEAN-REV) in [server.ts](server.ts). Each has its own cooldown (5/15/30 min) and its own SL/TP multipliers in `bot_settings`. MOMENTUM-ARB is the only one that requires the 15m EMA200 trend filter.

All three then pass through the shared `checkAutoExecute()` filter chain (volume, funding rate, F&G, OI change, L:S ratio, VWAP, cooldown) before an order is placed. If you change a filter there, it affects every strategy.

## Database — auto-migrating Postgres

Schema baseline is [db/init.sql](db/init.sql). The server auto-runs migrations on startup inside `runMigrations()` in [server.ts](server.ts) using `ALTER TABLE ... IF NOT EXISTS` patterns. **When changing the schema, you must update both** `db/init.sql` (for fresh deploys) **and** `runMigrations()` (for existing deployments) — otherwise the VPS will break on next deploy.

Tables: `trades`, `pnl_snapshots`, `bot_settings` (single row, `id = 'bot_config'`), `ohlcv` (persisted 1m/5m/15m candles powering the backtest endpoint).

Ignore [BACKEND_DB_GUIDE.md](BACKEND_DB_GUIDE.md) — it describes a Firestore design that was never implemented.

## Live vs mock mode

Without `BINANCE_API_KEY` / `BINANCE_SECRET_KEY`, the bot runs in mock mode: balance is hardcoded to 10k USDT and a `runMockTradeMonitor` interval simulates TP/SL fills against live prices. With keys, real market orders are placed with native TP (`priceProtect: true`, `workingType: "MARK_PRICE"`) and trailing stop; closes always use `reduceOnly: true`. `syncPositionsFromBinance()` runs every 60s to reconcile DB rows against the actual exchange — this is how native TP/SL fills get recorded as closed trades.

Frontend `GEMINI_API_KEY` (referenced in [vite.config.ts](vite.config.ts)) is a leftover from the AI Studio template; runtime AI confirmation uses `DEEPSEEK_API_KEY` via `callDeepSeek()` in `server.ts`.

## Conventions

- TypeScript ESM (`"type": "module"`). Path alias `@/*` maps to repo root.
- Pragmatic typing — `as any` is common around CCXT response shapes. Don't fight it.
- Comments are mixed English / Indonesian; keep them short.
- No auth on API routes — assume trusted local/private network. Don't expose port 3000 publicly without a reverse proxy.
- Vite dev server respects `DISABLE_HMR=true` (used in AI Studio) to suppress file watching during agent edits — don't override.

## Deploy

Push to `master` triggers `.github/workflows/deploy.yml`, which SSHes into the VPS and runs `docker compose up -d --build`. Required repo secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PROJECT_PATH`.
