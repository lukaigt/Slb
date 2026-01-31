# Solana Futures Trading Bot (Drift Protocol)

## Overview
Smart perpetual futures trading bot using Drift Protocol on Solana mainnet. Uses Order Book Imbalance + CVD + VWAP for intelligent entries, with dynamic danger mode for exits.

## Project Structure
```
├── slb-bot-futures/          # Smart Futures trading bot
│   ├── index.js              # Main bot logic with smart strategy
│   ├── package.json          # Node.js dependencies
│   ├── .env.example          # Environment variable template
│   ├── README.md             # Deployment documentation
│   └── .gitignore            # Git ignore rules
│
├── old_spot_bot/             # OLD: Archived spot trading bot
│   ├── index.js              # Kraken WS + Jupiter swap logic
│   ├── package.json          # Old dependencies
│   └── .env.example          # Old config template
```

## Trading Strategy (v2 - Smart Bot)

### Entry Logic (All 4 must be TRUE)
1. **Order Book Imbalance**: >25% buyers for LONG, >25% sellers for SHORT
2. **Imbalance Trend**: Consistently bullish (RISING) for LONG, consistently bearish (FALLING) for SHORT
3. **Price Position**: Price at/below average for LONG, at/above average for SHORT
4. **Cooldown**: No trade in last 2 minutes

### Exit Logic
- **Stop-Loss**: 0.5% price move against position
- **Take-Profit Activation**: 0.4% price move in favor
- **Trailing (Normal Mode)**: 0.15% from peak
- **Trailing (Danger Mode)**: 0.05% from peak (when reversal signals appear)

### Danger Mode
Activates when:
- In LONG and order book flips bearish OR CVD starts falling
- In SHORT and order book flips bullish OR CVD starts rising
Effect: Tightens trailing stop from 0.15% to 0.05%

### Data Sources (All Free)
- **Order Book**: Drift DLOB API (https://dlob.drift.trade)
- **Price**: Drift SDK via Pyth oracle
- **Imbalance Trend**: Tracks order book imbalance over time (real data)
- **Price Average**: Simple moving average of price (50 periods)

## Environment Variables
- SOLANA_RPC_URL: Helius RPC endpoint (free tier)
- PRIVATE_KEY: Wallet private key (base58)
- LEVERAGE: Trading leverage (default: 50, Drift may limit to 20x)
- SYMBOL: Market to trade (default: SOL-PERP)
- TRADE_AMOUNT_USDC: Position size in USDC
- IMBALANCE_THRESHOLD: Order book imbalance needed (default: 0.25)
- CVD_LOOKBACK: Periods to check CVD trend (default: 5)
- VWAP_PERIOD: Candles for VWAP calculation (default: 50)
- STOP_LOSS_PERCENT: Max loss before exit (default: 0.5)
- TAKE_PROFIT_ACTIVATION: Profit to activate trailing (default: 0.4)
- TRAILING_NORMAL: Normal trailing distance (default: 0.15)
- TRAILING_DANGER: Tight trailing distance (default: 0.05)
- COOLDOWN_SECONDS: Seconds between trades (default: 120)
- CHECK_INTERVAL_MS: Check frequency in ms (default: 5000)

## Running the Bot
1. cd slb-bot-futures
2. npm install
3. cp .env.example .env
4. Edit .env with your Helius RPC and private key
5. npm start

## VPS Deployment
```bash
cd ~/Slb && git pull && cd slb-bot-futures && npm install && pkill -f "node index.js"; nohup npm start > bot.log 2>&1 & tail -f bot.log
```

## Dependencies
- @drift-labs/sdk: Drift Protocol trading SDK
- @solana/web3.js: Solana blockchain SDK
- bs58: Base58 encoding for private keys
- dotenv: Environment variable management

## Recent Changes
- 2026-01-31: Complete rewrite with Order Book + CVD + VWAP strategy
- 2026-01-31: Added Danger Mode for smart exits
- 2026-01-31: Integrated Drift DLOB API for real-time order book
- 2026-01-31: Removed EMA/RSI/Bollinger (replaced with order flow)
- 2026-01-30: Created initial Drift Protocol integration

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers only)
- Security is critical (no key exposure)
