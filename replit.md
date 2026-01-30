# Solana Futures Trading Bot (Drift Protocol)

## Overview
High-performance perpetual futures trading bot using Drift Protocol on Solana mainnet. Supports 50x leverage, trailing take-profit, and professional trading indicators.

## Project Structure
```
├── slb-bot-futures/          # NEW: Futures trading bot
│   ├── index.js              # Main bot logic with Drift SDK
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

## Futures Bot (slb-bot-futures)

### Trading Strategy
- **Trend Detection**: EMA 20/50 crossover (Bullish when short > long)
- **Momentum Check**: RSI below 40 for LONG, above 60 for SHORT
- **Confirmation**: Bollinger Bands position relative to middle band
- **Volume Filter**: Requires 1.5x average volume to avoid fake breakouts

### Risk Management
- **Leverage**: 50x (configurable)
- **Stop-Loss**: 0.8% price move against position
- **Trailing Take-Profit**: Activates at 2% profit, trails by 0.5%
- **Position Sizing**: Fixed USDC amount per trade

### Key Features
- Uses official @drift-labs/sdk (secure, audited)
- WebSocket subscription (efficient, low API usage)
- Pyth oracle for price feeds (built into Drift)
- Reduce-only orders for safe position closing

## Environment Variables
- SOLANA_RPC_URL: QuickNode RPC endpoint
- PRIVATE_KEY: Wallet private key (base58)
- LEVERAGE: Trading leverage (default: 50)
- SYMBOL: Market to trade (default: SOL-PERP)
- TRADE_AMOUNT_USDC: Position size in USDC
- STOP_LOSS_PERCENT: Max loss before exit (default: 0.8)
- TRAILING_TP_START_PERCENT: Profit to activate trailing (default: 2.0)
- TRAILING_TP_DISTANCE_PERCENT: Trail distance (default: 0.5)

## Running the Bot
1. cd slb-bot-futures
2. npm install
3. cp .env.example .env
4. Edit .env with your keys
5. npm start

## VPS Deployment
- Git clone the repo to VPS
- npm install && npm start
- Use nohup or pm2 for background running

## Dependencies
- @drift-labs/sdk: Drift Protocol trading SDK
- @solana/web3.js: Solana blockchain SDK
- bs58: Base58 encoding for private keys
- dotenv: Environment variable management
- technicalindicators: EMA, RSI, Bollinger calculations

## Recent Changes
- 2026-01-30: Created new slb-bot-futures folder with Drift Protocol integration
- 2026-01-30: Moved old spot bot to old_spot_bot folder
- 2026-01-30: Implemented 50x leverage with trailing take-profit
- 2026-01-30: Added professional indicators (EMA, RSI, BB, Volume)

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers)
- Security is critical (no key exposure)
