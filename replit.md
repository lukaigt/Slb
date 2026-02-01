# Solana Futures Trading Bot v4 (Drift Protocol)

## Overview
Adaptive perpetual futures trading bot using Drift Protocol on Solana mainnet. Features multi-timeframe analysis, simulation mode for paper trading, volatility filtering, memory-based learning with realistic shadow trade resolution, and a live web dashboard.

## Project Structure
```
├── slb-bot-futures/          # Adaptive Futures trading bot v4
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

## New Features (v4)

### Simulation Mode
- Paper trade without risking real money
- Set `SIMULATION_MODE=true` in .env
- All trades logged as "simulated" in memory
- Switch to live by changing to `SIMULATION_MODE=false`
- Memory carries over - bot uses learned patterns for live trading
- Note: Still requires RPC_URL for price data, but PRIVATE_KEY is optional

### Multi-Timeframe Analysis
- **Fast (30s)**: 20 data points, ~10 min to start
- **Medium (2m)**: 10 data points, ~20 min to start  
- **Slow (5m)**: 6 data points, ~30 min to start
- Bot requires consensus across timeframes before trading
- Scaled point requirements prevent forever-long warmup

### Volatility Filter
- Calculates price volatility across timeframes
- Skips trading when volatility > threshold (default 0.5%)
- Avoids choppy, unpredictable market conditions

### Smarter Shadow Trades
- Tracks actual price highs/lows after signal
- Simulates stop loss and take profit hits
- More realistic "what would have happened" results
- 30-minute timeout for unresolved shadows

### Heartbeat Watchdog
- Monitors bot activity every 60 seconds
- Detects freezes (no activity for 5 trading loops / ~2.5 min)
- Auto-reconnects Drift SDK on freeze detection
- Force restarts process if reconnection fails
- Prevents VPS from getting stuck indefinitely

### Live Web Dashboard
- Real-time bot status and market data
- **System Health panel**: Uptime, last heartbeat, connection indicators (RPC/Drift/DLOB)
- **Volatility Gauge**: Visual bar showing market volatility vs threshold
- **Best/Worst Trade display**: Highlights biggest win and loss
- **Alert Log**: Shows watchdog triggers, reconnections, warnings
- Timeframe signals display
- Session statistics (real + simulated)
- Recent trades table
- Pattern performance rankings
- Shadow trade tracking
- Auto-refreshes every 5 seconds

### Adaptive Learning
- Analyzes all past trades on startup
- Shows best/worst performing patterns
- Expected value calculation per pattern
- Time-weighted stats (recent trades count more)
- Requires 55%+ win rate AND positive expected value

## Trading Strategy

### Entry Logic
1. **Timeframe Consensus**: 2+ timeframes with signals must agree on the same direction
2. **Trend Following**: Buy dips in uptrend, sell rallies in downtrend
3. **Absorption Detection**: Contrarian signals in ranging markets
4. **Memory Check**: Pattern must have positive history (if available)
5. **Safety Checks**: Cooldown, consecutive loss limits, volatility filter

### Exit Logic
- **Stop-Loss**: 0.8% against position
- **Take-Profit**: 1.2% activates trailing
- **Trailing Normal**: 0.25% from peak
- **Trailing Danger**: 0.1% when market turns against

## Environment Variables
- SOLANA_RPC_URL: Helius RPC endpoint
- PRIVATE_KEY: Wallet private key (base58)
- LEVERAGE: Trading leverage (default: 50)
- SYMBOL: Market to trade (default: SOL-PERP)
- TRADE_AMOUNT_USDC: Position size in USDC
- SIMULATION_MODE: true for paper trading, false for real (default: true)
- IMBALANCE_THRESHOLD: Order book imbalance threshold (default: 0.15)
- VOLATILITY_THRESHOLD: Max volatility to trade (default: 0.5)
- STOP_LOSS_PERCENT: Stop loss percentage (default: 0.8)
- TAKE_PROFIT_ACTIVATION: TP activation percentage (default: 1.2)
- TRAILING_NORMAL: Normal trailing distance (default: 0.25)
- TRAILING_DANGER: Danger mode trailing (default: 0.1)
- COOLDOWN_SECONDS: Seconds between trades (default: 120)
- BASE_INTERVAL_MS: Base check interval in ms (default: 30000)
- DASHBOARD_PORT: Web dashboard port (default: 3000)

## Running the Bot

### Local/Replit
1. cd slb-bot-futures
2. npm install
3. cp .env.example .env
4. Edit .env with your settings (keep SIMULATION_MODE=true initially)
5. npm start
6. Open http://localhost:3000 for dashboard

### VPS Deployment
```bash
cd ~/Slb && git pull && cd slb-bot-futures && npm install && pkill -f "node index.js"; nohup npm start > bot.log 2>&1 & tail -f bot.log
```

### Accessing Dashboard on VPS
Open in browser: `http://YOUR_VPS_IP:3000`

## Workflow: Simulation → Live

1. **Start in simulation mode**: `SIMULATION_MODE=true`
2. **Run for 1-2 days**: Watch dashboard, let bot learn patterns
3. **Check results**: Look at simulated win rate and P&L
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
- 2026-02-01: v4 complete rewrite with multi-timeframe system
- 2026-02-01: Added simulation mode for paper trading
- 2026-02-01: Added volatility filter to skip choppy markets
- 2026-02-01: Smarter shadow trades that simulate SL/TP
- 2026-02-01: Built live web dashboard with detailed stats
- 2026-02-01: Adaptive learning analyzes memory on startup
- 2026-02-01: Scaled timeframe points (no more 50-hour warmup)
- 2026-02-01: Added expected value calculation to pattern analysis

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers only)
- Security is critical (no key exposure)
- Dashboard for monitoring is important
