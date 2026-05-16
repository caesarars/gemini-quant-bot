import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
// DeepSeek replaces Gemini — OpenAI-compatible API, free tier is much more generous
import ccxt from "ccxt";
import * as dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME || "quantbot",
  user: process.env.DB_USER || "quantbot",
  password: process.env.DB_PASSWORD || "",
});

// Creates ohlcv table if it doesn't exist yet (safe to run on every startup)
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
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_ts
    ON ohlcv (symbol, timeframe, timestamp DESC)
  `);
  // Futures additions
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS leverage INTEGER DEFAULT 1`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS leverage INTEGER DEFAULT 10`);
}

// ── AI & Exchange ─────────────────────────────────────────────────────────────

// DeepSeek AI helper — OpenAI-compatible endpoint, generous free tier
async function callDeepSeek(prompt: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return "WAIT|0|DeepSeek API key not configured";
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
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

// USDT-M Perpetual Futures — public OHLCV works without keys
const binance = new ccxt.binanceusdm({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  options: { defaultType: "future" },
});

// ── Technical Indicators ──────────────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      ema.push(NaN);
    } else if (i === period - 1) {
      ema.push(values.slice(0, period).reduce((a, b) => a + b, 0) / period);
    } else {
      ema.push(values[i] * k + ema[i - 1] * (1 - k));
    }
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let ups = 0, downs = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) ups += diff;
    else downs -= diff;
  }
  return 100 - 100 / (1 + ups / (downs || 1));
}

function calcMACD(closes: number[]): { macd: number; signal: number; histogram: number } {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => (isNaN(v) || isNaN(ema26[i]) ? NaN : v - ema26[i]));
  const validMacd = macdLine.filter((v) => !isNaN(v));
  const rawSignal = calcEMA(validMacd, 9);
  const offset = macdLine.length - validMacd.length;
  const signalLine = [...Array(offset).fill(NaN), ...rawSignal.map((v, i) => (i < 8 ? NaN : v))];
  const last = macdLine.length - 1;
  return {
    macd: parseFloat((macdLine[last] || 0).toFixed(4)),
    signal: parseFloat((signalLine[last] || 0).toFixed(4)),
    histogram: parseFloat(((macdLine[last] || 0) - (signalLine[last] || 0)).toFixed(4)),
  };
}

function calcBollingerBands(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period);
  return {
    upper: parseFloat((middle + mult * stdDev).toFixed(4)),
    middle: parseFloat(middle.toFixed(4)),
    lower: parseFloat((middle - mult * stdDev).toFixed(4)),
  };
}

// Enhanced signal using RSI + MACD + BB + EMA cross — requires ≥ 2 confirmations
function calculateSignal(ohlcv: any[]) {
  if (!ohlcv || ohlcv.length < 26) return { action: "HOLD", rsi: 50, price: 0, macd: null, bb: null, ema9: null, ema21: null };

  const closes = ohlcv.map((c) => c[4]);
  const price = closes[closes.length - 1];

  const rsi = parseFloat(calcRSI(closes).toFixed(2));
  const macd = calcMACD(closes);
  const bb = calcBollingerBands(closes);
  const ema9 = parseFloat((calcEMA(closes, 9).at(-1) || 0).toFixed(4));
  const ema21 = parseFloat((calcEMA(closes, 21).at(-1) || 0).toFixed(4));

  let buyScore = 0, sellScore = 0;
  if (rsi < 35) buyScore++;
  if (rsi > 65) sellScore++;
  if (macd.macd > macd.signal && macd.histogram > 0) buyScore++;
  if (macd.macd < macd.signal && macd.histogram < 0) sellScore++;
  if (price < bb.lower) buyScore++;
  if (price > bb.upper) sellScore++;
  if (ema9 > ema21) buyScore++;
  if (ema9 < ema21) sellScore++;

  const action: "BUY" | "SELL" | "HOLD" = buyScore >= 2 ? "BUY" : sellScore >= 2 ? "SELL" : "HOLD";

  return { action, rsi, price, macd, bb, ema9, ema21 };
}

// ── OHLCV Persistence ─────────────────────────────────────────────────────────

async function saveOHLCV(symbol: string, candles: any[]) {
  if (!candles.length) return;
  await pool.query(
    `INSERT INTO ohlcv (symbol, timeframe, timestamp, open, high, low, close, volume)
     SELECT $1, '1m',
            unnest($2::bigint[]),
            unnest($3::numeric[]),
            unnest($4::numeric[]),
            unnest($5::numeric[]),
            unnest($6::numeric[]),
            unnest($7::numeric[])
     ON CONFLICT (symbol, timeframe, timestamp) DO NOTHING`,
    [
      symbol,
      candles.map((c) => c[0]),
      candles.map((c) => c[1]),
      candles.map((c) => c[2]),
      candles.map((c) => c[3]),
      candles.map((c) => c[4]),
      candles.map((c) => c[5]),
    ]
  );
}

// ── Scanner ───────────────────────────────────────────────────────────────────

let scanResults: any[] = [];
let isScanning = false;

const runScanner = async () => {
  if (isScanning) return;
  isScanning = true;
  try {
    const settingsRow = await pool.query("SELECT is_auto_pilot FROM bot_settings WHERE id = 'bot_config'");
    const isAutoPilot: boolean = settingsRow.rows[0]?.is_auto_pilot || false;

    const symbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "DOGE/USDT", "BNB/USDT"];
    const newResults = [];

    for (const symbol of symbols) {
      try {
        // 50 candles — enough for EMA26 + MACD signal(9)
        const ohlcv = await binance.fetchOHLCV(symbol, "1m", undefined, 50);
        const signal = calculateSignal(ohlcv);
        newResults.push({ symbol, ...signal });
        await saveOHLCV(symbol, ohlcv);

        // Auto-execute: only if autopilot on, signal is actionable, and no recent open trade
        console.log(`[SCAN] ${symbol} → action:${signal.action} rsi:${signal.rsi} autoPilot:${isAutoPilot}`);

        if (isAutoPilot && signal.action !== "HOLD") {
          const recent = await pool.query(
            `SELECT id FROM trades
             WHERE symbol = $1 AND status = 'OPEN'
             AND timestamp > NOW() - INTERVAL '5 minutes'
             LIMIT 1`,
            [symbol]
          );

          if (recent.rows.length > 0) {
            console.log(`[AUTO] ${symbol} skipped — open trade exists within 5 min`);
          } else {
            const cfgRow = await pool.query("SELECT leverage FROM bot_settings WHERE id = 'bot_config'");
            const leverage = cfgRow.rows[0]?.leverage || 10;
            const side = signal.action === "BUY" ? "buy" : "sell";
            const hasKeys = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY);

            // Calculate amount so notional ≥ $25 (safe above Binance $20 minimum)
            const targetNotional = 25;
            const rawAmount = targetNotional / signal.price;
            const amount = parseFloat((binance as any).amountToPrecision(symbol, rawAmount));

            console.log(`[AUTO] Executing ${signal.action} ${symbol} x${leverage} amount:${amount} notional:~$${(amount * signal.price).toFixed(2)} | hasKeys:${hasKeys}`);

            if (hasKeys) {
              try {
                await binance.setLeverage(leverage, symbol);
                await binance.createOrder(symbol, "market", side, amount);
                console.log(`[AUTO-FUTURES] ✓ Real order placed: ${signal.action} ${symbol} x${leverage} @ ${signal.price}`);
              } catch (e: any) {
                console.error(`[AUTO-FUTURES] ✗ Order failed [${symbol}]:`, e?.message);
              }
            } else {
              console.log(`[AUTO] No API keys — recorded to DB only`);
            }

            await pool.query(
              `INSERT INTO trades (symbol, type, entry_price, amount, strategy, status, leverage)
               VALUES ($1, $2, $3, $4, 'AUTO-FUTURES', 'OPEN', $5)`,
              [symbol, signal.action, signal.price, amount, leverage]
            );
            console.log(`[AUTO] DB recorded: ${signal.action} ${symbol} @ ${signal.price}`);
          }
        }
      } catch (e: any) {
        console.error(`Scanner error [${symbol}]:`, e?.message || e);
      }
    }
    scanResults = newResults;
  } catch (err) {
    console.error("Scanner critical error:", err);
  } finally {
    isScanning = false;
  }
};

// ── PnL Snapshot ──────────────────────────────────────────────────────────────

const takePnLSnapshot = async () => {
  try {
    let totalValue = 10000;
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY) {
      const balance = await binance.fetchBalance();
      totalValue = balance.total["USDT"] || totalValue;
    }
    const first = await pool.query("SELECT total_value FROM pnl_snapshots ORDER BY timestamp ASC LIMIT 1");
    const startValue = first.rows.length ? parseFloat(first.rows[0].total_value) : totalValue;
    const pnlPercent = startValue > 0 ? (((totalValue - startValue) / startValue) * 100).toFixed(4) : "0";
    await pool.query(
      "INSERT INTO pnl_snapshots (timestamp, total_value, pnl_percent) VALUES ($1, $2, $3)",
      [Date.now(), totalValue, pnlPercent]
    );
  } catch (err) {
    console.error("PnL snapshot error:", err);
  }
};

// ── API Routes ────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM bot_settings WHERE id = 'bot_config'");
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

app.post("/api/settings", async (req, res) => {
  const { isAutoPilot, riskLevel, maxSlippage } = req.body;
  try {
    const result = await pool.query(
      `UPDATE bot_settings
       SET is_auto_pilot = COALESCE($1, is_auto_pilot),
           risk_level    = COALESCE($2, risk_level),
           max_slippage  = COALESCE($3, max_slippage)
       WHERE id = 'bot_config'
       RETURNING *`,
      [isAutoPilot ?? null, riskLevel ?? null, maxSlippage ?? null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to update settings" });
  }
});

app.get("/api/scan", (req, res) => {
  res.json({ results: scanResults, timestamp: Date.now() });
});

// Full OHLCV candles for a symbol — used for backtesting / charting
app.get("/api/ohlcv/:symbol", async (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol);
  const limit = Math.min(parseInt((req.query.limit as string) || "200"), 1000);
  const timeframe = (req.query.timeframe as string) || "1m";
  try {
    const result = await pool.query(
      `SELECT timestamp, open, high, low, close, volume
       FROM ohlcv
       WHERE symbol = $1 AND timeframe = $2
       ORDER BY timestamp DESC
       LIMIT $3`,
      [symbol, timeframe, limit]
    );
    res.json(result.rows.reverse()); // oldest first for charting
  } catch (err) {
    console.error("OHLCV query error:", err);
    res.status(500).json({ error: "Failed to fetch OHLCV" });
  }
});

app.get("/api/pnl-history", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT TO_CHAR(TO_TIMESTAMP(timestamp / 1000.0), 'HH24:MI') AS time,
              total_value::float AS value
       FROM pnl_snapshots
       ORDER BY timestamp ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("PnL history DB error:", err);
    res.status(500).json({ error: "Failed to fetch PnL history" });
  }
});

app.get("/api/trade-history", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,
              symbol,
              entry_price::float AS entry,
              exit_price::float  AS exit,
              pnl::float,
              strategy,
              TO_CHAR(timestamp AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time
       FROM trades
       ORDER BY timestamp DESC
       LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Trade history DB error:", err);
    res.status(500).json({ error: "Failed to fetch trade history" });
  }
});

app.post("/api/execute", async (req, res) => {
  const { symbol, type, entryPrice, amount, strategy } = req.body;
  if (!symbol || !type || !entryPrice) {
    return res.status(400).json({ error: "symbol, type, entryPrice are required" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO trades (symbol, type, entry_price, amount, strategy, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN') RETURNING *`,
      [symbol, type, entryPrice, amount || 0, strategy || "MANUAL"]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Execute trade DB error:", err);
    res.status(500).json({ error: "Failed to record trade" });
  }
});

