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
  id           VARCHAR(50) PRIMARY KEY DEFAULT 'bot_config',
  is_auto_pilot BOOLEAN    DEFAULT false,
  risk_level   NUMERIC(5, 2) DEFAULT 1,
  max_slippage NUMERIC(5, 2) DEFAULT 0.5,
  symbols      TEXT[]      DEFAULT '{BTC/USDT,ETH/USDT,SOL/USDT,DOGE/USDT,BNB/USDT}'
);

-- Default settings row
INSERT INTO bot_settings (id) VALUES ('bot_config') ON CONFLICT (id) DO NOTHING;

-- Seed trade history
INSERT INTO trades (symbol, type, entry_price, exit_price, pnl, amount, strategy, status) VALUES
  ('BTC/USDT', 'BUY',  64102.5, 64150.2, 47.7,  0.01, 'ULTRA-SCALP v2.1', 'CLOSED'),
  ('ETH/USDT', 'SELL', 3452.1,  3448.5,  -3.6,  0.1,  'ULTRA-SCALP v2.1', 'CLOSED'),
  ('SOL/USDT', 'BUY',  141.2,   142.08,  0.88,  1,    'MOMENTUM ARB',     'CLOSED'),
  ('BTC/USDT', 'BUY',  64081.2, 64112.5, 31.3,  0.01, 'ULTRA-SCALP v2.1', 'CLOSED'),
  ('SOL/USDT', 'BUY',  140.5,   141.1,   0.6,   1,    'VOLATILITY CORE',  'CLOSED');

-- Seed PnL snapshots (last 8 hours)
INSERT INTO pnl_snapshots (timestamp, total_value, pnl_percent) VALUES
  (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 hours') * 1000, 10000, 0.00),
  (EXTRACT(EPOCH FROM NOW() - INTERVAL '6 hours') * 1000, 10012, 0.12),
  (EXTRACT(EPOCH FROM NOW() - INTERVAL '5 hours') * 1000, 10008, 0.08),
  (EXTRACT(EPOCH FROM NOW() - INTERVAL '4 hours') * 1000, 10025, 0.25),
  (EXTRACT(EPOCH FROM NOW() - INTERVAL '3 hours') * 1000, 10042, 0.42),
  (EXTRACT(EPOCH FROM NOW() - INTERVAL '2 hours') * 1000, 10038, 0.38),
  (EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour')  * 1000, 10055, 0.55),
  (EXTRACT(EPOCH FROM NOW())                       * 1000, 10068, 0.68);
