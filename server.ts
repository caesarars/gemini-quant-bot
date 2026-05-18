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
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS atr_tp_mult      NUMERIC(5,2) DEFAULT 2.5`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS active_strategy   VARCHAR(30)  DEFAULT 'ULTRA-SCALP'`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS arb_sl_mult      NUMERIC(5,2) DEFAULT 1.0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS arb_tp_mult      NUMERIC(5,2) DEFAULT 3.0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS active_strategies TEXT[]       DEFAULT '{ULTRA-SCALP,MOMENTUM-ARB}'`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee_usdt NUMERIC(20,8) DEFAULT 0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS mr_sl_mult NUMERIC(5,2) DEFAULT 1.0`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS mr_tp_mult NUMERIC(5,2) DEFAULT 2.0`);
  await pool.query(`UPDATE bot_settings SET active_strategies = array_append(active_strategies, 'MEAN-REV') WHERE id = 'bot_config' AND NOT ('MEAN-REV' = ANY(COALESCE(active_strategies, '{}')))`);

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

function calculateSignal(ohlcv: number[][]) {
  if (!ohlcv || ohlcv.length < 26) return { action: "HOLD" as const, rsi: 50, price: 0, macd: null, bb: null, ema9: null, ema21: null, volumeRatio: 1, atr: 0, atrPct: 0 };
  const closes  = ohlcv.map(c => c[4]);
  const volumes = ohlcv.map(c => c[5]);
  const price   = closes[closes.length - 1];
  const rsi     = parseFloat(calcRSI(closes).toFixed(2));
  const macd    = calcMACD(closes);
  const bb      = calcBollingerBands(closes);
  const ema9    = parseFloat((calcEMA(closes, 9).at(-1)  || 0).toFixed(4));
  const ema21   = parseFloat((calcEMA(closes, 21).at(-1) || 0).toFixed(4));
  const volumeRatio = parseFloat(calcVolumeRatio(volumes).toFixed(2));
  const atr     = parseFloat(calcATR(ohlcv).toFixed(6));
  const atrPct  = price > 0 ? parseFloat((atr / price * 100).toFixed(4)) : 0; // % of price

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
  return { action, rsi, price, macd, bb, ema9, ema21, volumeRatio, atr, atrPct };
}

// Returns signal for MOMENTUM ARB: EMA9/21 fresh crossover confirmed by RSI (5m candles)
function calculateMomentumSignal(ohlcv: number[][]) {
  const empty = { action: "HOLD" as const, rsi: 50, price: 0, volumeRatio: 1, atr: 0, atrPct: 0, cross: null as string | null };
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

  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (bullCross && rsi > 45) action = "BUY";
  if (bearCross && rsi < 55) action = "SELL";

  return { action, rsi, price, volumeRatio, atr, atrPct, cross };
}

// Returns signal for MEAN-REVERSION: BB band touch + RSI on 15m candles.
// Intentionally ignores trend direction — designed for range/neutral markets.
function calculateMeanRevSignal(ohlcv: number[][]) {
  const empty = { action: "HOLD" as const, rsi: 50, price: 0, volumeRatio: 1, atr: 0, atrPct: 0, bbPos: null as string | null };
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

  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (price <= bb.lower * 1.003 && rsi < 38) action = "BUY";  // oversold at lower band
  if (price >= bb.upper * 0.997 && rsi > 62) action = "SELL"; // overbought at upper band

  return { action, rsi, price, volumeRatio, atr, atrPct, bbPos };
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

// Rolling 50-candle buffer per symbol (1m), updated by WebSocket
const candleBuffer   = new Map<string, number[][]>(SYMBOLS.map(s => [s, []]));
// 50-candle buffer (5m) for MOMENTUM ARB strategy
const momentumBuffer = new Map<string, number[][]>(SYMBOLS.map(s => [s, []]));
// 200-candle buffer (15m) for trend filter — EMA200 direction
const trendBuffer    = new Map<string, number[][]>(SYMBOLS.map(s => [s, []]));
// Per-strategy action + attempt trackers — transition detection + retry without flooding the exchange
const lastUltraScalpAction  = new Map<string, string>(SYMBOLS.map(s => [s, "HOLD"]));
const lastUltraScalpAttempt = new Map<string, number>(SYMBOLS.map(s => [s, 0]));
const lastMomentumAction    = new Map<string, string>(SYMBOLS.map(s => [s, "HOLD"]));
const lastMomentumAttempt   = new Map<string, number>(SYMBOLS.map(s => [s, 0]));
const lastMeanRevAction     = new Map<string, string>(SYMBOLS.map(s => [s, "HOLD"]));
const lastMeanRevAttempt    = new Map<string, number>(SYMBOLS.map(s => [s, 0]));

let scanResults: any[] = [];
// Set of currently enabled strategies — all three active by default
let activeStrategies = new Set<string>(["ULTRA-SCALP", "MOMENTUM-ARB", "MEAN-REV"]);

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

// Returns a TP price guaranteed to cover round-trip taker fees (entry + exit).
// If ATR-based TP profit < total fee, bumps TP up by 10% above fee cost.
function safeTpPrice(
  isLong: boolean, fillPrice: number, amount: number,
  rawTpPct: number, entryFeeUsdt: number, symbol: string
): number {
  const TAKER_RATE = 0.0004;
  let tp = isLong ? fillPrice * (1 + rawTpPct) : fillPrice * (1 - rawTpPct);
  const exitFee  = tp * amount * TAKER_RATE;
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

type AnySignal = { action: "BUY" | "SELL" | "HOLD"; price: number; rsi: number; volumeRatio: number; atr: number; atrPct: number };

async function checkAutoExecute(symbol: string, signal: AnySignal, strategyName: string) {
  const settingsRow = await pool.query("SELECT is_auto_pilot FROM bot_settings WHERE id = 'bot_config'");
  const isAutoPilot = settingsRow.rows[0]?.is_auto_pilot || false;

  const trend = getTrend(symbol);
  console.log(`[${strategyName}] ${symbol} → ${signal.action} RSI:${signal.rsi} trend:${trend} autoPilot:${isAutoPilot}`);

  if (!isAutoPilot || signal.action === "HOLD") return;

  // Trend filter — only MOMENTUM-ARB uses this (crossover strategy benefits from trend alignment)
  // ULTRA-SCALP and MEAN-REV skip trend filter: 1m scalps are too short for 15m trend to matter
  if (strategyName === "MOMENTUM-ARB") {
    if (signal.action === "BUY"  && trend === "DOWN") { console.log(`[TREND] ${symbol} BUY blocked — DOWN`);    return; }
    if (signal.action === "SELL" && trend === "UP")   { console.log(`[TREND] ${symbol} SELL blocked — UP`);     return; }
    if (trend === "NEUTRAL")                           { console.log(`[TREND] ${symbol} blocked — NEUTRAL`);     return; }
  }

  // Volume threshold: MEAN-REV uses 0.8× (subdued range-market volume), others 1.0×.
  // ULTRA-SCALP fires on live in-progress candle ticks — the partial candle's volume is always
  // a fraction of a completed candle, so we recompute the ratio from the closed-candle buffer
  // to get a fair apples-to-apples comparison against the 20-period average.
  const volThreshold = strategyName === "MEAN-REV" ? 0.8 : 1.0;
  const volRatio = strategyName === "ULTRA-SCALP"
    ? parseFloat(calcVolumeRatio((candleBuffer.get(symbol) || []).map(c => c[5])).toFixed(2))
    : signal.volumeRatio ?? 1;
  if (volRatio < volThreshold) {
    console.log(`[VOL] ${symbol} blocked — ${volRatio}× < ${volThreshold}× threshold`);
    return;
  }

  // Funding rate filter — high positive = market overleveraged long; high negative = overleveraged short
  const fundingRate = fundingRateCache.get(symbol);
  if (fundingRate !== undefined) {
    if (signal.action === "BUY" && fundingRate > 0.0005) {
      console.log(`[FUNDING] ${symbol} BUY blocked — ${(fundingRate * 100).toFixed(4)}% > 0.05% (longs paying too much)`);
      return;
    }
    if (signal.action === "SELL" && fundingRate < -0.0003) {
      console.log(`[FUNDING] ${symbol} SELL blocked — ${(fundingRate * 100).toFixed(4)}% < -0.03% (shorts paying too much)`);
      return;
    }
  }

  // Fear & Greed filter
  if (fearGreedCache) {
    const fg = fearGreedCache.value;
    // MEAN-REV has no trend filter so is most exposed to regime risk — apply stricter F&G gates
    if (strategyName === "MEAN-REV") {
      if (signal.action === "BUY" && fg > 75)  { console.log(`[F&G] ${symbol} MEAN-REV BUY blocked — Extreme Greed (${fg})`);  return; }
      if (signal.action === "SELL" && fg < 25)  { console.log(`[F&G] ${symbol} MEAN-REV SELL blocked — Extreme Fear (${fg})`);  return; }
    }
    // All strategies: block at absolute extremes
    if (signal.action === "BUY"  && fg > 85) { console.log(`[F&G] ${symbol} ${strategyName} BUY blocked — F&G ${fg} (extreme greed)`);  return; }
    if (signal.action === "SELL" && fg < 15) { console.log(`[F&G] ${symbol} ${strategyName} SELL blocked — F&G ${fg} (extreme fear)`); return; }
  }

  // Open Interest filter
  const oiData = openInterestCache.get(symbol);
  if (oiData) {
    // MOMENTUM-ARB BUY on falling OI = short covering (no real demand), not a conviction rally
    if (strategyName === "MOMENTUM-ARB" && signal.action === "BUY" && oiData.oiChangePct < -2.0) {
      console.log(`[OI] ${symbol} MOMENTUM-ARB BUY blocked — OI ${oiData.oiChangePct.toFixed(2)}% (short covering, not real demand)`);
      return;
    }
    // MEAN-REV SELL on falling OI = long liquidation nearing exhaustion → reversal risk
    if (strategyName === "MEAN-REV" && signal.action === "SELL" && oiData.oiChangePct < -2.0) {
      console.log(`[OI] ${symbol} MEAN-REV SELL blocked — OI ${oiData.oiChangePct.toFixed(2)}% (liquidation exhaustion near)`);
      return;
    }
  }

  // Long/Short Ratio filter — extreme one-sided positioning
  const lsRatio = longShortCache.get(symbol);
  if (lsRatio !== undefined) {
    if (signal.action === "BUY"  && lsRatio > 2.5) {
      console.log(`[LS] ${symbol} BUY blocked — L/S ${lsRatio.toFixed(2)} (market over-long, reversal risk)`);
      return;
    }
    if (signal.action === "SELL" && lsRatio < 0.4) {
      console.log(`[LS] ${symbol} SELL blocked — L/S ${lsRatio.toFixed(2)} (market over-short, reversal risk)`);
      return;
    }
  }

  // Cooldown per strategy — each strategy tracks its own independently so they can all fire on the same symbol.
  const cooldown = strategyName === "MOMENTUM-ARB" ? "15 minutes" : strategyName === "MEAN-REV" ? "30 minutes" : "5 minutes";
  const recent   = await pool.query(
    `SELECT id FROM trades WHERE symbol = $1 AND strategy = $2 AND status = 'OPEN'
     AND timestamp > NOW() - INTERVAL '${cooldown}' LIMIT 1`, [symbol, strategyName]
  );
  if (recent.rows.length > 0) {
    console.log(`[AUTO] ${symbol} ${strategyName} skipped — open ${strategyName} trade within ${cooldown}`);
    return;
  }

  // ATR multipliers differ per strategy
  const cfgRow   = await pool.query("SELECT leverage, atr_sl_mult::float, atr_tp_mult::float, arb_sl_mult::float, arb_tp_mult::float, mr_sl_mult::float, mr_tp_mult::float FROM bot_settings WHERE id = 'bot_config'");
  const leverage = cfgRow.rows[0]?.leverage || 10;
  const slMult   = strategyName === "MOMENTUM-ARB" ? (cfgRow.rows[0]?.arb_sl_mult ?? 1.0)
                 : strategyName === "MEAN-REV"      ? (cfgRow.rows[0]?.mr_sl_mult  ?? 1.0)
                 :                                    (cfgRow.rows[0]?.atr_sl_mult ?? 1.5);
  const tpMult   = strategyName === "MOMENTUM-ARB" ? (cfgRow.rows[0]?.arb_tp_mult ?? 3.0)
                 : strategyName === "MEAN-REV"      ? (cfgRow.rows[0]?.mr_tp_mult  ?? 2.0)
                 :                                    (cfgRow.rows[0]?.atr_tp_mult ?? 2.5);
  const side      = signal.action === "BUY" ? "buy" : "sell";
  const closeSide = signal.action === "BUY" ? "sell" : "buy";
  const isLong    = signal.action === "BUY";
  const hasKeys   = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY);
  const amount    = parseFloat((binance as any).amountToPrecision(symbol, 25 / signal.price));

  console.log(`[AUTO] ${signal.action} ${symbol} x${leverage} ATR:${signal.atrPct?.toFixed(3)}% amount:${amount}`);

  let fillPrice = signal.price;
  // Binance USDM futures taker rate: 0.04% — used as fallback when fee not in API response
  const TAKER_RATE = 0.0004;
  let feeUsdt = parseFloat((fillPrice * amount * TAKER_RATE).toFixed(6));

  // Variables hoisted so Telegram notification at the end can reference them
  const orderWarnings: string[] = [];
  let tpPrice      = 0;
  let callbackRate = 0;
  let tpBonus      = 1.0;

  if (hasKeys) {
    try {
      await binance.setLeverage(leverage, symbol);
      const order = await binance.createOrder(symbol, "market", side, amount);
      fillPrice = parseFloat(String((order as any).average || (order as any).price || signal.price));
      const orderFee = (order as any).fee;
      if (orderFee?.cost && orderFee?.currency === "USDT") {
        feeUsdt = parseFloat(Math.abs(orderFee.cost).toFixed(6));
      } else {
        feeUsdt = parseFloat((fillPrice * amount * TAKER_RATE).toFixed(6));
      }
      console.log(`[AUTO-FUTURES] ✓ ${signal.action} ${symbol} x${leverage} fill:${fillPrice} fee:${feeUsdt} USDT`);
    } catch (e: any) {
      console.error(`[AUTO-FUTURES] ✗ Market order failed [${symbol}]:`, e?.message);
      await sendTelegram(
        `❌ <b>AUTO TRADE FAILED</b>\n` +
        `Symbol: <code>${symbol}</code>  Side: <b>${isLong ? "LONG" : "SHORT"}</b>\n` +
        `Strategy: <code>${strategyName}</code>\n` +
        `Reason: <code>${(e?.message ?? "unknown error").slice(0, 300)}</code>`
      );
      return;
    }

    // ── ATR-based dynamic levels with market-context adjustment ──
    const atrPctFill = (signal.atr ?? 0) / fillPrice;
    const vwap       = parseFloat(calcVWAP(candleBuffer.get(symbol) || []).toFixed(6));
    const oiD        = openInterestCache.get(symbol);
    const { tpBonus: tb, slMult: ctxSlMult } = calcContextMultipliers(
      signal.action, strategyName,
      fundingRateCache.get(symbol), fearGreedCache,
      vwap, fillPrice,
      oiD?.oiChangePct, longShortCache.get(symbol)
    );
    tpBonus = tb;
    const dynSlPct = Math.min(Math.max(atrPctFill * slMult * ctxSlMult, 0.001), 0.05);
    const dynTpPct = Math.min(Math.max(atrPctFill * tpMult * tpBonus,   0.01),  0.15);
    callbackRate   = parseFloat(Math.min(Math.max(dynSlPct * 100, 0.5), 5.0).toFixed(1));
    tpPrice        = safeTpPrice(isLong, fillPrice, amount, dynTpPct, feeUsdt, symbol);

    if (tpBonus !== 1.0 || ctxSlMult !== 1.0) {
      console.log(`[CTX] ${symbol} TP×${tpBonus.toFixed(2)} SL×${ctxSlMult.toFixed(2)} | FR:${((fundingRateCache.get(symbol) ?? 0)*100).toFixed(4)}% F&G:${fearGreedCache?.value ?? 'N/A'}`);
    }
    console.log(`[AUTO] ATR-SL:${(dynSlPct*100).toFixed(3)}% (cb:${callbackRate}%)  ATR-TP:${(dynTpPct*100).toFixed(3)}% @ ${tpPrice}`);

    // ── Native TP order ──
    try {
      await binance.createOrder(symbol, "TAKE_PROFIT_MARKET", closeSide, amount, undefined, {
        stopPrice: tpPrice, reduceOnly: true, workingType: "MARK_PRICE", priceProtect: true,
      });
      console.log(`[AUTO] TP order placed @ ${tpPrice}`);
    } catch (e: any) {
      console.error(`[AUTO] TP order failed [${symbol}]:`, e?.message);
      orderWarnings.push(`TP failed: ${(e?.message ?? "").slice(0, 150)}`);
    }

    // ── Native Trailing SL ──
    try {
      await binance.createOrder(symbol, "TRAILING_STOP_MARKET", closeSide, amount, undefined, {
        callbackRate, reduceOnly: true, workingType: "MARK_PRICE",
      });
      console.log(`[AUTO] Trailing SL placed @ ${callbackRate}% callback`);
    } catch (e: any) {
      console.error(`[AUTO] Trailing SL order failed [${symbol}]:`, e?.message);
      orderWarnings.push(`SL failed: ${(e?.message ?? "").slice(0, 150)}`);
    }
  }

  await pool.query(
    `INSERT INTO trades (symbol, type, entry_price, amount, strategy, status, leverage, fee_usdt)
     VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7)`,
    [symbol, signal.action, fillPrice, amount, strategyName, leverage, feeUsdt]
  );
  console.log(`[AUTO] DB recorded: ${signal.action} ${symbol} @ ${fillPrice} fee:${feeUsdt} USDT [${strategyName}]`);

  if (hasKeys) {
    const icon   = orderWarnings.length ? "⚠️" : "✅";
    const status = orderWarnings.length ? "EXECUTED (warnings)" : "EXECUTED";
    await sendTelegram(
      `${icon} <b>AUTO TRADE ${status}</b>\n` +
      `<code>${symbol}</code>  <b>${isLong ? "LONG 🟢" : "SHORT 🔴"}</b>  <code>${strategyName}</code>\n` +
      `Fill: <code>$${fillPrice.toLocaleString()}</code>  Lev: <code>${leverage}×</code>  Fee: <code>${feeUsdt} USDT</code>\n` +
      `TP: <code>$${tpPrice > 0 ? tpPrice.toLocaleString() : "N/A"}</code>  SL: <code>${callbackRate}% callback</code>\n` +
      `RSI: <code>${signal.rsi}</code>  ATR: <code>${signal.atrPct?.toFixed(3)}%</code>  TP×: <code>${tpBonus.toFixed(2)}</code>` +
      (orderWarnings.length ? `\n\n⚠️ <b>Warnings:</b>\n<code>${orderWarnings.join("\n")}</code>` : "")
    );
  }
}

// ── WebSocket — Binance Futures Kline Stream ───────────────────────────────────

async function seedCandleBuffer() {
  console.log(`[SEED] Fetching 1m + 5m + 15m candles (active: ${[...activeStrategies].join(", ")})...`);
  await Promise.all(SYMBOLS.map(async symbol => {
    try {
      // 1m — ULTRA-SCALP signal indicators
      const ohlcv1m = await binance.fetchOHLCV(symbol, "1m", undefined, 50);
      const buf1m   = ohlcv1m.map((c: any[]) => c.map(Number) as number[]);
      candleBuffer.set(symbol, buf1m);
      await saveOHLCV(symbol, buf1m);

      // 5m — MOMENTUM ARB (50 candles ≈ 4 hours)
      const ohlcv5m = await binance.fetchOHLCV(symbol, "5m", undefined, 50);
      const buf5m   = ohlcv5m.map((c: any[]) => c.map(Number) as number[]);
      momentumBuffer.set(symbol, buf5m);

      // 15m — trend filter (200 candles ≈ 50 hours)
      const ohlcv15m = await binance.fetchOHLCV(symbol, "15m", undefined, 200);
      const buf15m   = ohlcv15m.map((c: any[]) => c.map(Number) as number[]);
      trendBuffer.set(symbol, buf15m);
      await saveOHLCV(symbol, buf15m, "15m");

      // Build initial scanResult for ALL strategies simultaneously
      const trend  = getTrend(symbol);
      const sig1m  = calculateSignal(buf1m);
      const sig5m  = calculateMomentumSignal(buf5m);
      const sigMR  = calculateMeanRevSignal(buf15m);
      const entry  = {
        symbol,
        price:       sig1m.price || sig5m.price,
        trend,
        vwap:        parseFloat(calcVWAP(buf1m).toFixed(6)),
        oiChangePct: openInterestCache.get(symbol)?.oiChangePct ?? null,
        lsRatio:     longShortCache.get(symbol) ?? null,
        ultraScalp:  { action: sig1m.action, rsi: sig1m.rsi, volumeRatio: sig1m.volumeRatio, atrPct: sig1m.atrPct },
        momentumArb: { action: sig5m.action, rsi: sig5m.rsi, volumeRatio: sig5m.volumeRatio, atrPct: sig5m.atrPct, cross: sig5m.cross },
        meanRev:     { action: sigMR.action, rsi: sigMR.rsi, volumeRatio: sigMR.volumeRatio, atrPct: sigMR.atrPct, bbPos: sigMR.bbPos },
      };
      const idx = scanResults.findIndex(r => r.symbol === symbol);
      if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);
      console.log(`[SEED] ${symbol} US:${sig1m.action} MA:${sig5m.action} MR:${sigMR.action} trend:${trend}`);
    } catch (e: any) {
      console.error(`[SEED] ${symbol}:`, e?.message);
    }
  }));
}

function initWebSocket() {
  const streams1m  = SYMBOLS.map(s => `${toWsSym(s)}@kline_1m`);
  const streams5m  = SYMBOLS.map(s => `${toWsSym(s)}@kline_5m`);
  const streams15m = SYMBOLS.map(s => `${toWsSym(s)}@kline_15m`);
  const allStreams  = [...streams1m, ...streams5m, ...streams15m].join("/");
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${allStreams}`);

  ws.on("open", () => console.log("[WS] Connected — 1m + 5m + 15m streams"));

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
          const idx    = scanResults.findIndex(r => r.symbol === symbol);
          const entry  = scanResults[idx] || { symbol, price: signal.price, trend };
          entry.meanRev = { action: signal.action, rsi: signal.rsi, volumeRatio: signal.volumeRatio, atrPct: signal.atrPct, bbPos: signal.bbPos };
          if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);

          const prevMR  = lastMeanRevAction.get(symbol)  || "HOLD";
          const lastMR  = lastMeanRevAttempt.get(symbol) ?? 0;
          const isNewMR = signal.action !== "HOLD" && prevMR === "HOLD";
          const isRetryMR = signal.action !== "HOLD" && (Date.now() - lastMR) > 2 * 60 * 1000;
          if (activeStrategies.has("MEAN-REV") && (isNewMR || isRetryMR)) {
            lastMeanRevAttempt.set(symbol, Date.now());
            await checkAutoExecute(symbol, signal, "MEAN-REV");
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
          entry.momentumArb = { action: signal.action, rsi: signal.rsi, volumeRatio: signal.volumeRatio, atrPct: signal.atrPct, cross: signal.cross };
          if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);

          const prevMA  = lastMomentumAction.get(symbol)  || "HOLD";
          const lastMA  = lastMomentumAttempt.get(symbol) ?? 0;
          const isNewMA = signal.action !== "HOLD" && prevMA === "HOLD";
          const isRetryMA = signal.action !== "HOLD" && (Date.now() - lastMA) > 60 * 1000;
          if (activeStrategies.has("MOMENTUM-ARB") && (isNewMA || isRetryMA)) {
            lastMomentumAttempt.set(symbol, Date.now());
            await checkAutoExecute(symbol, signal, "MOMENTUM-ARB");
          }
          lastMomentumAction.set(symbol, signal.action);
        }
        return;
      }

      // ── 1m: ULTRA-SCALP — compute on every tick, execute on HOLD→BUY/SELL transition ──
      const buffer = candleBuffer.get(symbol) || [];
      if (k.x) {
        buffer.push(candle);
        if (buffer.length > 50) buffer.shift();
        candleBuffer.set(symbol, buffer);
        await saveOHLCV(symbol, [candle]);
      }

      // Append live in-progress candle so signal reacts in real-time, not at candle close
      const liveBuffer = buffer.length > 0 ? (k.x ? buffer : [...buffer, candle]) : buffer;
      if (liveBuffer.length >= 26) {
        const signal = calculateSignal(liveBuffer);
        const trend  = getTrend(symbol);
        const idx    = scanResults.findIndex(r => r.symbol === symbol);
        const entry  = scanResults[idx] || { symbol, price: signal.price, trend };
        entry.trend       = trend;
        entry.price       = signal.price;
        entry.vwap        = parseFloat(calcVWAP(liveBuffer).toFixed(6));
        entry.oiChangePct = openInterestCache.get(symbol)?.oiChangePct ?? null;
        entry.lsRatio     = longShortCache.get(symbol) ?? null;
        // Use closed-candle volume ratio for the scan result so the frontend displays the same
        // value that checkAutoExecute actually checks (not the partial in-progress candle's volume).
        const closedVolumeRatio = parseFloat(calcVolumeRatio(buffer.map(c => c[5])).toFixed(2));
        entry.ultraScalp  = { action: signal.action, rsi: signal.rsi, volumeRatio: closedVolumeRatio, atrPct: signal.atrPct };
        entry.lastTickMs  = Date.now();
        if (idx >= 0) scanResults[idx] = entry; else scanResults.push(entry);

        // Fire on HOLD→signal transition, OR retry every 3 min if the signal persists.
        // Without retry, a single blocked shot (e.g. volume low at candle start) wastes the entire BUY streak.
        const prevAction  = lastUltraScalpAction.get(symbol)  || "HOLD";
        const lastAttempt = lastUltraScalpAttempt.get(symbol) ?? 0;
        const isNewSignal = signal.action !== "HOLD" && prevAction === "HOLD";
        const isRetry     = signal.action !== "HOLD" && (Date.now() - lastAttempt) > 60 * 1000;
        if (activeStrategies.has("ULTRA-SCALP") && (isNewSignal || isRetry)) {
          lastUltraScalpAttempt.set(symbol, Date.now());
          await checkAutoExecute(symbol, signal, "ULTRA-SCALP");
        }
        lastUltraScalpAction.set(symbol, signal.action);
      } else {
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

// ── Mock Trade Monitor (no API keys — simulates TP/SL using live scan prices) ──
// In live mode Binance handles TP/SL natively via server-side orders placed on entry.

const runMockTradeMonitor = async () => {
  if (process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY) return; // live mode: Binance handles it
  try {
    const openTrades = await pool.query(
      `SELECT id, symbol, type, entry_price::float, amount::float FROM trades WHERE status = 'OPEN'`
    );
    if (openTrades.rows.length === 0) return;

    const cfg   = await pool.query(`SELECT take_profit_pct::float, stop_loss_pct::float FROM bot_settings WHERE id = 'bot_config'`);
    const tpPct = (cfg.rows[0]?.take_profit_pct ?? 1.5) / 100;
    const slPct = (cfg.rows[0]?.stop_loss_pct   ?? 0.8) / 100;

    for (const trade of openTrades.rows) {
      const live = scanResults.find(r => r.symbol === trade.symbol);
      if (!live?.price) continue;
      const currentPrice = live.price;
      const isLong       = trade.type === "BUY";
      const pnlPct       = isLong ? (currentPrice - trade.entry_price) / trade.entry_price
                                  : (trade.entry_price - currentPrice) / trade.entry_price;
      const hitTP = pnlPct >=  tpPct;
      const hitSL = pnlPct <= -slPct;
      if (!hitTP && !hitSL) continue;

      const reason  = hitTP ? "TP" : "SL";
      const pnlUSDT = (isLong ? currentPrice - trade.entry_price : trade.entry_price - currentPrice) * trade.amount;
      await pool.query(
        `UPDATE trades SET status = 'CLOSED', exit_price = $1, pnl = $2 WHERE id = $3`,
        [currentPrice, pnlUSDT.toFixed(4), trade.id]
      );
      console.log(`[MOCK-${reason}] ${trade.symbol} PnL=${pnlUSDT.toFixed(2)} USDT`);
    }
  } catch (err) {
    console.error("[MOCK-MONITOR] Error:", err);
  }
};

// ── Market Context (Funding Rate + Fear & Greed) ────────────────────────────────

const fundingRateCache = new Map<string, number>(); // symbol → rate (e.g. 0.0001 = 0.01% per 8h)
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

async function sendTelegram(message: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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

// Returns per-symbol cooldown status so the frontend can show if a trade was just fired
app.get("/api/cooldown-status", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT symbol, strategy, timestamp,
        CASE strategy
          WHEN 'MOMENTUM-ARB' THEN timestamp > NOW() - INTERVAL '15 minutes'
          WHEN 'MEAN-REV'     THEN timestamp > NOW() - INTERVAL '30 minutes'
          ELSE                     timestamp > NOW() - INTERVAL '5 minutes'
        END AS in_cooldown
      FROM trades
      WHERE status = 'OPEN'
        AND timestamp > NOW() - INTERVAL '30 minutes'
      ORDER BY timestamp DESC
    `);
    // Keyed by "SYMBOL|STRATEGY" so each strategy has its own cooldown status
    const map: Record<string, { inCooldown: boolean; strategy: string; since: string }> = {};
    for (const row of result.rows) {
      const key = `${row.symbol}|${row.strategy}`;
      if (!map[key]) {
        map[key] = { inCooldown: row.in_cooldown, strategy: row.strategy, since: row.timestamp };
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
      const live         = scanResults.find(r => r.symbol === trade.symbol);
      const currentPrice = live?.price ?? trade.entry_price;
      const isLong       = trade.type === "BUY";
      const grossPnl     = (isLong ? currentPrice - trade.entry_price : trade.entry_price - currentPrice) * trade.amount;
      const pnlPct       = ((isLong ? currentPrice - trade.entry_price : trade.entry_price - currentPrice) / trade.entry_price) * 100;
      const feeUsdt      = trade.fee_usdt ?? 0;
      return {
        ...trade,
        side:          isLong ? "LONG" : "SHORT",
        current_price: parseFloat(currentPrice.toFixed(4)),
        pnl_usdt:      parseFloat(grossPnl.toFixed(4)),
        net_pnl_usdt:  parseFloat((grossPnl - feeUsdt).toFixed(4)),
        pnl_pct:       parseFloat(pnlPct.toFixed(3)),
        fee_usdt:      parseFloat(feeUsdt.toFixed(6)),
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

// Close a single open position by trade ID
app.post("/api/close-position/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const tradeRes = await pool.query(
      `SELECT id, symbol, type, entry_price::float, amount::float FROM trades WHERE id = $1 AND status = 'OPEN'`,
      [id]
    );
    if (tradeRes.rows.length === 0)
      return res.status(404).json({ error: "Position not found or already closed" });

    const trade   = tradeRes.rows[0];
    const hasKeys = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY);
    let exitPrice = trade.entry_price;

    if (hasKeys) {
      try { await binance.cancelAllOrders(trade.symbol); } catch { /* TP/SL may already be filled */ }
      try {
        const closeSide = trade.type === "BUY" ? "sell" : "buy";
        const order = await binance.createOrder(trade.symbol, "market", closeSide, trade.amount, undefined, { reduceOnly: true });
        exitPrice = parseFloat(String((order as any).average || (order as any).price || trade.entry_price));
      } catch (e: any) {
        return res.status(500).json({ error: `Binance close failed: ${e?.message}` });
      }
    } else {
      exitPrice = scanResults.find(r => r.symbol === trade.symbol)?.price ?? trade.entry_price;
    }

    const isLong  = trade.type === "BUY";
    const pnlUsdt = (isLong ? exitPrice - trade.entry_price : trade.entry_price - exitPrice) * trade.amount;
    await pool.query(
      `UPDATE trades SET status = 'CLOSED', exit_price = $1, pnl = $2 WHERE id = $3`,
      [exitPrice, pnlUsdt.toFixed(4), id]
    );
    console.log(`[CLOSE] ${trade.symbol} @ ${exitPrice} PnL:${pnlUsdt.toFixed(2)} USDT`);
    res.json({ ok: true, symbol: trade.symbol, exitPrice, pnlUsdt: parseFloat(pnlUsdt.toFixed(4)) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// Close all open positions at market
app.post("/api/close-all-positions", async (_req, res) => {
  try {
    const openTrades = await pool.query(
      `SELECT id, symbol, type, entry_price::float, amount::float FROM trades WHERE status = 'OPEN'`
    );
    if (openTrades.rows.length === 0) return res.json({ ok: true, closed: 0 });

    const hasKeys      = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY);
    const symbolsSeen  = new Set<string>();
    let   closed       = 0;
    const results: any[] = [];

    for (const trade of openTrades.rows) {
      let exitPrice = trade.entry_price;

      if (hasKeys) {
        if (!symbolsSeen.has(trade.symbol)) {
          try { await binance.cancelAllOrders(trade.symbol); } catch { /* ignore */ }
          symbolsSeen.add(trade.symbol);
        }
        try {
          const closeSide = trade.type === "BUY" ? "sell" : "buy";
          const order = await binance.createOrder(trade.symbol, "market", closeSide, trade.amount, undefined, { reduceOnly: true });
          exitPrice = parseFloat(String((order as any).average || (order as any).price || trade.entry_price));
        } catch (e: any) {
          console.error(`[CLOSE-ALL] ${trade.symbol} failed:`, e?.message);
          continue;
        }
      } else {
        exitPrice = scanResults.find(r => r.symbol === trade.symbol)?.price ?? trade.entry_price;
      }

      const isLong  = trade.type === "BUY";
      const pnlUsdt = (isLong ? exitPrice - trade.entry_price : trade.entry_price - exitPrice) * trade.amount;
      await pool.query(
        `UPDATE trades SET status = 'CLOSED', exit_price = $1, pnl = $2 WHERE id = $3`,
        [exitPrice, pnlUsdt.toFixed(4), trade.id]
      );
      closed++;
      results.push({ symbol: trade.symbol, exitPrice, pnlUsdt: parseFloat(pnlUsdt.toFixed(4)) });
      console.log(`[CLOSE-ALL] ${trade.symbol} @ ${exitPrice} PnL:${pnlUsdt.toFixed(2)} USDT`);
    }

    res.json({ ok: true, closed, results });
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
  const { isAutoPilot, riskLevel, maxSlippage, takeProfitPct, stopLossPct, leverage,
          atrSlMult, atrTpMult, arbSlMult, arbTpMult, mrSlMult, mrTpMult, activeStrategiesVal } = req.body;
  const strategiesParam = Array.isArray(activeStrategiesVal) ? activeStrategiesVal : null;
  try {
    const r = await pool.query(
      `UPDATE bot_settings
       SET is_auto_pilot    = COALESCE($1,  is_auto_pilot),
           risk_level       = COALESCE($2,  risk_level),
           max_slippage     = COALESCE($3,  max_slippage),
           take_profit_pct  = COALESCE($4,  take_profit_pct),
           stop_loss_pct    = COALESCE($5,  stop_loss_pct),
           leverage         = COALESCE($6,  leverage),
           atr_sl_mult      = COALESCE($7,  atr_sl_mult),
           atr_tp_mult      = COALESCE($8,  atr_tp_mult),
           arb_sl_mult      = COALESCE($9,  arb_sl_mult),
           arb_tp_mult      = COALESCE($10, arb_tp_mult),
           active_strategies = COALESCE($11, active_strategies),
           mr_sl_mult       = COALESCE($12, mr_sl_mult),
           mr_tp_mult       = COALESCE($13, mr_tp_mult)
       WHERE id = 'bot_config' RETURNING *`,
      [isAutoPilot ?? null, riskLevel ?? null, maxSlippage ?? null,
       takeProfitPct ?? null, stopLossPct ?? null, leverage ?? null,
       atrSlMult ?? null, atrTpMult ?? null, arbSlMult ?? null, arbTpMult ?? null,
       strategiesParam, mrSlMult ?? null, mrTpMult ?? null]
    );
    // Sync in-memory Set so WebSocket handlers react immediately
    if (strategiesParam) {
      activeStrategies = new Set(strategiesParam);
      console.log(`[STRATEGY] Active: ${[...activeStrategies].join(", ")}`);
    }
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

app.delete("/api/pnl-history", async (req, res) => {
  try {
    const { above } = req.query; // optional: DELETE /api/pnl-history?above=10000
    if (above) {
      const threshold = parseFloat(above as string);
      await pool.query("DELETE FROM pnl_snapshots WHERE total_value > $1", [threshold]);
      res.json({ ok: true, message: `Deleted snapshots with total_value > ${threshold}` });
    } else {
      await pool.query("TRUNCATE pnl_snapshots");
      res.json({ ok: true, message: "All PnL history cleared" });
    }
  } catch { res.status(500).json({ error: "Failed to delete PnL history" }); }
});

app.get("/api/trade-history", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, symbol, entry_price::float AS entry, exit_price::float AS exit,
              pnl::float, fee_usdt::float AS fee, strategy,
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

// ── Diagnose — real-time filter state per symbol ───────────────────────────────

app.get("/api/diagnose", async (_req, res) => {
  try {
    const settingsRow = await pool.query("SELECT is_auto_pilot FROM bot_settings WHERE id = 'bot_config'");
    const isAutoPilot = settingsRow.rows[0]?.is_auto_pilot ?? false;

    function filterBlock(signal: any, strategyName: string, symbol: string): string {
      if (!isAutoPilot) return "autopilot OFF";
      if (signal.action === "HOLD") return "HOLD signal";
      const trend = getTrend(symbol);
      if (strategyName === "MOMENTUM-ARB") {
        if (signal.action === "BUY"  && trend === "DOWN")    return `trend DOWN (need UP)`;
        if (signal.action === "SELL" && trend === "UP")      return `trend UP (need DOWN)`;
        if (trend === "NEUTRAL")                             return `trend NEUTRAL`;
      }
      const volThreshold = strategyName === "MEAN-REV" ? 0.8 : strategyName === "ULTRA-SCALP" ? 0.5 : 1.0;
      if ((signal.volumeRatio ?? 1) < volThreshold)
        return `vol ${(signal.volumeRatio ?? 0).toFixed(2)}× < ${volThreshold}×`;
      const fr = fundingRateCache.get(symbol);
      if (fr !== undefined) {
        if (signal.action === "BUY"  && fr >  0.0005) return `funding +${(fr*100).toFixed(4)}% > 0.05%`;
        if (signal.action === "SELL" && fr < -0.0003) return `funding ${(fr*100).toFixed(4)}% < -0.03%`;
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
        if (strategyName === "MOMENTUM-ARB" && signal.action === "BUY"  && oi.oiChangePct < -2)
          return `OI ${oi.oiChangePct.toFixed(2)}% falling (MOMENTUM-ARB BUY)`;
        if (strategyName === "MEAN-REV"     && signal.action === "SELL" && oi.oiChangePct < -2)
          return `OI ${oi.oiChangePct.toFixed(2)}% falling (MEAN-REV SELL)`;
      }
      const ls = longShortCache.get(symbol);
      if (ls !== undefined) {
        if (signal.action === "BUY"  && ls > 2.5) return `L/S ${ls.toFixed(2)} > 2.5 (over-long)`;
        if (signal.action === "SELL" && ls < 0.4) return `L/S ${ls.toFixed(2)} < 0.4 (over-short)`;
      }
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
      const buf1m  = candleBuffer.get(symbol)  || [];
      const buf5m  = momentumBuffer.get(symbol) || [];
      const buf15m = trendBuffer.get(symbol)    || [];
      const sig1m  = calculateSignal(buf1m);
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

      return {
        symbol,
        trend: getTrend(symbol),
        buffers: { "1m": buf1m.length, "5m": buf5m.length, "15m": buf15m.length },
        openTrades: openTrades.length,
        cooldownBlocking: cooldownBlocking.length > 0,
        context: {
          fundingRate:  fr !== undefined ? `${(fr * 100).toFixed(4)}%` : null,
          oiChangePct:  oi?.oiChangePct ?? null,
          lsRatio:      ls ?? null,
        },
        strategies: {
          "ULTRA-SCALP":  { action: sig1m.action,  rsi: sig1m.rsi,  vol: sig1m.volumeRatio,  atrPct: sig1m.atrPct,  block: addCooldownNote(filterBlock(sig1m,  "ULTRA-SCALP",  symbol)) },
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

// ── Backtest Engine ────────────────────────────────────────────────────────────

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

    const cfg    = await pool.query(`SELECT atr_sl_mult::float, atr_tp_mult::float FROM bot_settings WHERE id = 'bot_config'`);
    const slMult = cfg.rows[0]?.atr_sl_mult ?? 1.5;
    const tpMult = cfg.rows[0]?.atr_tp_mult ?? 2.5;

    // Build 15m trend lookup: ts15m → EMA200 value
    const candles15m = resampleTo15m(candles1m);
    const closes15m  = candles15m.map(c => c[4]);
    const ema200arr  = calcEMA(closes15m, 200);
    const trendAt15m: Array<{ ts: number; ema: number; price: number }> = candles15m.map((c, i) => ({
      ts: c[0], ema: ema200arr[i], price: c[4],
    }));

    function getTrendAtTime(ts: number): "UP" | "DOWN" | "NEUTRAL" {
      let idx = -1;
      for (let i = trendAt15m.length - 1; i >= 0; i--) {
        if (trendAt15m[i].ts <= ts) { idx = i; break; }
      }
      if (idx < 0) return "NEUTRAL";
      const { ema, price } = trendAt15m[idx];
      if (isNaN(ema) || ema === 0) return "NEUTRAL";
      if (price > ema * 1.001) return "UP";
      if (price < ema * 0.999) return "DOWN";
      return "NEUTRAL";
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
    const WINDOW = 50;

    for (let i = WINDOW; i < candles1m.length; i++) {
      const window = candles1m.slice(i - WINDOW, i + 1);
      const signal = calculateSignal(window);
      const currentPrice = candles1m[i][4];

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
            entryTs: position.entryTs, exitTs: candles1m[i][0],
            holdMinutes: Math.round((candles1m[i][0] - position.entryTs) / 60000),
          });
          position = null;
        }
      }

      // ── Open new position ──
      if (!position && signal.action !== "HOLD") {
        const trend   = getTrendAtTime(candles1m[i][0]);
        const volOk   = (signal.volumeRatio ?? 1) >= 1.5;
        const trendOk = (signal.action === "BUY" && trend === "UP") ||
                        (signal.action === "SELL" && trend === "DOWN");
        if (volOk && trendOk) {
          const atrF    = (signal.atr ?? 0) / currentPrice;
          const dynSlPct = Math.min(Math.max(atrF * slMult, 0.001), 0.05);
          const dynTpPct = Math.min(Math.max(atrF * tpMult, 0.01), 0.10);
          position = {
            type: signal.action, entry: currentPrice,
            trailingHigh: currentPrice, trailingLow: currentPrice,
            entryTs: candles1m[i][0], dynSlPct, dynTpPct,
          };
        }
      }
    }

    const wins     = trades.filter(t => t.pnlPct > 0);
    const losses   = trades.filter(t => t.pnlPct <= 0);
    const totalPnl = parseFloat(trades.reduce((s, t) => s + t.pnlPct, 0).toFixed(3));
    const winRate  = trades.length > 0 ? parseFloat((wins.length / trades.length * 100).toFixed(1)) : 0;
    const avgWin   = wins.length  > 0 ? parseFloat((wins.reduce((s,t) => s + t.pnlPct, 0) / wins.length).toFixed(3)) : 0;
    const avgLoss  = losses.length > 0 ? parseFloat((losses.reduce((s,t) => s + t.pnlPct, 0) / losses.length).toFixed(3)) : 0;

    // Max drawdown: max cumulative PnL drop from a peak
    let peak = 0, cumPnl = 0, maxDD = 0;
    for (const t of trades) {
      cumPnl += t.pnlPct;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    res.json({
      symbol, days,
      stats: {
        total: trades.length, wins: wins.length, losses: losses.length,
        winRate, totalPnlPct: totalPnl,
        avgWinPct: avgWin, avgLossPct: avgLoss,
        maxDrawdownPct: parseFloat(maxDD.toFixed(3)),
        candles: candles1m.length,
      },
      trades: trades.slice(-100),  // last 100 trades max
    });
  } catch (err: any) {
    console.error("[BACKTEST] Error:", err?.message);
    res.status(500).json({ error: err?.message });
  }
});

// ── Startup ────────────────────────────────────────────────────────────────────

async function startServer() {
  await pool.query("SELECT 1");
  console.log("Database connected");

  await runMigrations();
  console.log("Migrations applied");

  // Load persisted active strategies before seeding
  const stRow = await pool.query("SELECT active_strategies FROM bot_settings WHERE id = 'bot_config'");
  activeStrategies = new Set(stRow.rows[0]?.active_strategies || ["ULTRA-SCALP", "MOMENTUM-ARB", "MEAN-REV"]);
  console.log(`Active strategies: ${[...activeStrategies].join(", ")}`);

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

  // Fallback reseed every 5 min (catches any gaps if WS misses a candle)
  setInterval(seedCandleBuffer, 5 * 60 * 1000);
  // Mock mode: simulate TP/SL via scan prices. Live mode: Binance handles it natively.
  setInterval(runMockTradeMonitor, 10 * 1000);
  // Sync DB with actual Binance positions every 60s (detects native TP/SL fills)
  setInterval(syncPositionsFromBinance, 60 * 1000);
  setInterval(takePnLSnapshot, 60 * 60 * 1000);
  runMockTradeMonitor();
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
