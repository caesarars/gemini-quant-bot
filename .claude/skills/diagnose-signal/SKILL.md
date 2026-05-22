---
name: diagnose-signal
description: Explain why the bot isn't trading a specific symbol/strategy by hitting /api/diagnose and decoding which filter is blocking. Use whenever the user asks "why didn't BTC fire?", "why is MEAN-REV not trading?", "what's blocking SOL?", or similar.
---

# diagnose-signal

The bot's `/api/diagnose` endpoint returns a per-symbol breakdown of every strategy's current signal and — critically — the human-readable `block` string explaining why an order wasn't placed. This skill drives that endpoint and translates the result.

## Procedure

1. **Hit the endpoint.** The dev server runs on `http://localhost:3000` (or `http://localhost:8080` when running via docker compose). Use whichever the user has running:

   ```bash
   curl -s http://localhost:3000/api/diagnose | jq .
   ```

   If `curl` fails with connection refused, ask the user to start the server (`npm run dev`) or check which port their stack is on. Don't start it yourself unless they ask.

2. **Filter to the symbol(s) the user asked about.** The response shape is:

   ```json
   {
     "isAutoPilot": false,
     "fearGreed": { "value": 42, ... },
     "results": [
       {
         "symbol": "BTC/USDT",
         "trend": "UP" | "DOWN" | "NEUTRAL",
         "regime": "TRENDING" | "RANGING",
         "adx": 28.4,
         "buffers": { "1m": 200, "5m": 200, "15m": 200 },
         "cooldownBlocking": false,
         "context": { "fundingRate": "0.0123%", "oiChangePct": 1.4, "lsRatio": 1.8 },
         "strategies": {
           "ULTRA-SCALP":  { "action": "BUY", "rsi": 62, "vol": 1.3, "atrPct": 0.4, "block": "PASS ✓ ..." },
           "MOMENTUM-ARB": { "action": "BUY", ..., "block": "trend DOWN (need UP)" },
           "MEAN-REV":     { "action": "HOLD", ..., "block": "HOLD signal" }
         }
       }
     ]
   }
   ```

3. **Decode the `block` field.** It's already human-readable, but here's what each blocker means:

   | Block message starts with | Meaning | How to unblock |
   |---|---|---|
   | `autopilot OFF` | Auto-pilot toggle is off in the dashboard. | Flip auto-pilot ON. Nothing else matters until you do. |
   | `HOLD signal` | The strategy's own indicators didn't produce a BUY/SELL this tick. | Not a filter problem — the math just doesn't see a setup. Wait for the next candle. |
   | `REGIME ... mean-rev disabled` / `momentum disabled` | ADX-based regime filter: MEAN-REV is locked out in trending markets (ADX high), MOMENTUM-ARB is locked out in ranging markets (ADX low). | Wait for regime to shift, or use the other strategy. |
   | `trend DOWN (need UP)` / `trend NEUTRAL` | MOMENTUM-ARB's 15m EMA200 trend filter. Only affects MOMENTUM-ARB. | Wait for 15m trend to align with signal direction. |
   | `vol X× < Y×` | Volume ratio under threshold (0.5× scalp, 1.0× momentum, 0.8× mean-rev). | Wait for a higher-volume candle. |
   | `funding +X% > 0.05%` / `funding X% < -0.03%` | Funding rate too extreme in the same direction as the trade (avoid trading into a crowded position). | Wait for funding to normalize. |
   | `F&G ... extreme greed/fear` | Fear & Greed index gate — blocks BUYs above 85, SELLs below 15. MEAN-REV has tighter gates (75/25). | Wait for sentiment to cool. |
   | `OI X% falling` | Open interest collapsing — typically a sign the trend is unwinding. | Wait for OI to stabilize. |
   | `L/S X > 2.5` / `< 0.4` | Long/short ratio extreme — crowd is already on this side. | Wait for ratio to normalize. |
   | `score X < 3.0` | Internal signal-strength score under threshold. | Wait for a stronger setup. |
   | `COOLDOWN — open trade within window` | An open trade for this symbol+strategy is still inside its cooldown (5m scalp, 15m momentum, 30m mean-rev). | Either wait, or close the position via the dashboard. |
   | `PASS ✓` | All filters cleared — order *should* fire on next tick. If it isn't, also check `/api/cooldown-status` and the activity log. |

4. **Report concisely.** Lead with the answer — "MEAN-REV on BTC/USDT is blocked because ADX is 32 (regime is TRENDING)" — then show the relevant raw row only if the user wants detail. Don't dump the whole JSON unless asked.

## Common follow-ups

- **"Why isn't ANYTHING trading?"** — check `isAutoPilot` first. If false, that's the whole answer.
- **"It says PASS but still no trade."** — also hit `/api/cooldown-status` (cooldown is checked separately from the filter chain) and check the activity log in the UI.
- **"Buffers are 0."** — the WebSocket hasn't seeded candles yet. Either the server just started (give it 30s) or the WS connection dropped (check server logs).
- **"Same filter blocks every symbol every time."** — the threshold is probably miscalibrated for current market conditions. Hit `/api/threshold-analysis?hours=72` for a percentile breakdown per symbol and recommended adjustments. The endpoint replays each indicator over recent OHLCV history and tells you where the current threshold sits in the distribution.
