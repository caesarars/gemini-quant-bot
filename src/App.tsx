import { useState, useEffect } from "react";
import {
  TrendingUp,
  TrendingDown,
  Activity,
  ShieldCheck,
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
}

interface ScanResult {
  symbol: string;
  price: number;
  trend?: 'UP' | 'DOWN' | 'NEUTRAL';
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
  skipTrend = false
): { label: string; color: string } {
  if (!isAutoPilot) return { label: 'Auto-pilot OFF', color: 'text-trading-muted' };
  if (action === 'HOLD') return { label: 'No signal', color: 'text-trading-muted' };
  if (!skipTrend) {
    if (trend === 'NEUTRAL') return { label: 'Trend neutral', color: 'text-orange-400' };
    if (action === 'BUY'  && trend === 'DOWN') return { label: 'BUY blocked — trend ↓', color: 'text-trading-down' };
    if (action === 'SELL' && trend === 'UP')   return { label: 'SELL blocked — trend ↑', color: 'text-trading-down' };
  }
  if ((volumeRatio ?? 1) < volThreshold) return { label: `Vol ${volumeRatio?.toFixed(1)}× < ${volThreshold}×`, color: 'text-orange-400' };
  return { label: 'All clear — fires on candle close', color: 'text-trading-up' };
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
  const [aiConfirmations, setAiConfirmations] = useState<Record<string, AIResult>>({});
  const [loadingAi, setLoadingAi] = useState<string | null>(null);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [isBacktestOpen, setIsBacktestOpen]   = useState(false);
  const [btSymbol, setBtSymbol]               = useState("BTC/USDT");
  const [btDays, setBtDays]                   = useState(7);
  const [btLoading, setBtLoading]             = useState(false);
  const [btResult, setBtResult]               = useState<any>(null);

  const runBacktest = async () => {
    setBtLoading(true);
    setBtResult(null);
    try {
      const r = await fetch(`/api/backtest?symbol=${encodeURIComponent(btSymbol)}&days=${btDays}`);
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

  useEffect(() => {
    const fetchData = async () => {
      try {
        const scanRes = await fetch("/api/scan");
        const scanData = await scanRes.json();
        setScanResults(scanData.results);

        const balRes = await fetch("/api/balance");
        if (balRes.ok) {
          const balData = await balRes.json();
          setBalance(balData.total);
          setApiStatus(balData.status);
          if (balData.status === 'error') {
             addLog(`API ERROR: ${balData.error}`, 'error');
          }
        }

        const pnlRes = await fetch("/api/pnl-history");
        const pnlHistory = await pnlRes.json();
        setPnlData(pnlHistory);

        const historyRes = await fetch("/api/trade-history");
        const historyData = await historyRes.json();
        setTradeHistory(historyData);

        const posRes = await fetch("/api/open-positions");
        const posData = await posRes.json();
        setOpenPositions(posData.positions ?? []);
        if (posData.last_sync) setLastSync(posData.last_sync);
      } catch (err) {
        console.error("Failed to fetch data", err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const getAiConfirmation = async (symbol: string, data: any) => {
    setLoadingAi(symbol);
    addLog(`AI analyzing ${symbol} structure...`, "ai");
    try {
      const res = await fetch("/api/ai-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, data })
      });
      const result = await res.json();
      setAiConfirmations(prev => ({ ...prev, [symbol]: result }));
      addLog(`AI Verdict for ${symbol}: ${result.verdict} (${result.confidence}%)`, "ai");
    } catch (e) {
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
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[240px_1fr_280px] gap-[1px] bg-trading-border overflow-hidden">
        
        {/* Left Column: Execution Strategies */}
        <aside className="bg-trading-bg p-5 flex flex-col overflow-y-auto">
          <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px] mb-4 after:content-[''] after:flex-1 after:h-[1px] after:bg-trading-border after:ml-3">
            Strategies
          </div>
          <div className="space-y-3">
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
                    "p-3 rounded border transition-all",
                    strat.available ? "cursor-pointer" : "cursor-not-allowed opacity-40",
                    isEnabled
                      ? "bg-trading-card border-trading-accent shadow-[0_0_15px_rgba(0,209,255,0.1)]"
                      : strat.available
                        ? "bg-trading-card/50 border-trading-border hover:border-trading-muted"
                        : "bg-trading-card/30 border-trading-border"
                  )}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[12px] font-bold">{strat.name}</div>
                    {strat.available && (
                      <span className={cn(
                        "text-[8px] font-black uppercase tracking-wider border px-1.5 py-0.5 rounded",
                        isEnabled ? "text-trading-accent border-trading-accent/40" : "text-trading-muted border-trading-muted/40"
                      )}>
                        {isEnabled ? "ON" : "OFF"}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-trading-muted leading-tight">{strat.desc}</div>
                </div>
              );
            })}
          </div>

          <div className="mt-8 flex-1 flex flex-col">
            <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px] mb-4">
              Performance (USDT)
              <div className="flex-1 h-[1px] bg-trading-border" />
              <button
                onClick={async () => {
                  if (!confirm("Reset semua PnL history? Data paper trading akan dihapus.")) return;
                  await fetch("/api/pnl-history", { method: "DELETE" });
                  setPnlData([]);
                }}
                className="text-[9px] px-1.5 py-0.5 bg-trading-down/10 text-trading-down border border-trading-down/30 rounded hover:bg-trading-down/20 transition-colors font-bold uppercase tracking-wider"
              >
                Reset
              </button>
            </div>
            <div className="flex-1 min-h-[200px] bg-trading-card/30 border border-trading-border rounded p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={pnlData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1A1D23" vertical={false} />
                  <XAxis 
                    dataKey="time" 
                    hide 
                  />
                  <YAxis 
                    hide 
                    domain={['dataMin - 10', 'dataMax + 10']}
                  />
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
          </div>

          <div className="mt-auto pt-6 grid grid-cols-2 gap-[1px] bg-trading-border border border-trading-border">
            {[
              { label: 'Win Rate', val: '72.4%', color: 'text-trading-text' },
              { label: 'Trades/24h', val: '1,402', color: 'text-trading-text' },
              { label: 'Profit/Day', val: '+0.84%', color: 'text-trading-up' },
              { label: 'Drawdown', val: '-0.12%', color: 'text-trading-down' }
            ].map(stat => (
              <div key={stat.label} className="bg-trading-bg p-3 text-center">
                <div className="text-[9px] text-trading-muted uppercase">{stat.label}</div>
                <div className={cn("text-sm font-bold mt-1", stat.color)}>{stat.val}</div>
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
                : coin.momentumArb?.action !== 'HOLD' ? coin.momentumArb?.action : 'HOLD';
              return (
                <motion.div
                  key={coin.symbol}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-trading-card border border-trading-border p-4 rounded relative overflow-hidden group"
                >
                  {/* Accent Top Bar */}
                  <div className={cn(
                    "absolute top-0 left-0 w-full h-[2px] opacity-50",
                    bestAction === 'BUY' ? "bg-trading-up" : bestAction === 'SELL' ? "bg-trading-down" : "bg-trading-accent"
                  )} />

                  {/* Symbol + Price + Trend */}
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <div className="text-[11px] font-bold text-trading-muted">{coin.symbol}</div>
                      <div className="text-xl font-bold mt-1">${coin.price?.toLocaleString()}</div>
                    </div>
                    {coin.trend && (
                      <div className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase flex items-center gap-0.5",
                        coin.trend === 'UP'   ? "bg-trading-up/10 text-trading-up"
                      : coin.trend === 'DOWN' ? "bg-trading-down/10 text-trading-down"
                      :                         "bg-trading-muted/10 text-trading-muted"
                      )}>
                        {coin.trend === 'UP' ? '↑' : coin.trend === 'DOWN' ? '↓' : '—'} {coin.trend}
                      </div>
                    )}
                  </div>

                  {/* Strategy signal rows */}
                  <div className="space-y-1.5 mb-3">
                    {coin.ultraScalp && (() => {
                      const r = getBlockReason(coin.ultraScalp.action, coin.trend, coin.ultraScalp.volumeRatio, 1.0, isAutoPilot);
                      return (
                        <div className="rounded overflow-hidden">
                          <div className="flex items-center gap-1.5 bg-trading-bg/40 px-2 py-1.5">
                            <span className="text-trading-muted font-mono w-[68px] shrink-0 text-[9px] uppercase">Scalp 1m</span>
                            <span className={cn("px-1 py-0.5 rounded font-bold text-[9px]",
                              coin.ultraScalp.action === 'BUY'  ? "bg-trading-up/10 text-trading-up"
                            : coin.ultraScalp.action === 'SELL' ? "bg-trading-down/10 text-trading-down"
                            :                                      "bg-trading-muted/10 text-trading-muted"
                            )}>{coin.ultraScalp.action}</span>
                            <span className="text-[10px] text-trading-muted">RSI {coin.ultraScalp.rsi.toFixed(0)}</span>
                            {coin.ultraScalp.volumeRatio !== undefined && (
                              <span className={cn("ml-auto text-[9px] font-bold",
                                coin.ultraScalp.volumeRatio >= 1.5 ? "text-trading-up" : "text-trading-muted"
                              )}>V {coin.ultraScalp.volumeRatio.toFixed(1)}×</span>
                            )}
                          </div>
                          <div className={cn("px-2 pb-1.5 text-[8px] font-mono bg-trading-bg/40", r.color)}>
                            ↳ {r.label}
                          </div>
                        </div>
                      );
                    })()}
                    {coin.momentumArb && (() => {
                      const r = getBlockReason(coin.momentumArb.action, coin.trend, coin.momentumArb.volumeRatio, 1.0, isAutoPilot);
                      return (
                        <div className="rounded overflow-hidden">
                          <div className="flex items-center gap-1.5 bg-trading-bg/40 px-2 py-1.5">
                            <span className="text-trading-muted font-mono w-[68px] shrink-0 text-[9px] uppercase">Moment 5m</span>
                            <span className={cn("px-1 py-0.5 rounded font-bold text-[9px]",
                              coin.momentumArb.action === 'BUY'  ? "bg-trading-up/10 text-trading-up"
                            : coin.momentumArb.action === 'SELL' ? "bg-trading-down/10 text-trading-down"
                            :                                       "bg-trading-muted/10 text-trading-muted"
                            )}>{coin.momentumArb.action}</span>
                            <span className="text-[10px] text-trading-muted">RSI {coin.momentumArb.rsi.toFixed(0)}</span>
                            {coin.momentumArb.cross && (
                              <span className={cn("text-[9px] font-bold",
                                coin.momentumArb.cross === 'GOLDEN' ? "text-trading-up" : "text-trading-down"
                              )}>{coin.momentumArb.cross === 'GOLDEN' ? '↑GX' : '↓DX'}</span>
                            )}
                            {coin.momentumArb.volumeRatio !== undefined && (
                              <span className={cn("ml-auto text-[9px] font-bold",
                                coin.momentumArb.volumeRatio >= 1.2 ? "text-trading-up" : "text-trading-muted"
                              )}>V {coin.momentumArb.volumeRatio.toFixed(1)}×</span>
                            )}
                          </div>
                          <div className={cn("px-2 pb-1.5 text-[8px] font-mono bg-trading-bg/40", r.color)}>
                            ↳ {r.label}
                          </div>
                        </div>
                      );
                    })()}
                    {coin.meanRev && (() => {
                      const r = getBlockReason(coin.meanRev.action, coin.trend, coin.meanRev.volumeRatio, 0.8, isAutoPilot, true);
                      const bbColor = coin.meanRev.bbPos === 'LOWER' ? 'text-trading-up'
                                    : coin.meanRev.bbPos === 'UPPER' ? 'text-trading-down'
                                    : 'text-trading-muted';
                      return (
                        <div className="rounded overflow-hidden">
                          <div className="flex items-center gap-1.5 bg-trading-accent/5 border border-trading-accent/10 px-2 py-1.5">
                            <span className="text-trading-accent/70 font-mono w-[68px] shrink-0 text-[9px] uppercase">MeanRev 15m</span>
                            <span className={cn("px-1 py-0.5 rounded font-bold text-[9px]",
                              coin.meanRev.action === 'BUY'  ? "bg-trading-up/10 text-trading-up"
                            : coin.meanRev.action === 'SELL' ? "bg-trading-down/10 text-trading-down"
                            :                                   "bg-trading-muted/10 text-trading-muted"
                            )}>{coin.meanRev.action}</span>
                            <span className="text-[10px] text-trading-muted">RSI {coin.meanRev.rsi.toFixed(0)}</span>
                            {coin.meanRev.bbPos && (
                              <span className={cn("text-[9px] font-bold", bbColor)}>
                                BB:{coin.meanRev.bbPos}
                              </span>
                            )}
                            {coin.meanRev.volumeRatio !== undefined && (
                              <span className={cn("ml-auto text-[9px] font-bold",
                                coin.meanRev.volumeRatio >= 0.8 ? "text-trading-up" : "text-trading-muted"
                              )}>V {coin.meanRev.volumeRatio.toFixed(1)}×</span>
                            )}
                          </div>
                          <div className={cn("px-2 pb-1.5 text-[8px] font-mono bg-trading-accent/5", r.color)}>
                            ↳ {r.label}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* ATR + action buttons */}
                  <div className="flex gap-1 items-center flex-wrap">
                    {(coin.ultraScalp?.atrPct ?? 0) > 0 && (
                      <div className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold",
                        (coin.ultraScalp?.atrPct ?? 0) >= 0.3  ? "bg-trading-down/10 text-trading-down"
                      : (coin.ultraScalp?.atrPct ?? 0) >= 0.15 ? "bg-orange-400/10 text-orange-400"
                      :                                            "bg-trading-muted/10 text-trading-muted"
                      )}>ATR {coin.ultraScalp?.atrPct?.toFixed(2)}%</div>
                    )}
                    <div className="ml-auto flex gap-1">
                      <button
                        onClick={() => setExpandedCard(expandedCard === coin.symbol ? null : coin.symbol)}
                        className={cn(
                          "p-1.5 rounded transition-colors text-[10px] font-bold uppercase flex items-center gap-1",
                          expandedCard === coin.symbol ? "bg-trading-accent text-trading-bg" : "bg-trading-bg text-trading-muted hover:text-white"
                        )}
                      >
                        <Info className="w-3.5 h-3.5" />
                        {expandedCard === coin.symbol ? "Hide" : "Details"}
                      </button>
                      <button
                        onClick={() => getAiConfirmation(coin.symbol, coin)}
                        disabled={loadingAi === coin.symbol}
                        className="p-1.5 bg-trading-bg rounded text-trading-accent hover:text-white transition-colors disabled:opacity-50"
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
                        <div className="pt-4 mt-4 border-t border-trading-border space-y-3">
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

        {/* Right Column: AI Analysis & Logs */}
        <aside className="bg-trading-bg p-5 flex flex-col overflow-y-auto">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px] after:content-[''] after:w-8 after:h-[1px] after:bg-trading-border after:ml-3">
              Neural Insight
            </div>
            <button 
              onClick={() => setAiConfirmations({})} 
              className="text-[9px] text-trading-muted hover:text-trading-accent transition-colors uppercase font-bold tracking-widest"
            >
              Clear
            </button>
          </div>
          
          <div className="space-y-3 mb-6">
            <AnimatePresence mode="popLayout">
              {loadingAi && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-3 bg-trading-accent/5 border border-trading-accent/30 border-dashed rounded flex gap-3 items-center"
                >
                  <div className="w-3 h-3 border-2 border-trading-accent/30 border-t-trading-accent rounded-full animate-spin" />
                  <div className="text-[10px] font-bold text-trading-accent uppercase animate-pulse">Analyzing {loadingAi}...</div>
                </motion.div>
              )}
              {Object.entries(aiConfirmations).map(([symbol, result]) => {
                const res = result as AIResult;
                const isBuy = res.verdict.toUpperCase().includes('BUY');
                const isSell = res.verdict.toUpperCase().includes('SELL');
                
                return (
                  <motion.div 
                    key={symbol}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="p-4 bg-trading-card border border-trading-border rounded relative overflow-hidden shadow-xl"
                  >
                    {/* Background Glow */}
                    <div className={cn(
                      "absolute -right-4 -top-4 w-12 h-12 blur-2xl opacity-10 rounded-full",
                      isBuy ? "bg-trading-up" : isSell ? "bg-trading-down" : "bg-trading-accent"
                    )} />

                    <div className="flex justify-between items-center mb-2">
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          isBuy ? "bg-trading-up shadow-[0_0_8px_var(--color-trading-up)]" : 
                          isSell ? "bg-trading-down shadow-[0_0_8px_var(--color-trading-down)]" : 
                          "bg-trading-muted"
                        )} />
                        <span className="font-bold text-[11px] tracking-tight">{symbol}</span>
                      </div>
                      <span className="text-[9px] font-mono font-bold text-trading-accent px-1.5 py-0.5 bg-trading-accent/10 rounded">
                        {res.confidence}% CONFIDENCE
                      </span>
                    </div>

                    <div className={cn(
                      "text-[12px] font-black mb-1.5 uppercase tracking-wider",
                      isBuy ? "text-trading-up" : isSell ? "text-trading-down" : "text-trading-muted"
                    )}>
                      VERDICT: {res.verdict}
                    </div>

                    <div className="relative">
                      <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-trading-border" />
                      <p className="text-[10px] text-trading-muted italic leading-relaxed pl-3 py-1">
                        "{res.reason}"
                      </p>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {Object.keys(aiConfirmations).length === 0 && !loadingAi && (
              <div className="text-center py-12 opacity-30 border border-trading-border border-dashed rounded">
                <Bot className="w-8 h-8 mx-auto mb-3 opacity-20" />
                <div className="text-[9px] uppercase tracking-widest leading-relaxed">Neural Core Idle<br/>Await Confirmation Request</div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 text-[10px] uppercase text-trading-muted tracking-[2px] mb-4 after:content-[''] after:flex-1 after:h-[1px] after:bg-trading-border after:ml-3">
            Execution Log
          </div>
          <div className="flex-1 space-y-1.5 overflow-y-auto mb-6">
            {logs.map((log) => (
              <div key={log.id} className="text-[9px] flex justify-between border-b border-trading-border/50 pb-1 font-medium">
                <span className="text-trading-muted">{log.time.split(' ')[0]}</span>
                <span className={cn(
                  "uppercase",
                  log.type === 'error' && "text-trading-down",
                  log.type === 'success' && "text-trading-up",
                  log.type === 'ai' && "text-trading-accent"
                )}>
                  {log.msg.length > 25 ? log.msg.slice(0, 25) + '...' : log.msg}
                </span>
              </div>
            ))}
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
                <button
                  onClick={runBacktest}
                  disabled={btLoading}
                  className="px-4 py-1.5 bg-trading-accent text-trading-bg rounded text-[11px] font-black uppercase tracking-wider hover:bg-trading-accent/80 transition-colors disabled:opacity-50"
                >
                  {btLoading ? "Running..." : "Run Backtest"}
                </button>
                <span className="text-[10px] text-trading-muted">Uses real OHLCV from DB · Signal + Trend + Volume filters</span>
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
                    {/* Stats Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: "Win Rate",     value: `${btResult.stats.winRate}%`,           color: btResult.stats.winRate >= 50 ? "text-trading-up" : "text-trading-down" },
                        { label: "Total PnL",    value: `${btResult.stats.totalPnlPct > 0 ? "+" : ""}${btResult.stats.totalPnlPct}%`, color: btResult.stats.totalPnlPct >= 0 ? "text-trading-up" : "text-trading-down" },
                        { label: "Total Trades", value: btResult.stats.total,                   color: "text-trading-text" },
                        { label: "Max Drawdown", value: `-${btResult.stats.maxDrawdownPct}%`,   color: "text-trading-down" },
                        { label: "Wins",         value: btResult.stats.wins,                    color: "text-trading-up" },
                        { label: "Losses",       value: btResult.stats.losses,                  color: "text-trading-down" },
                        { label: "Avg Win",      value: `+${btResult.stats.avgWinPct}%`,        color: "text-trading-up" },
                        { label: "Avg Loss",     value: `${btResult.stats.avgLossPct}%`,        color: "text-trading-down" },
                      ].map(s => (
                        <div key={s.label} className="bg-trading-card border border-trading-border rounded p-3">
                          <div className="text-[9px] text-trading-muted uppercase tracking-wider mb-1">{s.label}</div>
                          <div className={cn("text-lg font-black", s.color)}>{s.value}</div>
                        </div>
                      ))}
                    </div>

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
    </div>
  );
}
