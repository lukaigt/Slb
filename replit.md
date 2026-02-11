# AI Solana Futures Trading Bot v7 (Drift Protocol - GLM-4.7 Flash)

## Overview
AI-powered perpetual futures trading bot using Drift Protocol on Solana mainnet. All trading decisions (entries, exits, stop losses, take profits) are made by **GLM-4.7-Flash** AI model via OpenRouter. Trades SOL-PERP, BTC-PERP, and ETH-PERP with 50x leverage. Safety layer with 20% daily loss limit.

## Project Structure
```
slb-bot-futures/
  index.js              # Main bot logic + dashboard + Drift connection
  ai_brain.js           # AI decision engine (GLM-4.7-Flash via OpenRouter)
  self_tuner.js          # Safety layer (daily loss limit, consecutive loss pause)
  bot_config.json        # Safety config (auto-generated, gitignored)
  trade_memory.json      # Trade history (gitignored)
  package.json           # Node.js dependencies
  .env.example           # Environment variable template
  .gitignore             # Git ignore rules

old_spot_bot/            # OLD: Archived spot trading bot (not used)
```

## Architecture

### AI Brain (ai_brain.js)
- Sends market data to GLM-4.7-Flash via OpenRouter API
- AI receives: price, trend, orderbook imbalance, volatility, recent prices, past trade results
- AI responds with: action (LONG/SHORT/WAIT), stopLoss, takeProfit, confidence, reason, maxHoldMinutes
- System prompt teaches AI about 50x leverage, fees, risk management
- Each AI call costs fractions of a cent (~$0.50-1.00/day)
- All AI reasoning visible on dashboard

### Safety Layer (self_tuner.js)
Simple hard safety rules the AI cannot override:
- **20% daily loss limit** - bot pauses for the day if hit
- **8 consecutive losses** - bot pauses until reset
- Resets automatically at midnight UTC
- Manual unpause available

### Data Flow
1. Every 30s: Collect prices, orderbook data, calculate trend/volatility
2. Every 3 min (configurable): Send data to AI, get trading decision
3. Every 30s: Monitor open positions against AI's SL/TP/max hold time
4. Safety check before every trade attempt

### Trade Execution
- Uses Drift SDK for on-chain perp orders
- Supports simulation mode (paper trading) and live trading
- Position sync from chain on startup
- Trailing take profit with 0.3% trailing distance
- Max hold time enforced (AI sets per trade, max 120 min)

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
- `LEVERAGE`: Trading leverage (default: 50)
- `TRADE_AMOUNT_USDC`: Position size in USDC per market (default: 10)
- `ACTIVE_MARKETS`: Comma-separated list (default: SOL-PERP,BTC-PERP,ETH-PERP)
- `SIMULATION_MODE`: true for paper trading, false for real (default: true)
- `CHECK_INTERVAL_MS`: Position monitoring interval (default: 30000 = 30s)
- `COOLDOWN_SECONDS`: Seconds between trades per market (default: 180)

### Safety Limits
- `DAILY_LOSS_LIMIT`: Max daily loss % before pause (default: 20)
- `MAX_CONSECUTIVE_LOSSES`: Max losing streak before pause (default: 8)

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
