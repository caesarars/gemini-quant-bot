import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — @types/ws installed in Docker via npm ci
import WebSocket from "ws";
import ccxt from "ccxt";
import * as dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const app = express();
const PORT = 3000;
app.use(express.json());

// ── Database ───────────────────────────────────────────────────────────────────

const pool = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME     || "quantbot",
  user:     process.env.DB_USER     || "quantbot",
  password: process.env.DB_PASSWORD || "",
});

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ohlcv (
      id        SERIAL      PRIMARY KEY,
      symbol    VARCHAR(20) NOT NULL,
      timeframe VARCHAR(10) NOT NULL DEFAULT '1m',
      timestamp BIGINT      NOT NULL,
      open      NUMERIC(20, 8) NOT NULL,
      high      NUMERIC(20, 8) NOT NULL,
      low       NUMERIC(20, 8) NOT NULL,
      close     NUMERIC(20, 8) NOT NULL,
      volume    NUMERIC(30, 8) NOT NULL,
      UNIQUE (symbol, timeframe, timestamp)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_ts ON ohlcv (symbol, timeframe, timestamp DESC)`);
  await pool.query(`ALTER TABLE trades      ADD COLUMN IF NOT EXISTS leverage        INTEGER       DEFAULT 1`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS leverage       INTEGER       DEFAULT 10`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS take_profit_pct NUMERIC(5,2) DEFAULT 1.5`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS stop_loss_pct   NUMERIC(5,2) DEFAULT 0.8`);
}

// ── Exchange ───────────────────────────────────────────────────────────────────

const binance = new ccxt.binanceusdm({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  options: { defaultType: "future" },
});

// ── AI (DeepSeek) ──────────────────────────────────────────────────────────────

async function callDeepSeek(prompt: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return "WAIT|0|DeepSeek API key not configured";
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
      temperature: 0.3,
    }),
  });
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content?.trim() || "WAIT|0|No response";
}

// ── Technical Indicators ───────────────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1)      ema.push(NaN);
    else if (i === period -1) ema.push(values.slice(0, period).reduce((a, b) => a + b, 0) / period);
    else                      ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let ups = 0, downs = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) ups += diff; else downs -= diff;
  }
  return 100 - 100 / (1 + ups / (downs || 1));
}

function calcMACD(closes: number[]) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine   = ema12.map((v, i) => (isNaN(v) || isNaN(ema26[i]) ? NaN : v - ema26[i]));
  const validMacd  = macdLine.filter(v => !isNaN(v));
  const rawSignal  = calcEMA(validMacd, 9);
  const offset     = macdLine.length - validMacd.length;
  const signalLine = [...Array(offset).fill(NaN), ...rawSignal.map((v, i) => i < 8 ? NaN : v)];
  const last = macdLine.length - 1;
  return {
    macd:      parseFloat((macdLine[last]   || 0).toFixed(4)),
    signal:    parseFloat((signalLine[last] || 0).toFixed(4)),
    histogram: parseFloat(((macdLine[last] || 0) - (signalLine[last] || 0)).toFixed(4)),
  };
}

function calcBollingerBands(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice  = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period);
  return {
    upper:  parseFloat((middle + mult * stdDev).toFixed(4)),
    middle: parseFloat(middle.toFixed(4)),
    lower:  parseFloat((middle - mult * stdDev).toFixed(4)),
  };
}

