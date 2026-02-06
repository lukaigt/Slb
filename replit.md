# Solana Futures Trading Bot v6 (Drift Protocol - Self-Tuning)

## Overview
Self-adaptive perpetual futures trading bot using Drift Protocol on Solana mainnet. Trades **multiple markets simultaneously** (SOL, BTC, ETH) with a **self-tuning engine** that automatically adjusts stop losses, take profits, pattern selections, cooldowns, position sizing, and timing based on real performance data. The bot writes to its own configuration file (bot_config.json) and makes all decisions visible on a live dashboard.

## Project Structure
```
slb-bot-futures/
  index.js              # Main bot logic + dashboard (v6)
  self_tuner.js          # Self-tuning engine (63 rules, 9 categories)
  bot_config.json        # Auto-generated config (written by self-tuner)
  trade_memory.json      # Trade history & pattern stats (gitignored)
  package.json           # Node.js dependencies
  .env.example           # Environment variable template
  .gitignore             # Git ignore rules

old_spot_bot/            # OLD: Archived spot trading bot (not used)
```

## Architecture

### Self-Tuning Engine (self_tuner.js)
Separate module that reads AND writes `bot_config.json`. Contains 63 adaptive rules across 9 categories:

1. **Stop Loss Tuning** - Widens/tightens stops based on stop-out rate
2. **Take Profit Optimization** - Adjusts TP based on win rate and shadow trade comparison
3. **Pattern Management** - Disables patterns below 45% win rate, direction-locks others
4. **Time-of-Day Awareness** - Blocks unprofitable hours (UTC)
5. **Streak Handling** - Caution mode on losing streaks, cooldown multipliers
6. **Market Selection** - Pauses markets below 35% win rate
7. **Volatility Response** - Multipliers for SL in high/low volatility
8. **Position Sizing** - Reduces size after losses, increases after winning streaks
9. **Cooldown Adjustment** - Adapts cooldown based on recent performance

### How Self-Tuning Works
- Runs tuning cycle every 20 trades (configurable)
- Reads trade history, shadow trades, and pattern stats
- Applies rules and writes changes to bot_config.json
- Every decision is logged to "thinking log" visible on dashboard
- Caution mode: Activates if daily loss exceeds 3% or win rate drops below 35%

### Integration Points
- `shouldTrade()` - Called before every entry, can block trades or adjust size
- `getEffectiveStopLoss()` - Returns adjusted SL based on config + volatility
- `getEffectiveTakeProfit()` - Returns adjusted TP from config
- `getEffectiveTrailing()` - Returns trailing stop distance
- `isMarketEnabled()` - Checks if market is paused by tuner
- `think()` - Logs decisions with categories and colors

## Trading Strategy

### Entry Logic
1. Per-market analysis with multi-timeframe consensus (30s, 2m, 5m)
2. Trend following: Buy dips in uptrend, sell rallies in downtrend
3. Absorption detection in ranging markets
4. Shared memory check: Pattern must have positive history
5. Self-tuner gate: Checks disabled patterns, blocked hours, caution mode, market pause
6. Position size adjusted by confidence and self-tuner multiplier

### Exit Logic (Self-Tuning Defaults)
- **SOL-PERP**: Stop-Loss 1.5%, TP 2.5%, Trailing 0.4%
- **BTC-PERP**: Stop-Loss 1.0%, TP 1.8%, Trailing 0.3%
- **ETH-PERP**: Stop-Loss 1.2%, TP 2.0%, Trailing 0.35%
- All values auto-adjusted by self-tuner based on performance

### Shadow Trade Learning
- Shadow trades use 3x wider stops than real trades
- Tests "what would happen if held longer"
- Self-tuner compares shadow vs real results to decide whether to widen stops

## Dashboard (v6)
Full-width, dark theme dashboard with:
- **System Health**: Uptime, connections, mode, caution status
- **Markets Overview**: Price, mode, imbalance, volatility, position, entry price, P&L, SL/TP, enabled/paused status
- **Session Stats**: Win rate, P&L, daily P&L, disabled patterns count
- **Best/Worst Trade**: Quick reference
- **Bot Thinking (Live)**: Color-coded decision log showing every reasoning step
- **Top Patterns**: With enabled/disabled/direction-locked status
- **Recent Trades**: With entry/exit prices, pattern used, exit reason
- **Shadow Trades**: With hypothetical results
- **Self-Tuning Changes Log**: Every config change with before/after values and reasons

## Environment Variables

### Required
- `SOLANA_RPC_URL`: Helius RPC endpoint
- `PRIVATE_KEY`: Wallet private key (base58)

### Trading Settings
- `LEVERAGE`: Trading leverage (default: 50)
- `TRADE_AMOUNT_USDC`: Base position size in USDC per market (default: 10)
- `ACTIVE_MARKETS`: Comma-separated list (default: SOL-PERP,BTC-PERP,ETH-PERP)
- `SIMULATION_MODE`: true for paper trading, false for real (default: true)

### Global Thresholds
- `IMBALANCE_THRESHOLD`: Order book imbalance threshold (default: 0.15)
- `VOLATILITY_THRESHOLD`: Max volatility to trade (default: 0.5%)
- `COOLDOWN_SECONDS`: Seconds between trades per market (default: 120)
- `BASE_INTERVAL_MS`: Base check interval in ms (default: 30000)

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

## Dependencies
- @drift-labs/sdk: Drift Protocol trading SDK
- @solana/web3.js: Solana blockchain SDK
- bs58: Base58 encoding for private keys
- dotenv: Environment variable management

## Recent Changes
- 2026-02-06: v6 Self-tuning engine (63 rules, 9 categories)
- 2026-02-06: Bot Thinking dashboard section (live decision log)
- 2026-02-06: Self-tuning changes log on dashboard
- 2026-02-06: Entry/exit prices shown in trade history
- 2026-02-06: Market pause/enable by self-tuner
- 2026-02-06: Pattern disable/direction-lock system
- 2026-02-06: Caution mode (blocks low-confidence trades)
- 2026-02-06: Fixed Chinese character display (UTF-8 charset)
- 2026-02-06: Dashboard v6 redesign with GitHub-dark theme
- 2026-02-02: v5 Multi-market support (SOL, BTC, ETH)
- 2026-02-01: v4 complete rewrite with multi-timeframe system

## User Preferences
- Always ask before modifying code ("Don't modify anything yet, talk to me")
- Explain every decision in detail
- Tell the truth, never promise impossible things
- Only give current/accurate information
- Consider all implications of changes
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers only)
- Security is critical (no key exposure)
- Dashboard for monitoring is important
- User deploys to VPS manually via GitHub
