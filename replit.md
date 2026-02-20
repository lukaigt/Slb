# Solana Futures Trading Bot v9 (Drift Protocol - AI-Driven with S/R + Trap Detection)

## Overview
AI-driven perpetual futures trading bot using Drift Protocol on Solana mainnet. GLM-4.7-Flash makes all entry decisions using 9 technical indicators across 3 timeframes, support/resistance levels, candle pattern analysis, trap detection, and portfolio context. All 3 markets (SOL-PERP, BTC-PERP, ETH-PERP) can have simultaneous positions. Fee-aware P&L (2% round-trip at 20x). Multi-layered safety: 1.0% max SL cap, -25% circuit breaker, stepped profit locking, 10% daily loss limit.

## Project Structure
```
slb-bot-futures/
  index.js              # Main bot logic + dashboard + Drift connection
  ai_brain.js           # AI decision engine (GLM-4.7-Flash via OpenRouter)
  indicators.js          # Technical indicators, S/R calculator, candle pattern analyzer
  self_tuner.js          # Safety layer (daily loss limit, consecutive loss pause)
  bot_config.json        # Safety config (auto-generated, gitignored)
  trade_memory.json      # Trade history (gitignored)
  price_history.json     # Saved price data for indicator persistence (gitignored)
  package.json           # Node.js dependencies
  .env.example           # Environment variable template
  .gitignore             # Git ignore rules

old_spot_bot/            # OLD: Archived spot trading bot (not used)
```

## Architecture

### AI Brain (ai_brain.js)
- AI makes ALL entry decisions (LONG/SHORT/WAIT) with full market context
- AI receives: price, trend, orderbook imbalance, volatility, recent prices, 9 indicators across 3 timeframes, support/resistance levels with strength, candle patterns, open positions on other markets, daily P&L context, BTC trend correlation, past trade lessons
- AI responds with: action (LONG/SHORT/WAIT), stopLoss, takeProfit, confidence, reason, maxHoldMinutes
- Comprehensive system prompt teaches: indicators, S/R usage, trap detection (bull/bear traps, stop hunts), wick analysis, momentum exhaustion, volatility regimes, correlation awareness, dynamic SL/TP anchoring to S/R and ATR
- Past trade memory: retrieves similar trades (by trend/volatility/imbalance) and includes lessons
- Each AI call costs fractions of a cent (~$1-2/day total)
- All AI reasoning visible on dashboard

### Technical Indicators (indicators.js)
- 9 indicators: RSI(14), EMA(9/21/50), MACD(12/26/9), Bollinger Bands(20,2), ATR(14), Stochastic RSI(14,14,3,3), ADX(14)
- 3 timeframes: 1-minute, 5-minute, 15-minute candles built from raw price data
- **Support/Resistance Calculator**: Detects swing highs/lows, clusters nearby levels (0.3% threshold), counts touches for strength (WEAK/MODERATE/STRONG), returns top 3 support + top 3 resistance with distance from current price
- **Candle Pattern Analyzer**: Detects doji, shooting star, hammer, bullish/bearish engulfing, upper/lower wick rejections from last 5 candles on 5m timeframe
- OHLC candles constructed from 15-second price samples
- Price history saved to disk every 5 minutes and on shutdown; loaded on startup with 16-hour max age filter

### Safety Layer (self_tuner.js)
Hard safety rules the AI cannot override:
- **10% daily loss limit** - bot pauses for the day if hit
- **4 consecutive losses** - bot pauses until reset
- Resets automatically at midnight UTC
- Manual unpause available

### Data Flow
1. Every 15s: Collect prices, orderbook data, calculate trend/volatility, compute indicators, S/R levels, candle patterns
2. Every 3 min (configurable): Send full data packet to AI (indicators + S/R + candles + portfolio context + BTC trend + past trades), get trading decision
3. Every 15s: Monitor open positions against SL/TP/trailing/circuit breaker/max hold time
4. Safety check before every trade attempt

### Trade Execution
- Uses Drift SDK for on-chain perp orders
- Supports simulation mode (paper trading) and live trading
- Position sync from chain on startup
- All 3 markets can have positions simultaneously (no position limit)
- Dynamic SL/TP anchored to S/R levels and ATR per trade
- Stepped profit protection: +5% P&L → breakeven, +8% → lock +3%, +12% → lock +6%, +20% → lock +12%
- P&L-based trailing TP (10%→0.25%, 15%→0.20%, 30%→0.15%, 50%→0.10%)
- Emergency SL/TP defaults (0.75%/1.5%) auto-assigned when position has null values after restart
- Time-based decay: close stagnant positions after 30 min with <2% P&L
- Max hold time enforced (AI sets per trade, max 240 min)
- Emergency circuit breaker: force close at -25% P&L

## Environment Variables

### Required
- `OPENROUTER_API_KEY`: OpenRouter API key for GLM-4.7-Flash
- `SOLANA_RPC_URL`: Helius RPC endpoint
- `PRIVATE_KEY`: Wallet private key (base58) - only for live trading