function calculateSignal(ohlcv: number[][]) {
  if (!ohlcv || ohlcv.length < 26) return { action: "HOLD" as const, rsi: 50, price: 0, macd: null, bb: null, ema9: null, ema21: null };
  const closes = ohlcv.map(c => c[4]);
  const price  = closes[closes.length - 1];
  const rsi    = parseFloat(calcRSI(closes).toFixed(2));
  const macd   = calcMACD(closes);
  const bb     = calcBollingerBands(closes);
  const ema9   = parseFloat((calcEMA(closes, 9).at(-1)  || 0).toFixed(4));
  const ema21  = parseFloat((calcEMA(closes, 21).at(-1) || 0).toFixed(4));

  let buyScore = 0, sellScore = 0;
  if (rsi < 35)                                          buyScore++;
  if (rsi > 65)                                          sellScore++;
  if (macd.macd > macd.signal && macd.histogram > 0)    buyScore++;
  if (macd.macd < macd.signal && macd.histogram < 0)    sellScore++;
  if (price < bb.lower)                                  buyScore++;
  if (price > bb.upper)                                  sellScore++;
  if (ema9 > ema21)                                      buyScore++;
  if (ema9 < ema21)                                      sellScore++;

  const action = buyScore >= 2 ? "BUY" as const : sellScore >= 2 ? "SELL" as const : "HOLD" as const;
  return { action, rsi, price, macd, bb, ema9, ema21 };
}

// ── OHLCV Persistence ──────────────────────────────────────────────────────────

async function saveOHLCV(symbol: string, candles: number[][]) {
  if (!candles.length) return;
  await pool.query(
    `INSERT INTO ohlcv (symbol, timeframe, timestamp, open, high, low, close, volume)
     SELECT $1, '1m', unnest($2::bigint[]), unnest($3::numeric[]), unnest($4::numeric[]),
            unnest($5::numeric[]), unnest($6::numeric[]), unnest($7::numeric[])
     ON CONFLICT (symbol, timeframe, timestamp) DO NOTHING`,
    [symbol,
     candles.map(c => c[0]), candles.map(c => c[1]), candles.map(c => c[2]),
     candles.map(c => c[3]), candles.map(c => c[4]), candles.map(c => c[5])]
  );
}

// ── Scanner State ──────────────────────────────────────────────────────────────

const SYMBOLS   = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "DOGE/USDT", "BNB/USDT"];
const toWsSym   = (s: string) => s.replace("/", "").toLowerCase();    // BTC/USDT → btcusdt
const toCcxtSym = (s: string) => s.slice(0, -4) + "/" + s.slice(-4); // BTCUSDT → BTC/USDT

// Rolling 50-candle buffer per symbol, updated by WebSocket
const candleBuffer = new Map<string, number[][]>(SYMBOLS.map(s => [s, []]));
let scanResults: any[] = [];

// ── Auto-Execute ───────────────────────────────────────────────────────────────

async function checkAutoExecute(symbol: string, signal: ReturnType<typeof calculateSignal>) {
  const settingsRow = await pool.query("SELECT is_auto_pilot FROM bot_settings WHERE id = 'bot_config'");
  const isAutoPilot = settingsRow.rows[0]?.is_auto_pilot || false;

  console.log(`[SIGNAL] ${symbol} → ${signal.action} RSI:${signal.rsi} autoPilot:${isAutoPilot}`);
  if (!isAutoPilot || signal.action === "HOLD") return;

  const recent = await pool.query(
    `SELECT id FROM trades WHERE symbol = $1 AND status = 'OPEN'
     AND timestamp > NOW() - INTERVAL '5 minutes' LIMIT 1`, [symbol]
  );
  if (recent.rows.length > 0) {
    console.log(`[AUTO] ${symbol} skipped — open trade within 5 min`);
    return;
  }

  const cfgRow   = await pool.query("SELECT leverage FROM bot_settings WHERE id = 'bot_config'");
  const leverage = cfgRow.rows[0]?.leverage || 10;
  const side     = signal.action === "BUY" ? "buy" : "sell";
  const hasKeys  = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY);
  const amount   = parseFloat((binance as any).amountToPrecision(symbol, 25 / signal.price));

  console.log(`[AUTO] ${signal.action} ${symbol} x${leverage} amount:${amount} ~$${(amount * signal.price).toFixed(2)}`);

  if (hasKeys) {
    try {
      await binance.setLeverage(leverage, symbol);
      await binance.createOrder(symbol, "market", side, amount);
      console.log(`[AUTO-FUTURES] ✓ ${signal.action} ${symbol} x${leverage} @ ${signal.price}`);
    } catch (e: any) {
      console.error(`[AUTO-FUTURES] ✗ Order failed [${symbol}]:`, e?.message);
    }
  }

  await pool.query(
    `INSERT INTO trades (symbol, type, entry_price, amount, strategy, status, leverage)
     VALUES ($1, $2, $3, $4, 'AUTO-FUTURES', 'OPEN', $5)`,
    [symbol, signal.action, signal.price, amount, leverage]
  );
  console.log(`[AUTO] DB recorded: ${signal.action} ${symbol} @ ${signal.price}`);
}

