# Solana Futures Trading Bot v5 (Drift Protocol - Multi-Market)

## Overview
Adaptive perpetual futures trading bot using Drift Protocol on Solana mainnet. Now supports **multiple markets simultaneously** (SOL, BTC, ETH) with shared pattern learning and market-specific risk settings. Features multi-timeframe analysis, simulation mode for paper trading, volatility filtering, memory-based learning, and a live web dashboard.

## Project Structure
```
├── slb-bot-futures/          # Multi-market Futures trading bot v5
│   ├── index.js              # Main bot logic with dashboard
│   ├── package.json          # Node.js dependencies
│   ├── .env.example          # Environment variable template
│   ├── trade_memory.json     # Trade history & pattern stats (gitignored)
│   └── .gitignore            # Git ignore rules
│
├── old_spot_bot/             # OLD: Archived spot trading bot
│   ├── index.js              # Kraken WS + Jupiter swap logic
│   ├── package.json          # Old dependencies
│   └── .env.example          # Old config template
```

## New Features (v5)

### Multi-Market Trading
- Trade SOL-PERP, BTC-PERP, and ETH-PERP simultaneously
- Configure active markets via `ACTIVE_MARKETS` env variable
- Separate position tracking per market
- Independent timeframe data collection per market
- Markets processed sequentially each loop (no position conflicts)

### Shared Pattern Learning
- All markets contribute to the same pattern stats
- Patterns are based on imbalance type, trend, and price action
- Learning from one market helps improve trading on others
- Faster overall learning by 3x with shared data

### Market-Specific Risk Settings
- **SOL-PERP**: 0.8% stop loss, 1.2% take profit (more volatile)
- **BTC-PERP**: 0.5% stop loss, 0.8% take profit (less volatile)
- **ETH-PERP**: 0.6% stop loss, 1.0% take profit (medium)
- Customizable via environment variables
- Position size multipliers per market

### Enhanced Dashboard
- **Markets Overview table**: Price, mode, imbalance, volatility, position for each market
- Updated trades table shows which market each trade was on
- Shadow trades now tracked per market
- Connection status aggregated across all markets

### Previous Features (from v4)
- Simulation Mode (paper trading)
- Multi-Timeframe Analysis (30s, 2m, 5m)
- Volatility Filter
- Smarter Shadow Trades with SL/TP simulation
- Heartbeat Watchdog with auto-reconnect
- Adaptive Learning with time-weighted stats

## Trading Strategy

### Entry Logic
1. **Per-Market Analysis**: Each market analyzed independently
2. **Timeframe Consensus**: 2+ timeframes must agree on direction
3. **Trend Following**: Buy dips in uptrend, sell rallies in downtrend
4. **Absorption Detection**: Contrarian signals in ranging markets
5. **Shared Memory Check**: Pattern must have positive history across all markets
6. **Safety Checks**: Cooldown, consecutive loss limits, volatility filter

### Exit Logic (Market-Specific)
- **SOL-PERP**: Stop-Loss 0.8%, TP 1.2%, Trailing 0.25%
- **BTC-PERP**: Stop-Loss 0.5%, TP 0.8%, Trailing 0.15%
- **ETH-PERP**: Stop-Loss 0.6%, TP 1.0%, Trailing 0.20%

## Environment Variables

### Required
- `SOLANA_RPC_URL`: Helius RPC endpoint
- `PRIVATE_KEY`: Wallet private key (base58) - optional in simulation mode

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

### Market-Specific Risk (Optional)
- `SOL_STOP_LOSS`: SOL stop loss % (default: 0.8)
- `SOL_TAKE_PROFIT`: SOL TP activation % (default: 1.2)
- `BTC_STOP_LOSS`: BTC stop loss % (default: 0.5)
- `BTC_TAKE_PROFIT`: BTC TP activation % (default: 0.8)
- `ETH_STOP_LOSS`: ETH stop loss % (default: 0.6)
- `ETH_TAKE_PROFIT`: ETH TP activation % (default: 1.0)

### Dashboard
- `DASHBOARD_PORT`: Web dashboard port (default: 3000)

## Running the Bot

### Local/Replit
1. cd slb-bot-futures
2. npm install
3. cp .env.example .env
4. Edit .env with your settings (keep SIMULATION_MODE=true initially)
5. npm start
6. Open http://localhost:3000 for dashboard

### VPS Deployment (with auto-restart)
```bash
cd ~/Slb && git pull && cd slb-bot-futures && npm install && pkill -f "node index.js"; nohup npm start > bot.log 2>&1 & tail -f bot.log
```

### VPS with PM2 (recommended for production)
```bash
cd ~/Slb/slb-bot-futures && npm install
pm2 start index.js --name "drift-bot" --restart-delay=5000 --max-restarts=100
pm2 logs drift-bot
```

### Accessing Dashboard on VPS
Open in browser: `http://YOUR_VPS_IP:3000`

## Workflow: Simulation → Live

1. **Start in simulation mode**: `SIMULATION_MODE=true`
2. **Run for 1-2 days**: Watch dashboard, let bot learn patterns across all markets
3. **Check results**: Look at simulated win rate and P&L per market
4. **If good (>55% win rate, positive P&L)**:
   - Stop bot
   - Change to `SIMULATION_MODE=false`
   - Restart bot
5. **Bot now trades real money** using learned patterns

## Dependencies
- @drift-labs/sdk: Drift Protocol trading SDK
- @solana/web3.js: Solana blockchain SDK
- bs58: Base58 encoding for private keys
- dotenv: Environment variable management

## Recent Changes
- 2026-02-02: v5 Multi-market support (SOL, BTC, ETH)
- 2026-02-02: Shared pattern learning across markets
- 2026-02-02: Market-specific risk settings (stop loss, take profit)
- 2026-02-02: Enhanced dashboard with markets overview table
- 2026-02-02: Position tracking per market
- 2026-02-01: v4 complete rewrite with multi-timeframe system
- 2026-02-01: Added simulation mode for paper trading
- 2026-02-01: Added volatility filter to skip choppy markets
- 2026-02-01: Smarter shadow trades that simulate SL/TP
- 2026-02-01: Built live web dashboard with detailed stats

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers only)
- Security is critical (no key exposure)
- Dashboard for monitoring is important
