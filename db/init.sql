-- Gemini Quant Bot — PostgreSQL Schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS trades (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      VARCHAR(20) NOT NULL,
  type        VARCHAR(4)  NOT NULL CHECK (type IN ('BUY', 'SELL')),
  entry_price NUMERIC(20, 8) NOT NULL,
  exit_price  NUMERIC(20, 8),
  pnl         NUMERIC(20, 8),
  amount      NUMERIC(20, 8),
  strategy    VARCHAR(100),
  leverage    INTEGER     DEFAULT 1,
  timestamp   TIMESTAMPTZ DEFAULT NOW(),
  status      VARCHAR(10) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'))
);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id          SERIAL  PRIMARY KEY,
  timestamp   BIGINT  NOT NULL,
  total_value NUMERIC(20, 8) NOT NULL,
  pnl_percent NUMERIC(10, 4) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_settings (
  id                  VARCHAR(50) PRIMARY KEY DEFAULT 'bot_config',
  is_auto_pilot       BOOLEAN       DEFAULT false,
  risk_level          NUMERIC(5, 2) DEFAULT 1,
  max_slippage        NUMERIC(5, 2) DEFAULT 0.5,
  leverage            INTEGER       DEFAULT 10,
  take_profit_pct     NUMERIC(5, 2) DEFAULT 1.5,
  stop_loss_pct       NUMERIC(5, 2) DEFAULT 0.8,
  symbols             TEXT[]        DEFAULT '{BTC/USDT,ETH/USDT,SOL/USDT,XRP/USDT,BNB/USDT,AVAX/USDT,ARB/USDT,OP/USDT}',
  telegram_bot_token  VARCHAR(255)  DEFAULT NULL,
  telegram_chat_id    VARCHAR(50)   DEFAULT NULL
);

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
);

CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_ts ON ohlcv (symbol, timeframe, timestamp DESC);

CREATE TABLE IF NOT EXISTS signals (
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
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol_sent ON signals (symbol, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals (status);

-- Default settings row
INSERT INTO bot_settings (id) VALUES ('bot_config') ON CONFLICT (id) DO NOTHING;

-- Seed signal history (sample)
INSERT INTO signals (symbol, side, strategy, timeframe, entry_price, tp_price, sl_price, confidence, est_duration, status, telegram_sent, sent_at) VALUES
  ('BTC/USDT', 'LONG',  'MOMENTUM-ARB', '5m',  64102.50, 64600.00, 63800.00, 4.2, '30–60 min',   'HIT_TP', true, NOW() - INTERVAL '2 hours'),
  ('ETH/USDT', 'SHORT', 'MEAN-REV',     '15m', 3452.10,  3400.00,  3480.00,  3.8, '1–4 hours',   'EXPIRED', true, NOW() - INTERVAL '5 hours'),
  ('SOL/USDT', 'LONG',  'SWING-LONG',   '4h',  141.20,   150.00,   135.00,   4.5, '1–3 days',    'ACTIVE', true, NOW() - INTERVAL '1 hour');