// ── WebSocket — Binance Futures Kline Stream ───────────────────────────────────

async function seedCandleBuffer() {
  console.log("[SEED] Fetching initial candles via REST...");
  for (const symbol of SYMBOLS) {
    try {
      const ohlcv = await binance.fetchOHLCV(symbol, "1m", undefined, 50);
      const buf   = ohlcv.map((c: any[]) => c.map(Number) as number[]);
      candleBuffer.set(symbol, buf);
      await saveOHLCV(symbol, buf);
      const signal = calculateSignal(buf);
      const idx    = scanResults.findIndex(r => r.symbol === symbol);
      const entry  = { symbol, ...signal };
      if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);
      console.log(`[SEED] ${symbol} → ${signal.action} RSI:${signal.rsi}`);
    } catch (e: any) {
      console.error(`[SEED] ${symbol}:`, e?.message);
    }
  }
}

function initWebSocket() {
  const streams = SYMBOLS.map(s => `${toWsSym(s)}@kline_1m`).join("/");
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

  ws.on("open", () => console.log("[WS] Connected to Binance Futures kline stream"));

  ws.on("message", async (raw: Buffer) => {
    try {
      const k = JSON.parse(raw.toString())?.data?.k;
      if (!k) return;

      const symbol = toCcxtSym(k.s);
      const candle: number[] = [k.t, +k.o, +k.h, +k.l, +k.c, +k.v];
      const buffer = candleBuffer.get(symbol) || [];

      if (k.x) {
        // ── Candle closed: update buffer, recalculate, auto-execute ──
        buffer.push(candle);
        if (buffer.length > 50) buffer.shift();
        candleBuffer.set(symbol, buffer);
        await saveOHLCV(symbol, [candle]);

        if (buffer.length >= 26) {
          const signal = calculateSignal(buffer);
          const idx    = scanResults.findIndex(r => r.symbol === symbol);
          const entry  = { symbol, ...signal };
          if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);
          await checkAutoExecute(symbol, signal);
        }
      } else {
        // ── Candle still open: update live price only ──
        const idx = scanResults.findIndex(r => r.symbol === symbol);
        if (idx >= 0) scanResults[idx] = { ...scanResults[idx], price: +k.c };
      }
    } catch (e: any) {
      console.error("[WS] Message error:", e?.message);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Disconnected — reconnecting in 5s...");
    setTimeout(initWebSocket, 5000);
  });

  ws.on("error", (err: Error) => console.error("[WS] Error:", err.message));
}

// ── Trade Monitor (Stop Loss / Take Profit) ────────────────────────────────────

