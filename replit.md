# Solana Jupiter Trading Bot

## Overview
Automated SOL/USDC trading bot using Jupiter aggregator on Solana mainnet. The bot monitors price changes and executes trades based on a simple momentum strategy.

## Project Structure
```
├── index.js          # Main bot logic with Jupiter integration
├── package.json      # Node.js dependencies
├── .env.example      # Environment variable template
├── README.md         # Documentation for running the bot
└── .gitignore        # Git ignore rules
```

## Key Components

### Trading Strategy
- Monitors SOL/USDC price every 10 seconds
- BUY SOL when price increases by 1% from reference
- SELL SOL when price decreases by 1% from reference
- Trades 20% of available balance per trade
- 60-second cooldown between trades

### Jupiter Integration
- Uses Jupiter Quote API v6 for price quotes
- Uses Jupiter Swap API v6 for transaction building
- Supports versioned transactions
- Automatic slippage and priority fee handling

## Environment Variables
- `SOLANA_RPC_URL`: Solana RPC endpoint
- `PRIVATE_KEY`: Wallet private key (base58 or JSON array)
- `SLIPPAGE_BPS`: Slippage in basis points (default: 50)
- `TRADE_PERCENT`: Balance percentage per trade (default: 0.2)

## Running the Bot
1. Copy `.env.example` to `.env`
2. Configure your private key and RPC URL
3. Run: `npm start`

## Dependencies
- @solana/web3.js: Solana SDK
- bs58: Base58 encoding/decoding
- dotenv: Environment variable management

## Recent Changes
- 2026-01-27: Initial implementation with Jupiter v6 API
