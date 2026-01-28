# Solana Jupiter Trading Bot

Automated SOL/USDC trading bot using CoinGecko for price monitoring and Jupiter aggregator for swap execution.

## Features

- Price monitoring via CoinGecko API (every 15 seconds)
- Swap execution via Jupiter DEX aggregator
- Simple momentum strategy (1% threshold)
- 60-second cooldown between trades
- Reserves 0.01 SOL for transaction fees

## Requirements

- Node.js >= 18.0.0
- Solana wallet with SOL and/or USDC

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your private key

# Run the bot
npm start
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SOLANA_RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `PRIVATE_KEY` | Wallet private key (base58 or JSON array) | Required |
| `SLIPPAGE_BPS` | Slippage tolerance (basis points) | `50` |
| `TRADE_PERCENT` | Balance percentage per trade | `0.2` |

## Strategy

- Checks SOL/USD price from CoinGecko every 15 seconds
- BUY SOL when price increases 1% from reference
- SELL SOL when price decreases 1% from reference
- Trades 20% of available balance per trade

## VPS Deployment

```bash
# Using PM2
npm install -g pm2
pm2 start index.js --name "sol-bot"
pm2 logs sol-bot
```

## Security

- Never share your private key
- Use a dedicated trading wallet
- The `.env` file is gitignored