const runTradeMonitor = async () => {
  try {
    const openTrades = await pool.query(
      `SELECT id, symbol, type, entry_price::float, amount::float, leverage
       FROM trades WHERE status = 'OPEN'`
    );
    if (openTrades.rows.length === 0) return;

    const cfg    = await pool.query(`SELECT take_profit_pct::float, stop_loss_pct::float FROM bot_settings WHERE id = 'bot_config'`);
    const tpPct  = (cfg.rows[0]?.take_profit_pct ?? 1.5) / 100;
    const slPct  = (cfg.rows[0]?.stop_loss_pct   ?? 0.8) / 100;
    const hasKeys = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY);

    for (const trade of openTrades.rows) {
      try {
        const ticker       = await binance.fetchTicker(trade.symbol);
        const currentPrice = ticker.last as number;
        const isLong       = trade.type === "BUY";
        const pnlPct       = isLong ? (currentPrice - trade.entry_price) / trade.entry_price
                                    : (trade.entry_price - currentPrice) / trade.entry_price;
        const hitTP = pnlPct >=  tpPct;
        const hitSL = pnlPct <= -slPct;
        if (!hitTP && !hitSL) continue;

        const reason    = hitTP ? "TP" : "SL";
        const closeSide = isLong ? "sell" : "buy";
        const pnlUSDT   = (isLong ? currentPrice - trade.entry_price : trade.entry_price - currentPrice) * trade.amount;

        console.log(`[${reason}] ${trade.symbol} pnl:${(pnlPct*100).toFixed(3)}% → ${pnlUSDT.toFixed(2)} USDT`);

        if (hasKeys) {
          try {
            await binance.createOrder(trade.symbol, "market", closeSide, trade.amount, undefined, { reduceOnly: true });
            console.log(`[${reason}] ✓ Closed on Binance: ${trade.symbol}`);
          } catch (e: any) {
            console.error(`[${reason}] ✗ Close failed [${trade.symbol}]:`, e?.message);
          }
        }

        await pool.query(
          `UPDATE trades SET status = 'CLOSED', exit_price = $1, pnl = $2 WHERE id = $3`,
          [currentPrice, pnlUSDT.toFixed(4), trade.id]
        );
        console.log(`[${reason}] DB closed: ${trade.symbol} PnL=${pnlUSDT.toFixed(2)} USDT`);
      } catch (e: any) {
        console.error(`Trade monitor error [${trade.symbol}]:`, e?.message);
      }
    }
  } catch (err) {
    console.error("Trade monitor critical error:", err);
  }
};

// ── Binance Position Sync ──────────────────────────────────────────────────────

let lastSyncAt: string | null = null;

async function syncPositionsFromBinance() {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) return;

  try {
    // All OPEN trades in our DB
    const dbTrades = await pool.query(
      `SELECT id, symbol, type, entry_price::float, amount::float
       FROM trades WHERE status = 'OPEN'`
    );
    if (dbTrades.rows.length === 0) {
      lastSyncAt = new Date().toISOString();
      return;
    }

    // Actual open positions on Binance (only contracts > 0)
    const rawPositions = await binance.fetchPositions();
    const openOnBinance = new Map<string, any>();
    for (const pos of rawPositions) {
      if (Math.abs(Number(pos.contracts ?? 0)) > 0) {
        // ccxt may return "BTC/USDT:USDT" — normalise to "BTC/USDT"
        const sym = (pos.symbol as string).split(":")[0];
        openOnBinance.set(sym, pos);
      }
    }

    for (const trade of dbTrades.rows as any[]) {
      const stillOpen = openOnBinance.has(trade.symbol);
      if (stillOpen) continue;

      // Position gone on Binance → mark CLOSED in DB
      // Use current ticker price as best-effort exit price
      let exitPrice = trade.entry_price;
      try {
        const ticker = await binance.fetchTicker(trade.symbol);
        exitPrice = ticker.last as number;
      } catch { /* keep entry price as fallback */ }

      const isLong  = trade.type === "BUY";
      const pnlUSDT = (isLong ? exitPrice - trade.entry_price : trade.entry_price - exitPrice) * trade.amount;

      await pool.query(
        `UPDATE trades SET status = 'CLOSED', exit_price = $1, pnl = $2 WHERE id = $3`,
        [exitPrice, pnlUSDT.toFixed(4), trade.id]
      );
      console.log(`[SYNC] Closed in DB: ${trade.symbol} exit:${exitPrice} PnL:${pnlUSDT.toFixed(2)} USDT`);
    }

    lastSyncAt = new Date().toISOString();
    console.log(`[SYNC] Done — ${dbTrades.rows.length} checked, ${new Date().toLocaleTimeString()}`);
  } catch (err: any) {
    console.error("[SYNC] Error:", err?.message);
  }
}