### AI Settings
- `AI_MODEL`: AI model (default: z-ai/glm-4.7-flash)
- `AI_BASE_URL`: API base URL (default: https://openrouter.ai/api/v1)
- `AI_INTERVAL_MS`: How often to ask AI in ms (default: 180000 = 3 min)
- `MIN_CONFIDENCE`: Minimum AI confidence to trade (default: 0.75)

### Trading Settings
- `LEVERAGE`: Trading leverage (default: 20)
- `TRADE_AMOUNT_USDC`: Position size in USDC per market (default: 10)
- `ACTIVE_MARKETS`: Comma-separated list (default: SOL-PERP,BTC-PERP,ETH-PERP)
- `SIMULATION_MODE`: true for paper trading, false for real (default: true)
- `CHECK_INTERVAL_MS`: Position monitoring interval (default: 15000 = 15s)
- `COOLDOWN_SECONDS`: Seconds between trades per market (default: 600)

### Safety Limits
- `DAILY_LOSS_LIMIT`: Max daily loss % before pause (default: 10)
- `MAX_CONSECUTIVE_LOSSES`: Max losing streak before pause (default: 4)

### Dashboard
- `DASHBOARD_PORT`: Web dashboard port (default: 3000, Replit uses 5000)

## Running the Bot

### Replit
Workflow configured: `cd slb-bot-futures && DASHBOARD_PORT=5000 node index.js`

### VPS Deployment (PM2 recommended)
```bash
cd ~/Slb/slb-bot-futures && npm install
pm2 start index.js --name "drift-bot" --restart-delay=5000 --max-restarts=100
pm2 logs drift-bot
```

### VPS Quick Deploy
```bash
cd ~/Slb && git pull && cd slb-bot-futures && npm install && pkill -f "node index.js"; nohup npm start > bot.log 2>&1 & tail -f bot.log
```

## Dashboard
Dark theme dashboard showing:
- **System Health**: Uptime, connections, mode, AI model, safety status
- **Markets Overview**: Price, trend, imbalance, volatility, position, P&L, AI's SL/TP, hold time
- **Support/Resistance & Candle Patterns**: S/R levels with strength and touches, detected candle patterns per market
- **Technical Indicators**: Full 9-indicator table across 3 timeframes with color-coded values
- **Session Stats**: Win rate, P&L, total trades
- **Daily Safety**: Daily P&L vs limit, consecutive losses, pause status
- **Best/Worst Trade**: Quick reference
- **AI Brain Live Decisions**: Color-coded log of every AI decision with reasoning
- **Recent Trades**: Entry/exit prices, P&L, exit reason, hold time, AI reasoning

## Dependencies
- @drift-labs/sdk: Drift Protocol trading SDK
- @solana/web3.js: Solana blockchain SDK
- axios: HTTP client for OpenRouter API calls
- bs58: Base58 encoding for private keys
- dotenv: Environment variable management

## Recent Changes
- 2026-02-20: v9 AI-DRIVEN REWRITE - Restored full AI entry decisions, removed rule-based EMA crossover system
- 2026-02-20: Support/Resistance calculator - detects swing highs/lows, clusters levels, counts touches for strength
- 2026-02-20: Candle pattern analyzer - doji, shooting star, hammer, engulfing, wick rejections
- 2026-02-20: Comprehensive AI prompt rewrite - S/R awareness, trap detection (bull/bear traps, stop hunts), wick analysis, momentum exhaustion, volatility regimes, correlation awareness, dynamic SL/TP anchoring
- 2026-02-20: Enhanced market data packet - S/R levels, candle patterns, other market positions, daily P&L context, BTC trend correlation
- 2026-02-20: Removed position limit - all 3 markets can trade simultaneously
- 2026-02-20: Stepped profit protection - +5% breakeven, +8% lock +3%, +12% lock +6%, +20% lock +12%
- 2026-02-20: Dashboard shows S/R levels and candle patterns per market
- 2026-02-15: v8 RULE-BASED REWRITE - Replaced AI-only entries with mathematical signal system (EMA crossover + RSI + ADX + ATR)
- 2026-02-15: CRITICAL BUG FIX - checkStopLoss treated SL=0 (breakeven) as falsy, silently disabling stop loss protection
- 2026-02-15: Fee-aware P&L - all P&L now subtracts 0.1% round-trip fees (2% at 20x leverage) for real profitability tracking
- 2026-02-15: ATR-based dynamic SL (1.5x ATR capped at 1.0%) and TP (3x ATR with 2:1 R:R minimum)
- 2026-02-14: CRITICAL SAFETY OVERHAUL - Max stop loss capped to 1.0% price move (=20% P&L max per trade)
- 2026-02-14: Emergency circuit breaker - force close any position at -25% P&L regardless of stop loss
- 2026-02-14: Enforced 2:1 minimum reward-to-risk ratio on all trades
- 2026-02-14: Daily loss limit tightened from -20% to -10%, consecutive losses limit from 8 to 4
- 2026-02-14: 15-minute cooldown after every losing trade per market
- 2026-02-14: Minimum AI confidence raised from 0.6 to 0.75
- 2026-02-13: Technical Indicators - 9 indicators across 3 timeframes (1m, 5m, 15m)
- 2026-02-13: Price history persistence for indicator continuity across restarts
- 2026-02-12: Phase 2 AI Memory - retrieves similar past trades and lessons
- 2026-02-12: P&L-based trailing TP system
- 2026-02-12: Phase 1 Memory Recorder
- 2026-02-11: v7 AI-powered rewrite with GLM-4.7-Flash

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Tell the truth, never promise impossible things
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers / cheap models)
- Security is critical (no key exposure, keys in .env only)
- Dashboard for monitoring is important
- User deploys to VPS manually via GitHub (push here, pull on VPS)
