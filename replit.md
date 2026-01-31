# Solana Futures Trading Bot (Drift Protocol)

## Overview
Adaptive perpetual futures trading bot using Drift Protocol on Solana mainnet. Features market mode detection, memory-based learning, and adaptive strategy that trades WITH trends and uses contrarian absorption signals in ranging markets.

## Project Structure
```
├── slb-bot-futures/          # Adaptive Futures trading bot
│   ├── index.js              # Main bot logic with learning system
│   ├── package.json          # Node.js dependencies
│   ├── .env.example          # Environment variable template
│   ├── trade_memory.json     # Trade history & pattern stats (auto-created)
│   └── .gitignore            # Git ignore rules
│
├── old_spot_bot/             # OLD: Archived spot trading bot
│   ├── index.js              # Kraken WS + Jupiter swap logic
│   ├── package.json          # Old dependencies
│   └── .env.example          # Old config template
```

## Trading Strategy (v3 - Adaptive Bot)

### Market Mode Detection
Bot detects current market conditions:
- **UPTREND**: Price rising >0.3% over last 20 readings → Only take LONGs
- **DOWNTREND**: Price falling >0.3% over last 20 readings → Only take SHORTs
- **RANGING**: Price flat → Use absorption signals (contrarian)

### Entry Logic

**Trend Following (Uptrend/Downtrend):**
- Wait for pullback/rally against the trend
- Enter WITH the trend direction on the dip/rally

**Absorption Detection (Ranging):**
- Order book shows selling pressure BUT price not dropping → Hidden buyer → LONG
- Order book shows buying pressure BUT price not rising → Hidden seller → SHORT
- Requires 3+ "absorption ticks" to confirm signal
- Imbalance must be stable over 5+ readings (filters spoofing)

**Memory-Based Signals:**
- Bot remembers all past trades and shadow trades
- When pattern appears, checks historical win rate
- Takes direction that worked >60% of the time in similar patterns

### Exit Logic
- **Stop-Loss**: 0.8% price move against position
- **Take-Profit Activation**: 1.2% price move in favor
- **Trailing (Normal Mode)**: 0.25% from peak
- **Trailing (Danger Mode)**: 0.1% from peak

### Danger Mode
Activates when:
- In LONG and market mode turns to DOWNTREND or imbalance strongly bearish
- In SHORT and market mode turns to UPTREND or imbalance strongly bullish
Effect: Tightens trailing stop from 0.25% to 0.1%

### Memory Learning System
- **Real Trades**: All trades saved with pattern, result, profit/loss
- **Shadow Trades**: Signals not taken are tracked, outcome recorded after 5 min
- **Pattern Stats**: Win rates calculated for each pattern (imbalance + trend + price action)
- **Weighted Learning**: Recent trades count more than old ones
- **Persistence**: Memory saved to trade_memory.json, survives restarts

### Loss Adaptation
- Tracks consecutive losses per direction
- After 2+ consecutive LONG losses → Avoids LONGs until a SHORT wins
- After 2+ consecutive SHORT losses → Avoids SHORTs until a LONG wins
- Prevents revenge trading in wrong direction

## Data Sources (All Free)
- **Order Book**: Drift DLOB API (https://dlob.drift.trade)
- **Price**: Drift SDK via Pyth oracle
- **Memory**: Local JSON file

## Environment Variables
- SOLANA_RPC_URL: Helius RPC endpoint (free tier)
- PRIVATE_KEY: Wallet private key (base58)
- LEVERAGE: Trading leverage (default: 50, Drift may limit to 20x)
- SYMBOL: Market to trade (default: SOL-PERP)
- TRADE_AMOUNT_USDC: Position size in USDC
- IMBALANCE_THRESHOLD: Order book imbalance needed (default: 0.15 = 15%)
- IMBALANCE_STABILITY_CHECKS: Readings to confirm stable imbalance (default: 5)
- TREND_LOOKBACK: Readings to detect trend (default: 20)
- TREND_THRESHOLD_PERCENT: Price change to confirm trend (default: 0.3%)
- ABSORPTION_TICKS_REQUIRED: Ticks needed for absorption signal (default: 3)
- STOP_LOSS_PERCENT: Max loss before exit (default: 0.8)
- TAKE_PROFIT_ACTIVATION: Profit to activate trailing (default: 1.2)
- TRAILING_NORMAL: Normal trailing distance (default: 0.25)
- TRAILING_DANGER: Danger mode trailing distance (default: 0.1)
- COOLDOWN_SECONDS: Seconds between trades (default: 120)
- CHECK_INTERVAL_MS: Check frequency in ms (default: 2000)

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
- 2026-01-31: Added market mode detection (uptrend/downtrend/ranging)
- 2026-01-31: Implemented memory learning system with shadow trades
- 2026-01-31: Added absorption detection for ranging markets
- 2026-01-31: Added loss adaptation (avoids repeat losses in same direction)
- 2026-01-31: Changed to trade WITH trends instead of against them
- 2026-01-31: Reduced check interval to 2 seconds
- 2026-01-31: Updated risk settings (0.8% SL, 1.2% TP activation)

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers only)
- Security is critical (no key exposure)