// ── PnL Snapshot ───────────────────────────────────────────────────────────────

const takePnLSnapshot = async () => {
  try {
    let totalValue = 10000;
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY) {
      const balance = await binance.fetchBalance({ type: "future" });
      totalValue    = parseFloat(String((balance as any).total?.USDT ?? totalValue));
    }
    const first      = await pool.query("SELECT total_value FROM pnl_snapshots ORDER BY timestamp ASC LIMIT 1");
    const startValue = first.rows.length ? parseFloat(first.rows[0].total_value) : totalValue;
    const pnlPercent = startValue > 0 ? (((totalValue - startValue) / startValue) * 100).toFixed(4) : "0";
    await pool.query("INSERT INTO pnl_snapshots (timestamp, total_value, pnl_percent) VALUES ($1, $2, $3)",
      [Date.now(), totalValue, pnlPercent]);
  } catch (err) {
    console.error("PnL snapshot error:", err);
  }
};

// ── API Routes ─────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => res.json({ status: "ok", timestamp: Date.now() }));

app.get("/api/scan", (req, res) => res.json({ results: scanResults, timestamp: Date.now() }));

app.get("/api/open-positions", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, symbol, type, entry_price::float, amount::float, leverage,
              TO_CHAR(timestamp AT TIME ZONE 'UTC', 'HH24:MI:SS') AS opened_at
       FROM trades WHERE status = 'OPEN' ORDER BY timestamp DESC`
    );
    const positions = result.rows.map((trade: any) => {
      const live         = scanResults.find(r => r.symbol === trade.symbol);
      const currentPrice = live?.price ?? trade.entry_price;
      const isLong       = trade.type === "BUY";
      const pnlUSDT      = (isLong ? currentPrice - trade.entry_price : trade.entry_price - currentPrice) * trade.amount;
      const pnlPct       = ((isLong ? currentPrice - trade.entry_price : trade.entry_price - currentPrice) / trade.entry_price) * 100;
      return {
        ...trade,
        side:          isLong ? "LONG" : "SHORT",
        current_price: parseFloat(currentPrice.toFixed(4)),
        pnl_usdt:      parseFloat(pnlUSDT.toFixed(4)),
        pnl_pct:       parseFloat(pnlPct.toFixed(3)),
      };
    });
    res.json({ positions, last_sync: lastSyncAt });
  } catch (err) {
    console.error("Open positions error:", err);
    res.status(500).json({ error: "Failed to fetch open positions" });
  }
});

// Manual sync trigger
app.post("/api/sync-positions", async (_req, res) => {
  try {
    await syncPositionsFromBinance();
    res.json({ ok: true, last_sync: lastSyncAt });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM bot_settings WHERE id = 'bot_config'");
    res.json(r.rows[0] || {});
  } catch { res.status(500).json({ error: "Failed to fetch settings" }); }
});

app.post("/api/settings", async (req, res) => {
  const { isAutoPilot, riskLevel, maxSlippage, takeProfitPct, stopLossPct, leverage } = req.body;
  try {
    const r = await pool.query(
      `UPDATE bot_settings
       SET is_auto_pilot   = COALESCE($1, is_auto_pilot),
           risk_level      = COALESCE($2, risk_level),
           max_slippage    = COALESCE($3, max_slippage),
           take_profit_pct = COALESCE($4, take_profit_pct),
           stop_loss_pct   = COALESCE($5, stop_loss_pct),
           leverage        = COALESCE($6, leverage)
       WHERE id = 'bot_config' RETURNING *`,
      [isAutoPilot ?? null, riskLevel ?? null, maxSlippage ?? null,
       takeProfitPct ?? null, stopLossPct ?? null, leverage ?? null]
    );
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: "Failed to update settings" }); }
});

app.get("/api/ohlcv/:symbol", async (req, res) => {
  const symbol    = decodeURIComponent(req.params.symbol);
  const limit     = Math.min(parseInt((req.query.limit as string) || "200"), 1000);
  const timeframe = (req.query.timeframe as string) || "1m";
  try {
    const r = await pool.query(
      `SELECT timestamp, open, high, low, close, volume FROM ohlcv
       WHERE symbol = $1 AND timeframe = $2 ORDER BY timestamp DESC LIMIT $3`,
      [symbol, timeframe, limit]
    );
    res.json(r.rows.reverse());
  } catch { res.status(500).json({ error: "Failed to fetch OHLCV" }); }
});

app.get("/api/pnl-history", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT TO_CHAR(TO_TIMESTAMP(timestamp/1000.0),'HH24:MI') AS time, total_value::float AS value
       FROM pnl_snapshots ORDER BY timestamp ASC`
    );
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Failed to fetch PnL history" }); }
});

