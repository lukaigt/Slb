# Solana Jupiter Trading Bot

## Overview
Automated SOL/USDC trading bot using Kraken WebSocket for real-time price monitoring and Jupiter aggregator for swap execution on Solana mainnet.

## Project Structure
```
├── index.js          # Main bot logic with Kraken WS
├── package.json      # Node.js dependencies
├── .env.example      # Environment variable template
├── README.md         # Documentation
└── .gitignore        # Git ignore rules
```

## Key Components

### Price Monitoring (Kraken WebSocket)
- Connects to wss://ws.kraken.com
- Subscribes to SOL/USD ticker channel
- Parses last trade price from ticker messages
- Auto-reconnects on disconnect (up to 10 attempts)
- No API keys required (public WebSocket)

### Trading Strategy (index.js)
- BUY SOL when price increases by BUY_THRESHOLD% from reference
- SELL SOL when price decreases by SELL_THRESHOLD% from reference
- Trades TRADE_PERCENT of available balance per trade
- COOLDOWN_SECONDS cooldown between trades
- Reserves 0.01 SOL for gas fees

### Swap Execution
- Uses Jupiter Quote API v6 for quotes
- Uses Jupiter Swap API v6 for transaction building
- Supports versioned transactions

## Environment Variables
- SOLANA_RPC_URL: Solana RPC endpoint (required)
- PRIVATE_KEY: Wallet private key in base58 (required)
- TRADE_PERCENT: Balance percentage per trade (default: 0.2)
- BUY_THRESHOLD: Buy trigger percentage (default: 1)
- SELL_THRESHOLD: Sell trigger percentage (default: 1)
- COOLDOWN_SECONDS: Seconds between trades (default: 60)
- SLIPPAGE_BPS: Slippage in basis points (default: 50)
- COMMITMENT: RPC commitment level (default: confirmed)

## Running the Bot
1. Copy .env.example to .env
2. Configure your private key and RPC URL
3. Run: npm start

## Dependencies
- @solana/web3.js: Solana SDK
- ws: WebSocket client for Kraken
- bs58: Base58 encoding/decoding
- dotenv: Environment variable management

## Recent Changes
- 2026-01-28: Replaced previous price feed with Kraken WebSocket
- 2026-01-28: Added WebSocket auto-reconnect logic
- 2026-01-28: Bot waits for first price before trading