app.post("/api/ai-confirm", async (req, res) => {
  const { symbol, data } = req.body;
  try {
    const prompt = `Analyze this crypto futures market data for ${symbol}: ${JSON.stringify(data)}.
    Give a short technical verdict: BUY, SELL, or WAIT. Include a confidence score (0-100) and 1 reason.
    Reply in this exact format only: VERDICT|CONFIDENCE|REASON`;
    const text = await callDeepSeek(prompt);
    const [verdict, confidence, reason] = text.split("|");
    res.json({
      verdict: verdict?.trim() || "WAIT",
      confidence: parseInt(confidence) || 0,
      reason: reason?.trim() || "No detailed reason provided",
    });
  } catch (error) {
    console.error("DeepSeek Error:", error);
    res.status(500).json({ error: "AI Confirmation Failed" });
  }
});

app.get("/api/balance", async (req, res) => {
  try {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
      return res.json({
        total: { USDT: 10000 },
        status: "mock",
        message: "Using simulated futures balance (API keys missing)",
      });
    }
    const balance = await binance.fetchBalance({ type: "future" });
    const usdt = parseFloat(String(balance.total?.USDT ?? 0));
    res.json({ total: { USDT: usdt }, status: "live", type: "futures" });
  } catch (err: any) {
    console.error("Balance Error:", err);
    res.status(200).json({ status: "error", error: err.message, total: {} });
  }
});

app.get("/api/check-api", async (req, res) => {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
    return res.json({ connected: false, reason: "Keys not found in environment" });
  }
  try {
    await binance.fetchBalance();
    res.json({ connected: true });
  } catch (e: any) {
    res.json({ connected: false, reason: e.message });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function startServer() {
  try {
    await pool.query("SELECT 1");
    console.log("Database connected");
  } catch (err) {
    console.error("Database connection failed:", err);
    process.exit(1);
  }

  await runMigrations();
  console.log("Migrations applied");

  await binance.loadMarkets();
  console.log("Markets loaded");

  setInterval(runScanner, 30000);
  setInterval(takePnLSnapshot, 60 * 60 * 1000);
  runScanner();

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

startServer();