app.get("/api/trade-history", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, symbol, entry_price::float AS entry, exit_price::float AS exit,
              pnl::float, strategy,
              TO_CHAR(timestamp AT TIME ZONE 'UTC','HH24:MI:SS') AS time
       FROM trades ORDER BY timestamp DESC LIMIT 50`
    );
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Failed to fetch trade history" }); }
});

app.post("/api/execute", async (req, res) => {
  const { symbol, type, entryPrice, amount, strategy } = req.body;
  if (!symbol || !type || !entryPrice) return res.status(400).json({ error: "symbol, type, entryPrice required" });
  try {
    const r = await pool.query(
      `INSERT INTO trades (symbol, type, entry_price, amount, strategy, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN') RETURNING *`,
      [symbol, type, entryPrice, amount || 0, strategy || "MANUAL"]
    );
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: "Failed to record trade" }); }
});

app.post("/api/ai-confirm", async (req, res) => {
  const { symbol, data } = req.body;
  try {
    const prompt = `Analyze this crypto futures market data for ${symbol}: ${JSON.stringify(data)}.
    Give a short technical verdict: BUY, SELL, or WAIT. Include a confidence score (0-100) and 1 reason.
    Reply in this exact format only: VERDICT|CONFIDENCE|REASON`;
    const text = await callDeepSeek(prompt);
    const [verdict, confidence, reason] = text.split("|");
    res.json({ verdict: verdict?.trim() || "WAIT", confidence: parseInt(confidence) || 0, reason: reason?.trim() || "No reason" });
  } catch { res.status(500).json({ error: "AI Confirmation Failed" }); }
});

app.get("/api/balance", async (req, res) => {
  try {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
      return res.json({ total: { USDT: 10000 }, status: "mock" });
    }
    const balance = await binance.fetchBalance({ type: "future" });
    res.json({ total: { USDT: parseFloat(String((balance as any).total?.USDT ?? 0)) }, status: "live", type: "futures" });
  } catch (err: any) {
    res.status(200).json({ status: "error", error: err.message, total: {} });
  }
});

app.get("/api/check-api", async (req, res) => {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY)
    return res.json({ connected: false, reason: "Keys not found" });
  try { await binance.fetchBalance(); res.json({ connected: true }); }
  catch (e: any) { res.json({ connected: false, reason: e.message }); }
});

// ── Startup ────────────────────────────────────────────────────────────────────

async function startServer() {
  await pool.query("SELECT 1");
  console.log("Database connected");

  await runMigrations();
  console.log("Migrations applied");

  await binance.loadMarkets();
  console.log("Markets loaded");

  // Seed candle buffer via REST, then hand off to WebSocket
  await seedCandleBuffer();
  initWebSocket();

  // Fallback reseed every 5 min (catches any gaps if WS misses a candle)
  setInterval(seedCandleBuffer, 5 * 60 * 1000);
  setInterval(runTradeMonitor, 10 * 1000);
  setInterval(syncPositionsFromBinance, 60 * 1000); // sync every 60s
  setInterval(takePnLSnapshot, 60 * 60 * 1000);
  runTradeMonitor();
  syncPositionsFromBinance();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer().catch(err => { console.error("Startup failed:", err); process.exit(1); });
