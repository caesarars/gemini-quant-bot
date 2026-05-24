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
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_high NUMERIC(20,8)`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_low  NUMERIC(20,8)`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS atr_sl_mult      NUMERIC(5,2) DEFAULT 1.5`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS atr_tp_mult      NUMERIC(5,2) DEFAULT 4.0`);
  await pool.query(`UPDATE bot_settings SET atr_tp_mult = 4.0 WHERE id = 'bot_config' AND atr_tp_mult = 2.5`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS active_strategy   VARCHAR(30)  DEFAULT 'ULTRA-SCALP'`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS arb_sl_mult      NUMERIC(5,2) DEFAULT 1.0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS arb_tp_mult      NUMERIC(5,2) DEFAULT 3.0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS active_strategies TEXT[]       DEFAULT '{MOMENTUM-ARB}'`);
  await pool.query(`UPDATE bot_settings SET active_strategies = array_remove(active_strategies, 'ULTRA-SCALP') WHERE id = 'bot_config'`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee_usdt NUMERIC(20,8) DEFAULT 0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS mr_sl_mult NUMERIC(5,2) DEFAULT 1.0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS mr_tp_mult NUMERIC(5,2) DEFAULT 2.0`);
  await pool.query(`UPDATE bot_settings SET active_strategies = array_append(active_strategies, 'MEAN-REV') WHERE id = 'bot_config' AND NOT ('MEAN-REV' = ANY(COALESCE(active_strategies, '{}')))`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS telegram_bot_token VARCHAR(255) DEFAULT NULL`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS telegram_chat_id   VARCHAR(50)  DEFAULT NULL`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS taker_rate NUMERIC(8,6) DEFAULT 0.0004`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS swing_leverage  INTEGER      DEFAULT 3`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS swing_sl_mult   NUMERIC(5,2) DEFAULT 2.0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS swing_tp_mult   NUMERIC(5,2) DEFAULT 8.0`);
  await pool.query(`UPDATE bot_settings SET active_strategies = array_append(active_strategies, 'SWING-LONG') WHERE id = 'bot_config' AND NOT ('SWING-LONG' = ANY(COALESCE(active_strategies, '{}')))`);

  await pool.query(`CREATE TABLE IF NOT EXISTS signals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol        VARCHAR(20) NOT NULL,
    side          VARCHAR(10) NOT NULL CHECK (side IN ('LONG','SHORT')),
    strategy      VARCHAR(100) NOT NULL,
    timeframe     VARCHAR(10) NOT NULL,
    entry_price   NUMERIC(20,8) NOT NULL,
    tp_price      NUMERIC(20,8) NOT NULL,
    sl_price      NUMERIC(20,8) NOT NULL,
    confidence    NUMERIC(4,2),
    est_duration  VARCHAR(50),
    context       JSONB,
    status        VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','HIT_TP','HIT_SL')),
    telegram_sent BOOLEAN DEFAULT false,
    sent_at       TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_signals_symbol_sent ON signals (symbol, sent_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_signals_status ON signals (status)`);

  // Paper trading mode
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS paper_mode BOOLEAN DEFAULT true`);
  await pool.query(`CREATE TABLE IF NOT EXISTS paper_trades (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol       VARCHAR(20)  NOT NULL,
    strategy     VARCHAR(30)  NOT NULL,
    side         VARCHAR(10)  NOT NULL CHECK (side IN ('LONG','SHORT')),
    entry_price  NUMERIC(20,8) NOT NULL,
    tp_price     NUMERIC(20,8) NOT NULL,
    sl_price     NUMERIC(20,8) NOT NULL,
    status       VARCHAR(10)  DEFAULT 'OPEN' CHECK (status IN ('OPEN','TP','SL','MANUAL','EXPIRED')),
    open_time    TIMESTAMPTZ  DEFAULT NOW(),
    close_time   TIMESTAMPTZ,
    close_price  NUMERIC(20,8),
    pnl_pct      NUMERIC(10,4),
    signal_score NUMERIC(4,2),
    context      JSONB
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_paper_trades_status   ON paper_trades (status, open_time DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy ON paper_trades (strategy, open_time DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS strategy_stats (
    strategy      VARCHAR(30)   PRIMARY KEY,
    total_trades  INT           DEFAULT 0,
    win_trades    INT           DEFAULT 0,
    loss_trades   INT           DEFAULT 0,
    total_pnl_pct NUMERIC(18,4) DEFAULT 0,
    avg_win_pct   NUMERIC(10,4) DEFAULT 0,
    avg_loss_pct  NUMERIC(10,4) DEFAULT 0,
    last_updated  TIMESTAMPTZ   DEFAULT NOW()
  )`);
}

// ── Exchange ───────────────────────────────────────────────────────────────────

const binance = new ccxt.binanceusdm({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  options: { defaultType: "future" },
  enableRateLimit: true,
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

function calcATR(ohlcv: number[][], period = 14): number {
  if (ohlcv.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const [, , high, low] = ohlcv[i];
    const prevClose = ohlcv[i - 1][4];
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  // Wilder's smoothing (EMA with k = 1/period)
  const k = 1 / period;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = trs[i] * k + atr * (1 - k);
  return atr;
}

function calcVolumeRatio(ohlcv: number[], period = 20): number {
  if (ohlcv.length < period + 1) return 1;
  const avg = ohlcv.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  return avg > 0 ? ohlcv[ohlcv.length - 1] / avg : 1;
}

function calcVWAP(ohlcv: number[][]): number {
  if (!ohlcv.length) return 0;
  let pv = 0, vol = 0;
  for (const c of ohlcv) {
    const typical = (c[2] + c[3] + c[4]) / 3;
    pv  += typical * c[5];
    vol += c[5];
  }
  return vol > 0 ? pv / vol : 0;
}

function calcADX(ohlcv: number[][], period = 14): { adx: number; plusDI: number; minusDI: number } {
  if (ohlcv.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
  const highs = ohlcv.map(c => c[2]);
  const lows  = ohlcv.map(c => c[3]);
  const closes = ohlcv.map(c => c[4]);

  let trSum = 0, plusDMSum = 0, minusDMSum = 0;
  for (let i = 1; i <= period; i++) {
    const high = highs[i], low = lows[i];
    const prevHigh = highs[i - 1], prevLow = lows[i - 1], prevClose = closes[i - 1];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const plusDM  = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
    const minusDM = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;
    trSum += tr; plusDMSum += plusDM; minusDMSum += minusDM;
  }

  let trAvg = trSum / period;
  let plusDMAvg = plusDMSum / period;
  let minusDMAvg = minusDMSum / period;

  let plusDI  = 100 * plusDMAvg / trAvg;
  let minusDI = 100 * minusDMAvg / trAvg;
  let dx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
  let adx = dx;

  for (let i = period + 1; i < ohlcv.length; i++) {
    const high = highs[i], low = lows[i];
    const prevHigh = highs[i - 1], prevLow = lows[i - 1], prevClose = closes[i - 1];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const plusDM  = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
    const minusDM = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;
    trAvg = (trAvg * (period - 1) + tr) / period;
    plusDMAvg  = (plusDMAvg  * (period - 1) + plusDM)  / period;
    minusDMAvg = (minusDMAvg * (period - 1) + minusDM) / period;
    plusDI  = 100 * plusDMAvg / trAvg;
    minusDI = 100 * minusDMAvg / trAvg;
    dx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
    adx = (adx * (period - 1) + dx) / period;
  }
  return { adx: parseFloat(adx.toFixed(2)), plusDI: parseFloat(plusDI.toFixed(2)), minusDI: parseFloat(minusDI.toFixed(2)) };
}

// Returns signal for MOMENTUM ARB: EMA9/21 fresh crossover confirmed by RSI (5m candles)
function calculateMomentumSignal(ohlcv: number[][]) {
  const empty = { action: "HOLD" as const, rsi: 50, price: 0, volumeRatio: 1, atr: 0, atrPct: 0, cross: null as string | null, score: 0 };
  if (!ohlcv || ohlcv.length < 22) return empty;
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);
  const price   = closes[closes.length - 1];
  const rsi     = parseFloat(calcRSI(closes).toFixed(2));
  const ema9arr  = calcEMA(closes, 9);
  const ema21arr = calcEMA(closes, 21);
  const volumeRatio = parseFloat(calcVolumeRatio(volumes).toFixed(2));
  const atr     = parseFloat(calcATR(ohlcv).toFixed(6));
  const atrPct  = price > 0 ? parseFloat((atr / price * 100).toFixed(4)) : 0;

  const last  = ema9arr.length - 1;
  const curr9 = ema9arr[last], curr21 = ema21arr[last];
  const prev9 = ema9arr[last - 1], prev21 = ema21arr[last - 1];
  if ([curr9, curr21, prev9, prev21].some(isNaN)) return { ...empty, price, rsi, volumeRatio, atr, atrPct };

  // Fresh crossovers only — trend continuation without a cross is HOLD
  const bullCross = prev9 <= prev21 && curr9 > curr21;
  const bearCross = prev9 >= prev21 && curr9 < curr21;
  const cross     = bullCross ? "GOLDEN" : bearCross ? "DEATH" : null;

  // ── Weighted scoring (max 4.5) ──
  let score = 0;
  if (bullCross || bearCross) score += 3;           // fresh crossover (base)
  if (bullCross && rsi > 55) score += 1;            // strong RSI momentum
  if (bearCross && rsi < 45) score += 1;
  if (bullCross && rsi > 45 && rsi <= 55) score += 0.5; // moderate RSI
  if (bearCross && rsi >= 45 && rsi < 55) score += 0.5;
  if (volumeRatio >= 1.2) score += 0.5;             // volume spike confirmation

  // Loosened from 3.0 → 2.5: a fresh cross (+3) alone now qualifies, instead of
  // requiring cross + RSI/volume confirmation. Cross itself is a strong filter.
  const MIN_SCORE = 2.5;
  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (bullCross && score >= MIN_SCORE) action = "BUY";
  if (bearCross && score >= MIN_SCORE) action = "SELL";

  return { action, rsi, price, volumeRatio, atr, atrPct, cross, score };
}

// Returns signal for MEAN-REVERSION: BB band touch + RSI on 15m candles.
// Intentionally ignores trend direction — designed for range/neutral markets.
function calculateMeanRevSignal(ohlcv: number[][]) {
  const empty = { action: "HOLD" as const, rsi: 50, price: 0, volumeRatio: 1, atr: 0, atrPct: 0, bbPos: null as string | null, score: 0 };
  if (!ohlcv || ohlcv.length < 20) return empty;
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);
  const price   = closes[closes.length - 1];
  const rsi     = parseFloat(calcRSI(closes).toFixed(2));
  const bb      = calcBollingerBands(closes, 20, 2);
  const atr     = parseFloat(calcATR(ohlcv).toFixed(6));
  const atrPct  = price > 0 ? parseFloat((atr / price * 100).toFixed(4)) : 0;
  const volumeRatio = parseFloat(calcVolumeRatio(volumes).toFixed(2));

  const bbPos = price <= bb.lower ? "LOWER" : price >= bb.upper ? "UPPER" : "MID";
  const bbRange = bb.upper - bb.lower;
  const distFromMid = bbRange > 0 ? Math.abs(price - bb.middle) / (bbRange / 2) : 0; // 0 = mid, 1 = band

  // ── Weighted scoring (max 5.0) ──
  let score = 0;

  // BB band touch / proximity (weight up to 2). Proximity widened from 0.3%
  // to 1.0% — closes rarely land within 0.3% of the band on 15m candles.
  if (price <= bb.lower * 1.010) score += 2;
  else if (bbPos === "LOWER") score += 1.5;
  else if (price < bb.middle && distFromMid > 0.5) score += 1;

  if (price >= bb.upper * 0.990) score += 2;
  else if (bbPos === "UPPER") score += 1.5;
  else if (price > bb.middle && distFromMid > 0.5) score += 1;

  // RSI extreme (weight up to 1.5)
  if (rsi < 30) score += 1.5;
  else if (rsi < 38) score += 1.0;
  else if (rsi < 45) score += 0.5;

  if (rsi > 70) score += 1.5;
  else if (rsi > 62) score += 1.0;
  else if (rsi > 55) score += 0.5;

  // Distance from midpoint bonus (weight up to 1)
  score += Math.min(distFromMid, 1);

  const MIN_SCORE = 3.0;
  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (price <= bb.lower * 1.010 && score >= MIN_SCORE) action = "BUY";
  if (price >= bb.upper * 0.990 && score >= MIN_SCORE) action = "SELL";

  return { action, rsi, price, volumeRatio, atr, atrPct, bbPos, score };
}

// ── SWING-LONG Strategy (4h, multi-day hold) ──────────────────────────────────
// Long-only trend-following strategy on 4h candles.
// Requires EMA alignment (price > EMA20 > EMA50 > EMA200), MACD bullish,
// ADX directional, and healthy RSI. Holds positions for 1-7 days.
function calculateSwingLongSignal(ohlcv: number[][]) {
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);
  const price   = closes[closes.length - 1];
  const HOLD = { action: "HOLD" as const, price, rsi: 50, volumeRatio: 1, atr: 0, atrPct: 0, score: 0, buyScore: 0, sellScore: 0, emaAlign: 0, macdBull: false, adxBull: false, ema20: 0, ema50: 0, ema200: 0, adx: 0, plusDI: 0, minusDI: 0 };
  if (ohlcv.length < 55) return HOLD;

  const rsi         = parseFloat(calcRSI(closes).toFixed(2));
  const atr         = parseFloat(calcATR(ohlcv, 14).toFixed(6));
  const atrPct      = price > 0 ? parseFloat((atr / price * 100).toFixed(4)) : 0;
  const volumeRatio = parseFloat(calcVolumeRatio(volumes).toFixed(2));

  const ema20arr = calcEMA(closes, 20);
  const ema50arr = calcEMA(closes, 50);
  const ema20    = ema20arr[ema20arr.length - 1] ?? 0;
  const ema50    = ema50arr[ema50arr.length - 1] ?? 0;

  const hasLongData = ohlcv.length >= 200;
  const ema200arr   = hasLongData ? calcEMA(closes, 200) : null;
  const ema200      = ema200arr ? (ema200arr[ema200arr.length - 1] ?? 0) : 0;

  // MACD: line = EMA12 - EMA26, signal = EMA9 of MACD line series
  const ema12arr   = calcEMA(closes, 12);
  const ema26arr   = calcEMA(closes, 26);
  const macdSeries = ema12arr
    .map((e12, i) => (isNaN(e12) || isNaN(ema26arr[i])) ? NaN : e12 - ema26arr[i])
    .filter(v => !isNaN(v));
  const macdSigArr = calcEMA(macdSeries, 9);
  const macdLine   = macdSeries[macdSeries.length - 1] ?? 0;
  const macdSig    = macdSigArr[macdSigArr.length - 1] ?? 0;
  const macdBull   = macdLine > macdSig;

  const { adx, plusDI, minusDI } = calcADX(ohlcv, 14);
  const adxBull = adx > 20 && plusDI > minusDI;

  // ── Score (max 7, BUY threshold = 5) ──
  let score = 0, emaAlign = 0;
  if (price > ema20 && ema20 > 0)                     { score += 1; emaAlign++; }
  if (ema20  > ema50 && ema50 > 0)                    { score += 1; emaAlign++; }
  if (hasLongData && ema200 > 0 && ema50 > ema200)    { score += 1; emaAlign++; }
  if (rsi >= 40 && rsi <= 68)                         score += 1;
  if (macdBull)                                       score += 1;
  if (adxBull)                                        score += 1;
  if (volumeRatio >= 1.0)                             score += 1;

  // Hard gate: EMA50 > EMA200 required when data is available (no longs in bear structure)
  const longTermBull = !hasLongData || (ema200 > 0 && ema50 > ema200);
  const action: "BUY" | "HOLD" = (score >= 5 && longTermBull) ? "BUY" : "HOLD";

  return { action, price, rsi, atr, atrPct, volumeRatio, score, buyScore: score, sellScore: 0, emaAlign, macdBull, adxBull, ema20, ema50, ema200, adx, plusDI, minusDI };
}

// ── OHLCV Persistence ──────────────────────────────────────────────────────────

async function saveOHLCV(symbol: string, candles: number[][], timeframe = "1m") {
  if (!candles.length) return;
  await pool.query(
    `INSERT INTO ohlcv (symbol, timeframe, timestamp, open, high, low, close, volume)
     SELECT $1, $2, unnest($3::bigint[]), unnest($4::numeric[]), unnest($5::numeric[]),
            unnest($6::numeric[]), unnest($7::numeric[]), unnest($8::numeric[])
     ON CONFLICT (symbol, timeframe, timestamp) DO NOTHING`,
    [symbol, timeframe,
     candles.map(c => c[0]), candles.map(c => c[1]), candles.map(c => c[2]),
     candles.map(c => c[3]), candles.map(c => c[4]), candles.map(c => c[5])]
  );
}

// ── Scanner State ──────────────────────────────────────────────────────────────

const SYMBOLS   = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "BNB/USDT", "AVAX/USDT", "ARB/USDT", "OP/USDT"];
const toWsSym   = (s: string) => s.replace("/", "").toLowerCase();    // BTC/USDT → btcusdt
const toCcxtSym = (s: string) => s.slice(0, -4) + "/" + s.slice(-4); // BTCUSDT → BTC/USDT

// 50-candle buffer (5m) for MOMENTUM ARB strategy
const momentumBuffer = new Map<string, number[][]>(SYMBOLS.map(s => [s, []]));
// 200-candle buffer (15m) for trend filter — EMA200 direction
const trendBuffer    = new Map<string, number[][]>(SYMBOLS.map(s => [s, []]));
// 250-candle buffer (4h) for SWING-LONG — covers EMA200 (~33 days)
const swingBuffer    = new Map<string, number[][]>(SYMBOLS.map(s => [s, []]));
// Per-strategy action + attempt trackers — transition detection + retry without flooding the exchange
const lastMomentumAction    = new Map<string, string>(SYMBOLS.map(s => [s, "HOLD"]));
const lastMomentumAttempt   = new Map<string, number>(SYMBOLS.map(s => [s, 0]));
const lastMeanRevAction     = new Map<string, string>(SYMBOLS.map(s => [s, "HOLD"]));
const lastMeanRevAttempt    = new Map<string, number>(SYMBOLS.map(s => [s, 0]));
const lastSwingAction       = new Map<string, string>(SYMBOLS.map(s => [s, "HOLD"]));
const lastSwingAttempt      = new Map<string, number>(SYMBOLS.map(s => [s, 0]));

let scanResults: any[] = [];
// Set of currently enabled strategies — includes SWING-LONG
let activeStrategies = new Set<string>(["MOMENTUM-ARB", "MEAN-REV", "SWING-LONG"]);
// Taker fee rate — configurable via Settings, persisted in DB
let takerRate  = 0.0004;
let paperMode  = true;   // paper-trade mode (execute virtual trades, no Binance API)

// ── Validation Log ─────────────────────────────────────────────────────────────
// Real-time audit trail of every generateSignal run so the frontend can show
// exactly which filter blocked (or passed) a signal.
type ValidationCheck = { name: string; status: "pass" | "block" | "info"; detail: string };
type ValidationEntry = {
  id: string;
  timestamp: number;
  symbol: string;
  strategy: string;
  action: string;
  finalStatus: "executed" | "blocked" | "skipped" | "signaled";
  checks: ValidationCheck[];
};
const validationLogs: ValidationEntry[] = [];

function pushValidation(entry: ValidationEntry) {
  validationLogs.unshift(entry);
  if (validationLogs.length > 40) validationLogs.pop();
  broadcastSSE("validation", entry);
}

// ── Trend Filter (EMA 200 on 15m) ─────────────────────────────────────────────

function getTrend(symbol: string): "UP" | "DOWN" | "NEUTRAL" {
  const buf = trendBuffer.get(symbol) || [];
  if (buf.length < 200) return "NEUTRAL";
  const closes  = buf.map(c => c[4]);
  const ema200  = calcEMA(closes, 200);
  const lastEma = ema200[ema200.length - 1];
  const lastPrice = closes[closes.length - 1];
  if (isNaN(lastEma) || lastEma === 0) return "NEUTRAL";
  if (lastPrice > lastEma) return "UP";
  if (lastPrice < lastEma) return "DOWN";
  return "NEUTRAL"; // hanya tepat di EMA200 (sangat jarang)
}

// Market regime detection using ADX on 15m trend buffer.
// Crypto perps frequently sit at ADX 25-32 during normal chop — the textbook
// >25 trending boundary mislabels too much. Widened band keeps NEUTRAL dominant.
// TRENDING = ADX > 32 (strong trend, disable mean-rev)
// RANGING  = ADX < 18 (weak trend, disable momentum)
// NEUTRAL  = ADX 18-32 (all strategies allowed)
function getRegime(symbol: string): { regime: "TRENDING" | "RANGING" | "NEUTRAL"; adx: number; plusDI: number; minusDI: number } {
  const buf = trendBuffer.get(symbol) || [];
  if (buf.length < 29) return { regime: "NEUTRAL", adx: 0, plusDI: 0, minusDI: 0 };
  const { adx, plusDI, minusDI } = calcADX(buf, 14);
  if (adx > 32) return { regime: "TRENDING", adx, plusDI, minusDI };
  if (adx < 18) return { regime: "RANGING", adx, plusDI, minusDI };
  return { regime: "NEUTRAL", adx, plusDI, minusDI };
}

// Returns a TP price guaranteed to cover round-trip taker fees (entry + exit).
// If ATR-based TP profit < total fee, bumps TP up by 10% above fee cost.
function safeTpPrice(
  isLong: boolean, fillPrice: number, amount: number,
  rawTpPct: number, entryFeeUsdt: number, symbol: string
): number {
  let tp = isLong ? fillPrice * (1 + rawTpPct) : fillPrice * (1 - rawTpPct);
  const exitFee  = tp * amount * takerRate;
  const totalFee = entryFeeUsdt + exitFee;
  const profit   = Math.abs(tp - fillPrice) * amount;
  if (profit < totalFee) {
    const minDiff = (totalFee * 1.1) / amount; // 10% buffer above break-even
    tp = isLong ? fillPrice + minDiff : fillPrice - minDiff;
    console.log(`[TP-FEE] bumped TP → ${tp.toFixed(4)} (profit ${profit.toFixed(4)} < fee ${totalFee.toFixed(4)} USDT)`);
  }
  return parseFloat((binance as any).priceToPrecision(symbol, tp));
}

// Adjusts TP/SL multipliers based on all market context signals.
// tpBonus > 1.0 = extend TP; slMult < 1.0 = tighten SL.
function calcContextMultipliers(
  action: string, strategyName: string,
  fundingRate: number | undefined,
  fearGreed: { value: number } | null,
  vwap = 0, price = 0,
  oiChangePct?: number,
  lsRatio?: number
): { tpBonus: number; slMult: number } {
  let tpBonus = 1.0;
  let slMult  = 1.0;

  // Funding: favorable side (you receive it) → extend TP; crowded side → tighten SL
  if (fundingRate !== undefined) {
    if (action === "BUY"  && fundingRate < -0.0002) tpBonus += 0.2;
    if (action === "SELL" && fundingRate >  0.0002) tpBonus += 0.2;
    if (action === "BUY"  && fundingRate >  0.0003) slMult = 0.8;
    if (action === "SELL" && fundingRate < -0.0002) slMult = 0.8;
  }

  // F&G: MEAN-REV only — extreme sentiment = larger potential snap-back
  if (fearGreed && strategyName === "MEAN-REV") {
    const fg = fearGreed.value;
    if (action === "BUY"  && fg < 40) tpBonus += Math.min((40 - fg) / 40 * 0.4, 0.4);
    if (action === "SELL" && fg > 60) tpBonus += Math.min((fg - 60) / 40 * 0.4, 0.4);
  }

  // VWAP: entry at discount (below VWAP for BUY) = more room to mean-revert → extend TP
  if (vwap > 0 && price > 0) {
    const pctFromVwap = (price - vwap) / vwap;
    if (action === "BUY"  && pctFromVwap < -0.001) tpBonus += Math.min(Math.abs(pctFromVwap) * 8, 0.2);
    if (action === "SELL" && pctFromVwap >  0.001) tpBonus += Math.min(pctFromVwap * 8, 0.2);
  }

  // OI rising = real money confirming direction → extend TP
  if (oiChangePct !== undefined && oiChangePct > 1.0) tpBonus += 0.15;

  // L/S: market crowded against you = unwind fuel → extend TP
  if (lsRatio !== undefined) {
    if (action === "SELL" && lsRatio > 1.5) tpBonus += Math.min((lsRatio - 1.5) / 2 * 0.25, 0.25);
    if (action === "BUY"  && lsRatio < 0.8) tpBonus += Math.min((0.8 - lsRatio) / 0.8 * 0.25, 0.25);
  }

  return { tpBonus: Math.min(tpBonus, 1.8), slMult };
}


// ── Auto-Execute ───────────────────────────────────────────────────────────────

type AnySignal = { action: "BUY" | "SELL" | "HOLD"; price: number; rsi: number; volumeRatio: number; atr: number; atrPct: number; score?: number; buyScore?: number; sellScore?: number; cross?: string | null; bbPos?: string | null };

async function generateSignal(symbol: string, signal: AnySignal, strategyName: string) {
  const vid = Math.random().toString(36).slice(2, 8);
  const checks: ValidationCheck[] = [];

  const trend = getTrend(symbol);
  const { regime, adx } = getRegime(symbol);
  console.log(`[${strategyName}] ${symbol} → ${signal.action} RSI:${signal.rsi} trend:${trend} regime:${regime}(ADX:${adx})`);

  checks.push({ name: "Signal", status: "info", detail: `${signal.action}  RSI:${signal.rsi}  Score:${(signal.score ?? 0).toFixed(1)}` });
  checks.push({ name: "Regime", status: "info", detail: `${regime} (ADX ${adx.toFixed(1)})` });

  if (signal.action === "HOLD") {
    pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "skipped", checks });
    return;
  }

  // Regime filter
  const meanRevConflict  = strategyName === "MEAN-REV"      && regime === "TRENDING";
  const momentumConflict = strategyName === "MOMENTUM-ARB"  && regime === "RANGING";
  if (meanRevConflict || momentumConflict) {
    const reason = meanRevConflict
      ? `ADX ${adx.toFixed(1)} (strong trend) — mean-rev contra-trend risk`
      : `ADX ${adx.toFixed(1)} (ranging) — momentum needs directional move`;
    checks.push({ name: "Regime Gate", status: "block", detail: `${strategyName} blocked — ${reason}` });
    pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
    console.log(`[REGIME] ${symbol} ${strategyName} blocked — ${reason}`);
    return;
  }
  checks.push({ name: "Regime Gate", status: "pass", detail: `${strategyName} allowed in ${regime} regime` });

  // Trend filter — only MOMENTUM-ARB uses this
  if (strategyName === "MOMENTUM-ARB") {
    if (signal.action === "BUY"  && trend === "DOWN") {
      checks.push({ name: "Trend", status: "block", detail: `BUY blocked — trend is DOWN` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[TREND] ${symbol} BUY blocked — DOWN`); return;
    }
    if (signal.action === "SELL" && trend === "UP") {
      checks.push({ name: "Trend", status: "block", detail: `SELL blocked — trend is UP` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[TREND] ${symbol} SELL blocked — UP`); return;
    }
    checks.push({ name: "Trend", status: "pass", detail: `${signal.action} aligned with ${trend} trend` });
  } else {
    checks.push({ name: "Trend", status: "pass", detail: `Skipped — ${strategyName} ignores trend` });
  }

  // Volume thresholds
  const volThreshold = strategyName === "MEAN-REV"     ? 0.6
                     : strategyName === "MOMENTUM-ARB" ? 0.8
                     :                                   0.7;
  const volRatio = signal.volumeRatio ?? 1;
  if (volRatio < volThreshold) {
    checks.push({ name: "Volume", status: "block", detail: `${volRatio.toFixed(2)}× < ${volThreshold}× threshold` });
    pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
    console.log(`[VOL] ${symbol} blocked — ${volRatio}× < ${volThreshold}× threshold`);
    return;
  }
  checks.push({ name: "Volume", status: "pass", detail: `${volRatio.toFixed(2)}× ≥ ${volThreshold}× threshold` });

  // Funding rate filter
  const fundingRate = fundingRateCache.get(symbol);
  if (fundingRate !== undefined) {
    if (signal.action === "BUY" && fundingRate > 0.0005) {
      checks.push({ name: "Funding", status: "block", detail: `${(fundingRate * 100).toFixed(4)}% > 0.05%` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[FUNDING] ${symbol} BUY blocked — ${(fundingRate * 100).toFixed(4)}% > 0.05%`); return;
    }
    if (signal.action === "SELL" && fundingRate < -0.0006) {
      checks.push({ name: "Funding", status: "block", detail: `${(fundingRate * 100).toFixed(4)}% < -0.06%` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[FUNDING] ${symbol} SELL blocked — ${(fundingRate * 100).toFixed(4)}% < -0.06%`); return;
    }
    checks.push({ name: "Funding", status: "pass", detail: `${(fundingRate * 100).toFixed(4)}% within limits` });
  } else {
    checks.push({ name: "Funding", status: "pass", detail: `No data — skipped` });
  }

  // Fear & Greed filter
  if (fearGreedCache) {
    const fg = fearGreedCache.value;
    if (strategyName === "MEAN-REV") {
      if (signal.action === "BUY" && fg > 75) {
        checks.push({ name: "Fear & Greed", status: "block", detail: `MEAN-REV BUY blocked — Extreme Greed (${fg})` });
        pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
        console.log(`[F&G] ${symbol} MEAN-REV BUY blocked — Extreme Greed (${fg})`); return;
      }
      if (signal.action === "SELL" && fg < 25) {
        checks.push({ name: "Fear & Greed", status: "block", detail: `MEAN-REV SELL blocked — Extreme Fear (${fg})` });
        pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
        console.log(`[F&G] ${symbol} MEAN-REV SELL blocked — Extreme Fear (${fg})`); return;
      }
    }
    if (signal.action === "BUY"  && fg > 85) {
      checks.push({ name: "Fear & Greed", status: "block", detail: `BUY blocked — F&G ${fg}` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[F&G] ${symbol} BUY blocked — F&G ${fg}`); return;
    }
    if (signal.action === "SELL" && fg < 15) {
      checks.push({ name: "Fear & Greed", status: "block", detail: `SELL blocked — F&G ${fg}` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[F&G] ${symbol} SELL blocked — F&G ${fg}`); return;
    }
    checks.push({ name: "Fear & Greed", status: "pass", detail: `F&G ${fg} — within limits` });
  } else {
    checks.push({ name: "Fear & Greed", status: "pass", detail: `No data — skipped` });
  }

  // Open Interest filter
  const oiData = openInterestCache.get(symbol);
  if (oiData) {
    if (strategyName === "MOMENTUM-ARB" && signal.action === "BUY" && oiData.oiChangePct < -4.0) {
      checks.push({ name: "Open Interest", status: "block", detail: `OI ${oiData.oiChangePct.toFixed(2)}%` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[OI] ${symbol} blocked — OI ${oiData.oiChangePct.toFixed(2)}%`); return;
    }
    if (strategyName === "MEAN-REV" && signal.action === "SELL" && oiData.oiChangePct < -4.0) {
      checks.push({ name: "Open Interest", status: "block", detail: `OI ${oiData.oiChangePct.toFixed(2)}%` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[OI] ${symbol} blocked — OI ${oiData.oiChangePct.toFixed(2)}%`); return;
    }
    checks.push({ name: "Open Interest", status: "pass", detail: `OI ${oiData.oiChangePct.toFixed(2)}% — valid` });
  } else {
    checks.push({ name: "Open Interest", status: "pass", detail: `No data — skipped` });
  }

  // Long/Short Ratio filter
  const lsRatio = longShortCache.get(symbol);
  if (lsRatio !== undefined) {
    if (signal.action === "BUY"  && lsRatio > 2.5) {
      checks.push({ name: "Long/Short", status: "block", detail: `L/S ${lsRatio.toFixed(2)}` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[LS] ${symbol} BUY blocked — L/S ${lsRatio.toFixed(2)}`); return;
    }
    if (signal.action === "SELL" && lsRatio < 0.4) {
      checks.push({ name: "Long/Short", status: "block", detail: `L/S ${lsRatio.toFixed(2)}` });
      pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
      console.log(`[LS] ${symbol} SELL blocked — L/S ${lsRatio.toFixed(2)}`); return;
    }
    checks.push({ name: "Long/Short", status: "pass", detail: `L/S ${lsRatio.toFixed(2)} — balanced` });
  } else {
    checks.push({ name: "Long/Short", status: "pass", detail: `No data — skipped` });
  }

  // Score gate
  const score = signal.score ?? 0;
  if (score < 3.0) {
    checks.push({ name: "Score", status: "block", detail: `${score.toFixed(1)} < 3.0` });
    pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
    console.log(`[SCORE] ${symbol} blocked — ${score} < 3.0`); return;
  }
  checks.push({ name: "Score", status: "pass", detail: `${score.toFixed(1)} ≥ 3.0` });

  // Cooldown per strategy
  const cooldown = strategyName === "SWING-LONG"   ? "24 hours"
                 : strategyName === "MOMENTUM-ARB" ? "15 minutes"
                 : strategyName === "MEAN-REV"      ? "30 minutes"
                 :                                   "5 minutes";
  const recent   = await pool.query(
    `SELECT id FROM signals WHERE symbol = $1 AND strategy = $2
     AND sent_at > NOW() - INTERVAL '${cooldown}' LIMIT 1`, [symbol, strategyName]
  );
  if (recent.rows.length > 0) {
    checks.push({ name: "Cooldown", status: "block", detail: `Active (${cooldown})` });
    pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "blocked", checks });
    console.log(`[SIGNAL] ${symbol} ${strategyName} skipped — cooldown active (${cooldown})`);
    return;
  }
  checks.push({ name: "Cooldown", status: "pass", detail: `None (${cooldown} window clear)` });

  // ATR multipliers
  const cfgRow   = await pool.query("SELECT atr_sl_mult::float, atr_tp_mult::float, arb_sl_mult::float, arb_tp_mult::float, mr_sl_mult::float, mr_tp_mult::float, swing_sl_mult::float, swing_tp_mult::float FROM bot_settings WHERE id = 'bot_config'");
  const slMult   = strategyName === "SWING-LONG"   ? (cfgRow.rows[0]?.swing_sl_mult ?? 2.0)
                 : strategyName === "MOMENTUM-ARB" ? (cfgRow.rows[0]?.arb_sl_mult  ?? 1.0)
                 : strategyName === "MEAN-REV"      ? (cfgRow.rows[0]?.mr_sl_mult   ?? 1.0)
                 :                                    (cfgRow.rows[0]?.atr_sl_mult  ?? 1.5);
  const tpMult   = strategyName === "SWING-LONG"   ? (cfgRow.rows[0]?.swing_tp_mult ?? 8.0)
                 : strategyName === "MOMENTUM-ARB" ? (cfgRow.rows[0]?.arb_tp_mult  ?? 3.0)
                 : strategyName === "MEAN-REV"      ? (cfgRow.rows[0]?.mr_tp_mult   ?? 2.0)
                 :                                    (cfgRow.rows[0]?.atr_tp_mult  ?? 4.0);
  const isLong    = signal.action === "BUY";
  const side      = isLong ? "LONG" : "SHORT";
  const entryPrice = signal.price;
  const atr       = signal.atr ?? 0;

  // Context multipliers
  const vwap = parseFloat(calcVWAP(momentumBuffer.get(symbol) || []).toFixed(6));
  const oiD  = openInterestCache.get(symbol);
  const { tpBonus, slMult: ctxSlMult } = calcContextMultipliers(
    signal.action, strategyName,
    fundingRateCache.get(symbol), fearGreedCache,
    vwap, entryPrice,
    oiD?.oiChangePct, longShortCache.get(symbol)
  );
  const dynSlPct = Math.min(Math.max((atr / entryPrice) * slMult * ctxSlMult, 0.001), 0.05);
  const dynTpPct = Math.min(Math.max((atr / entryPrice) * tpMult * tpBonus,   0.01),  0.15);
  const slPrice  = isLong ? entryPrice * (1 - dynSlPct) : entryPrice * (1 + dynSlPct);
  const tpPrice  = isLong ? entryPrice * (1 + dynTpPct) : entryPrice * (1 - dynTpPct);

  const estDuration = strategyName === "SWING-LONG"   ? "1–3 days"
                    : strategyName === "MOMENTUM-ARB" ? "30–60 min"
                    : strategyName === "MEAN-REV"      ? "1–4 hours"
                    :                                   "5–15 min";
  const timeframe   = strategyName === "SWING-LONG"   ? "4h"
                    : strategyName === "MOMENTUM-ARB" ? "5m"
                    : strategyName === "MEAN-REV"      ? "15m"
                    :                                   "1m";

  // Insert signal
  await pool.query(
    `INSERT INTO signals (symbol, side, strategy, timeframe, entry_price, tp_price, sl_price, confidence, est_duration, context, status, telegram_sent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', false)`,
    [symbol, side, strategyName, timeframe, entryPrice, tpPrice, slPrice, score, estDuration,
      JSON.stringify({ trend, regime, adx, volRatio, fundingRate, fg: fearGreedCache?.value, oiChangePct: oiD?.oiChangePct, lsRatio })]
  );

  // Send Telegram
  const icon = "🚨";
  const status = "SIGNAL GENERATED";
  const slPriceDisplay = slPrice > 0 ? slPrice.toLocaleString() : "N/A";
  const tpPriceDisplay = tpPrice > 0 ? tpPrice.toLocaleString() : "N/A";

  await sendTelegram(
    `${icon} <b>NEXUSBOT SIGNAL — ${status}</b>
` +
    `<code>${symbol}</code>  <b>${isLong ? "LONG 🟢" : "SHORT 🔴"}</b>  <code>${strategyName}</code>
` +
    `Score: <code>${score.toFixed(1)}/5.0</code>  RSI: <code>${signal.rsi}</code>

` +
    `📊 <b>SETUP</b>
` +
    `Entry: <code>$${entryPrice.toLocaleString()}</code>
` +
    `TP:    <code>$${tpPriceDisplay}</code>  (+${(dynTpPct*100).toFixed(2)}%)
` +
    `SL:    <code>$${slPriceDisplay}</code>  (-${(dynSlPct*100).toFixed(2)}%)
` +
    `⏱ Est. Time: <code>${estDuration}</code>

` +
    `📈 Trend: <code>${trend}</code> | Regime: <code>${regime}</code>
` +
    `💧 Vol: <code>${volRatio.toFixed(1)}×</code> | Funding: <code>${((fundingRate ?? 0)*100).toFixed(4)}%</code>
` +
    `Sent: <code>${new Date().toISOString()}</code>`
  );

  // Mark telegram_sent = true on the latest signal for this symbol+strategy
  await pool.query(
    `UPDATE signals SET telegram_sent = true WHERE symbol = $1 AND strategy = $2 AND sent_at = (SELECT MAX(sent_at) FROM signals WHERE symbol = $1 AND strategy = $2)`,
    [symbol, strategyName]
  );

  checks.push({ name: "Signal Sent", status: "pass", detail: `Telegram alert dispatched` });
  pushValidation({ id: vid, timestamp: Date.now(), symbol, strategy: strategyName, action: signal.action, finalStatus: "signaled", checks });

  broadcastSSE("signal", {
    symbol, side, strategy: strategyName, entryPrice, tpPrice, slPrice,
    confidence: score, estDuration, timestamp: Date.now()
  });

  console.log(`[SIGNAL] ✓ ${side} ${symbol} @ ${entryPrice} TP:${tpPrice} SL:${slPrice} [${strategyName}]`);

  // Execute a paper trade immediately if paper mode is enabled
  if (paperMode) {
    await executePaperTrade(symbol, side, strategyName, entryPrice, tpPrice, slPrice, score, {
      trend, regime, adx, volRatio, fundingRate, fg: fearGreedCache?.value,
    });
  }
}

// ── Paper Trading ──────────────────────────────────────────────────────────────

async function executePaperTrade(
  symbol: string, side: string, strategy: string,
  entryPrice: number, tpPrice: number, slPrice: number,
  score: number, context: Record<string, any> = {}
) {
  try {
    await pool.query(
      `INSERT INTO paper_trades (symbol, strategy, side, entry_price, tp_price, sl_price, signal_score, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [symbol, strategy, side, entryPrice, tpPrice, slPrice, score, JSON.stringify(context)]
    );
    const isLong = side === "LONG";
    const tpPct  = isLong ? (tpPrice - entryPrice) / entryPrice * 100 : (entryPrice - tpPrice) / entryPrice * 100;
    const slPct  = isLong ? (entryPrice - slPrice) / entryPrice * 100 : (slPrice - entryPrice) / entryPrice * 100;
    const rr     = slPct > 0 ? (tpPct / slPct).toFixed(2) : "N/A";
    await sendTelegram(
      `📝 <b>PAPER TRADE OPENED</b>\n` +
      `${isLong ? "🟢 LONG" : "🔴 SHORT"} <code>${symbol}</code>  [${strategy}]\n\n` +
      `Entry: <code>$${entryPrice.toLocaleString()}</code>\n` +
      `TP:    <code>$${tpPrice.toLocaleString()}</code>  (+${tpPct.toFixed(2)}%)\n` +
      `SL:    <code>$${slPrice.toLocaleString()}</code>  (-${slPct.toFixed(2)}%)\n` +
      `R:R    <code>1 : ${rr}</code>   Score: <code>${score.toFixed(1)}</code>`
    );
    console.log(`[PAPER] ✓ ${side} ${symbol} @ ${entryPrice} TP:${tpPrice} SL:${slPrice} [${strategy}]`);
  } catch (e: any) {
    console.error(`[PAPER] Error opening trade:`, e?.message);
  }
}

async function updateStrategyStats(strategy: string, pnlPct: number) {
  try {
    const isWin = pnlPct > 0;
    await pool.query(
      `INSERT INTO strategy_stats (strategy, total_trades, win_trades, loss_trades, total_pnl_pct,
                                   avg_win_pct, avg_loss_pct, last_updated)
       VALUES ($1, 1, $2, $3, $4,
         CASE WHEN $4 > 0 THEN $4 ELSE 0 END,
         CASE WHEN $4 <= 0 THEN $4 ELSE 0 END,
         NOW())
       ON CONFLICT (strategy) DO UPDATE
       SET total_trades  = strategy_stats.total_trades + 1,
           win_trades    = strategy_stats.win_trades   + $2,
           loss_trades   = strategy_stats.loss_trades  + $3,
           total_pnl_pct = strategy_stats.total_pnl_pct + $4,
           avg_win_pct   = CASE
             WHEN (strategy_stats.win_trades + $2) > 0 THEN
               (strategy_stats.avg_win_pct * strategy_stats.win_trades + GREATEST($4, 0))
               / (strategy_stats.win_trades + $2)
             ELSE strategy_stats.avg_win_pct END,
           avg_loss_pct  = CASE
             WHEN (strategy_stats.loss_trades + $3) > 0 THEN
               (strategy_stats.avg_loss_pct * strategy_stats.loss_trades + LEAST($4, 0))
               / (strategy_stats.loss_trades + $3)
             ELSE strategy_stats.avg_loss_pct END,
           last_updated  = NOW()`,
      [strategy, isWin ? 1 : 0, isWin ? 0 : 1, pnlPct]
    );
  } catch (e: any) {
    console.error(`[STATS] Error updating strategy stats:`, e?.message);
  }
}

async function runPaperTradeMonitor() {
  try {
    const openTrades = await pool.query(
      `SELECT id, symbol, strategy, side,
              entry_price::float, tp_price::float, sl_price::float
       FROM paper_trades WHERE status = 'OPEN'`
    );
    if (openTrades.rows.length === 0) return;

    for (const trade of openTrades.rows) {
      const price = markPriceCache.get(trade.symbol)
                 ?? scanResults.find(r => r.symbol === trade.symbol)?.price;
      if (!price) continue;

      const isLong = trade.side === "LONG";
      const hitTP  = isLong ? price >= trade.tp_price : price <= trade.tp_price;
      const hitSL  = isLong ? price <= trade.sl_price : price >= trade.sl_price;
      if (!hitTP && !hitSL) continue;

      const closeReason = hitTP ? "TP" : "SL";
      const pnlPct = isLong
        ? (price - trade.entry_price) / trade.entry_price * 100
        : (trade.entry_price - price) / trade.entry_price * 100;

      await pool.query(
        `UPDATE paper_trades SET status = $1, close_time = NOW(), close_price = $2, pnl_pct = $3 WHERE id = $4`,
        [closeReason, price, pnlPct, trade.id]
      );
      await updateStrategyStats(trade.strategy, pnlPct);

      const emoji   = hitTP ? "✅" : "❌";
      const pnlSign = pnlPct >= 0 ? "+" : "";
      await sendTelegram(
        `${emoji} <b>PAPER TRADE CLOSED — ${closeReason}</b>\n` +
        `${isLong ? "🟢 LONG" : "🔴 SHORT"} <code>${trade.symbol}</code>  [${trade.strategy}]\n\n` +
        `Entry: <code>$${trade.entry_price.toLocaleString()}</code>\n` +
        `Exit:  <code>$${price.toLocaleString()}</code>\n` +
        `PnL:   <code>${pnlSign}${pnlPct.toFixed(2)}%</code>  ${hitTP ? "🎯" : "🛑"}`
      );
      broadcastSSE("paper_trade_closed", {
        id: trade.id, symbol: trade.symbol, strategy: trade.strategy,
        reason: closeReason, pnlPct: parseFloat(pnlPct.toFixed(2)),
        entryPrice: trade.entry_price, closePrice: price,
      });
      console.log(`[PAPER] ${closeReason} ${trade.symbol} ${pnlSign}${pnlPct.toFixed(2)}% [${trade.strategy}]`);
    }
  } catch (e: any) {
    console.error("[PAPER] Monitor error:", e?.message);
  }
}

// ── WebSocket — Binance Futures Kline Stream ───────────────────────────────────

async function seedCandleBuffer() {
  console.log(`[SEED] Fetching 5m + 15m + 4h candles (active: ${[...activeStrategies].join(", ")})...`);
  await Promise.all(SYMBOLS.map(async symbol => {
    try {
      // 5m — MOMENTUM ARB (50 candles ≈ 4 hours)
      // Fetch +1 extra and drop the last (currently-open) candle so partial volume doesn't skew the ratio.
      const ohlcv5m = await binance.fetchOHLCV(symbol, "5m", undefined, 51);
      const buf5m   = ohlcv5m.slice(0, -1).map((c: any[]) => c.map(Number) as number[]);
      momentumBuffer.set(symbol, buf5m);

      // 15m — trend filter (200 candles ≈ 50 hours)
      const ohlcv15m = await binance.fetchOHLCV(symbol, "15m", undefined, 201);
      const buf15m   = ohlcv15m.slice(0, -1).map((c: any[]) => c.map(Number) as number[]);
      trendBuffer.set(symbol, buf15m);
      await saveOHLCV(symbol, buf15m, "15m");

      // 4h — SWING-LONG (252 candles ≈ 42 days — enough for valid EMA200 on 4h)
      const ohlcv4h = await binance.fetchOHLCV(symbol, "4h", undefined, 252);
      const buf4h   = ohlcv4h.slice(0, -1).map((c: any[]) => c.map(Number) as number[]);
      swingBuffer.set(symbol, buf4h);

      // Build initial scanResult for all strategies simultaneously
      const trend    = getTrend(symbol);
      const { regime, adx, plusDI, minusDI } = getRegime(symbol);
      const sig5m    = calculateMomentumSignal(buf5m);
      const sigMR    = calculateMeanRevSignal(buf15m);
      const sigSwing = calculateSwingLongSignal(buf4h);
      const entry    = {
        symbol,
        price:       sig5m.price,
        trend,
        regime,
        adx,
        plusDI,
        minusDI,
        vwap:        parseFloat(calcVWAP(buf5m).toFixed(6)),
        oiChangePct: openInterestCache.get(symbol)?.oiChangePct ?? null,
        lsRatio:     longShortCache.get(symbol) ?? null,
        momentumArb: { action: sig5m.action, rsi: sig5m.rsi, volumeRatio: sig5m.volumeRatio, atrPct: sig5m.atrPct, cross: sig5m.cross, score: sig5m.score },
        meanRev:     { action: sigMR.action, rsi: sigMR.rsi, volumeRatio: sigMR.volumeRatio, atrPct: sigMR.atrPct, bbPos: sigMR.bbPos, score: sigMR.score },
        swingLong:   { action: sigSwing.action, rsi: sigSwing.rsi, volumeRatio: sigSwing.volumeRatio, atrPct: sigSwing.atrPct, score: sigSwing.score, emaAlign: sigSwing.emaAlign, macdBull: sigSwing.macdBull, adxBull: sigSwing.adxBull, ema20: sigSwing.ema20, ema50: sigSwing.ema50, ema200: sigSwing.ema200, adx: sigSwing.adx },
      };
      const idx = scanResults.findIndex(r => r.symbol === symbol);
      if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);
      console.log(`[SEED] ${symbol} MA:${sig5m.action} MR:${sigMR.action} SW:${sigSwing.action}(${sigSwing.score.toFixed(1)}) trend:${trend} regime:${regime}(ADX:${adx})`);
    } catch (e: any) {
      console.error(`[SEED] ${symbol}:`, e?.message);
    }
  }));
}

// Refresh 4h swing buffers via REST every 15 min — 4h candles change slowly so
// WebSocket is unnecessary; REST poll is cleaner and avoids stream count limits.
async function refreshSwingBuffers() {
  await Promise.all(SYMBOLS.map(async symbol => {
    try {
      const ohlcv4h = await binance.fetchOHLCV(symbol, "4h", undefined, 252);
      const buf4h   = ohlcv4h.slice(0, -1).map((c: any[]) => c.map(Number) as number[]);
      swingBuffer.set(symbol, buf4h);

      if (buf4h.length < 55) return;
      const signal = calculateSwingLongSignal(buf4h);

      const idx = scanResults.findIndex(r => r.symbol === symbol);
      if (idx >= 0) {
        scanResults[idx].swingLong = {
          action: signal.action, rsi: signal.rsi, volumeRatio: signal.volumeRatio,
          atrPct: signal.atrPct, score: signal.score,
          emaAlign: signal.emaAlign, macdBull: signal.macdBull, adxBull: signal.adxBull,
          ema20: signal.ema20, ema50: signal.ema50, ema200: signal.ema200, adx: signal.adx,
        };
      }

      const prevAction  = lastSwingAction.get(symbol) || "HOLD";
      const lastAttempt = lastSwingAttempt.get(symbol) ?? 0;
      const isNew   = signal.action === "BUY" && prevAction === "HOLD";
      const isRetry = signal.action === "BUY" && (Date.now() - lastAttempt) > 30 * 60 * 1000;

      if (activeStrategies.has("SWING-LONG") && (isNew || isRetry)) {
        lastSwingAttempt.set(symbol, Date.now());
        await generateSignal(symbol, signal as AnySignal, "SWING-LONG");
      }
      lastSwingAction.set(symbol, signal.action);
    } catch (e: any) {
      console.error(`[SWING] Refresh error [${symbol}]:`, e?.message);
    }
  }));
}

function initWebSocket() {
  const streams5m  = SYMBOLS.map(s => `${toWsSym(s)}@kline_5m`);
  const streams15m = SYMBOLS.map(s => `${toWsSym(s)}@kline_15m`);
  const allStreams  = [...streams5m, ...streams15m].join("/");
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${allStreams}`);

  ws.on("open", () => console.log("[WS] Connected — 5m + 15m streams"));

  ws.on("message", async (raw: Buffer) => {
    try {
      const k = JSON.parse(raw.toString())?.data?.k;
      if (!k) return;

      const symbol = toCcxtSym(k.s);
      const candle: number[] = [k.t, +k.o, +k.h, +k.l, +k.c, +k.v];

      // ── 15m: trend filter buffer + MEAN-REV signal ──
      if (k.i === "15m") {
        const buf15 = trendBuffer.get(symbol) || [];
        if (k.x) {
          buf15.push(candle);
          if (buf15.length > 200) buf15.shift();
          trendBuffer.set(symbol, buf15);
          await saveOHLCV(symbol, [candle], "15m");
        } else {
          if (buf15.length > 0) buf15[buf15.length - 1] = candle;
          trendBuffer.set(symbol, buf15);
        }

        // Evaluate MEAN-REV on every tick (close or live) — catches BB touches mid-candle
        if (buf15.length >= 20) {
          const signal = calculateMeanRevSignal(buf15);
          const trend  = getTrend(symbol);
          const { regime, adx, plusDI, minusDI } = getRegime(symbol);
          const idx    = scanResults.findIndex(r => r.symbol === symbol);
          const entry  = scanResults[idx] || { symbol, price: signal.price, trend };
          entry.trend   = trend;
          entry.regime  = regime;
          entry.adx     = adx;
          entry.plusDI  = plusDI;
          entry.minusDI = minusDI;
          entry.meanRev = { action: signal.action, rsi: signal.rsi, volumeRatio: signal.volumeRatio, atrPct: signal.atrPct, bbPos: signal.bbPos, score: signal.score };
          if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);

          const prevMR  = lastMeanRevAction.get(symbol)  || "HOLD";
          const lastMR  = lastMeanRevAttempt.get(symbol) ?? 0;
          const isNewMR = signal.action !== "HOLD" && prevMR === "HOLD";
          const isRetryMR = signal.action !== "HOLD" && (Date.now() - lastMR) > 2 * 60 * 1000;
          if (activeStrategies.has("MEAN-REV") && (isNewMR || isRetryMR)) {
            lastMeanRevAttempt.set(symbol, Date.now());
            await generateSignal(symbol, signal, "MEAN-REV");
          }
          lastMeanRevAction.set(symbol, signal.action);
        }
        return;
      }

      // ── 5m: MOMENTUM ARB — evaluate on every tick, execute on crossover ──
      if (k.i === "5m") {
        const buf5 = momentumBuffer.get(symbol) || [];
        if (k.x) {
          buf5.push(candle);
          if (buf5.length > 50) buf5.shift();
          momentumBuffer.set(symbol, buf5);
        } else {
          if (buf5.length > 0) buf5[buf5.length - 1] = candle;
          momentumBuffer.set(symbol, buf5);
        }

        // Evaluate on every tick — catches EMA crossovers the moment they form, not at candle close
        if (buf5.length >= 22) {
          const signal = calculateMomentumSignal(buf5);
          const trend  = getTrend(symbol);
          const idx    = scanResults.findIndex(r => r.symbol === symbol);
          const entry  = scanResults[idx] || { symbol, price: signal.price, trend };
          entry.trend       = trend;
          entry.price       = signal.price;
          entry.vwap        = parseFloat(calcVWAP(buf5).toFixed(6));
          entry.oiChangePct = openInterestCache.get(symbol)?.oiChangePct ?? null;
          entry.lsRatio     = longShortCache.get(symbol) ?? null;
          entry.lastTickMs  = Date.now();
          entry.momentumArb = { action: signal.action, rsi: signal.rsi, volumeRatio: signal.volumeRatio, atrPct: signal.atrPct, cross: signal.cross, score: signal.score };
          if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);

          const prevMA  = lastMomentumAction.get(symbol)  || "HOLD";
          const lastMA  = lastMomentumAttempt.get(symbol) ?? 0;
          const isNewMA = signal.action !== "HOLD" && prevMA === "HOLD";
          const isRetryMA = signal.action !== "HOLD" && (Date.now() - lastMA) > 60 * 1000;
          if (activeStrategies.has("MOMENTUM-ARB") && (isNewMA || isRetryMA)) {
            lastMomentumAttempt.set(symbol, Date.now());
            await generateSignal(symbol, signal, "MOMENTUM-ARB");
          }
          lastMomentumAction.set(symbol, signal.action);
        }
        return;
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



// ── Market Context (Funding Rate + Fear & Greed) ────────────────────────────────

const fundingRateCache = new Map<string, number>(); // symbol → rate (e.g. 0.0001 = 0.01% per 8h)
const markPriceCache   = new Map<string, number>(); // symbol → mark price (Binance uses this for PnL)
let fearGreedCache: { value: number; classification: string } | null = null;

interface OIData { oi: number; oiChangePct: number }
const openInterestCache = new Map<string, OIData>(); // symbol → latest OI snapshot
const longShortCache    = new Map<string, number>(); // symbol → L/S ratio (e.g. 1.45 = 59% long)

async function fetchFundingRates() {
  try {
    const res  = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex");
    const data = (await res.json()) as any[];
    for (const item of data) {
      const ccxtSym = toCcxtSym(item.symbol);
      if (SYMBOLS.includes(ccxtSym)) {
        fundingRateCache.set(ccxtSym, parseFloat(item.lastFundingRate));
        if (item.markPrice) markPriceCache.set(ccxtSym, parseFloat(item.markPrice));
      }
    }
    console.log(`[FUNDING] Updated — BTC: ${((fundingRateCache.get("BTC/USDT") ?? 0) * 100).toFixed(4)}%`);
  } catch (e: any) {
    console.error("[FUNDING] Fetch error:", e?.message);
  }
}

async function fetchFearGreed() {
  try {
    const res  = await fetch("https://api.alternative.me/fng/?limit=1");
    const data = (await res.json()) as any;
    const item = data.data?.[0];
    if (item) {
      fearGreedCache = { value: parseInt(item.value), classification: item.value_classification };
      console.log(`[F&G] ${fearGreedCache.value} — ${fearGreedCache.classification}`);
    }
  } catch (e: any) {
    console.error("[F&G] Fetch error:", e?.message);
  }
}

// Read Telegram config from DB (overrides env vars if set)
async function getTelegramConfig(): Promise<{ token: string | null; chatId: string | null }> {
  try {
    const r = await pool.query("SELECT telegram_bot_token, telegram_chat_id FROM bot_settings WHERE id = 'bot_config'");
    const row = r.rows[0];
    return {
      token:  row?.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || null,
      chatId: row?.telegram_chat_id   || process.env.TELEGRAM_CHAT_ID   || null,
    };
  } catch {
    return {
      token:  process.env.TELEGRAM_BOT_TOKEN || null,
      chatId: process.env.TELEGRAM_CHAT_ID   || null,
    };
  }
}

async function sendTelegram(message: string): Promise<void> {
  const { token, chatId } = await getTelegramConfig();
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch (e: any) {
    console.error("[TELEGRAM] Send failed:", e?.message);
  }
}



async function fetchFuturesData() {
  await Promise.all(SYMBOLS.map(async symbol => {
    const binSym = symbol.replace("/", ""); // BTC/USDT → BTCUSDT
    try {
      const r    = await fetch(`https://fapi.binance.com/futures/data/openInterestStat?symbol=${binSym}&period=5m&limit=2`);
      const data = (await r.json()) as any[];
      if (Array.isArray(data) && data.length >= 2) {
        const cur  = parseFloat(data[data.length - 1].sumOpenInterest);
        const prev = parseFloat(data[data.length - 2].sumOpenInterest);
        openInterestCache.set(symbol, { oi: cur, oiChangePct: prev > 0 ? (cur - prev) / prev * 100 : 0 });
      }
    } catch { /* non-fatal — Binance may rate-limit some symbols */ }
    try {
      const r    = await fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${binSym}&period=5m&limit=1`);
      const data = (await r.json()) as any[];
      if (Array.isArray(data) && data.length > 0) longShortCache.set(symbol, parseFloat(data[0].longShortRatio));
    } catch { /* non-fatal */ }
  }));
  console.log(`[FUTURES-DATA] OI/LS updated for ${openInterestCache.size} symbols`);
}

// ── Binance Position Sync ──────────────────────────────────────────────────────

let lastSyncAt: string | null = null;



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

// ── SSE (Server-Sent Events) ───────────────────────────────────────────────────

const sseClients: any[] = [];

function broadcastSSE(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch {
      sseClients.splice(i, 1); // remove dead connections
    }
  }
}

// Build cooldown map from DB (cached for SSE)
let cachedCooldownMap: Record<string, { inCooldown: boolean; strategy: string; status: string }> = {};
let cachedCooldownAt = 0;
async function getCooldownMap(): Promise<Record<string, { inCooldown: boolean; strategy: string; status: string }>> {
  if (Date.now() - cachedCooldownAt < 5000) return cachedCooldownMap;
  try {
    const result = await pool.query(`
      WITH rules AS (
        SELECT symbol, strategy, timestamp, status,
          CASE
            WHEN status = 'OPEN' THEN true
            WHEN strategy = 'MOMENTUM-ARB' AND timestamp > NOW() - INTERVAL '15 minutes' THEN true
            WHEN strategy = 'MEAN-REV'     AND timestamp > NOW() - INTERVAL '30 minutes' THEN true
            WHEN strategy NOT IN ('MOMENTUM-ARB','MEAN-REV') AND timestamp > NOW() - INTERVAL '5 minutes' THEN true
            ELSE false
          END AS in_cooldown
        FROM trades
      )
      SELECT symbol, strategy, timestamp, status, in_cooldown
      FROM rules
      WHERE in_cooldown = true
      ORDER BY timestamp DESC
    `);
    const map: Record<string, { inCooldown: boolean; strategy: string; status: string }> = {};
    for (const row of result.rows) {
      const key = `${row.symbol}|${row.strategy}`;
      if (!map[key]) map[key] = { inCooldown: row.in_cooldown, strategy: row.strategy, status: row.status };
    }
    cachedCooldownMap = map;
    cachedCooldownAt = Date.now();
  } catch (err) {
    console.error("[SSE] cooldown cache error:", err);
  }
  return cachedCooldownMap;
}

// Gather lightweight dashboard data for SSE snapshots
async function gatherSSEData() {
  const cooldownStatus = await getCooldownMap();
  return {
    scanResults,
    marketContext: {
      fearGreed: fearGreedCache,
      fundingRates: Object.fromEntries(fundingRateCache),
      openInterest: Object.fromEntries(openInterestCache),
      longShortRatios: Object.fromEntries(longShortCache),
    },
    cooldownStatus,
    activeStrategies: [...activeStrategies],
    validationLogs,
    timestamp: Date.now(),
  };
}

app.get("/api/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send initial snapshot immediately
  const initial = await gatherSSEData();
  res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);

  sseClients.push(res);
  console.log(`[SSE] Client connected — total: ${sseClients.length}`);

  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
    console.log(`[SSE] Client disconnected — total: ${sseClients.length}`);
  });
});

// ── REST API ───────────────────────────────────────────────────────────────────

// Returns per-symbol cooldown status so the frontend can show if a trade was just fired
app.get("/api/cooldown-status", async (_req, res) => {
  try {
    const result = await pool.query(`
      WITH rules AS (
        SELECT symbol, strategy, timestamp, status,
          CASE
            WHEN status = 'OPEN' THEN true
            WHEN strategy = 'MOMENTUM-ARB' AND timestamp > NOW() - INTERVAL '15 minutes' THEN true
            WHEN strategy = 'MEAN-REV'     AND timestamp > NOW() - INTERVAL '30 minutes' THEN true
            WHEN strategy NOT IN ('MOMENTUM-ARB','MEAN-REV') AND timestamp > NOW() - INTERVAL '5 minutes' THEN true
            ELSE false
          END AS in_cooldown
        FROM trades
      )
      SELECT symbol, strategy, timestamp, status, in_cooldown
      FROM rules
      WHERE in_cooldown = true
      ORDER BY timestamp DESC
    `);
    // Keyed by "SYMBOL|STRATEGY" so each strategy has its own cooldown status
    const map: Record<string, { inCooldown: boolean; strategy: string; since: string; status: string }> = {};
    for (const row of result.rows) {
      const key = `${row.symbol}|${row.strategy}`;
      if (!map[key]) {
        map[key] = { inCooldown: row.in_cooldown, strategy: row.strategy, since: row.timestamp, status: row.status };
      }
    }
    res.json(map);
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

app.get("/api/market-context", (_req, res) => {
  const rates: Record<string, number> = {};
  fundingRateCache.forEach((v, k) => { rates[k] = v; });
  const oi: Record<string, { oiChangePct: number }> = {};
  openInterestCache.forEach((v, k) => { oi[k] = { oiChangePct: v.oiChangePct }; });
  const ls: Record<string, number> = {};
  longShortCache.forEach((v, k) => { ls[k] = v; });
  res.json({ fearGreed: fearGreedCache, fundingRates: rates, openInterest: oi, longShortRatios: ls });
});

app.get("/api/scan", (req, res) => res.json({ results: scanResults, timestamp: Date.now() }));

app.get("/api/open-positions", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, symbol, type, entry_price::float, amount::float, leverage, fee_usdt::float,
              TO_CHAR(timestamp AT TIME ZONE 'UTC', 'HH24:MI:SS') AS opened_at
       FROM trades WHERE status = 'OPEN' ORDER BY timestamp DESC`
    );
    const positions = result.rows.map((trade: any) => {
      // Priority: mark price (what Binance uses for PnL) → live scan price → entry price
      const markPrice    = markPriceCache.get(trade.symbol);
      const live         = scanResults.find(r => r.symbol === trade.symbol);
      const currentPrice = markPrice ?? live?.price ?? trade.entry_price;
      const isLong       = trade.type === "BUY";
      const lev          = trade.leverage || 1;
      const priceDelta   = isLong ? currentPrice - trade.entry_price : trade.entry_price - currentPrice;
      const grossPnl     = priceDelta * trade.amount;
      const feeUsdt      = trade.fee_usdt ?? 0;
      // Exit fee estimated at current mark/live price
      const exitFeeEst   = currentPrice * trade.amount * takerRate;
      const totalFeeEst  = parseFloat((feeUsdt + exitFeeEst).toFixed(6));
      // Break-even: entry price adjusted so (price - entry) * amount = totalFee
      const feePerUnit   = trade.amount > 0 ? totalFeeEst / trade.amount : 0;
      const breakEvenPrice = parseFloat((isLong ? trade.entry_price + feePerUnit : trade.entry_price - feePerUnit).toFixed(4));
      // ROE% — matches Binance "Unrealized PnL%" which is leveraged return on margin
      const pnlPct       = (priceDelta / trade.entry_price) * 100 * lev;
      return {
        ...trade,
        side:            isLong ? "LONG" : "SHORT",
        current_price:   parseFloat(currentPrice.toFixed(4)),
        pnl_usdt:        parseFloat(grossPnl.toFixed(4)),
        net_pnl_usdt:    parseFloat((grossPnl - totalFeeEst).toFixed(4)),
        pnl_pct:         parseFloat(pnlPct.toFixed(3)),
        fee_usdt:        parseFloat(feeUsdt.toFixed(6)),
        total_fee_est:   totalFeeEst,
        break_even_price: breakEvenPrice,
        using_mark_price: !!markPrice,
      };
    });
    res.json({ positions, last_sync: lastSyncAt });
  } catch (err) {
    console.error("Open positions error:", err);
    res.status(500).json({ error: "Failed to fetch open positions" });
  }
});


app.get("/api/settings", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM bot_settings WHERE id = 'bot_config'");
    res.json(r.rows[0] || {});
  } catch { res.status(500).json({ error: "Failed to fetch settings" }); }
});

app.post("/api/settings", async (req, res) => {
  const { isAutoPilot, riskLevel, maxSlippage, takeProfitPct, stopLossPct, leverage,
          atrSlMult, atrTpMult, arbSlMult, arbTpMult, mrSlMult, mrTpMult, activeStrategiesVal,
          telegramBotToken, telegramChatId, takerRateVal,
          swingLeverageVal, swingSlMult, swingTpMult, paperModeVal } = req.body;
  const strategiesParam = Array.isArray(activeStrategiesVal) ? activeStrategiesVal : null;
  try {
    const r = await pool.query(
      `UPDATE bot_settings
       SET is_auto_pilot     = COALESCE($1,  is_auto_pilot),
           risk_level        = COALESCE($2,  risk_level),
           max_slippage      = COALESCE($3,  max_slippage),
           take_profit_pct   = COALESCE($4,  take_profit_pct),
           stop_loss_pct     = COALESCE($5,  stop_loss_pct),
           leverage          = COALESCE($6,  leverage),
           atr_sl_mult       = COALESCE($7,  atr_sl_mult),
           atr_tp_mult       = COALESCE($8,  atr_tp_mult),
           arb_sl_mult       = COALESCE($9,  arb_sl_mult),
           arb_tp_mult       = COALESCE($10, arb_tp_mult),
           active_strategies = COALESCE($11, active_strategies),
           mr_sl_mult        = COALESCE($12, mr_sl_mult),
           mr_tp_mult        = COALESCE($13, mr_tp_mult),
           telegram_bot_token = NULLIF(COALESCE($14, telegram_bot_token), ''),
           telegram_chat_id   = NULLIF(COALESCE($15, telegram_chat_id), ''),
           taker_rate         = COALESCE($16, taker_rate),
           swing_leverage     = COALESCE($17, swing_leverage),
           swing_sl_mult      = COALESCE($18, swing_sl_mult),
           swing_tp_mult      = COALESCE($19, swing_tp_mult),
           paper_mode         = COALESCE($20, paper_mode)
       WHERE id = 'bot_config' RETURNING *`,
      [isAutoPilot ?? null, riskLevel ?? null, maxSlippage ?? null,
       takeProfitPct ?? null, stopLossPct ?? null, leverage ?? null,
       atrSlMult ?? null, atrTpMult ?? null, arbSlMult ?? null, arbTpMult ?? null,
       strategiesParam, mrSlMult ?? null, mrTpMult ?? null,
       telegramBotToken ?? null, telegramChatId ?? null,
       takerRateVal != null ? parseFloat(takerRateVal) : null,
       swingLeverageVal != null ? parseInt(swingLeverageVal) : null,
       swingSlMult ?? null, swingTpMult ?? null,
       paperModeVal != null ? Boolean(paperModeVal) : null]
    );
    // Sync in-memory values so they take effect immediately without restart
    if (strategiesParam) {
      activeStrategies = new Set(strategiesParam);
      console.log(`[STRATEGY] Active: ${[...activeStrategies].join(", ")}`);
    }
    if (takerRateVal != null) {
      takerRate = parseFloat(takerRateVal);
      console.log(`[SETTINGS] Taker rate updated to ${(takerRate * 100).toFixed(4)}%`);
    }
    if (paperModeVal != null) {
      paperMode = Boolean(paperModeVal);
      console.log(`[SETTINGS] Paper mode: ${paperMode ? "ON" : "OFF"}`);
    }
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: "Failed to update settings" }); }
});

app.post("/api/test-telegram", async (req, res) => {
  const { type = "basic" } = req.body;
  try {
    if (type === "signal") {
      await sendTelegram(
        `🧪 <b>NEXUSBOT TEST SIGNAL</b>\n` +
        `<code>BTC/USDT</code>  <b>LONG 🟢</b>  <code>MOMENTUM-ARB</code>\n` +
        `Score: <code>4.2/5.0</code>  RSI: <code>34</code>\n\n` +
        `📊 <b>SETUP</b>\n` +
        `Entry: <code>$64,250.00</code>\n` +
        `TP:    <code>$65,000.00</code>\n` +
        `SL:    <code>$63,500.00</code>\n` +
        `⏱ Est. Time: <code>30–60 min</code>`
      );
    } else {
      await sendTelegram(
        `<b>🧪 NEXUSBOT Test Notification</b>\n\n` +
        `Type: <code>${type}</code>\n` +
        `Time: <code>${new Date().toISOString()}</code>\n\n` +
        `If you receive this, your Telegram bot integration is working correctly ✅`
      );
    }
    res.json({ ok: true, message: "Telegram test message sent" });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
app.get("/api/signals", async (req, res) => {
  try {
    const status = (req.query.status as string) || "ALL";
    let query = `SELECT id, symbol, side, strategy, timeframe, entry_price::float AS entry_price, tp_price::float AS tp_price, sl_price::float AS sl_price, confidence, est_duration, status, telegram_sent, sent_at FROM signals`;
    const params: any[] = [];
    if (status !== "ALL") {
      query += ` WHERE status = $1`;
      params.push(status);
    }
    query += ` ORDER BY sent_at DESC LIMIT 50`;
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Failed to fetch signals" }); }
});

app.post("/api/signals/:id/expire", async (req, res) => {
  try {
    await pool.query(`UPDATE signals SET status = 'EXPIRED' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed to expire signal" }); }
});

app.post("/api/send-signal", async (req, res) => {
  const { symbol, side, strategy, entry, tp, sl } = req.body;
  if (!symbol || !side || !strategy || !entry || !tp || !sl) {
    return res.status(400).json({ error: "Missing fields" });
  }
  try {
    await pool.query(
      `INSERT INTO signals (symbol, side, strategy, timeframe, entry_price, tp_price, sl_price, confidence, est_duration, status, telegram_sent)
       VALUES ($1, $2, $3, 'MANUAL', $4, $5, $6, 5.0, 'Manual', 'ACTIVE', false)`,
      [symbol, side, strategy, entry, tp, sl]
    );
    await sendTelegram(
      `🚨 <b>NEXUSBOT MANUAL SIGNAL</b>
` +
      `<code>${symbol}</code>  <b>${side}</b>  <code>${strategy}</code>
` +
      `Entry: <code>$${Number(entry).toLocaleString()}</code>
` +
      `TP:    <code>$${Number(tp).toLocaleString()}</code>
` +
      `SL:    <code>$${Number(sl).toLocaleString()}</code>`
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});











// ── Paper Trade API ────────────────────────────────────────────────────────────

app.get("/api/paper-trades", async (req, res) => {
  try {
    const status = (req.query.status as string) || "ALL";
    let q = `SELECT id, symbol, strategy, side,
               entry_price::float, tp_price::float, sl_price::float,
               status, open_time, close_time, close_price::float, pnl_pct::float, signal_score::float
             FROM paper_trades`;
    const params: any[] = [];
    if (status !== "ALL") { q += ` WHERE status = $1`; params.push(status); }
    q += ` ORDER BY open_time DESC LIMIT 100`;
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/strategy-stats", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT strategy, total_trades, win_trades, loss_trades,
              total_pnl_pct::float, avg_win_pct::float, avg_loss_pct::float, last_updated
       FROM strategy_stats ORDER BY total_trades DESC`
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/paper-trades/:id/close", async (req, res) => {
  try {
    const { id } = req.params;
    const tRow = await pool.query(
      `SELECT symbol, strategy, side, entry_price::float FROM paper_trades WHERE id = $1 AND status = 'OPEN'`,
      [id]
    );
    if (tRow.rows.length === 0)
      return res.status(404).json({ error: "Trade not found or already closed" });
    const t = tRow.rows[0];
    const price = markPriceCache.get(t.symbol)
               ?? scanResults.find(r => r.symbol === t.symbol)?.price
               ?? t.entry_price;
    const isLong = t.side === "LONG";
    const pnlPct = isLong
      ? (price - t.entry_price) / t.entry_price * 100
      : (t.entry_price - price) / t.entry_price * 100;
    await pool.query(
      `UPDATE paper_trades SET status = 'MANUAL', close_time = NOW(), close_price = $1, pnl_pct = $2 WHERE id = $3`,
      [price, pnlPct, id]
    );
    await updateStrategyStats(t.strategy, pnlPct);
    res.json({ ok: true, pnlPct: parseFloat(pnlPct.toFixed(2)), closePrice: price });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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

// ── Manual Signal Trigger ─────────────────────────────────────────────────────




app.get("/api/check-api", async (req, res) => {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY)
    return res.json({ connected: false, reason: "Keys not found" });
  try {
    await binance.fetchBalance();
    res.json({ connected: true, mode: "live" });
  } catch (e: any) {
    console.error("[API /check-api] error:", e?.message);
    res.json({ connected: false, reason: e?.message, hint: "Check: (1) API key is correct, (2) Futures permission is enabled, (3) IP whitelist matches your server IP" });
  }
});

// ── Force-test a real order for a specific symbol/strategy ───────────────────


// ── Diagnose — real-time filter state per symbol ───────────────────────────────

app.get("/api/diagnose", async (_req, res) => {
  try {
    const settingsRow = await pool.query("SELECT is_auto_pilot FROM bot_settings WHERE id = 'bot_config'");
    const isAutoPilot = settingsRow.rows[0]?.is_auto_pilot ?? false;

    function filterBlock(signal: any, strategyName: string, symbol: string): string {
      if (!isAutoPilot) return "autopilot OFF";
      if (signal.action === "HOLD") return "HOLD signal";
      const { regime, adx } = getRegime(symbol);
      if (strategyName === "MEAN-REV" && regime === "TRENDING") return `REGIME ${regime} (ADX ${adx}) — mean-rev disabled`;
      if (strategyName === "MOMENTUM-ARB" && regime === "RANGING") return `REGIME ${regime} (ADX ${adx}) — momentum disabled`;
      const trend = getTrend(symbol);
      if (strategyName === "MOMENTUM-ARB") {
        if (signal.action === "BUY"  && trend === "DOWN")    return `trend DOWN (need UP)`;
        if (signal.action === "SELL" && trend === "UP")      return `trend UP (need DOWN)`;
        // NEUTRAL trend is no longer a block — falls through to score gate.
      }
      const volThreshold = strategyName === "MEAN-REV"     ? 0.6
                         : strategyName === "MOMENTUM-ARB" ? 0.8
                         :                                   0.7;
      if ((signal.volumeRatio ?? 1) < volThreshold)
        return `vol ${(signal.volumeRatio ?? 0).toFixed(2)}× < ${volThreshold}×`;
      const fr = fundingRateCache.get(symbol);
      if (fr !== undefined) {
        if (signal.action === "BUY"  && fr >  0.0005) return `funding +${(fr*100).toFixed(4)}% > 0.05%`;
        if (signal.action === "SELL" && fr < -0.0006) return `funding ${(fr*100).toFixed(4)}% < -0.06%`;
      }
      if (fearGreedCache) {
        const fg = fearGreedCache.value;
        if (strategyName === "MEAN-REV" && signal.action === "BUY"  && fg > 75) return `F&G ${fg} > 75 (MEAN-REV BUY)`;
        if (strategyName === "MEAN-REV" && signal.action === "SELL" && fg < 25) return `F&G ${fg} < 25 (MEAN-REV SELL)`;
        if (signal.action === "BUY"  && fg > 85) return `F&G ${fg} > 85 extreme greed`;
        if (signal.action === "SELL" && fg < 15) return `F&G ${fg} < 15 extreme fear`;
      }
      const oi = openInterestCache.get(symbol);
      if (oi) {
        if (strategyName === "MOMENTUM-ARB" && signal.action === "BUY"  && oi.oiChangePct < -4)
          return `OI ${oi.oiChangePct.toFixed(2)}% falling (MOMENTUM-ARB BUY)`;
        if (strategyName === "MEAN-REV"     && signal.action === "SELL" && oi.oiChangePct < -4)
          return `OI ${oi.oiChangePct.toFixed(2)}% falling (MEAN-REV SELL)`;
      }
      const ls = longShortCache.get(symbol);
      if (ls !== undefined) {
        if (signal.action === "BUY"  && ls > 2.5) return `L/S ${ls.toFixed(2)} > 2.5 (over-long)`;
        if (signal.action === "SELL" && ls < 0.4) return `L/S ${ls.toFixed(2)} < 0.4 (over-short)`;
      }
      // Score threshold check — MOMENTUM-ARB now uses 2.5 (loosened from 3.0)
      const minScore = strategyName === "MOMENTUM-ARB" ? 2.5 : 3.0;
      if ((signal.score ?? 0) < minScore) return `score ${(signal.score ?? 0).toFixed(1)} < ${minScore.toFixed(1)} (weak signal)`;
      return "PASS ✓ (cooldown not checked here — see /api/cooldown-status)";
    }

    // Also fetch cooldown status for each symbol
    const cooldownRes = await pool.query(`
      SELECT symbol, strategy, timestamp,
        CASE strategy
          WHEN 'MOMENTUM-ARB' THEN timestamp > NOW() - INTERVAL '15 minutes'
          WHEN 'MEAN-REV'     THEN timestamp > NOW() - INTERVAL '30 minutes'
          ELSE                     timestamp > NOW() - INTERVAL '5 minutes'
        END AS in_cooldown
      FROM trades WHERE status = 'OPEN' ORDER BY timestamp DESC
    `);
    const cooldownMap: Record<string, { inCooldown: boolean; strategy: string; since: string }[]> = {};
    for (const row of cooldownRes.rows) {
      if (!cooldownMap[row.symbol]) cooldownMap[row.symbol] = [];
      cooldownMap[row.symbol].push({ inCooldown: row.in_cooldown, strategy: row.strategy, since: row.timestamp });
    }

    const results = await Promise.all(SYMBOLS.map(async symbol => {
      const buf5m  = momentumBuffer.get(symbol) || [];
      const buf15m = trendBuffer.get(symbol)    || [];
      const sig5m  = calculateMomentumSignal(buf5m);
      const sig15m = calculateMeanRevSignal(buf15m);
      const fr     = fundingRateCache.get(symbol);
      const oi     = openInterestCache.get(symbol);
      const ls     = longShortCache.get(symbol);
      const openTrades = cooldownMap[symbol] || [];
      const cooldownBlocking = openTrades.filter(t => t.inCooldown);

      function addCooldownNote(base: string): string {
        if (base.startsWith("PASS") && cooldownBlocking.length > 0) {
          const t = openTrades[0];
          return `COOLDOWN — open trade within window (${t.strategy} @ ${new Date(t.since).toLocaleTimeString()})`;
        }
        return base;
      }

      const { regime, adx } = getRegime(symbol);
      return {
        symbol,
        trend: getTrend(symbol),
        regime,
        adx,
        buffers: { "5m": buf5m.length, "15m": buf15m.length },
        openTrades: openTrades.length,
        cooldownBlocking: cooldownBlocking.length > 0,
        context: {
          fundingRate:  fr !== undefined ? `${(fr * 100).toFixed(4)}%` : null,
          oiChangePct:  oi?.oiChangePct ?? null,
          lsRatio:      ls ?? null,
        },
        strategies: {
          "MOMENTUM-ARB": { action: sig5m.action,  rsi: sig5m.rsi,  vol: sig5m.volumeRatio,  atrPct: sig5m.atrPct,  cross: (sig5m as any).cross, block: addCooldownNote(filterBlock(sig5m,  "MOMENTUM-ARB", symbol)) },
          "MEAN-REV":     { action: sig15m.action, rsi: sig15m.rsi, vol: sig15m.volumeRatio, atrPct: sig15m.atrPct, bbPos: (sig15m as any).bbPos, block: addCooldownNote(filterBlock(sig15m, "MEAN-REV",     symbol)) },
        },
      };
    }));

    res.json({ isAutoPilot, fearGreed: fearGreedCache, timestamp: new Date().toISOString(), results });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ── Threshold Analysis ────────────────────────────────────────────────────────
//
// Replays each indicator (ADX, volume ratio, RSI, BB proximity) at every historical
// candle position in the `ohlcv` table and reports percentile distributions so the
// user can see whether the current filter thresholds sit in a sensible zone or are
// clipping too many candles.
//
// Usage:
//   GET /api/threshold-analysis              → 72h window, all symbols
//   GET /api/threshold-analysis?hours=168    → 7d window
//   GET /api/threshold-analysis?symbol=BTC/USDT
//   GET /api/threshold-analysis?summary=1    → just the recommendations, no raw percentiles
//
// Needs the bot to have been running long enough to populate ohlcv. The 15m series
// is the binding constraint — you want at least ~100 15m candles (~25h) for ADX
// percentiles to be meaningful.

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return parseFloat(sorted[idx].toFixed(4));
}

function pctOf(arr: number[], pred: (v: number) => boolean): number {
  if (!arr.length) return 0;
  return parseFloat((arr.filter(pred).length / arr.length * 100).toFixed(1));
}

app.get("/api/threshold-analysis", async (req, res) => {
  try {
    const hours       = Math.min(720, Math.max(6, parseInt(String(req.query.hours ?? "72"), 10) || 72));
    const symbolParam = req.query.symbol ? String(req.query.symbol) : null;
    const summaryOnly = req.query.summary === "1" || req.query.summary === "true";
    const cutoff      = Date.now() - hours * 3600 * 1000;
    const targets     = symbolParam ? [symbolParam] : SYMBOLS;

    // Current thresholds — kept here so the response self-documents what it's measuring against.
    const CURRENT = {
      adx: { trending: 32, ranging: 18 },
      volume: { "5m": 0.8, "15m": 0.6 },   // MOMENTUM-ARB / MEAN-REV
      bbProximityPct: 1.0,                  // MEAN-REV — 1.0% from band counts as "touch"
    };

    const perSymbol: Record<string, any> = {};

    for (const symbol of targets) {
      const rows = await pool.query(
        `SELECT timeframe, timestamp, open, high, low, close, volume
         FROM ohlcv WHERE symbol = $1 AND timestamp >= $2
         ORDER BY timeframe, timestamp ASC`,
        [symbol, cutoff]
      );
      const byTf: Record<string, number[][]> = { "5m": [], "15m": [] };
      for (const r of rows.rows) {
        const tf = r.timeframe as string;
        if (!byTf[tf]) continue;
        byTf[tf].push([Number(r.timestamp), parseFloat(r.open), parseFloat(r.high), parseFloat(r.low), parseFloat(r.close), parseFloat(r.volume)]);
      }
      const c5m  = byTf["5m"];
      const c15m = byTf["15m"];

      // ADX series over 15m (one ADX value per candle position once we have enough history)
      const adxSeries: number[] = [];
      for (let i = 30; i <= c15m.length; i++) {
        const { adx } = calcADX(c15m.slice(0, i), 14);
        if (adx > 0) adxSeries.push(adx);
      }

      // Rolling volume ratio per timeframe
      const volSeriesFor = (candles: number[][]) => {
        const vols = candles.map(c => c[5]);
        const out: number[] = [];
        for (let i = 21; i <= vols.length; i++) out.push(calcVolumeRatio(vols.slice(0, i)));
        return out;
      };
      const vol5m  = volSeriesFor(c5m);
      const vol15m = volSeriesFor(c15m);

      // BB proximity over 15m — distance from each band as a % of band price.
      // 0 = price is at or beyond the band; higher = farther into the channel.
      const bbLowerDistPct: number[] = [];
      const bbUpperDistPct: number[] = [];
      for (let i = 20; i <= c15m.length; i++) {
        const closes = c15m.slice(0, i).map(c => c[4]);
        const bb     = calcBollingerBands(closes, 20, 2);
        const price  = closes[closes.length - 1];
        if (!isFinite(bb.lower) || !isFinite(bb.upper)) continue;
        bbLowerDistPct.push(price <= bb.lower ? 0 : (price - bb.lower) / bb.lower * 100);
        bbUpperDistPct.push(price >= bb.upper ? 0 : (bb.upper - price) / bb.upper * 100);
      }

      const adxStats = {
        p10: percentile(adxSeries, 10),
        p25: percentile(adxSeries, 25),
        p50: percentile(adxSeries, 50),
        p75: percentile(adxSeries, 75),
        p90: percentile(adxSeries, 90),
        currentTrending: CURRENT.adx.trending,
        currentRanging:  CURRENT.adx.ranging,
        pctTrending: pctOf(adxSeries, v => v > CURRENT.adx.trending),
        pctRanging:  pctOf(adxSeries, v => v < CURRENT.adx.ranging),
        pctNeutral:  pctOf(adxSeries, v => v >= CURRENT.adx.ranging && v <= CURRENT.adx.trending),
      };

      const volStats = (series: number[], tf: "5m" | "15m") => ({
        p20: percentile(series, 20),
        p50: percentile(series, 50),
        p80: percentile(series, 80),
        currentThreshold: CURRENT.volume[tf],
        pctBlocked: pctOf(series, v => v < CURRENT.volume[tf]),
      });

      const bbStats = {
        lowerP10: percentile(bbLowerDistPct, 10),
        lowerP25: percentile(bbLowerDistPct, 25),
        upperP10: percentile(bbUpperDistPct, 10),
        upperP25: percentile(bbUpperDistPct, 25),
        currentThresholdPct: CURRENT.bbProximityPct,
        pctTriggeringLower: pctOf(bbLowerDistPct, v => v <= CURRENT.bbProximityPct),
        pctTriggeringUpper: pctOf(bbUpperDistPct, v => v <= CURRENT.bbProximityPct),
      };

      // ── Recommendations — heuristic rules over the distributions ──
      // Targets:
      //   ADX: NEUTRAL band should cover ~50-70% (balanced regime gate)
      //   Volume: filter should block ~20-35% of candles (selective but not strangling)
      //   BB:    ~10-25% of candles should be within tolerance (MEAN-REV is selective)
      const recs: { filter: string; current: string; suggest: string; reason: string }[] = [];

      if (adxSeries.length >= 50) {
        if (adxStats.pctNeutral < 45) {
          const target = { trending: percentile(adxSeries, 75), ranging: percentile(adxSeries, 25) };
          recs.push({
            filter: "ADX regime",
            current: `TRENDING>${CURRENT.adx.trending}, RANGING<${CURRENT.adx.ranging} (neutral covers ${adxStats.pctNeutral}%)`,
            suggest: `TRENDING>${target.trending.toFixed(1)}, RANGING<${target.ranging.toFixed(1)}`,
            reason:  `Neutral band too narrow — only ${adxStats.pctNeutral}% of candles fall through. Widen to p25/p75 to get ~50%.`,
          });
        } else if (adxStats.pctNeutral > 80) {
          recs.push({
            filter: "ADX regime",
            current: `TRENDING>${CURRENT.adx.trending}, RANGING<${CURRENT.adx.ranging} (neutral covers ${adxStats.pctNeutral}%)`,
            suggest: `TRENDING>${percentile(adxSeries, 70).toFixed(1)}, RANGING<${percentile(adxSeries, 30).toFixed(1)}`,
            reason:  `Regime gate barely activates (${adxStats.pctNeutral}% always neutral) — tighten to actually filter.`,
          });
        }
      }

      for (const [tf, stats] of Object.entries({ "5m": volStats(vol5m, "5m"), "15m": volStats(vol15m, "15m") })) {
        if (stats.pctBlocked > 50) {
          recs.push({
            filter: `Volume (${tf})`,
            current: `${stats.currentThreshold}× (blocks ${stats.pctBlocked}%)`,
            suggest: `${percentile(tf === "5m" ? vol5m : vol15m, 25).toFixed(2)}×`,
            reason:  `Current threshold rejects over half of candles — lower to p25 of observed distribution.`,
          });
        } else if (stats.pctBlocked < 10) {
          recs.push({
            filter: `Volume (${tf})`,
            current: `${stats.currentThreshold}× (blocks ${stats.pctBlocked}%)`,
            suggest: `${percentile(tf === "5m" ? vol5m : vol15m, 30).toFixed(2)}×`,
            reason:  `Filter rarely engages — bump up to maintain volume selectivity.`,
          });
        }
      }

      const bbTrigger = (bbStats.pctTriggeringLower + bbStats.pctTriggeringUpper) / 2;
      if (bbTrigger < 5 && bbLowerDistPct.length >= 50) {
        recs.push({
          filter: "MEAN-REV BB proximity",
          current: `±${CURRENT.bbProximityPct}% (triggers on ~${bbTrigger.toFixed(1)}% of candles)`,
          suggest: `±${percentile([...bbLowerDistPct, ...bbUpperDistPct], 15).toFixed(2)}%`,
          reason:  `MEAN-REV almost never sees a band touch — widen tolerance to p15 of observed distance.`,
        });
      } else if (bbTrigger > 40 && bbLowerDistPct.length >= 50) {
        recs.push({
          filter: "MEAN-REV BB proximity",
          current: `±${CURRENT.bbProximityPct}% (triggers on ~${bbTrigger.toFixed(1)}% of candles)`,
          suggest: `±${percentile([...bbLowerDistPct, ...bbUpperDistPct], 15).toFixed(2)}%`,
          reason:  `Tolerance too loose — too many candles count as "at the band". Tighten to p15.`,
        });
      }

      perSymbol[symbol] = summaryOnly
        ? { samples: { "5m": c5m.length, "15m": c15m.length }, recommendations: recs }
        : {
            samples:    { "5m": c5m.length, "15m": c15m.length },
            adx_15m:    adxStats,
            volume_5m:  volStats(vol5m,  "5m"),
            volume_15m: volStats(vol15m, "15m"),
            bb_proximity_15m: bbStats,
            recommendations: recs,
          };
    }

    res.json({
      windowHours: hours,
      timestamp: new Date().toISOString(),
      currentThresholds: CURRENT,
      symbols: perSymbol,
      notes: [
        "Targets: ADX neutral band 50-70% of candles; volume filter blocks 20-35%; BB triggers on 10-25%.",
        "Recommendations only appear when current threshold is outside healthy band. Empty recs = filter is well-tuned for this symbol.",
        "Tuning is a guide, not a mandate — combine with what the bot's actual win rate is doing.",
      ],
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ── Backtest Engine ────────────────────────────────────────────────────────────

function resampleTo5m(candles1m: number[][]): number[][] {
  const buckets = new Map<number, number[][]>();
  for (const c of candles1m) {
    const key = Math.floor(c[0] / (5 * 60 * 1000)) * 5 * 60 * 1000;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ts, group]) => [
      ts,
      group[0][1],                               // open  = first 1m open
      Math.max(...group.map(c => c[2])),          // high  = max
      Math.min(...group.map(c => c[3])),          // low   = min
      group[group.length - 1][4],                 // close = last 1m close
      group.reduce((s, c) => s + c[5], 0),        // vol   = sum
    ]);
}

function resampleTo15m(candles1m: number[][]): number[][] {
  const buckets = new Map<number, number[][]>();
  for (const c of candles1m) {
    const key = Math.floor(c[0] / (15 * 60 * 1000)) * 15 * 60 * 1000;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ts, group]) => [
      ts,
      group[0][1],                               // open  = first 1m open
      Math.max(...group.map(c => c[2])),          // high  = max
      Math.min(...group.map(c => c[3])),          // low   = min
      group[group.length - 1][4],                 // close = last 1m close
      group.reduce((s, c) => s + c[5], 0),        // vol   = sum
    ]);
}

app.get("/api/backtest", async (req, res) => {
  const symbol = (req.query.symbol as string) || "BTC/USDT";
  const days   = Math.min(parseInt((req.query.days as string) || "7"), 30);
  const strategyName = (req.query.strategy as string) || "MOMENTUM-ARB";

  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const raw   = await pool.query(
      `SELECT timestamp, open::float, high::float, low::float, close::float, volume::float
       FROM ohlcv WHERE symbol = $1 AND timeframe = '1m' AND timestamp >= $2
       ORDER BY timestamp ASC`,
      [symbol, since]
    );
    const candles1m: number[][] = raw.rows.map((r: any) =>
      [r.timestamp, r.open, r.high, r.low, r.close, r.volume]
    );
    if (candles1m.length < 60) {
      return res.json({ error: "Not enough 1m data in DB yet. Let the bot run for a while first.", candles: candles1m.length });
    }

    // ── Prepare data & config per strategy ──
    let candles: number[][];
    let windowSize: number;
    let signalFn: (ohlcv: number[][]) => any;
    let volThreshold: number;
    let skipTrend: boolean;
    let cooldownMs: number;
    let slMult: number;
    let tpMult: number;

    if (strategyName === "MOMENTUM-ARB") {
      candles = resampleTo5m(candles1m);
      windowSize = 22;
      signalFn = calculateMomentumSignal;
      volThreshold = 1.0;
      skipTrend = false;
      cooldownMs = 15 * 60 * 1000;
    } else if (strategyName === "MEAN-REV") {
      candles = resampleTo15m(candles1m);
      windowSize = 20;
      signalFn = calculateMeanRevSignal;
      volThreshold = 0.8;
      skipTrend = true;
      cooldownMs = 30 * 60 * 1000;
    } else {
      // Default to MOMENTUM-ARB for any unrecognised strategy
      candles = resampleTo5m(candles1m);
      windowSize = 22;
      signalFn = calculateMomentumSignal;
      volThreshold = 1.0;
      skipTrend = false;
      cooldownMs = 15 * 60 * 1000;
    }

    const cfg = await pool.query(`
      SELECT atr_sl_mult::float, atr_tp_mult::float,
             arb_sl_mult::float, arb_tp_mult::float,
             mr_sl_mult::float,  mr_tp_mult::float
      FROM bot_settings WHERE id = 'bot_config'
    `);
    if (strategyName === "MOMENTUM-ARB") {
      slMult = cfg.rows[0]?.arb_sl_mult ?? 1.0;
      tpMult = cfg.rows[0]?.arb_tp_mult ?? 3.0;
    } else if (strategyName === "MEAN-REV") {
      slMult = cfg.rows[0]?.mr_sl_mult ?? 1.0;
      tpMult = cfg.rows[0]?.mr_tp_mult ?? 2.0;
    } else {
      slMult = cfg.rows[0]?.atr_sl_mult ?? 1.5;
      tpMult = cfg.rows[0]?.atr_tp_mult ?? 4.0;
    }

    // ── Build 15m trend & ADX lookup ──
    const candles15m = resampleTo15m(candles1m);
    const closes15m  = candles15m.map(c => c[4]);
    const ema200arr  = calcEMA(closes15m, 200);
    const trendAt15m = candles15m.map((c, i) => ({ ts: c[0], ema: ema200arr[i], price: c[4] }));

    function getTrendAtTime(ts: number): "UP" | "DOWN" | "NEUTRAL" {
      let idx = -1;
      for (let i = trendAt15m.length - 1; i >= 0; i--) {
        if (trendAt15m[i].ts <= ts) { idx = i; break; }
      }
      if (idx < 0) return "NEUTRAL";
      const { ema, price } = trendAt15m[idx];
      if (isNaN(ema) || ema === 0) return "NEUTRAL";
      if (price > ema) return "UP";
      if (price < ema) return "DOWN";
      return "NEUTRAL";
    }

    function getRegimeAtTime(ts: number): { regime: "TRENDING" | "RANGING" | "NEUTRAL"; adx: number } {
      let idx = -1;
      for (let i = candles15m.length - 1; i >= 0; i--) {
        if (candles15m[i][0] <= ts) { idx = i; break; }
      }
      if (idx < 29) return { regime: "NEUTRAL", adx: 0 };
      const buf = candles15m.slice(0, idx + 1);
      const { adx } = calcADX(buf, 14);
      if (adx > 25) return { regime: "TRENDING", adx };
      if (adx < 20) return { regime: "RANGING", adx };
      return { regime: "NEUTRAL", adx };
    }

    interface BtTrade {
      type: string; entry: number; exit: number;
      pnlPct: number; reason: string;
      entryTs: number; exitTs: number; holdMinutes: number;
    }

    interface BtPosition {
      type: string; entry: number;
      trailingHigh: number; trailingLow: number;
      entryTs: number;
      dynSlPct: number; dynTpPct: number;
    }

    const trades: BtTrade[] = [];
    let position: BtPosition | null = null;
    let lastEntryTs = 0;
    const equity: { ts: number; value: number }[] = [];
    let currentEquity = 100; // start at 100 for percentage baseline

    for (let i = windowSize; i < candles.length; i++) {
      const window = candles.slice(i - windowSize, i + 1);
      const signal = signalFn(window);
      const currentPrice = candles[i][4];
      const currentTs = candles[i][0];

      // ── Manage open position ──
      if (position) {
        const isLong = position.type === "BUY";
        if (isLong) position.trailingHigh = Math.max(position.trailingHigh, currentPrice);
        else         position.trailingLow  = Math.min(position.trailingLow, currentPrice);

        const pnlTP   = isLong ? (currentPrice - position.entry) / position.entry
                               : (position.entry - currentPrice) / position.entry;
        const trailRef = isLong ? position.trailingHigh : position.trailingLow;
        const pnlSL   = isLong ? (currentPrice - trailRef) / trailRef
                               : (trailRef - currentPrice) / trailRef;

        if (pnlTP >= position.dynTpPct || pnlSL <= -position.dynSlPct) {
          const reason  = pnlTP >= position.dynTpPct ? "TP" : "TSL";
          const realPnl = isLong ? (currentPrice - position.entry) / position.entry * 100
                                 : (position.entry - currentPrice) / position.entry * 100;
          trades.push({
            type: position.type, entry: position.entry, exit: currentPrice,
            pnlPct: parseFloat(realPnl.toFixed(3)), reason,
            entryTs: position.entryTs, exitTs: currentTs,
            holdMinutes: Math.round((currentTs - position.entryTs) / 60000),
          });
          currentEquity = currentEquity * (1 + realPnl / 100);
          equity.push({ ts: currentTs, value: parseFloat(currentEquity.toFixed(4)) });
          position = null;
        }
      }

      // ── Open new position ──
      if (!position && signal.action !== "HOLD") {
        // Cooldown
        if (currentTs - lastEntryTs < cooldownMs) continue;

        const trend = getTrendAtTime(currentTs);
        const { regime } = getRegimeAtTime(currentTs);

        // Regime filter
        if (strategyName === "MEAN-REV" && regime === "TRENDING") continue;
        if (strategyName === "MOMENTUM-ARB" && regime === "RANGING") continue;

        // Trend filter
        if (!skipTrend) {
          if (signal.action === "BUY" && trend === "DOWN") continue;
          if (signal.action === "SELL" && trend === "UP") continue;
          if (trend === "NEUTRAL") continue;
        }

        // Volume filter
        const volRatio = signal.volumeRatio ?? 1;
        if (volRatio < volThreshold) continue;

        const atrF = (signal.atr ?? 0) / currentPrice;
        const dynSlPct = Math.min(Math.max(atrF * slMult, 0.001), 0.05);
        const dynTpPct = Math.min(Math.max(atrF * tpMult, 0.01), 0.15);

        position = {
          type: signal.action, entry: currentPrice,
          trailingHigh: currentPrice, trailingLow: currentPrice,
          entryTs: currentTs, dynSlPct, dynTpPct,
        };
        lastEntryTs = currentTs;
      }

      // Record equity while flat
      if (!position) {
        equity.push({ ts: currentTs, value: parseFloat(currentEquity.toFixed(4)) });
      }
    }

    // Close any open position at last price
    if (position) {
      const lastPrice = candles[candles.length - 1][4];
      const lastTs = candles[candles.length - 1][0];
      const isLong = position.type === "BUY";
      const realPnl = isLong ? (lastPrice - position.entry) / position.entry * 100
                             : (position.entry - lastPrice) / position.entry * 100;
      trades.push({
        type: position.type, entry: position.entry, exit: lastPrice,
        pnlPct: parseFloat(realPnl.toFixed(3)), reason: "OPEN_AT_END",
        entryTs: position.entryTs, exitTs: lastTs,
        holdMinutes: Math.round((lastTs - position.entryTs) / 60000),
      });
      currentEquity = currentEquity * (1 + realPnl / 100);
      equity.push({ ts: lastTs, value: parseFloat(currentEquity.toFixed(4)) });
    }

    const wins     = trades.filter(t => t.pnlPct > 0);
    const losses   = trades.filter(t => t.pnlPct <= 0);
    const totalPnl = parseFloat(trades.reduce((s, t) => s + t.pnlPct, 0).toFixed(3));
    const winRate  = trades.length > 0 ? parseFloat((wins.length / trades.length * 100).toFixed(1)) : 0;
    const avgWin   = wins.length  > 0 ? parseFloat((wins.reduce((s,t) => s + t.pnlPct, 0) / wins.length).toFixed(3)) : 0;
    const avgLoss  = losses.length > 0 ? parseFloat((losses.reduce((s,t) => s + t.pnlPct, 0) / losses.length).toFixed(3)) : 0;

    let peak = 0, cumPnl = 0, maxDD = 0;
    for (const t of trades) {
      cumPnl += t.pnlPct;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    res.json({
      symbol, days, strategy: strategyName,
      stats: {
        total: trades.length, wins: wins.length, losses: losses.length,
        winRate, totalPnlPct: totalPnl,
        avgWinPct: avgWin, avgLossPct: avgLoss,
        maxDrawdownPct: parseFloat(maxDD.toFixed(3)),
        finalEquity: parseFloat(currentEquity.toFixed(4)),
        candles: candles.length,
      },
      equity: equity, // time-series for charting
      trades: trades.slice(-100),
    });
  } catch (err: any) {
    console.error("[BACKTEST] Error:", err?.message);
    res.status(500).json({ error: err?.message });
  }
});

// ── Markov Chain Analysis ─────────────────────────────────────────────────────

type MarkovState = 'BEAR' | 'STAGNANT' | 'BULL';
const MARKOV_ALL: MarkovState[] = ['BEAR', 'STAGNANT', 'BULL'];

function classifyMarkovState(returnPct: number, bearThresh: number, bullThresh: number): MarkovState {
  if (returnPct < bearThresh) return 'BEAR';
  if (returnPct > bullThresh) return 'BULL';
  return 'STAGNANT';
}

function buildTransitionMatrix(states: MarkovState[]) {
  const counts: Record<string, Record<string, number>> = {
    BEAR:     { BEAR: 0, STAGNANT: 0, BULL: 0 },
    STAGNANT: { BEAR: 0, STAGNANT: 0, BULL: 0 },
    BULL:     { BEAR: 0, STAGNANT: 0, BULL: 0 },
  };
  for (let i = 0; i < states.length - 1; i++) counts[states[i]][states[i + 1]]++;
  const matrix: Record<string, Record<string, number>> = {};
  for (const from of MARKOV_ALL) {
    const total = counts[from].BEAR + counts[from].STAGNANT + counts[from].BULL;
    matrix[from] = {
      BEAR:     total > 0 ? parseFloat((counts[from].BEAR     / total).toFixed(4)) : 0,
      STAGNANT: total > 0 ? parseFloat((counts[from].STAGNANT / total).toFixed(4)) : 0,
      BULL:     total > 0 ? parseFloat((counts[from].BULL     / total).toFixed(4)) : 0,
    };
  }
  return matrix;
}

app.get("/api/markov/:symbol", async (req, res) => {
  const symbol     = decodeURIComponent(req.params.symbol);
  const timeframe  = (req.query.timeframe as string) || "15m";
  const limit      = Math.min(parseInt((req.query.limit as string) || "500"), 2000);
  const bearThresh = parseFloat((req.query.bear as string) || "-1.5");
  const bullThresh = parseFloat((req.query.bull as string) || "1.5");

  try {
    const r = await pool.query(
      `SELECT timestamp, close::float FROM ohlcv
       WHERE symbol = $1 AND timeframe = $2
       ORDER BY timestamp ASC LIMIT $3`,
      [symbol, timeframe, limit]
    );
    const rows = r.rows;
    if (rows.length < 10) return res.json({ error: "Not enough data", candleCount: rows.length });

    const seq: { ts: number; close: number; returnPct: number; state: MarkovState }[] = [];
    for (let i = 1; i < rows.length; i++) {
      const ret = (rows[i].close - rows[i - 1].close) / rows[i - 1].close * 100;
      seq.push({ ts: rows[i].timestamp, close: rows[i].close, returnPct: parseFloat(ret.toFixed(4)), state: classifyMarkovState(ret, bearThresh, bullThresh) });
    }

    const allStates   = seq.map(s => s.state);
    const matrix      = buildTransitionMatrix(allStates);
    const currentState = allStates[allStates.length - 1] || 'STAGNANT';
    const prediction   = matrix[currentState] as Record<string, number>;
    const maxProb      = Math.max(...Object.values(prediction));
    const nextState    = (Object.entries(prediction).sort((a, b) => b[1] - a[1])[0]?.[0] || 'STAGNANT') as MarkovState;

    let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    if (nextState === 'BULL' && maxProb >= 0.45) signal = 'BUY';
    else if (nextState === 'BEAR' && maxProb >= 0.45) signal = 'SELL';

    const dist = { BEAR: 0, STAGNANT: 0, BULL: 0 };
    for (const s of allStates) dist[s]++;
    const total = allStates.length;

    res.json({
      symbol, timeframe, candleCount: rows.length,
      bearThreshold: bearThresh, bullThreshold: bullThresh,
      currentState, matrix, prediction, predictedNext: nextState, signal,
      confidence: parseFloat((maxProb * 100).toFixed(1)),
      distribution: {
        BEAR:     parseFloat((dist.BEAR     / total * 100).toFixed(1)),
        STAGNANT: parseFloat((dist.STAGNANT / total * 100).toFixed(1)),
        BULL:     parseFloat((dist.BULL     / total * 100).toFixed(1)),
      },
      recentStates: seq.slice(-60),
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ── Startup ────────────────────────────────────────────────────────────────────

async function startServer() {
  await pool.query("SELECT 1");
  console.log("Database connected");

  await runMigrations();
  console.log("Migrations applied");

  // Load persisted settings before seeding
  const stRow = await pool.query("SELECT active_strategies, taker_rate, paper_mode FROM bot_settings WHERE id = 'bot_config'");
  activeStrategies = new Set(stRow.rows[0]?.active_strategies || ["MOMENTUM-ARB", "MEAN-REV", "SWING-LONG"]);
  if (stRow.rows[0]?.taker_rate  != null) takerRate = parseFloat(stRow.rows[0].taker_rate);
  if (stRow.rows[0]?.paper_mode  != null) paperMode = Boolean(stRow.rows[0].paper_mode);
  console.log(`Active strategies: ${[...activeStrategies].join(", ")} | Taker rate: ${(takerRate * 100).toFixed(4)}% | Paper mode: ${paperMode ? "ON" : "OFF"}`);

  await binance.loadMarkets();
  console.log("Markets loaded");

  await fetchFundingRates();
  await fetchFearGreed();
  await fetchFuturesData();
  setInterval(fetchFundingRates, 5 * 60 * 1000);
  setInterval(fetchFearGreed, 30 * 60 * 1000);
  setInterval(fetchFuturesData, 5 * 60 * 1000);

  // Seed candle buffer via REST, then hand off to WebSocket
  await seedCandleBuffer();
  initWebSocket();

  // 4h SWING-LONG buffer: refresh every 15 min (new 4h candle closes every 240 min)
  setInterval(refreshSwingBuffers, 15 * 60 * 1000);

  // Paper trade monitor: check open paper trades against live prices every 30s
  setInterval(runPaperTradeMonitor, 30 * 1000);

  // SSE snapshot interval — push dashboard data to all connected clients every 2s
  setInterval(async () => {
    if (sseClients.length === 0) return;
    const data = await gatherSSEData();
    broadcastSSE("snapshot", data);
  }, 2000);

  // Fallback reseed every 5 min (catches any gaps if WS misses a candle)
  setInterval(seedCandleBuffer, 5 * 60 * 1000);

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
