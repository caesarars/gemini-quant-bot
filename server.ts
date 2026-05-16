import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import ccxt from "ccxt";
import * as dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME || "quantbot",
  user: process.env.DB_USER || "quantbot",
  password: process.env.DB_PASSWORD || "",
});

// Initialize AI and Exchange
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

const binance = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
});

// Cache for scanner data
let scanResults: any[] = [];
let isScanning = false;

// Scalping Strategy logic helper
function calculateSignal(ohlcv: any[]) {
  if (!ohlcv || ohlcv.length < 20) return { action: "HOLD", rsi: 50, price: 0 };

  const closes = ohlcv.map((c) => c[4]);
  const lastClose = closes[closes.length - 1];

  let ups = 0;
  let downs = 0;
  for (let i = ohlcv.length - 14; i < ohlcv.length; i++) {
    const diff = closes[i] - (closes[i - 1] || closes[i]);
    if (diff > 0) ups += diff;
    else downs -= diff;
  }
  const rsi = 100 - 100 / (1 + ups / (downs || 1));

  if (rsi < 30) return { action: "BUY", rsi, price: lastClose };
  if (rsi > 70) return { action: "SELL", rsi, price: lastClose };

  return { action: "HOLD", rsi, price: lastClose };
}

// API Routes
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.get("/api/scan", (req, res) => {
  console.log("HIT /api/scan - returning", scanResults.length, "results");
  res.json({ results: scanResults, timestamp: Date.now() });
});

app.get("/api/pnl-history", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT TO_CHAR(TO_TIMESTAMP(timestamp / 1000.0), 'HH24:MI') AS time,
              total_value AS value
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
              entry_price AS entry,
              exit_price  AS exit,
              pnl,
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

// Write a new trade execution to the DB
app.post("/api/execute", async (req, res) => {
  const { symbol, type, entryPrice, amount, strategy } = req.body;
  if (!symbol || !type || !entryPrice) {
    return res.status(400).json({ error: "symbol, type, entryPrice are required" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO trades (symbol, type, entry_price, amount, strategy, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN')
       RETURNING *`,
      [symbol, type, entryPrice, amount || 0, strategy || "MANUAL"]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Execute trade DB error:", err);
    res.status(500).json({ error: "Failed to record trade" });
  }
});

app.post("/api/ai-confirm", async (req, res) => {
  console.log("HIT /api/ai-confirm");
  const { symbol, data } = req.body;
  try {
    const prompt = `Analyze this crypto market data for ${symbol}: ${JSON.stringify(data)}.
    Give a short technical verdict: BUY, SELL, or WAIT. Include a confidence score (0-100) and 1 reason.
    Format: VERDICT|CONFIDENCE|REASON`;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });

    const responseText = response.text || "WAIT|0|Unknown error";
    const [verdict, confidence, reason] = responseText.split("|");

    res.json({
      verdict: verdict?.trim() || "WAIT",
      confidence: parseInt(confidence) || 0,
      reason: reason?.trim() || "No detailed reason provided",
    });
  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: "AI Confirmation Failed" });
  }
});

app.get("/api/balance", async (req, res) => {
  try {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
      return res.json({
        total: { USDT: 10000, BTC: 0.1, ETH: 1.5, SOL: 20 },
        status: "mock",
        message: "Using simulated balance (API keys missing)",
      });
    }
    const balance = await binance.fetchBalance();
    res.json({ total: balance.total, status: "live" });
  } catch (err: any) {
    console.error("Balance Error:", err);
    res.status(200).json({
      status: "error",
      error: err.message || "Invalid API keys or network error",
      total: {},
    });
  }
});

app.get("/api/check-api", async (req, res) => {
  const hasKey = !!process.env.BINANCE_API_KEY;
  const hasSecret = !!process.env.BINANCE_SECRET_KEY;

  if (!hasKey || !hasSecret) {
    return res.json({ connected: false, reason: "Keys not found in environment" });
  }

  try {
    await binance.fetchBalance();
    res.json({ connected: true });
  } catch (e: any) {
    res.json({ connected: false, reason: e.message });
  }
});

// Save an hourly PnL snapshot to the DB
const takePnLSnapshot = async () => {
  try {
    let totalValue = 10000;
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY) {
      const balance = await binance.fetchBalance();
      totalValue = balance.total["USDT"] || totalValue;
    }

    const first = await pool.query("SELECT total_value FROM pnl_snapshots ORDER BY timestamp ASC LIMIT 1");
    const startValue = first.rows.length ? parseFloat(first.rows[0].total_value) : totalValue;
    const pnlPercent = startValue > 0 ? ((totalValue - startValue) / startValue) * 100 : 0;

    await pool.query(
      "INSERT INTO pnl_snapshots (timestamp, total_value, pnl_percent) VALUES ($1, $2, $3)",
      [Date.now(), totalValue, pnlPercent.toFixed(4)]
    );
  } catch (err) {
    console.error("PnL snapshot error:", err);
  }
};

// Background Scanner
const runScanner = async () => {
  if (isScanning) return;
  isScanning = true;

  try {
    const symbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "DOGE/USDT", "BNB/USDT"];
    const newResults = [];

    for (const symbol of symbols) {
      try {
        const ohlcv = await binance.fetchOHLCV(symbol, "1m", undefined, 30);
        const signal = calculateSignal(ohlcv);
        newResults.push({ symbol, ...signal });
      } catch (e) {
        // silently skip failed symbols
      }
    }

    scanResults = newResults;
  } catch (err) {
    console.error("Scanner critical error:", err);
  } finally {
    isScanning = false;
  }
};

setInterval(runScanner, 30000);
setInterval(takePnLSnapshot, 60 * 60 * 1000); // hourly PnL snapshot

async function startServer() {
  // Verify DB connection on startup
  try {
    await pool.query("SELECT 1");
    console.log("Database connected");
  } catch (err) {
    console.error("Database connection failed:", err);
    process.exit(1);
  }

  runScanner();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
