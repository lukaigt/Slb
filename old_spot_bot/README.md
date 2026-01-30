# Solana Jupiter Trading Bot

Automated SOL/USDC trading bot using **Kraken WebSocket** for real-time price monitoring and **Jupiter aggregator** for swap execution.

## Features

- **Real-time price feed**: Uses Kraken WebSocket for SOL/USD prices (no API keys needed)
- **Jupiter DEX integration**: Best-price swaps via Jupiter aggregator
- **Momentum strategy**: Buy on +1% increase, sell on -1% decrease
- **Auto-reconnect**: Automatically reconnects if WebSocket disconnects
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
# Edit .env with your private key and RPC URL

# Run the bot
npm start
```

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| SOLANA_RPC_URL | Solana RPC endpoint | Yes | - |
| PRIVATE_KEY | Wallet private key (base58) | Yes | - |
| TRADE_PERCENT | Balance percentage per trade | No | 0.2 |
| BUY_THRESHOLD | Buy trigger (% increase) | No | 1 |
| SELL_THRESHOLD | Sell trigger (% decrease) | No | 1 |
| COOLDOWN_SECONDS | Seconds between trades | No | 60 |
| SLIPPAGE_BPS | Slippage tolerance (bps) | No | 50 |
| COMMITMENT | RPC commitment level | No | confirmed |

## How It Works

1. Connects to Kraken WebSocket and subscribes to SOL/USD ticker
2. Stores the latest price in memory
3. Every 15 seconds, checks price change from reference
4. Triggers BUY when price increases by threshold
5. Triggers SELL when price decreases by threshold
6. Executes swaps via Jupiter with slippage protection

## Project Structure

```
├── index.js          # Main bot logic with Kraken WS
├── package.json      # Node.js dependencies
├── .env.example      # Environment variable template
└── README.md         # Documentation
```

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
- The .env file is gitignored
