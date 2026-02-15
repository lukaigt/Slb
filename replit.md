# Solana Futures Trading Bot v8 (Drift Protocol - Rule-Based Signals)

## Overview
Rule-based perpetual futures trading bot using Drift Protocol on Solana mainnet. Entry signals use **EMA 9/21 crossovers** on 5m timeframe with RSI filters, ADX>25 trend confirmation, 15m timeframe alignment, and ATR-based dynamic SL/TP. AI (GLM-4.7-Flash) still provides post-trade analysis. One position at a time across all markets. Fee-aware P&L (2% round-trip at 20x). Trades SOL-PERP, BTC-PERP, and ETH-PERP with 20x leverage. Safety layer with 10% daily loss limit.

## Project Structure
```
slb-bot-futures/
  index.js              # Main bot logic + dashboard + Drift connection
  ai_brain.js           # AI decision engine (GLM-4.7-Flash via OpenRouter)
  indicators.js          # Technical indicators (RSI, EMA, MACD, BB, ATR, StochRSI, ADX)
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
- Sends market data + technical indicators to GLM-4.7-Flash via OpenRouter API
- AI receives: price, trend, orderbook imbalance, volatility, recent prices, past trade results, 9 technical indicators across 3 timeframes
- AI responds with: action (LONG/SHORT/WAIT), stopLoss, takeProfit, confidence, reason, maxHoldMinutes
- System prompt teaches AI about 20x leverage, fees, risk management, and all 9 technical indicators with interpretation rules
- Phase 2: Retrieves similar past trades (by trend/volatility/imbalance) and includes lessons in prompt
- Each AI call costs fractions of a cent (~$0.50-1.00/day)
- All AI reasoning visible on dashboard

### Technical Indicators (indicators.js)
- 9 indicators calculated from on-chain oracle prices: RSI(14), EMA(9/21/50), MACD(12/26/9), Bollinger Bands(20,2), ATR(14), Stochastic RSI(14,14,3,3), ADX(14)
- 3 timeframes: 1-minute, 5-minute, 15-minute candles built from raw price data
- OHLC candles constructed from 15-second price samples
- Indicators progressively become available as enough data accumulates (ADX/MACD need ~35+ candles)
- Price history saved to disk every 5 minutes and on shutdown; loaded on startup with 1-hour max age filter

### Safety Layer (self_tuner.js)
Simple hard safety rules the AI cannot override:
- **20% daily loss limit** - bot pauses for the day if hit
- **8 consecutive losses** - bot pauses until reset
- Resets automatically at midnight UTC
- Manual unpause available

### Data Flow
1. Every 15s: Collect prices, orderbook data, calculate trend/volatility
2. Every 3 min (configurable): Send data + past trade memories to AI, get trading decision
3. Every 15s: Monitor open positions against AI's SL/TP/max hold time
4. Safety check before every trade attempt

### Trade Execution
- Uses Drift SDK for on-chain perp orders
- Supports simulation mode (paper trading) and live trading
- Position sync from chain on startup
- P&L-based stepped trailing TP (10%→0.25%, 15%→0.20%, 30%→0.15%, 50%→0.10%)
- Profit protection floor: trailing activates at 10% P&L regardless of AI's TP target
- Emergency SL/TP defaults (1.5%) auto-assigned when position has null values after restart
- Max hold time enforced (AI sets per trade, max 240 min)

## Environment Variables

### Required
- `OPENROUTER_API_KEY`: OpenRouter API key for GLM-4.7-Flash
- `SOLANA_RPC_URL`: Helius RPC endpoint
- `PRIVATE_KEY`: Wallet private key (base58) - only for live trading

### AI Settings
- `AI_MODEL`: AI model (default: z-ai/glm-4.7-flash)
- `AI_BASE_URL`: API base URL (default: https://openrouter.ai/api/v1)
- `AI_INTERVAL_MS`: How often to ask AI in ms (default: 180000 = 3 min)
- `MIN_CONFIDENCE`: Minimum AI confidence to trade (default: 0.6)

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
- 2026-02-15: v8 RULE-BASED REWRITE - Replaced AI-only entries with mathematical signal system (EMA crossover + RSI + ADX + ATR)
- 2026-02-15: CRITICAL BUG FIX - checkStopLoss treated SL=0 (breakeven) as falsy, silently disabling stop loss protection
- 2026-02-15: Fee-aware P&L - all P&L now subtracts 0.1% round-trip fees (2% at 20x leverage) for real profitability tracking
- 2026-02-15: One position at a time across ALL markets - eliminates correlated exposure risk
- 2026-02-15: Dynamic monitoring interval - 5s when position open, 15s when scanning for entries
- 2026-02-15: ATR-based dynamic SL (1.5x ATR capped at 1.0%) and TP (3x ATR with 2:1 R:R minimum)
- 2026-02-15: Signal generator in indicators.js with multi-timeframe confirmation rules
- 2026-02-14: CRITICAL SAFETY OVERHAUL - Max stop loss capped to 1.0% price move (=20% P&L max per trade, was 2.5%/50%)
- 2026-02-14: Emergency circuit breaker - force close any position at -25% P&L regardless of stop loss
- 2026-02-14: Hard-coded indicator gates - blocks trades when 15m ADX<20 (choppy), timeframes conflict, or price vs EMA50 disagrees with direction
- 2026-02-14: Enforced 2:1 minimum reward-to-risk ratio on all trades
- 2026-02-14: Daily loss limit tightened from -20% to -10%, consecutive losses limit from 8 to 4
- 2026-02-14: 15-minute cooldown after every losing trade per market
- 2026-02-14: Minimum AI confidence raised from 0.6 to 0.75
- 2026-02-14: AI check interval increased from 3min to 5min, cooldown from 3min to 10min
- 2026-02-13: Technical Indicators - 9 indicators (RSI, EMA 9/21/50, MACD, Bollinger Bands, ATR, StochRSI, ADX) across 3 timeframes (1m, 5m, 15m)
- 2026-02-13: AI system prompt rewritten to teach technical analysis, multi-timeframe confirmation rules, indicator-based entry/exit criteria
- 2026-02-13: Dashboard now shows full indicator table with color-coded values matching what AI sees
- 2026-02-13: Price history persistence for indicator continuity across restarts (saves every 5 min + on shutdown)
- 2026-02-13: AI max_tokens increased to 1500 for longer indicator-rich responses
- 2026-02-12: Phase 2 AI Memory - AI now retrieves similar past trades and their lessons before making decisions
- 2026-02-12: P&L-based trailing TP system - uses leverage-aware P&L% instead of raw price%, profit floor at 10% P&L
- 2026-02-12: Emergency SL/TP defaults (1.5% each) auto-assigned when position has null values after restart
- 2026-02-12: Position monitoring sped up from 30s to 15s for faster response at leverage
- 2026-02-12: All P&L calculations now leverage-aware (price move * leverage)
- 2026-02-12: AI prompt updated for 20x leverage with realistic TP targets (0.5-2.0% price move)
- 2026-02-12: Phase 1 Memory Recorder - stores market snapshots (trend, volatility, imbalance) with each trade for future AI learning
- 2026-02-12: Fixed crazy P&L display (977888%) - added sanity checks on entry price sync and P&L calculations
- 2026-02-12: Increased max hold time from 2h to 4h (AI can now hold trades longer)
- 2026-02-11: Stepped trailing TP - tightens from 0.3% at TP target to 0.1% at 35%+ profit to lock in big wins
- 2026-02-11: v7 AI-powered rewrite with GLM-4.7-Flash
- 2026-02-11: Removed old technical analysis, patterns, shadow trades
- 2026-02-11: AI sets dynamic SL/TP per trade based on market conditions
- 2026-02-11: Simplified safety layer (20% daily loss limit, 8 consecutive losses max)
- 2026-02-11: New dashboard showing AI reasoning and decisions
- 2026-02-11: Added axios for OpenRouter API calls
- 2026-02-11: Cleared old trade memory, starting fresh
- 2026-02-06: v6 Self-tuning engine (replaced by AI in v7)
- 2026-02-02: v5 Multi-market support (SOL, BTC, ETH)

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Tell the truth, never promise impossible things
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers / cheap models)
- Security is critical (no key exposure, keys in .env only)
- Dashboard for monitoring is important
- User deploys to VPS manually via GitHub (push here, pull on VPS)
