import { useState, useEffect } from "react";
import {
  TrendingUp,
  TrendingDown,
  Activity,
  ShieldCheck,
  Shield,
  Send,
  Bell,
  Bot,
  Settings,
  History,
  Zap,
  Info,
  AlertTriangle,
  LineChart as LineChartIcon,
  X,
  BarChart2
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';

interface StrategySignal {
  action: 'BUY' | 'SELL' | 'HOLD';
  rsi: number;
  volumeRatio?: number;
  atrPct?: number;
  cross?: string | null;
  bbPos?: string | null;
  score?: number;
  buyScore?: number;
  sellScore?: number;
  stochK?: number;
  stochD?: number;
  supertrend?: 1 | -1;
  williamsR?: number;
}

interface ScanResult {
  symbol: string;
  price: number;
  trend?: 'UP' | 'DOWN' | 'NEUTRAL';
  regime?: 'TRENDING' | 'RANGING' | 'NEUTRAL';
  adx?: number;
  plusDI?: number;
  minusDI?: number;
  vwap?: number;
  oiChangePct?: number | null;
  lsRatio?: number | null;
  lastTickMs?: number;
  ultraScalp?: StrategySignal;
  momentumArb?: StrategySignal;
  meanRev?: StrategySignal;
}

interface AIResult {
  verdict: string;
  confidence: number;
  reason: string;
}

interface OpenPosition {
  id: string;
  symbol: string;
  type: string;
  side: 'LONG' | 'SHORT';
  entry_price: number;
  current_price: number;
  amount: number;
  leverage: number;
  pnl_usdt: number;
  net_pnl_usdt: number;
  pnl_pct: number;
  fee_usdt: number;
  opened_at: string;
}

function getBlockReason(
  action: 'BUY' | 'SELL' | 'HOLD',
  trend: 'UP' | 'DOWN' | 'NEUTRAL' | undefined,
  volumeRatio: number | undefined,
  volThreshold: number,
  isAutoPilot: boolean,
  skipTrend = false,
  fundingRate?: number,
  fearGreed?: number | null,
  strategyId?: string,
  oiChangePct?: number | null,
  lsRatio?: number | null,
  cdInfo?: { inCooldown: boolean; status?: string } | undefined,
  regime?: 'TRENDING' | 'RANGING' | 'NEUTRAL' | undefined,
  adx?: number | null
): { label: string; color: string } {
  if (!isAutoPilot) return { label: 'Auto-pilot OFF', color: 'text-trading-muted' };
  if (cdInfo?.status === 'OPEN') return { label: 'Position open', color: 'text-orange-400' };
  if (cdInfo?.inCooldown) return { label: 'Cooldown active', color: 'text-orange-400' };
  if (strategyId === 'MEAN-REV' && regime === 'TRENDING') return { label: `Blocked: TREND regime (ADX ${adx?.toFixed(0) ?? '?'})`, color: 'text-orange-400' };
  if (strategyId === 'MOMENTUM-ARB' && regime === 'RANGING') return { label: `Blocked: RANGE regime (ADX ${adx?.toFixed(0) ?? '?'})`, color: 'text-orange-400' };
  if (action === 'HOLD') return { label: 'No signal', color: 'text-trading-muted' };
  if (!skipTrend) {
    if (trend === 'NEUTRAL') return { label: 'Trend neutral', color: 'text-orange-400' };
    if (action === 'BUY'  && trend === 'DOWN') return { label: 'BUY blocked — trend ↓', color: 'text-trading-down' };
    if (action === 'SELL' && trend === 'UP')   return { label: 'SELL blocked — trend ↑', color: 'text-trading-down' };
  }
  if ((volumeRatio ?? 1) < volThreshold) return { label: `Vol ${volumeRatio?.toFixed(1)}× < ${volThreshold}×`, color: 'text-orange-400' };
  if (fundingRate !== undefined) {
    if (action === 'BUY'  && fundingRate >  0.0005) return { label: `Funding +${(fundingRate*100).toFixed(3)}% — overbought`, color: 'text-trading-down' };
    if (action === 'SELL' && fundingRate < -0.0003) return { label: `Funding ${(fundingRate*100).toFixed(3)}% — oversold`,    color: 'text-trading-down' };
  }
  if (fearGreed != null) {
    if (strategyId === 'MEAN-REV') {
      if (action === 'BUY'  && fearGreed > 75) return { label: `F&G ${fearGreed} Extreme Greed — BUY blocked`,  color: 'text-trading-down' };
      if (action === 'SELL' && fearGreed < 25) return { label: `F&G ${fearGreed} Extreme Fear — SELL blocked`, color: 'text-trading-down' };
    }
    if (action === 'BUY'  && fearGreed > 85) return { label: `F&G ${fearGreed} — too greedy`, color: 'text-orange-400' };
    if (action === 'SELL' && fearGreed < 15) return { label: `F&G ${fearGreed} — too fearful`, color: 'text-orange-400' };
  }
  if (oiChangePct != null) {
    if (strategyId === 'MOMENTUM-ARB' && action === 'BUY'  && oiChangePct < -2.0)
      return { label: `OI ${oiChangePct.toFixed(1)}% — short covering`, color: 'text-trading-down' };
    if (strategyId === 'MEAN-REV'     && action === 'SELL' && oiChangePct < -2.0)
      return { label: `OI ${oiChangePct.toFixed(1)}% — liq exhaustion near`, color: 'text-trading-down' };
  }
  if (lsRatio != null) {
    if (action === 'BUY'  && lsRatio > 2.5) return { label: `L/S ${lsRatio.toFixed(2)} — market over-long`,  color: 'text-trading-down' };
    if (action === 'SELL' && lsRatio < 0.4) return { label: `L/S ${lsRatio.toFixed(2)} — market over-short`, color: 'text-trading-down' };
  }
  return { label: 'All clear — monitoring', color: 'text-trading-up' };
}

export default function App() {
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [balance, setBalance] = useState<Record<string, number>>({});
  const [pnlData, setPnlData] = useState<any[]>([]);
  const [tradeHistory, setTradeHistory] = useState<any[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isPositionsOpen, setIsPositionsOpen] = useState(false);
  const [openPositions, setOpenPositions] = useState<OpenPosition[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [isSyncing, setIsSyncing]       = useState(false);
  const [closingId, setClosingId]       = useState<string | null>(null);
  const [closingAll, setClosingAll]     = useState(false);
  const [logs, setLogs] = useState<{ id: string; msg: string; time: string; type: string }[]>([]);
  const [isAutoPilot, setIsAutoPilot]             = useState(false);
  const [activeStrategies, setActiveStrategies]   = useState<string[]>(["ULTRA-SCALP", "MOMENTUM-ARB"]);
  const [riskLevel, setRiskLevel]                 = useState<number>(1);
  const [isSettingsOpen, setIsSettingsOpen]       = useState(false);
  const [settingsLoading, setSettingsLoading]     = useState(false);
  const [telegramTestLoading, setTelegramTestLoading] = useState(false);
  const [telegramBotToken, setTelegramBotToken]   = useState("");
  const [telegramChatId, setTelegramChatId]       = useState("");
  const [botSettings, setBotSettings] = useState({
    leverage: 10,
    maxSlippage: 0.5,
    takeProfitPct: 1.5,
    stopLossPct: 0.8,
    atrSlMult: 1.5,
    atrTpMult: 4.0,
    arbSlMult: 1.0,
    arbTpMult: 3.0,
    mrSlMult: 1.0,
    mrTpMult: 2.0,
  });
  const [maxConcurrentPositions, setMaxConcurrentPositions] = useState<number>(3);
  const [useKellySizing, setUseKellySizing]               = useState<boolean>(true);
  const [partialTpEnabled, setPartialTpEnabled]           = useState<boolean>(true);
  const [cooldownStatus, setCooldownStatus]       = useState<Record<string, { inCooldown: boolean; strategy: string; status?: string }>>({});
  const [validationLogs, setValidationLogs] = useState<any[]>([]);
  const [loadingAi, setLoadingAi] = useState<string | null>(null);
  const [marketContext, setMarketContext] = useState<{
    fearGreed: { value: number; classification: string } | null;
    fundingRates: Record<string, number>;
    openInterest: Record<string, { oiChangePct: number }>;
    longShortRatios: Record<string, number>;
  }>({ fearGreed: null, fundingRates: {}, openInterest: {}, longShortRatios: {} });
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [isBacktestOpen, setIsBacktestOpen]   = useState(false);
  const [btSymbol, setBtSymbol]               = useState("BTC/USDT");
  const [btDays, setBtDays]                   = useState(7);
  const [btStrategy, setBtStrategy]           = useState("ULTRA-SCALP");
  const [btLoading, setBtLoading]             = useState(false);
  const [btResult, setBtResult]               = useState<any>(null);
  // Increments every second so scan-age badges re-render without full data refresh
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const runBacktest = async () => {
    setBtLoading(true);
    setBtResult(null);
    try {
      const r = await fetch(`/api/backtest?symbol=${encodeURIComponent(btSymbol)}&days=${btDays}&strategy=${encodeURIComponent(btStrategy)}`);
      const d = await r.json();
      setBtResult(d);
    } catch { setBtResult({ error: "Request failed" }); }
    setBtLoading(false);
  };

  const addLog = (msg: string, type: string = "info") => {
    const log = {
      id: Math.random().toString(36).substr(2, 9),
      msg,
      time: new Date().toLocaleTimeString(),
      type
    };
    setLogs(prev => [log, ...prev].slice(0, 50));
  };

  const [apiStatus, setApiStatus] = useState<string>("connecting");

  // Load persisted settings on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        if (typeof s.is_auto_pilot === "boolean") setIsAutoPilot(s.is_auto_pilot);
        if (Array.isArray(s.active_strategies)) setActiveStrategies(s.active_strategies);
        if (typeof s.risk_level === "number") setRiskLevel(s.risk_level);
        setBotSettings(prev => ({
          leverage:        s.leverage ?? prev.leverage,
          maxSlippage:     s.max_slippage ?? prev.maxSlippage,
          takeProfitPct:   s.take_profit_pct ?? prev.takeProfitPct,
          stopLossPct:     s.stop_loss_pct ?? prev.stopLossPct,
          atrSlMult:       s.atr_sl_mult ?? prev.atrSlMult,
          atrTpMult:       s.atr_tp_mult ?? prev.atrTpMult,
          arbSlMult:       s.arb_sl_mult ?? prev.arbSlMult,
          arbTpMult:       s.arb_tp_mult ?? prev.arbTpMult,
          mrSlMult:        s.mr_sl_mult ?? prev.mrSlMult,
          mrTpMult:        s.mr_tp_mult ?? prev.mrTpMult,
        }));
        if (typeof s.telegram_bot_token === "string") setTelegramBotToken(s.telegram_bot_token);
        if (typeof s.telegram_chat_id   === "string") setTelegramChatId(s.telegram_chat_id);
        if (typeof s.max_concurrent_positions === "number") setMaxConcurrentPositions(s.max_concurrent_positions);
        if (typeof s.use_kelly_sizing === "boolean") setUseKellySizing(s.use_kelly_sizing);
        if (typeof s.partial_tp_enabled === "boolean") setPartialTpEnabled(s.partial_tp_enabled);
      })
      .catch(() => {});
  }, []);

  const toggleStrategy = async (id: string) => {
    const next = activeStrategies.includes(id)
      ? activeStrategies.filter(s => s !== id)
      : [...activeStrategies, id];
    if (next.length === 0) return; // prevent disabling all
    setActiveStrategies(next);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeStrategiesVal: next }),
    });
    addLog(`Active: ${next.join(", ")}`, "info");
  };

  const refreshPositions = async () => {
    const r = await fetch("/api/open-positions");
    const d = await r.json();
    setOpenPositions(d.positions ?? []);
    if (d.last_sync) setLastSync(d.last_sync);
  };

  const closePosition = async (id: string) => {
    setClosingId(id);
    try {
      const r = await fetch(`/api/close-position/${id}`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) { addLog(`Close failed: ${d.error}`, "error"); return; }
      addLog(`Closed ${d.symbol} @ ${d.exitPrice} PnL: ${d.pnlUsdt >= 0 ? "+" : ""}${d.pnlUsdt.toFixed(2)} USDT`, d.pnlUsdt >= 0 ? "success" : "error");
      await refreshPositions();
    } finally {
      setClosingId(null);
    }
  };

  const closeAllPositions = async () => {
    if (!confirm(`Close semua ${openPositions.length} posisi sekarang?`)) return;
    setClosingAll(true);
    try {
      const r = await fetch("/api/close-all-positions", { method: "POST" });
      const d = await r.json();
      if (!r.ok) { addLog(`Close all failed: ${d.error}`, "error"); return; }
      addLog(`Closed ${d.closed} positions`, "success");
      await refreshPositions();
    } finally {
      setClosingAll(false);
    }
  };

  // ── Initial data fetch (REST) + SSE for real-time updates ──
  useEffect(() => {
    // 1. Fetch static/less-frequent data once on mount
    const fetchStaticData = async () => {
      try {
        const [checkRes, balRes, pnlRes, historyRes, posRes] = await Promise.all([
          fetch("/api/check-api"),
          fetch("/api/balance"),
          fetch("/api/pnl-history"),
          fetch("/api/trade-history"),
          fetch("/api/open-positions"),
        ]);

        if (checkRes.ok) {
          const checkData = await checkRes.json();
          setApiStatus(checkData.connected ? (checkData.mode || 'live') : 'mock');
          if (!checkData.connected && checkData.reason && checkData.reason !== 'Keys not found') {
            addLog(`API ERROR: ${checkData.reason}`, 'error');
          }
        }
        if (balRes.ok) {
          const balData = await balRes.json();
          setBalance(balData.total);
          if (balData.fallback === 'mock') setApiStatus('mock');
        }
        if (pnlRes.ok) setPnlData(await pnlRes.json());
        if (historyRes.ok) setTradeHistory(await historyRes.json());
        if (posRes.ok) {
          const posData = await posRes.json();
          setOpenPositions(posData.positions ?? []);
          if (posData.last_sync) setLastSync(posData.last_sync);
        }
      } catch (err) {
        console.error("[INIT] Failed to fetch static data", err);
      }
    };

    fetchStaticData();

    // 2. SSE for real-time scanner + market context + cooldown
    let es: EventSource | null = null;
    let reconnectAttempts = 0;
    const maxReconnects = 5;

    const connectSSE = () => {
      es = new EventSource("/api/events");

      es.onopen = () => {
        reconnectAttempts = 0;
        console.log("[SSE] Connected");
      };

      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.scanResults) setScanResults(msg.scanResults);
          if (msg.marketContext) setMarketContext(msg.marketContext);
          if (msg.cooldownStatus) setCooldownStatus(msg.cooldownStatus);
        } catch (err) {
          console.error("[SSE] Parse error:", err);
        }
      };

      // Named events
      es.addEventListener("snapshot", (ev: any) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.scanResults) setScanResults(data.scanResults);
          if (data.marketContext) setMarketContext(data.marketContext);
          if (data.cooldownStatus) setCooldownStatus(data.cooldownStatus);
          if (data.validationLogs) setValidationLogs(data.validationLogs);
        } catch (err) {
          console.error("[SSE] snapshot error:", err);
        }
      });

      es.addEventListener("trade", (ev: any) => {
        try {
          const data = JSON.parse(ev.data);
          addLog(`Trade: ${data.action} ${data.symbol} @ $${data.price.toLocaleString()} [${data.strategy}]`, 'success');
          // Re-fetch positions & trade history after a trade
          fetch("/api/open-positions").then(r => r.json()).then(d => {
            setOpenPositions(d.positions ?? []);
            if (d.last_sync) setLastSync(d.last_sync);
          }).catch(() => {});
          fetch("/api/trade-history").then(r => r.json()).then(setTradeHistory).catch(() => {});
          fetch("/api/balance").then(r => r.json()).then(d => setBalance(d.total)).catch(() => {});
        } catch (err) {
          console.error("[SSE] trade event error:", err);
        }
      });

      es.addEventListener("validation", (ev: any) => {
        try {
          const data = JSON.parse(ev.data);
          setValidationLogs(prev => [data, ...prev].slice(0, 40));
        } catch (err) {
          console.error("[SSE] validation event error:", err);
        }
      });

      es.addEventListener("sync", (ev: any) => {
        try {
          const data = JSON.parse(ev.data);
          addLog(`Positions synced at ${new Date(data.timestamp).toLocaleTimeString()}`, 'info');
          fetch("/api/open-positions").then(r => r.json()).then(d => {
            setOpenPositions(d.positions ?? []);
            if (d.last_sync) setLastSync(d.last_sync);
          }).catch(() => {});
        } catch (err) {
          console.error("[SSE] sync event error:", err);
        }
      });

      es.onerror = () => {
        console.error(`[SSE] Connection error (attempt ${reconnectAttempts + 1}/${maxReconnects})`);
        es?.close();
        if (reconnectAttempts < maxReconnects) {
          reconnectAttempts++;
          setTimeout(connectSSE, 3000);
        } else {
          addLog("SSE failed — falling back to polling mode", 'error');
          // Fallback: start polling every 10s
          const fallbackInterval = setInterval(fetchStaticData, 10000);
          // Store interval on window for cleanup (hacky but works)
          (window as any).__fallbackInterval = fallbackInterval;
        }
      };
    };

    connectSSE();

    // 3. Light backup fetch every 30s for balance & PnL (in case SSE misses something)
    const backupInterval = setInterval(() => {
      fetch("/api/balance").then(r => r.json()).then(d => setBalance(d.total)).catch(() => {});
      fetch("/api/pnl-history").then(r => r.json()).then(setPnlData).catch(() => {});
    }, 30000);

    return () => {
      es?.close();
      clearInterval(backupInterval);
      if ((window as any).__fallbackInterval) clearInterval((window as any).__fallbackInterval);
    };
  }, []);

  const getAiConfirmation = async (symbol: string, data: any) => {
    setLoadingAi(symbol);
    addLog(`AI analyzing ${symbol}...`, "ai");
    try {
      const res = await fetch("/api/ai-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, data })
      });
      const result = await res.json();
      addLog(`AI ${symbol}: ${result.verdict} ${result.confidence}% — ${result.reason}`, "ai");
    } catch {
      addLog(`AI analysis failed for ${symbol}`, "error");
    } finally {
      setLoadingAi(null);
    }
  };


  return (
    <div className="min-h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-[60px] px-6 flex items-center justify-between border-b border-trading-border bg-trading-bg/80 backdrop-blur-md z-50">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-trading-accent rounded flex items-center justify-center font-bold text-trading-bg text-xl">
            Σ
          </div>
          <div className="text-lg font-black tracking-tighter">
            NEXUS<span className="text-trading-accent">BOT</span>.v4
          </div>
          <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-trading-up/10 text-trading-up rounded-full border border-trading-up/30 text-[10px] uppercase font-bold tracking-wider">
            Live Trading: Enabled
          </div>
        </div>
        
        <div className="hidden lg:flex items-center gap-8 text-[11px] font-medium">
          <div className="text-trading-muted uppercase tracking-wider">
            BINANCE API: <span className={cn(
              "font-bold",
              apiStatus === 'live' ? "text-trading-up" : "text-orange-400"
            )}>
              {apiStatus === 'live' ? "CONNECTED" : apiStatus === 'mock' ? "SIMULATED" : "ERROR"}
            </span>
          </div>
          <div className="text-trading-muted">LATENCY: <span className="text-trading-up">14ms</span></div>
          <div className="text-trading-muted">BAL: <span className="text-trading-text">{balance['USDT']?.toLocaleString() || '0.00'} USDT</span></div>
          <button
            onClick={() => setIsPositionsOpen(true)}
            className="relative flex items-center gap-2 p-2 px-3 bg-trading-card border border-trading-border rounded hover:border-trading-muted transition-colors"
          >
            <BarChart2 className="w-4 h-4 text-trading-up" />
            <span className="text-[10px] font-bold uppercase tracking-widest">Positions</span>
            {openPositions.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-trading-up text-trading-bg text-[9px] font-black rounded-full flex items-center justify-center">
                {openPositions.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setIsHistoryOpen(true)}
            className="flex items-center gap-2 p-2 px-3 bg-trading-card border border-trading-border rounded hover:border-trading-muted transition-colors"
          >
            <History className="w-4 h-4 text-trading-accent" />
            <span className="text-[10px] font-bold uppercase tracking-widest">History</span>
          </button>
          <button
            onClick={() => setIsBacktestOpen(true)}
            className="flex items-center gap-2 p-2 px-3 bg-trading-card border border-trading-border rounded hover:border-trading-muted transition-colors"
          >
            <LineChartIcon className="w-4 h-4 text-trading-accent" />
            <span className="text-[10px] font-bold uppercase tracking-widest">Backtest</span>
          </button>
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="flex items-center gap-2 p-2 px-3 bg-trading-card border border-trading-border rounded hover:border-trading-muted transition-colors"
          >
            <Settings className="w-4 h-4 text-trading-accent" />
            <span className="text-[10px] font-bold uppercase tracking-widest">Settings</span>
          </button>
        </div>
      </header>

      {/* Main Layout */}
      <main className="flex-1 flex flex-col gap-[1px] bg-trading-border overflow-hidden">

        {/* ── Hero: Performance (USDT) Chart ── */}
        <section className="bg-trading-panel p-5 flex-none h-[280px] flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px]">
                <TrendingUp className="w-3.5 h-3.5" />
                Performance (USDT)
              </div>
              {(() => {
                const last = pnlData[pnlData.length - 1]?.value ?? 0;
                const first = pnlData[0]?.value ?? 0;
                const totalRet = first !== 0 ? ((last - first) / Math.abs(first) * 100) : 0;
                let maxDD = 0, peak = first;
                for (const d of pnlData) {
                  if (d.value > peak) peak = d.value;
                  const dd = (peak - d.value) / Math.abs(peak) * 100;
                  if (dd > maxDD) maxDD = dd;
                }
                const stats = [
                  { label: 'Equity', val: `$${last.toFixed(2)}`, color: last >= first ? 'text-trading-up' : 'text-trading-down' },
                  { label: 'Total Return', val: `${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(2)}%`, color: totalRet >= 0 ? 'text-trading-up' : 'text-trading-down' },
                  { label: 'Max Drawdown', val: `-${maxDD.toFixed(2)}%`, color: 'text-trading-down' },
                  { label: 'Data Points', val: `${pnlData.length}`, color: 'text-trading-text' },
                ];
                return (
                  <div className="flex items-center gap-2">
                    {stats.map(s => (
                      <div key={s.label} className="px-2.5 py-1 bg-trading-card border border-trading-border rounded flex items-center gap-1.5">
                        <span className="text-[9px] text-trading-muted uppercase">{s.label}</span>
                        <span className={cn("text-[11px] font-black font-mono", s.color)}>{s.val}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
            <button
              onClick={async () => {
                if (!confirm("Reset semua PnL history? Data paper trading akan dihapus.")) return;
                await fetch("/api/pnl-history", { method: "DELETE" });
                setPnlData([]);
              }}
              className="text-[9px] px-2 py-1 bg-trading-down/10 text-trading-down border border-trading-down/30 rounded hover:bg-trading-down/20 transition-colors font-bold uppercase tracking-wider"
            >
              Reset
            </button>
          </div>
          <div className="flex-1 min-h-0 bg-trading-card/30 border border-trading-border rounded p-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={pnlData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D23" vertical={false} />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['dataMin - 10', 'dataMax + 10']} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111318', border: '1px solid #1A1D23', fontSize: '10px' }}
                  labelStyle={{ color: '#666' }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#00D1FF"
                  strokeWidth={2}
                  dot={{ fill: '#00D1FF', r: 2 }}
                  activeDot={{ r: 4, stroke: '#00FFA3' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Bottom Grid: Strategies | Scanner | Activity */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[220px_1fr_280px] gap-[1px] bg-trading-border overflow-hidden">

          {/* Left Column: Validation Log + Strategies */}
          <aside className="bg-trading-bg p-4 flex flex-col overflow-y-auto">
            {/* ── Validation Log Widget ── */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-[10px] uppercase text-trading-muted tracking-[2px]">
                <ShieldCheck className="w-3 h-3" />
                <span>Validation Log</span>
                {validationLogs.length > 0 && (
                  <span className="px-1.5 py-0.5 bg-trading-card rounded text-[8px] font-black text-trading-muted">
                    {validationLogs.length}
                  </span>
                )}
              </div>
              <button
                onClick={() => setValidationLogs([])}
                className="text-[9px] text-trading-muted hover:text-trading-down transition-colors uppercase font-bold tracking-widest"
              >
                Clear
              </button>
            </div>

            <div className="flex-1 min-h-[180px] max-h-[260px] overflow-y-auto mb-4 space-y-2 pr-0.5">
              {validationLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full opacity-20 py-6">
                  <ShieldCheck className="w-5 h-5 mb-1.5" />
                  <div className="text-[9px] uppercase tracking-widest text-center leading-relaxed">
                    No validations yet<br/>Bot is scanning
                  </div>
                </div>
              ) : (
                validationLogs.map((v) => {
                  const blocked = v.finalStatus === "blocked";
                  const skipped = v.finalStatus === "skipped";
                  const time = new Date(v.timestamp).toLocaleTimeString();
                  const firstBlock = v.checks.find((c: any) => c.status === "block");
                  return (
                    <div key={v.id} className={cn(
                      "p-2 rounded border text-[10px] leading-tight",
                      blocked ? "bg-trading-down/5 border-trading-down/20" :
                      skipped ? "bg-trading-muted/5 border-trading-border/40" :
                                "bg-trading-up/5 border-trading-up/20"
                    )}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className={cn("w-1.5 h-1.5 rounded-full",
                            blocked ? "bg-trading-down" : skipped ? "bg-trading-muted" : "bg-trading-up"
                          )} />
                          <span className="font-bold text-white">{v.symbol.replace('/USDT','')}</span>
                          <span className={cn("font-black uppercase",
                            v.action === 'BUY' ? "text-trading-up" : "text-trading-down"
                          )}>{v.action}</span>
                          <span className="text-trading-muted">{v.strategy?.replace('MOMENTUM-ARB','MOM').replace('ULTRA-SCALP','SCALP').replace('MEAN-REV','MR')}</span>
                        </div>
                        <span className="text-[8px] text-trading-muted font-mono">{time}</span>
                      </div>
                      <div className="text-trading-muted mb-1">
                        {blocked && firstBlock ? (
                          <span className="text-trading-down">↳ Blocked at <span className="font-bold">{firstBlock.name}</span>: {firstBlock.detail}</span>
                        ) : skipped ? (
                          <span className="text-trading-muted">↳ Skipped — {v.checks[v.checks.length - 1]?.detail || "Auto-pilot OFF or HOLD"}</span>
                        ) : (
                          <span className="text-trading-up">↳ Executed — {v.checks.filter((c: any) => c.status === "pass").length}/{v.checks.length} checks passed</span>
                        )}
                      </div>
                      {/* Mini check list */}
                      <div className="flex flex-wrap gap-1">
                        {v.checks.slice(0, 6).map((c: any, i: number) => (
                          <span key={i} className={cn("px-1 py-0.5 rounded text-[8px] font-bold uppercase",
                            c.status === "pass" ? "bg-trading-up/10 text-trading-up" :
                            c.status === "block" ? "bg-trading-down/10 text-trading-down" :
                            "bg-trading-accent/10 text-trading-accent"
                          )} title={c.detail}>
                            {c.name}
                          </span>
                        ))}
                        {v.checks.length > 6 && (
                          <span className="px-1 py-0.5 rounded text-[8px] text-trading-muted">+{v.checks.length - 6}</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px] mb-3 after:content-[''] after:flex-1 after:h-[1px] after:bg-trading-border after:ml-3">
              Strategies
            </div>
            <div className="space-y-2">
              {([
                { id: 'ULTRA-SCALP',     name: 'ULTRA-SCALP v2.1', desc: '1m · RSI+MACD+BB+EMA · Vol 1.5×',             available: true },
                { id: 'MOMENTUM-ARB',    name: 'MOMENTUM ARB',      desc: '5m · EMA9/21 crossover · Vol 1.2×',          available: true },
                { id: 'MEAN-REV',        name: 'MEAN REVERSION',    desc: '15m · BB band touch + RSI · No trend filter', available: true },
                { id: 'VOLATILITY-CORE', name: 'VOLATILITY CORE',   desc: 'Coming soon — BB squeeze + ATR expansion',    available: false },
              ] as const).map(strat => {
                const isEnabled = activeStrategies.includes(strat.id);
                return (
                  <div
                    key={strat.id}
                    onClick={() => strat.available && toggleStrategy(strat.id)}
                    className={cn(
                      "p-2.5 rounded border transition-all",
                      strat.available ? "cursor-pointer" : "cursor-not-allowed opacity-40",
                      isEnabled
                        ? "bg-trading-card border-trading-accent shadow-[0_0_15px_rgba(0,209,255,0.1)]"
                        : strat.available
                          ? "bg-trading-card/50 border-trading-border hover:border-trading-muted"
                          : "bg-trading-card/30 border-trading-border"
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[11px] font-bold">{strat.name}</div>
                      {strat.available && (
                        <span className={cn(
                          "text-[8px] font-black uppercase tracking-wider border px-1.5 py-0.5 rounded",
                          isEnabled ? "text-trading-accent border-trading-accent/40" : "text-trading-muted border-trading-muted/40"
                        )}>
                          {isEnabled ? "ON" : "OFF"}
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] text-trading-muted leading-tight">{strat.desc}</div>
                  </div>
                );
              })}
            </div>

            <div className="mt-auto pt-4 grid grid-cols-2 gap-[1px] bg-trading-border border border-trading-border">
              {[
                { label: 'Win Rate', val: '72.4%', color: 'text-trading-text' },
                { label: 'Trades/24h', val: '1,402', color: 'text-trading-text' },
                { label: 'Profit/Day', val: '+0.84%', color: 'text-trading-up' },
                { label: 'Drawdown', val: '-0.12%', color: 'text-trading-down' }
              ].map(stat => (
                <div key={stat.label} className="bg-trading-bg p-2.5 text-center">
                  <div className="text-[8px] text-trading-muted uppercase">{stat.label}</div>
                  <div className={cn("text-xs font-bold mt-0.5", stat.color)}>{stat.val}</div>
                </div>
              ))}
            </div>
          </aside>

          {/* Middle Column: Scanner Grid */}
        <section className="bg-trading-panel p-5 flex flex-col overflow-y-auto overflow-x-hidden">
          <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px] mb-4 after:content-[''] after:flex-1 after:h-[1px] after:bg-trading-border after:ml-3">
            Active Multi-Asset Scanner
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {scanResults.map((coin) => {
              const bestAction = coin.ultraScalp?.action !== 'HOLD' ? coin.ultraScalp?.action
                : coin.momentumArb?.action !== 'HOLD' ? coin.momentumArb?.action
                : coin.meanRev?.action !== 'HOLD' ? coin.meanRev?.action : 'HOLD';

              const ageMs      = coin.lastTickMs ? now - coin.lastTickMs : Infinity;
              const isLive     = ageMs < 15_000;
              const isRecent   = ageMs < 60_000;
              const ageLabel   = !coin.lastTickMs ? 'no data'
                               : ageMs < 5_000    ? 'LIVE'
                               : ageMs < 60_000   ? `${Math.floor(ageMs / 1000)}s ago`
                               : `${Math.floor(ageMs / 60_000)}m ago`;

              const hasTraded  = ['ULTRA-SCALP','MOMENTUM-ARB','MEAN-REV'].some(
                s => cooldownStatus[`${coin.symbol}|${s}`]?.inCooldown
              );
              const tradedStrategy = ['ULTRA-SCALP','MOMENTUM-ARB','MEAN-REV'].find(
                s => cooldownStatus[`${coin.symbol}|${s}`]?.inCooldown
              );

              return (
                <motion.div
                  key={coin.symbol}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-trading-card border border-trading-border rounded relative overflow-hidden group"
                >
                  {/* Left accent bar — colored by dominant signal */}
                  <div className={cn(
                    "absolute left-0 top-0 bottom-0 w-[3px]",
                    bestAction === 'BUY'  ? "bg-trading-up"
                  : bestAction === 'SELL' ? "bg-trading-down"
                  :                         "bg-trading-border"
                  )} />

                  <div className="pl-4 pr-4 pt-4 pb-3">
                    {/* ── Header row ── */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1 min-w-0">
                        {/* Symbol row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Live scanning dot */}
                          <span
                            title={isLive ? 'WebSocket active' : isRecent ? 'Slightly stale' : 'No data / disconnected'}
                            className={cn(
                              "w-2.5 h-2.5 rounded-full shrink-0 mt-px",
                              isLive   ? "bg-green-400 animate-pulse"
                            : isRecent ? "bg-yellow-400"
                            :            "bg-trading-muted/40"
                            )}
                          />
                          <span className="text-base font-bold text-white leading-none">
                            {coin.symbol.replace('/USDT', '')}
                          </span>
                          <span className="text-[11px] text-trading-muted">USDT</span>
                          {/* Trend */}
                          {coin.trend && (
                            <span className={cn("text-[11px] font-bold px-1.5 py-0.5 rounded",
                              coin.trend === 'UP'   ? "bg-trading-up/15 text-trading-up"
                            : coin.trend === 'DOWN' ? "bg-trading-down/15 text-trading-down"
                            :                         "bg-trading-muted/10 text-trading-muted"
                            )}>
                              {coin.trend === 'UP' ? '↑' : coin.trend === 'DOWN' ? '↓' : '—'}
                            </span>
                          )}
                          {/* Regime (ADX) */}
                          {coin.regime && (
                            <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded",
                              coin.regime === 'TRENDING' ? "bg-purple-500/15 text-purple-400"
                            : coin.regime === 'RANGING'  ? "bg-cyan-500/15 text-cyan-400"
                            :                              "bg-trading-muted/10 text-trading-muted"
                            )}>
                              {coin.regime === 'TRENDING' ? 'TREND' : coin.regime === 'RANGING' ? 'RANGE' : 'NEUT'} {coin.adx?.toFixed(0)}
                            </span>
                          )}
                          {/* Trade fired badge */}
                          {hasTraded && (
                            <span className="text-[10px] px-2 py-0.5 bg-trading-up/15 text-trading-up border border-trading-up/30 rounded font-black uppercase tracking-wider animate-pulse">
                              ✓ {tradedStrategy?.replace('MOMENTUM-ARB','MOM').replace('ULTRA-SCALP','SCALP').replace('MEAN-REV','MR')}
                            </span>
                          )}
                        </div>
                        {/* Price + funding */}
                        <div className="flex items-baseline gap-2 mt-1.5">
                          <span className="text-2xl font-bold leading-none">${coin.price?.toLocaleString()}</span>
                          {marketContext.fundingRates[coin.symbol] !== undefined && (
                            <span className={cn("text-[11px] font-mono",
                              marketContext.fundingRates[coin.symbol] >  0.0005 ? "text-trading-down"
                            : marketContext.fundingRates[coin.symbol] < -0.0003 ? "text-trading-up"
                            :                                                      "text-trading-muted"
                            )}>
                              FR {marketContext.fundingRates[coin.symbol] >= 0 ? "+" : ""}
                              {(marketContext.fundingRates[coin.symbol] * 100).toFixed(4)}%
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Scan status + ATR (top-right) */}
                      <div className="flex flex-col items-end gap-1.5 ml-2 shrink-0">
                        <span className={cn("text-[11px] font-mono font-bold",
                          isLive   ? "text-green-400"
                        : isRecent ? "text-yellow-400"
                        :            "text-trading-muted"
                        )}>{ageLabel}</span>
                        {(coin.ultraScalp?.atrPct ?? 0) > 0 && (
                          <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded",
                            (coin.ultraScalp?.atrPct ?? 0) >= 0.3  ? "bg-trading-down/10 text-trading-down"
                          : (coin.ultraScalp?.atrPct ?? 0) >= 0.15 ? "bg-orange-400/10 text-orange-400"
                          :                                            "bg-trading-muted/10 text-trading-muted"
                          )}>ATR {coin.ultraScalp?.atrPct?.toFixed(2)}%</span>
                        )}
                      </div>
                    </div>

                    {/* ── Strategy rows ── */}
                    <div className="space-y-1.5 mb-3">
                      {coin.ultraScalp && (() => {
                        const r = getBlockReason(coin.ultraScalp.action, coin.trend, coin.ultraScalp.volumeRatio, 1.0, isAutoPilot, true, marketContext.fundingRates[coin.symbol], marketContext.fearGreed?.value, 'ULTRA-SCALP', coin.oiChangePct, coin.lsRatio, cooldownStatus[`${coin.symbol}|ULTRA-SCALP`], coin.regime, coin.adx);
                        const active = coin.ultraScalp.action !== 'HOLD';
                        return (
                          <div className={cn("rounded overflow-hidden border",
                            active ? "border-trading-border/60" : "border-transparent"
                          )}>
                            <div className={cn("flex items-center gap-2 px-2.5 py-2",
                              active ? "bg-trading-bg/60" : "bg-trading-bg/30"
                            )}>
                              <span className="text-[11px] font-bold font-mono text-trading-muted w-[76px] shrink-0 uppercase tracking-wide">Scalp 1m</span>
                              <span className={cn("px-2 py-0.5 rounded font-black text-[11px]",
                                coin.ultraScalp.action === 'BUY'  ? "bg-trading-up/15 text-trading-up"
                              : coin.ultraScalp.action === 'SELL' ? "bg-trading-down/15 text-trading-down"
                              :                                      "bg-trading-muted/10 text-trading-muted"
                              )}>{coin.ultraScalp.action}</span>
                              {coin.ultraScalp.score !== undefined && (
                                <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded",
                                  (coin.ultraScalp.score ?? 0) >= 4 ? "bg-trading-up/20 text-trading-up"
                                  : (coin.ultraScalp.score ?? 0) >= 3 ? "bg-orange-400/20 text-orange-400"
                                  :                                     "bg-trading-muted/10 text-trading-muted"
                                )}>{(coin.ultraScalp.score ?? 0).toFixed(1)}</span>
                              )}
                              <span className="text-[11px] text-trading-muted">RSI {coin.ultraScalp.rsi.toFixed(0)}</span>
                              {coin.ultraScalp.stochK !== undefined && (
                                <span className={cn("text-[10px] font-bold px-1 py-0.5 rounded",
                                  coin.ultraScalp.stochK < 20 ? "bg-trading-up/10 text-trading-up"
                                : coin.ultraScalp.stochK > 80 ? "bg-trading-down/10 text-trading-down"
                                :                                "bg-trading-muted/10 text-trading-muted"
                                )}>K{coin.ultraScalp.stochK.toFixed(0)}</span>
                              )}
                              {coin.ultraScalp.supertrend !== undefined && (
                                <span className={cn("text-[10px] font-black",
                                  coin.ultraScalp.supertrend === 1 ? "text-trading-up" : "text-trading-down"
                                )}>{coin.ultraScalp.supertrend === 1 ? "ST↑" : "ST↓"}</span>
                              )}
                              {coin.ultraScalp.volumeRatio !== undefined && (
                                <span className={cn("ml-auto text-[11px] font-bold",
                                  coin.ultraScalp.volumeRatio >= 1.5 ? "text-trading-up"
                                : coin.ultraScalp.volumeRatio >= 1.0 ? "text-trading-muted"
                                :                                       "text-trading-down/70"
                                )}>V {coin.ultraScalp.volumeRatio.toFixed(1)}×</span>
                              )}
                            </div>
                            <div className={cn("px-2.5 py-1.5 text-[11px] font-mono border-t border-trading-border/20",
                              active ? "bg-trading-bg/50" : "bg-trading-bg/20", r.color
                            )}>↳ {r.label}</div>
                          </div>
                        );
                      })()}

                      {coin.momentumArb && (() => {
                        const r = getBlockReason(coin.momentumArb.action, coin.trend, coin.momentumArb.volumeRatio, 1.0, isAutoPilot, false, marketContext.fundingRates[coin.symbol], marketContext.fearGreed?.value, 'MOMENTUM-ARB', coin.oiChangePct, coin.lsRatio, cooldownStatus[`${coin.symbol}|MOMENTUM-ARB`], coin.regime, coin.adx);
                        const active = coin.momentumArb.action !== 'HOLD';
                        return (
                          <div className={cn("rounded overflow-hidden border",
                            active ? "border-trading-border/60" : "border-transparent"
                          )}>
                            <div className={cn("flex items-center gap-2 px-2.5 py-2",
                              active ? "bg-trading-bg/60" : "bg-trading-bg/30"
                            )}>
                              <span className="text-[11px] font-bold font-mono text-trading-muted w-[76px] shrink-0 uppercase tracking-wide">Mom 5m</span>
                              <span className={cn("px-2 py-0.5 rounded font-black text-[11px]",
                                coin.momentumArb.action === 'BUY'  ? "bg-trading-up/15 text-trading-up"
                              : coin.momentumArb.action === 'SELL' ? "bg-trading-down/15 text-trading-down"
                              :                                       "bg-trading-muted/10 text-trading-muted"
                              )}>{coin.momentumArb.action}</span>
                              {coin.momentumArb.score !== undefined && (
                                <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded",
                                  (coin.momentumArb.score ?? 0) >= 4 ? "bg-trading-up/20 text-trading-up"
                                  : (coin.momentumArb.score ?? 0) >= 3 ? "bg-orange-400/20 text-orange-400"
                                  :                                      "bg-trading-muted/10 text-trading-muted"
                                )}>{(coin.momentumArb.score ?? 0).toFixed(1)}</span>
                              )}
                              <span className="text-[11px] text-trading-muted">RSI {coin.momentumArb.rsi.toFixed(0)}</span>
                              {coin.momentumArb.cross && (
                                <span className={cn("text-[11px] font-black",
                                  coin.momentumArb.cross === 'GOLDEN' ? "text-trading-up" : "text-trading-down"
                                )}>{coin.momentumArb.cross === 'GOLDEN' ? '↑GX' : '↓DX'}</span>
                              )}
                              {coin.momentumArb.supertrend !== undefined && (
                                <span className={cn("text-[10px] font-black",
                                  coin.momentumArb.supertrend === 1 ? "text-trading-up" : "text-trading-down"
                                )}>{coin.momentumArb.supertrend === 1 ? "ST↑" : "ST↓"}</span>
                              )}
                              {coin.momentumArb.volumeRatio !== undefined && (
                                <span className={cn("ml-auto text-[11px] font-bold",
                                  coin.momentumArb.volumeRatio >= 1.2 ? "text-trading-up" : "text-trading-muted"
                                )}>V {coin.momentumArb.volumeRatio.toFixed(1)}×</span>
                              )}
                            </div>
                            <div className={cn("px-2.5 py-1.5 text-[11px] font-mono border-t border-trading-border/20",
                              active ? "bg-trading-bg/50" : "bg-trading-bg/20", r.color
                            )}>↳ {r.label}</div>
                          </div>
                        );
                      })()}

                      {coin.meanRev && (() => {
                        const r = getBlockReason(coin.meanRev.action, coin.trend, coin.meanRev.volumeRatio, 0.8, isAutoPilot, true, marketContext.fundingRates[coin.symbol], marketContext.fearGreed?.value, 'MEAN-REV', coin.oiChangePct, coin.lsRatio, cooldownStatus[`${coin.symbol}|MEAN-REV`], coin.regime, coin.adx);
                        const active = coin.meanRev.action !== 'HOLD';
                        const bbColor = coin.meanRev.bbPos === 'LOWER' ? 'text-trading-up'
                                      : coin.meanRev.bbPos === 'UPPER' ? 'text-trading-down'
                                      : 'text-trading-muted';
                        return (
                          <div className={cn("rounded overflow-hidden border",
                            active ? "border-trading-accent/30" : "border-transparent"
                          )}>
                            <div className={cn("flex items-center gap-2 px-2.5 py-2",
                              active ? "bg-trading-accent/8" : "bg-trading-bg/30"
                            )}>
                              <span className="text-[11px] font-bold font-mono text-trading-accent/60 w-[76px] shrink-0 uppercase tracking-wide">MRev 15m</span>
                              <span className={cn("px-2 py-0.5 rounded font-black text-[11px]",
                                coin.meanRev.action === 'BUY'  ? "bg-trading-up/15 text-trading-up"
                              : coin.meanRev.action === 'SELL' ? "bg-trading-down/15 text-trading-down"
                              :                                   "bg-trading-muted/10 text-trading-muted"
                              )}>{coin.meanRev.action}</span>
                              {coin.meanRev.score !== undefined && (
                                <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded",
                                  (coin.meanRev.score ?? 0) >= 4 ? "bg-trading-up/20 text-trading-up"
                                  : (coin.meanRev.score ?? 0) >= 3 ? "bg-orange-400/20 text-orange-400"
                                  :                                    "bg-trading-muted/10 text-trading-muted"
                                )}>{(coin.meanRev.score ?? 0).toFixed(1)}</span>
                              )}
                              <span className="text-[11px] text-trading-muted">RSI {coin.meanRev.rsi.toFixed(0)}</span>
                              {coin.meanRev.bbPos && (
                                <span className={cn("text-[11px] font-bold", bbColor)}>BB:{coin.meanRev.bbPos}</span>
                              )}
                              {coin.meanRev.stochK !== undefined && (
                                <span className={cn("text-[10px] font-bold px-1 py-0.5 rounded",
                                  coin.meanRev.stochK < 25 ? "bg-trading-up/10 text-trading-up"
                                : coin.meanRev.stochK > 75 ? "bg-trading-down/10 text-trading-down"
                                :                             "bg-trading-muted/10 text-trading-muted"
                                )}>K{coin.meanRev.stochK.toFixed(0)}</span>
                              )}
                              {coin.meanRev.williamsR !== undefined && (
                                <span className={cn("text-[10px] font-mono",
                                  coin.meanRev.williamsR < -80 ? "text-trading-up"
                                : coin.meanRev.williamsR > -20 ? "text-trading-down"
                                :                                 "text-trading-muted"
                                )}>W%{coin.meanRev.williamsR.toFixed(0)}</span>
                              )}
                              {coin.meanRev.volumeRatio !== undefined && (
                                <span className={cn("ml-auto text-[11px] font-bold",
                                  coin.meanRev.volumeRatio >= 0.8 ? "text-trading-up" : "text-trading-muted"
                                )}>V {coin.meanRev.volumeRatio.toFixed(1)}×</span>
                              )}
                            </div>
                            <div className={cn("px-2.5 py-1.5 text-[11px] font-mono border-t border-trading-border/20",
                              active ? "bg-trading-accent/5" : "bg-trading-bg/20", r.color
                            )}>↳ {r.label}</div>
                          </div>
                        );
                      })()}
                    </div>

                    {/* ── Futures context row ── */}
                    {(coin.oiChangePct != null || coin.lsRatio != null || (coin.vwap && coin.vwap > 0)) && (
                      <div className="flex gap-2 flex-wrap mb-2.5">
                        {coin.oiChangePct != null && (
                          <span className={cn("px-2 py-0.5 rounded text-[11px] font-bold font-mono",
                            coin.oiChangePct >  1.0 ? "bg-trading-up/10 text-trading-up"
                          : coin.oiChangePct < -1.0 ? "bg-trading-down/10 text-trading-down"
                          :                            "bg-trading-muted/10 text-trading-muted"
                          )}>OI {coin.oiChangePct >= 0 ? "+" : ""}{coin.oiChangePct.toFixed(2)}%</span>
                        )}
                        {coin.lsRatio != null && (
                          <span className={cn("px-2 py-0.5 rounded text-[11px] font-bold font-mono",
                            coin.lsRatio > 1.8 ? "bg-trading-down/10 text-trading-down"
                          : coin.lsRatio < 0.6 ? "bg-trading-up/10 text-trading-up"
                          :                       "bg-trading-muted/10 text-trading-muted"
                          )}>L/S {coin.lsRatio.toFixed(2)}</span>
                        )}
                        {coin.vwap != null && coin.vwap > 0 && (
                          <span className={cn("px-2 py-0.5 rounded text-[11px] font-bold font-mono",
                            coin.price > coin.vwap * 1.001 ? "bg-trading-down/10 text-trading-down"
                          : coin.price < coin.vwap * 0.999 ? "bg-trading-up/10 text-trading-up"
                          :                                   "bg-trading-muted/10 text-trading-muted"
                          )}>VWAP {coin.price > coin.vwap ? "↑" : "↓"}{Math.abs((coin.price - coin.vwap) / coin.vwap * 100).toFixed(2)}%</span>
                        )}
                      </div>
                    )}

                    {/* ── Buttons ── */}
                    <div className="flex gap-1.5 justify-end">
                      <button
                        onClick={() => setExpandedCard(expandedCard === coin.symbol ? null : coin.symbol)}
                        className={cn(
                          "px-2.5 py-1.5 rounded transition-colors text-xs font-bold uppercase flex items-center gap-1.5",
                          expandedCard === coin.symbol ? "bg-trading-accent text-trading-bg" : "bg-trading-bg text-trading-muted hover:text-white"
                        )}
                      >
                        <Info className="w-3.5 h-3.5" />
                        {expandedCard === coin.symbol ? "Hide" : "Details"}
                      </button>
                      <button
                        onClick={() => getAiConfirmation(coin.symbol, coin)}
                        disabled={loadingAi === coin.symbol}
                        className="px-2.5 py-1.5 bg-trading-bg rounded text-trading-accent hover:text-white transition-colors disabled:opacity-50"
                      >
                        <Activity className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <AnimatePresence>
                    {expandedCard === coin.symbol && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="pt-3 mt-0 border-t border-trading-border space-y-3 pl-4 pr-3 pb-3">
                          <div className="grid grid-cols-2 gap-2">
                            <div className="bg-trading-bg/40 p-2 rounded">
                              <div className="text-[8px] text-trading-muted uppercase mb-1">Scalp Signal (1m)</div>
                              <div className={cn("text-[11px] font-bold",
                                coin.ultraScalp?.action === 'BUY' ? 'text-trading-up' :
                                coin.ultraScalp?.action === 'SELL' ? 'text-trading-down' : 'text-trading-muted'
                              )}>
                                {coin.ultraScalp?.action === 'BUY' ? 'Bullish Setup' : coin.ultraScalp?.action === 'SELL' ? 'Bearish Pressure' : 'Consolidating'}
                              </div>
                            </div>
                            <div className="bg-trading-bg/40 p-2 rounded">
                              <div className="text-[8px] text-trading-muted uppercase mb-1">Momentum (5m)</div>
                              <div className={cn("text-[11px] font-bold",
                                coin.momentumArb?.action === 'BUY' ? 'text-trading-up' :
                                coin.momentumArb?.action === 'SELL' ? 'text-trading-down' : 'text-trading-muted'
                              )}>
                                {coin.momentumArb?.cross === 'GOLDEN' ? 'Golden Cross ↑' : coin.momentumArb?.cross === 'DEATH' ? 'Death Cross ↓' : 'No Crossover'}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {['EMA200', 'ATR-SL', 'VOL-FILTER'].map(tag => (
                              <span key={tag} className="text-[8px] px-1.5 py-0.5 bg-trading-bg border border-trading-border rounded text-trading-muted font-mono">{tag}</span>
                            ))}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>

          <div className="mt-auto bg-trading-accent/5 p-4 rounded border border-trading-border border-dashed flex gap-4 items-start">
            <div className="p-2 bg-trading-accent/10 rounded">
              <Bot className="w-5 h-5 text-trading-accent" />
            </div>
            <div>
              <div className="text-[12px] text-trading-accent font-bold mb-1 uppercase tracking-wider">Bot Insight: Market Anomaly Detected</div>
              <div className="text-[11px] text-trading-muted leading-relaxed">
                BTC/USDT showing oversold divergence on 1m timeframe. Volume profiles suggest liquidity sweep. Neural confirmation pending.
              </div>
            </div>
          </div>
        </section>

        {/* Right Column: Bot Activity Log */}
        <aside className="bg-trading-bg p-5 flex flex-col overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-[10px] uppercase text-trading-muted tracking-[2px]">
              <Activity className="w-3 h-3" />
              <span>Bot Activity Log</span>
              {logs.length > 0 && (
                <span className="px-1.5 py-0.5 bg-trading-card rounded text-[8px] font-black text-trading-muted">
                  {logs.length}
                </span>
              )}
            </div>
            <button
              onClick={() => setLogs([])}
              className="text-[9px] text-trading-muted hover:text-trading-down transition-colors uppercase font-bold tracking-widest"
            >
              Clear
            </button>
          </div>

          {/* Market Sentiment widget */}
          <div className="mb-4 p-3 bg-trading-card border border-trading-border rounded space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[9px] uppercase text-trading-muted font-bold tracking-wider">Fear & Greed</span>
              {marketContext.fearGreed ? (
                <div className={cn(
                  "flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-black",
                  marketContext.fearGreed.value < 25 ? "bg-trading-down/10 text-trading-down"
                : marketContext.fearGreed.value > 75 ? "bg-orange-400/10 text-orange-400"
                : marketContext.fearGreed.value > 50 ? "bg-trading-up/10 text-trading-up"
                : "bg-trading-muted/10 text-trading-muted"
                )}>
                  <span>{marketContext.fearGreed.value}</span>
                  <span className="text-[8px] font-medium">{marketContext.fearGreed.classification}</span>
                </div>
              ) : (
                <span className="text-[9px] text-trading-muted font-mono">loading…</span>
              )}
            </div>
            {marketContext.fearGreed && (
              <div className="h-1 bg-trading-border rounded-full overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all",
                    marketContext.fearGreed.value < 25 ? "bg-trading-down"
                  : marketContext.fearGreed.value > 75 ? "bg-orange-400"
                  : marketContext.fearGreed.value > 50 ? "bg-trading-up"
                  : "bg-trading-muted"
                  )}
                  style={{ width: `${marketContext.fearGreed.value}%` }}
                />
              </div>
            )}
            {Object.keys(marketContext.fundingRates).length > 0 && (() => {
              const rates = Object.values(marketContext.fundingRates);
              const avg   = rates.reduce((a, b) => a + b, 0) / rates.length;
              return (
                <div className="flex items-center justify-between">
                  <span className="text-[9px] uppercase text-trading-muted font-bold tracking-wider">Avg Funding/8h</span>
                  <span className={cn("text-[10px] font-black font-mono",
                    avg >  0.0005 ? "text-trading-down"
                  : avg < -0.0003 ? "text-trading-up"
                  : "text-trading-muted"
                  )}>
                    {avg >= 0 ? "+" : ""}{(avg * 100).toFixed(4)}%
                  </span>
                </div>
              );
            })()}
          </div>

          <div className="flex-1 overflow-y-auto mb-4 min-h-0">
            {logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full opacity-20 py-12">
                <Activity className="w-6 h-6 mb-2" />
                <div className="text-[9px] uppercase tracking-widest text-center leading-relaxed">
                  No activity yet<br/>Bot is monitoring
                </div>
              </div>
            ) : (
              <AnimatePresence mode="popLayout" initial={false}>
                {logs.map((log) => (
                  <motion.div
                    key={log.id}
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                    className="flex gap-2 items-start py-2 border-b border-trading-border/30"
                  >
                    <span className="text-[8px] font-mono text-trading-muted shrink-0 mt-0.5 w-[38px]">
                      {log.time.split(' ')[0]}
                    </span>
                    <span className={cn(
                      "text-[7px] font-black px-1 py-0.5 rounded shrink-0 uppercase tracking-wider mt-0.5",
                      log.type === 'success' && "bg-trading-up/15 text-trading-up",
                      log.type === 'error'   && "bg-trading-down/15 text-trading-down",
                      log.type === 'ai'      && "bg-trading-accent/15 text-trading-accent",
                      log.type === 'warning' && "bg-orange-400/15 text-orange-400",
                      log.type === 'info'    && "bg-trading-muted/15 text-trading-muted",
                    )}>
                      {log.type === 'success' ? 'TRADE'
                       : log.type === 'error'   ? 'ERR'
                       : log.type === 'ai'      ? 'AI'
                       : log.type === 'warning' ? 'WARN'
                       : 'SYS'}
                    </span>
                    <span className={cn(
                      "text-[10px] leading-snug break-words min-w-0",
                      log.type === 'success' && "text-trading-up",
                      log.type === 'error'   && "text-trading-down",
                      log.type === 'ai'      && "text-trading-accent",
                      log.type === 'warning' && "text-orange-400",
                      log.type === 'info'    && "text-trading-muted",
                    )}>
                      {log.msg}
                    </span>
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>

          <div className="space-y-4 pt-4 border-t border-trading-border">
            <div className="flex justify-between items-center">
              <div className="text-[10px] text-trading-muted uppercase tracking-widest font-bold">Auto-Trade Override</div>
              <div 
                onClick={() => {
                  const next = !isAutoPilot;
                  setIsAutoPilot(next);
                  addLog(`Auto-trade ${next ? 'ENABLED' : 'DISABLED'}`, next ? 'success' : 'warning');
                  fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isAutoPilot: next }) });
                }}
                className={cn(
                  "w-8 h-4 rounded-full transition-all relative cursor-pointer",
                  isAutoPilot ? "bg-trading-up" : "bg-trading-border"
                )}
              >
                <div className={cn(
                  "absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform",
                  isAutoPilot && "translate-x-4"
                )} />
              </div>
            </div>
            <button 
              onClick={() => {
                const next = !isAutoPilot;
                setIsAutoPilot(next);
                addLog(`Manual Override: ${next ? 'EXECUTION START' : 'EMERGENCY KILL'}`, next ? 'success' : 'error');
                fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isAutoPilot: next }) });
              }}
              className={cn(
                "w-full py-3 rounded text-[11px] font-black uppercase tracking-widest transition-all",
                isAutoPilot 
                  ? "bg-trading-down text-white shadow-[0_0_20px_rgba(255,59,105,0.2)]" 
                  : "bg-trading-accent text-trading-bg"
              )}
            >
              {isAutoPilot ? "Emergency Kill" : "Initialize Trade"}
            </button>
          </div>
        </aside>

        </div>
      </main>

      {/* ── Open Positions Modal ── */}
      <AnimatePresence>
        {isPositionsOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setIsPositionsOpen(false)}
              className="absolute inset-0 bg-trading-bg/90 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-4xl max-h-[80vh] bg-trading-card border border-trading-border rounded-lg shadow-2xl flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-trading-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <BarChart2 className="w-5 h-5 text-trading-up" />
                  <h2 className="text-sm font-bold uppercase tracking-[2px]">Open Positions</h2>
                  <span className="text-[9px] px-2 py-0.5 bg-trading-up/10 text-trading-up border border-trading-up/30 rounded-full font-bold uppercase">
                    {openPositions.length} Active
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {openPositions.length > 0 && (
                    <button
                      onClick={closeAllPositions}
                      disabled={closingAll || closingId !== null}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-trading-down/10 text-trading-down border border-trading-down/30 rounded text-[10px] font-black uppercase tracking-widest hover:bg-trading-down/20 transition-colors disabled:opacity-50"
                    >
                      {closingAll ? (
                        <><Activity className="w-3 h-3 animate-spin" /> Closing...</>
                      ) : (
                        <><X className="w-3 h-3" /> Close All</>
                      )}
                    </button>
                  )}
                  <button onClick={() => setIsPositionsOpen(false)} className="p-2 hover:bg-trading-border rounded transition-colors text-trading-muted hover:text-white">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-auto">
                {openPositions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-48 opacity-30">
                    <BarChart2 className="w-8 h-8 mb-3" />
                    <div className="text-[10px] uppercase tracking-widest">No open positions</div>
                  </div>
                ) : (
                  <table className="w-full text-left text-[11px]">
                    <thead className="sticky top-0 bg-trading-card border-b border-trading-border">
                      <tr className="text-trading-muted uppercase tracking-wider">
                        <th className="px-6 py-4 font-medium">Symbol</th>
                        <th className="px-6 py-4 font-medium">Side</th>
                        <th className="px-6 py-4 font-medium">Entry</th>
                        <th className="px-6 py-4 font-medium">Current</th>
                        <th className="px-6 py-4 font-medium">Amount</th>
                        <th className="px-6 py-4 font-medium">Leverage</th>
                        <th className="px-6 py-4 font-medium">Fee</th>
                        <th className="px-6 py-4 font-medium">Unrealized PnL</th>
                        <th className="px-6 py-4 font-medium text-right">Opened</th>
                        <th className="px-4 py-4 font-medium text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-trading-border">
                      {openPositions.map(pos => (
                        <tr key={pos.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="px-6 py-4 font-bold">{pos.symbol}</td>
                          <td className="px-6 py-4">
                            <span className={cn(
                              "px-2 py-0.5 rounded text-[9px] font-black uppercase",
                              pos.side === 'LONG' ? "bg-trading-up/10 text-trading-up" : "bg-trading-down/10 text-trading-down"
                            )}>
                              {pos.side}
                            </span>
                          </td>
                          <td className="px-6 py-4 font-mono">${pos.entry_price.toLocaleString()}</td>
                          <td className="px-6 py-4 font-mono">${pos.current_price.toLocaleString()}</td>
                          <td className="px-6 py-4 font-mono text-trading-muted">{pos.amount}</td>
                          <td className="px-6 py-4 font-mono text-trading-muted">{pos.leverage}x</td>
                          <td className="px-6 py-4 font-mono text-trading-down">
                            -{pos.fee_usdt.toFixed(4)} USDT
                          </td>
                          <td className="px-6 py-4">
                            <div className={cn("font-bold font-mono", pos.pnl_usdt >= 0 ? "text-trading-up" : "text-trading-down")}>
                              {pos.pnl_usdt >= 0 ? "+" : ""}{pos.pnl_usdt.toFixed(2)} USDT
                            </div>
                            <div className={cn("text-[9px] font-mono mt-0.5", pos.pnl_pct >= 0 ? "text-trading-up" : "text-trading-down")}>
                              {pos.pnl_pct >= 0 ? "+" : ""}{pos.pnl_pct.toFixed(3)}%
                            </div>
                            <div className={cn("text-[9px] font-mono mt-0.5 font-bold", pos.net_pnl_usdt >= 0 ? "text-trading-up" : "text-trading-down")}>
                              Net: {pos.net_pnl_usdt >= 0 ? "+" : ""}{pos.net_pnl_usdt.toFixed(2)}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right text-trading-muted font-mono">{pos.opened_at}</td>
                          <td className="px-4 py-4 text-right">
                            <button
                              onClick={() => closePosition(pos.id)}
                              disabled={closingId === pos.id || closingAll}
                              className="px-2 py-1 bg-trading-down/10 text-trading-down border border-trading-down/30 rounded text-[9px] font-black uppercase tracking-widest hover:bg-trading-down/20 transition-colors disabled:opacity-40"
                            >
                              {closingId === pos.id ? <Activity className="w-3 h-3 animate-spin inline" /> : "Close"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="p-4 bg-trading-bg/50 border-t border-trading-border flex items-center justify-between text-[10px]">
                <div className="flex items-center gap-3">
                  <button
                    onClick={async () => {
                      setIsSyncing(true);
                      try {
                        const r = await fetch("/api/sync-positions", { method: "POST" });
                        const d = await r.json();
                        if (d.last_sync) setLastSync(d.last_sync);
                        const posRes = await fetch("/api/open-positions");
                        const posData = await posRes.json();
                        setOpenPositions(posData.positions ?? []);
                      } finally {
                        setIsSyncing(false);
                      }
                    }}
                    disabled={isSyncing}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-trading-card border border-trading-border rounded hover:border-trading-muted transition-colors disabled:opacity-50 uppercase font-bold tracking-widest text-[9px]"
                  >
                    <Activity className={cn("w-3 h-3", isSyncing && "animate-spin")} />
                    {isSyncing ? "Syncing..." : "Sync Binance"}
                  </button>
                  {lastSync && (
                    <span className="text-trading-muted">
                      Last sync: {new Date(lastSync).toLocaleTimeString()}
                    </span>
                  )}
                </div>
                {openPositions.length > 0 && (
                  <div className="flex items-center gap-4">
                    <span className="text-trading-muted font-mono">
                      Fees: <span className="text-trading-down font-bold">
                        -{openPositions.reduce((s, p) => s + p.fee_usdt, 0).toFixed(4)} USDT
                      </span>
                    </span>
                    <span className={cn(
                      "font-bold font-mono",
                      openPositions.reduce((s, p) => s + p.net_pnl_usdt, 0) >= 0 ? "text-trading-up" : "text-trading-down"
                    )}>
                      Net Unrealized: {openPositions.reduce((s, p) => s + p.net_pnl_usdt, 0) >= 0 ? "+" : ""}
                      {openPositions.reduce((s, p) => s + p.net_pnl_usdt, 0).toFixed(2)} USDT
                    </span>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Trade History Modal ── */}
      <AnimatePresence>
        {isHistoryOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsHistoryOpen(false)}
              className="absolute inset-0 bg-trading-bg/90 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-4xl max-h-[80vh] bg-trading-card border border-trading-border rounded-lg shadow-2xl flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-trading-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <History className="w-5 h-5 text-trading-accent" />
                  <h2 className="text-sm font-bold uppercase tracking-[2px]">Detailed Execution History</h2>
                </div>
                <button 
                  onClick={() => setIsHistoryOpen(false)}
                  className="p-2 hover:bg-trading-border rounded transition-colors text-trading-muted hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-trading-card border-b border-trading-border">
                    <tr className="text-trading-muted uppercase tracking-wider">
                      <th className="px-6 py-4 font-medium">Asset</th>
                      <th className="px-6 py-4 font-medium">Strategy</th>
                      <th className="px-6 py-4 font-medium">Entry</th>
                      <th className="px-6 py-4 font-medium">Exit</th>
                      <th className="px-6 py-4 font-medium">Fee</th>
                      <th className="px-6 py-4 font-medium">PnL</th>
                      <th className="px-6 py-4 font-medium text-right">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-trading-border">
                    {tradeHistory.map((trade) => (
                      <tr key={trade.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-4 font-bold">{trade.symbol}</td>
                        <td className="px-6 py-4 text-trading-muted">{trade.strategy}</td>
                        <td className="px-6 py-4 font-mono">${trade.entry?.toLocaleString() ?? '—'}</td>
                        <td className="px-6 py-4 font-mono text-trading-muted">
                          {trade.exit != null ? `$${trade.exit.toLocaleString()}` : <span className="text-trading-accent text-[9px] font-bold uppercase">OPEN</span>}
                        </td>
                        <td className="px-6 py-4 font-mono text-trading-down text-[10px]">
                          {trade.fee != null && trade.fee > 0 ? `-${trade.fee.toFixed(4)}` : <span className="text-trading-muted">—</span>}
                        </td>
                        <td className="px-6 py-4">
                          <div className={cn(
                            "font-bold font-mono",
                            trade.pnl == null ? "text-trading-muted" : trade.pnl >= 0 ? "text-trading-up" : "text-trading-down"
                          )}>
                            {trade.pnl != null ? `${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} USDT` : '—'}
                          </div>
                          {trade.pnl != null && trade.fee != null && trade.fee > 0 && (
                            <div className={cn(
                              "text-[9px] font-mono mt-0.5 font-bold",
                              (trade.pnl - trade.fee) >= 0 ? "text-trading-up" : "text-trading-down"
                            )}>
                              Net: {(trade.pnl - trade.fee) >= 0 ? "+" : ""}{(trade.pnl - trade.fee).toFixed(2)}
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right text-trading-muted font-mono">{trade.time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-4 bg-trading-bg/50 border-t border-trading-border text-[10px] text-trading-muted text-center italic">
                Showing last {tradeHistory.length} verified executions from Binance API stream.
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Backtest Modal ── */}
      <AnimatePresence>
        {isBacktestOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
              onClick={() => setIsBacktestOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
              className="relative bg-trading-bg border border-trading-border rounded-xl w-full max-w-4xl max-h-[85vh] flex flex-col z-10 overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-trading-border shrink-0">
                <div className="flex items-center gap-3">
                  <LineChartIcon className="w-5 h-5 text-trading-accent" />
                  <span className="font-black tracking-tight">BACKTEST ENGINE</span>
                  <span className="text-[10px] text-trading-muted font-mono uppercase">Historical Strategy Simulation</span>
                </div>
                <button onClick={() => setIsBacktestOpen(false)} className="text-trading-muted hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Controls */}
              <div className="flex items-center gap-3 px-6 py-3 border-b border-trading-border bg-trading-card/30 shrink-0 flex-wrap">
                <select
                  value={btSymbol}
                  onChange={e => setBtSymbol(e.target.value)}
                  className="bg-trading-bg border border-trading-border rounded px-2 py-1.5 text-[11px] font-bold text-trading-text"
                >
                  {["BTC/USDT","ETH/USDT","SOL/USDT","XRP/USDT","BNB/USDT","AVAX/USDT","ARB/USDT","OP/USDT"].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select
                  value={btDays}
                  onChange={e => setBtDays(parseInt(e.target.value))}
                  className="bg-trading-bg border border-trading-border rounded px-2 py-1.5 text-[11px] font-bold text-trading-text"
                >
                  {[1,3,7,14,30].map(d => (
                    <option key={d} value={d}>Last {d} day{d > 1 ? "s" : ""}</option>
                  ))}
                </select>
                <select
                  value={btStrategy}
                  onChange={e => setBtStrategy(e.target.value)}
                  className="bg-trading-bg border border-trading-border rounded px-2 py-1.5 text-[11px] font-bold text-trading-text"
                >
                  <option value="ULTRA-SCALP">ULTRA-SCALP (1m)</option>
                  <option value="MOMENTUM-ARB">MOMENTUM-ARB (5m)</option>
                  <option value="MEAN-REV">MEAN-REV (15m)</option>
                </select>
                <button
                  onClick={runBacktest}
                  disabled={btLoading}
                  className="px-4 py-1.5 bg-trading-accent text-trading-bg rounded text-[11px] font-black uppercase tracking-wider hover:bg-trading-accent/80 transition-colors disabled:opacity-50"
                >
                  {btLoading ? "Running..." : "Run Backtest"}
                </button>
                <span className="text-[10px] text-trading-muted">Uses real OHLCV from DB · Signal + Trend + Volume + Regime filters</span>
              </div>

              {/* Body */}
              <div className="overflow-y-auto flex-1 p-6">
                {!btResult && !btLoading && (
                  <div className="text-center text-trading-muted text-[12px] mt-12">
                    Select a symbol and period, then click Run Backtest.
                    <div className="text-[10px] mt-2 text-trading-muted/60">Requires OHLCV data stored in DB — bot must have been running for the selected period.</div>
                  </div>
                )}
                {btLoading && (
                  <div className="text-center text-trading-accent text-[12px] mt-12 animate-pulse">Simulating strategy on historical data...</div>
                )}
                {btResult?.error && (
                  <div className="text-center text-trading-down text-[12px] mt-12">{btResult.error}{btResult.candles != null && ` (${btResult.candles} candles found)`}</div>
                )}
                {btResult?.stats && (
                  <div className="space-y-6">
                    {/* Strategy badge */}
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold px-2 py-1 bg-trading-accent/15 text-trading-accent rounded uppercase tracking-wider">{btResult.strategy}</span>
                      <span className="text-[10px] text-trading-muted">{btResult.stats.candles} candles · {btResult.days}d</span>
                    </div>

                    {/* Stats Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: "Win Rate",      value: `${btResult.stats.winRate}%`,           color: btResult.stats.winRate >= 50 ? "text-trading-up" : "text-trading-down" },
                        { label: "Total PnL",     value: `${btResult.stats.totalPnlPct > 0 ? "+" : ""}${btResult.stats.totalPnlPct}%`, color: btResult.stats.totalPnlPct >= 0 ? "text-trading-up" : "text-trading-down" },
                        { label: "Final Equity",  value: `${btResult.stats.finalEquity}`,        color: btResult.stats.finalEquity >= 100 ? "text-trading-up" : "text-trading-down" },
                        { label: "Max Drawdown",  value: `-${btResult.stats.maxDrawdownPct}%`,   color: "text-trading-down" },
                        { label: "Sharpe Ratio",  value: btResult.stats.sharpeRatio ?? "N/A",    color: (btResult.stats.sharpeRatio ?? 0) >= 1 ? "text-trading-up" : (btResult.stats.sharpeRatio ?? 0) >= 0 ? "text-orange-400" : "text-trading-down" },
                        { label: "Profit Factor", value: btResult.stats.profitFactor ?? "N/A",   color: (btResult.stats.profitFactor ?? 0) >= 1.5 ? "text-trading-up" : (btResult.stats.profitFactor ?? 0) >= 1 ? "text-orange-400" : "text-trading-down" },
                        { label: "Expectancy",    value: `${(btResult.stats.expectancy ?? 0) >= 0 ? "+" : ""}${btResult.stats.expectancy ?? 0}%`, color: (btResult.stats.expectancy ?? 0) >= 0 ? "text-trading-up" : "text-trading-down" },
                        { label: "Avg Hold",      value: `${btResult.stats.avgHoldMinutes ?? 0}m`, color: "text-trading-muted" },
                        { label: "Total Trades",  value: btResult.stats.total,                   color: "text-trading-text" },
                        { label: "Wins",          value: btResult.stats.wins,                    color: "text-trading-up" },
                        { label: "Losses",        value: btResult.stats.losses,                  color: "text-trading-down" },
                        { label: "Avg Win",       value: `+${btResult.stats.avgWinPct}%`,        color: "text-trading-up" },
                        { label: "Avg Loss",      value: `${btResult.stats.avgLossPct}%`,        color: "text-trading-down" },
                        { label: "Candles",       value: btResult.stats.candles,                 color: "text-trading-muted" },
                      ].map(s => (
                        <div key={s.label} className="bg-trading-card border border-trading-border rounded p-3">
                          <div className="text-[9px] text-trading-muted uppercase tracking-wider mb-1">{s.label}</div>
                          <div className={cn("text-lg font-black", s.color)}>{s.value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Equity Curve */}
                    {btResult.equity && btResult.equity.length > 0 && (
                      <div className="bg-trading-card border border-trading-border rounded p-4">
                        <div className="text-[10px] uppercase text-trading-muted tracking-wider mb-3">Equity Curve (Base 100)</div>
                        <ResponsiveContainer width="100%" height={220}>
                          <LineChart data={btResult.equity}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="ts" tickFormatter={(ts) => new Date(ts).toLocaleDateString()} stroke="#64748b" fontSize={9} />
                            <YAxis domain={['auto', 'auto']} stroke="#64748b" fontSize={9} />
                            <Tooltip
                              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', fontSize: 11 }}
                              labelFormatter={(ts) => new Date(ts).toLocaleString()}
                              formatter={(value: any) => [`${value}`, 'Equity']}
                            />
                            <Line type="monotone" dataKey="value" stroke="#00e5a0" strokeWidth={1.5} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* Trade Log */}
                    {btResult.trades?.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase text-trading-muted tracking-wider mb-2">
                          Simulated Trades (last {btResult.trades.length} · {btResult.stats.candles} candles · {btResult.days}d)
                        </div>
                        <div className="border border-trading-border rounded overflow-hidden">
                          <table className="w-full text-[10px]">
                            <thead>
                              <tr className="border-b border-trading-border bg-trading-card/50">
                                {["Time", "Type", "Entry", "Exit", "PnL%", "Reason", "Hold"].map(h => (
                                  <th key={h} className="text-left px-3 py-2 text-trading-muted font-bold uppercase">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {[...btResult.trades].reverse().map((t: any, i: number) => (
                                <tr key={i} className="border-b border-trading-border/50 hover:bg-trading-card/30 transition-colors">
                                  <td className="px-3 py-1.5 font-mono text-trading-muted">{new Date(t.entryTs).toLocaleTimeString()}</td>
                                  <td className={cn("px-3 py-1.5 font-bold", t.type === "BUY" ? "text-trading-up" : "text-trading-down")}>{t.type === "BUY" ? "LONG" : "SHORT"}</td>
                                  <td className="px-3 py-1.5 font-mono">{t.entry.toLocaleString()}</td>
                                  <td className="px-3 py-1.5 font-mono">{t.exit.toLocaleString()}</td>
                                  <td className={cn("px-3 py-1.5 font-black", t.pnlPct >= 0 ? "text-trading-up" : "text-trading-down")}>
                                    {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct}%
                                  </td>
                                  <td className={cn("px-3 py-1.5 font-bold text-[9px]", t.reason === "TP" ? "text-trading-up" : "text-orange-400")}>{t.reason}</td>
                                  <td className="px-3 py-1.5 text-trading-muted">{t.holdMinutes}m</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {btResult.stats.total === 0 && (
                      <div className="text-center text-trading-muted text-[11px] py-6">
                        No trades fired in this period — signals + trend + volume filters may be too strict, or not enough data yet.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Settings Modal ── */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-6">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
              onClick={() => setIsSettingsOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
              className="relative bg-trading-bg border border-trading-border rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col z-10 overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-trading-border shrink-0">
                <div className="flex items-center gap-3">
                  <Settings className="w-5 h-5 text-trading-accent" />
                  <span className="font-black tracking-tight">BOT SETTINGS</span>
                  <span className="text-[10px] text-trading-muted font-mono uppercase">Configure Trading Parameters</span>
                </div>
                <button onClick={() => setIsSettingsOpen(false)} className="text-trading-muted hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Body */}
              <div className="overflow-y-auto flex-1 p-6 space-y-8">

                {/* ── Global Settings ── */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px]">
                    <Shield className="w-3.5 h-3.5" />
                    Global Risk & Execution
                    <div className="flex-1 h-[1px] bg-trading-border" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {/* Risk Level */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase text-trading-muted font-bold tracking-wider">Risk Per Trade</label>
                        <span className="text-[13px] font-black text-trading-accent">{riskLevel.toFixed(1)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="5"
                        step="0.1"
                        value={riskLevel}
                        onChange={e => setRiskLevel(parseFloat(e.target.value))}
                        className="w-full h-1.5 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                      />
                      <p className="text-[9px] text-trading-muted leading-relaxed">
                        Account % risked per trade. ATR sizing: <code className="text-trading-accent">size = balance × risk% / (ATR × SLmult)</code>
                      </p>
                    </div>

                    {/* Leverage */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase text-trading-muted font-bold tracking-wider">Leverage</label>
                        <span className="text-[13px] font-black text-trading-accent">{botSettings.leverage}x</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="125"
                        step="1"
                        value={botSettings.leverage}
                        onChange={e => setBotSettings(prev => ({ ...prev, leverage: parseInt(e.target.value) }))}
                        className="w-full h-1.5 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                      />
                      <p className="text-[9px] text-trading-muted leading-relaxed">Futures leverage applied to all auto-executed positions.</p>
                    </div>

                    {/* Max Slippage */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase text-trading-muted font-bold tracking-wider">Max Slippage</label>
                        <span className="text-[13px] font-black text-trading-accent">{botSettings.maxSlippage}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.05"
                        max="2"
                        step="0.05"
                        value={botSettings.maxSlippage}
                        onChange={e => setBotSettings(prev => ({ ...prev, maxSlippage: parseFloat(e.target.value) }))}
                        className="w-full h-1.5 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                      />
                      <p className="text-[9px] text-trading-muted leading-relaxed">Maximum acceptable price slippage on market orders.</p>
                    </div>

                    {/* Max Concurrent Positions */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase text-trading-muted font-bold tracking-wider">Max Concurrent Positions</label>
                        <span className="text-[13px] font-black text-trading-accent">{maxConcurrentPositions}</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="10"
                        step="1"
                        value={maxConcurrentPositions}
                        onChange={e => setMaxConcurrentPositions(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                      />
                      <p className="text-[9px] text-trading-muted leading-relaxed">Maximum number of open positions across all strategies at once.</p>
                    </div>

                    {/* Kelly Sizing Toggle */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase text-trading-muted font-bold tracking-wider">Kelly Criterion Sizing</label>
                        <div
                          onClick={() => setUseKellySizing(v => !v)}
                          className={cn("w-8 h-4 rounded-full transition-all relative cursor-pointer", useKellySizing ? "bg-trading-up" : "bg-trading-border")}
                        >
                          <div className={cn("absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform", useKellySizing && "translate-x-4")} />
                        </div>
                      </div>
                      <p className="text-[9px] text-trading-muted leading-relaxed">
                        Uses historical win rate + avg win/loss to compute optimal position size (fractional Kelly, capped at 3%). Falls back to ATR sizing if insufficient history.
                      </p>
                    </div>

                    {/* Partial TP Toggle */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase text-trading-muted font-bold tracking-wider">Partial Take-Profit</label>
                        <div
                          onClick={() => setPartialTpEnabled(v => !v)}
                          className={cn("w-8 h-4 rounded-full transition-all relative cursor-pointer", partialTpEnabled ? "bg-trading-up" : "bg-trading-border")}
                        >
                          <div className={cn("absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform", partialTpEnabled && "translate-x-4")} />
                        </div>
                      </div>
                      <p className="text-[9px] text-trading-muted leading-relaxed">
                        Scale out: close 50% at TP1 (60% of full TP) and remaining 50% at TP2 (full TP). Locks in profit while letting winners run.
                      </p>
                    </div>
                  </div>
                </div>

                {/* ── Strategy Multipliers ── */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px]">
                    <Activity className="w-3.5 h-3.5" />
                    Strategy SL / TP Multipliers
                    <div className="flex-1 h-[1px] bg-trading-border" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {/* ULTRA-SCALP */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="text-[11px] font-bold text-trading-accent uppercase tracking-wider">ULTRA-SCALP</div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-trading-muted uppercase">SL Mult</span>
                          <span className="text-[11px] font-black">{botSettings.atrSlMult}x</span>
                        </div>
                        <input
                          type="range" min="0.5" max="3" step="0.1"
                          value={botSettings.atrSlMult}
                          onChange={e => setBotSettings(prev => ({ ...prev, atrSlMult: parseFloat(e.target.value) }))}
                          className="w-full h-1 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                        />
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-trading-muted uppercase">TP Mult</span>
                          <span className="text-[11px] font-black">{botSettings.atrTpMult}x</span>
                        </div>
                        <input
                          type="range" min="1" max="8" step="0.1"
                          value={botSettings.atrTpMult}
                          onChange={e => setBotSettings(prev => ({ ...prev, atrTpMult: parseFloat(e.target.value) }))}
                          className="w-full h-1 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                        />
                      </div>
                    </div>

                    {/* MOMENTUM-ARB */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="text-[11px] font-bold text-trading-accent uppercase tracking-wider">MOMENTUM-ARB</div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-trading-muted uppercase">SL Mult</span>
                          <span className="text-[11px] font-black">{botSettings.arbSlMult}x</span>
                        </div>
                        <input
                          type="range" min="0.5" max="3" step="0.1"
                          value={botSettings.arbSlMult}
                          onChange={e => setBotSettings(prev => ({ ...prev, arbSlMult: parseFloat(e.target.value) }))}
                          className="w-full h-1 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                        />
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-trading-muted uppercase">TP Mult</span>
                          <span className="text-[11px] font-black">{botSettings.arbTpMult}x</span>
                        </div>
                        <input
                          type="range" min="1" max="8" step="0.1"
                          value={botSettings.arbTpMult}
                          onChange={e => setBotSettings(prev => ({ ...prev, arbTpMult: parseFloat(e.target.value) }))}
                          className="w-full h-1 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                        />
                      </div>
                    </div>

                    {/* MEAN-REV */}
                    <div className="p-4 bg-trading-card border border-trading-border rounded space-y-3">
                      <div className="text-[11px] font-bold text-trading-accent uppercase tracking-wider">MEAN-REV</div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-trading-muted uppercase">SL Mult</span>
                          <span className="text-[11px] font-black">{botSettings.mrSlMult}x</span>
                        </div>
                        <input
                          type="range" min="0.5" max="3" step="0.1"
                          value={botSettings.mrSlMult}
                          onChange={e => setBotSettings(prev => ({ ...prev, mrSlMult: parseFloat(e.target.value) }))}
                          className="w-full h-1 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                        />
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-trading-muted uppercase">TP Mult</span>
                          <span className="text-[11px] font-black">{botSettings.mrTpMult}x</span>
                        </div>
                        <input
                          type="range" min="1" max="8" step="0.1"
                          value={botSettings.mrTpMult}
                          onChange={e => setBotSettings(prev => ({ ...prev, mrTpMult: parseFloat(e.target.value) }))}
                          className="w-full h-1 bg-trading-border rounded-full appearance-none cursor-pointer accent-trading-accent"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Telegram Config ── */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px]">
                    <Send className="w-3.5 h-3.5" />
                    Telegram Notifications
                    <div className="flex-1 h-[1px] bg-trading-border" />
                  </div>

                  <div className="grid grid-cols-1 gap-4 max-w-2xl">
                    {/* Bot Token */}
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase text-trading-muted font-bold tracking-wider">Bot Token</label>
                      <input
                        type="text"
                        value={telegramBotToken}
                        onChange={e => setTelegramBotToken(e.target.value)}
                        placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxyz"
                        className="w-full bg-trading-card border border-trading-border rounded px-3 py-2 text-[11px] text-trading-text placeholder:text-trading-muted/40 focus:border-trading-accent focus:outline-none transition-colors"
                      />
                      <p className="text-[9px] text-trading-muted">Get from <span className="text-trading-accent">@BotFather</span>. Saved securely in database. Falls back to env var if empty.</p>
                    </div>

                    {/* Chat ID */}
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase text-trading-muted font-bold tracking-wider">Chat ID</label>
                      <input
                        type="text"
                        value={telegramChatId}
                        onChange={e => setTelegramChatId(e.target.value)}
                        placeholder="12345678 atau -1001234567890"
                        className="w-full bg-trading-card border border-trading-border rounded px-3 py-2 text-[11px] text-trading-text placeholder:text-trading-muted/40 focus:border-trading-accent focus:outline-none transition-colors"
                      />
                      <p className="text-[9px] text-trading-muted">Your Telegram user ID or group ID. Get from <span className="text-trading-accent">@userinfobot</span>.</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={async () => {
                        setTelegramTestLoading(true);
                        try {
                          const r = await fetch("/api/test-telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "basic" }) });
                          const d = await r.json();
                          if (d.ok) addLog("Telegram test message sent", "success");
                          else addLog(`Telegram test failed: ${d.error}`, "error");
                        } catch (e: any) {
                          addLog(`Telegram test error: ${e.message}`, "error");
                        }
                        setTelegramTestLoading(false);
                      }}
                      disabled={telegramTestLoading}
                      className="flex items-center gap-2 px-4 py-2.5 bg-trading-card border border-trading-border rounded hover:border-trading-accent transition-colors disabled:opacity-50"
                    >
                      <Send className="w-4 h-4 text-trading-accent" />
                      <span className="text-[11px] font-bold uppercase tracking-wider">{telegramTestLoading ? "Sending..." : "Test Basic Message"}</span>
                    </button>
                    <button
                      onClick={async () => {
                        setTelegramTestLoading(true);
                        try {
                          const r = await fetch("/api/test-telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "signal" }) });
                          const d = await r.json();
                          if (d.ok) addLog("Telegram signal alert test sent", "success");
                          else addLog(`Telegram test failed: ${d.error}`, "error");
                        } catch (e: any) {
                          addLog(`Telegram test error: ${e.message}`, "error");
                        }
                        setTelegramTestLoading(false);
                      }}
                      disabled={telegramTestLoading}
                      className="flex items-center gap-2 px-4 py-2.5 bg-trading-card border border-trading-border rounded hover:border-trading-accent transition-colors disabled:opacity-50"
                    >
                      <Bell className="w-4 h-4 text-trading-up" />
                      <span className="text-[11px] font-bold uppercase tracking-wider">{telegramTestLoading ? "Sending..." : "Test Signal Alert"}</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Footer Save */}
              <div className="px-6 py-4 border-t border-trading-border bg-trading-card/30 shrink-0 flex items-center justify-between">
                <span className="text-[10px] text-trading-muted">Changes apply immediately to the bot engine.</span>
                <button
                  onClick={async () => {
                    setSettingsLoading(true);
                    try {
                      await fetch("/api/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          riskLevel,
                          leverage: botSettings.leverage,
                          maxSlippage: botSettings.maxSlippage,
                          takeProfitPct: botSettings.takeProfitPct,
                          stopLossPct: botSettings.stopLossPct,
                          atrSlMult: botSettings.atrSlMult,
                          atrTpMult: botSettings.atrTpMult,
                          arbSlMult: botSettings.arbSlMult,
                          arbTpMult: botSettings.arbTpMult,
                          mrSlMult: botSettings.mrSlMult,
                          mrTpMult: botSettings.mrTpMult,
                          telegramBotToken,
                          telegramChatId,
                          maxConcurrentPositions,
                          useKellySizing,
                          partialTpEnabled,
                        }),
                      });
                      addLog("Bot settings saved", "success");
                    } catch {
                      addLog("Failed to save settings", "error");
                    }
                    setSettingsLoading(false);
                    setIsSettingsOpen(false);
                  }}
                  disabled={settingsLoading}
                  className="px-6 py-2.5 bg-trading-accent text-trading-bg rounded text-[12px] font-black uppercase tracking-widest hover:bg-trading-accent/80 transition-colors disabled:opacity-50"
                >
                  {settingsLoading ? "Saving..." : "Save All Settings"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
