# Solana Jupiter Trading Bot

Automated SOL/USDC trading bot using **Pyth Network on-chain oracle** for price monitoring and **Jupiter aggregator** for swap execution.

## Features

- **On-chain price oracle**: Uses Pyth Network directly via Solana RPC (no HTTP APIs)
- **No API keys required**: Reads price data directly from Solana blockchain
- **Price safety checks**: Rejects stale prices (>60s) and wide confidence intervals
- **Jupiter DEX integration**: Best-price swaps via Jupiter aggregator
- **Momentum strategy**: Buy on +1% increase, sell on -1% decrease
- **Spam protection**: 60-second cooldown between trades

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
| `SOLANA_RPC_URL` | Solana RPC endpoint | Required |
| `PRIVATE_KEY` | Wallet private key (base58) | Required |
| `TRADE_PERCENT` | Balance percentage per trade | `0.2` |
| `BUY_THRESHOLD` | Buy trigger (% increase) | `1` |
| `SELL_THRESHOLD` | Sell trigger (% decrease) | `1` |
| `COOLDOWN_SECONDS` | Seconds between trades | `60` |
| `SLIPPAGE_BPS` | Slippage tolerance (bps) | `50` |
| `COMMITMENT` | RPC commitment level | `confirmed` |

## How It Works

1. Fetches SOL/USD price from Pyth on-chain oracle every 15 seconds
2. Validates price freshness (<60s old) and confidence interval
3. Compares to reference price set at startup
4. Triggers BUY when price increases by threshold
5. Triggers SELL when price decreases by threshold
6. Executes swaps via Jupiter with slippage protection

## Price Safety

The bot validates Pyth oracle data before trading:
- **Staleness check**: Rejects prices older than 60 seconds
- **Zero check**: Rejects zero or undefined prices
- **Confidence check**: Rejects if confidence > 5% of price

If any check fails, the trading cycle is safely skipped.

## VPS Deployment

```bash
# Using PM2
npm install -g pm2
pm2 start index.js --name "sol-bot"
pm2 logs sol-bot
pm2 save
pm2 startup
```

## Security

- Never share your private key
- Use a dedicated trading wallet with limited funds
- The `.env` file is gitignored
