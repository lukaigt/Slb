# Solana Futures Trading Bot (Drift Protocol)

## Overview
High-performance 50x leverage trading bot for Solana Perpetual Futures using Drift Protocol.

## Features
- 50x Leverage on SOL-PERP
- Trailing Take-Profit (locks in gains as price moves)
- Liquidation-Based Stop-Loss (0.8% to protect capital)
- EMA 20/50 Crossover for trend detection
- RSI + Bollinger Bands for momentum
- Volume filter to avoid fake breakouts
- WebSocket connection (efficient, low API usage)

## VPS Deployment (Step-by-Step)

### Option 1: Git Clone
```bash
# On your VPS, navigate to home directory
cd ~

# Clone your private repo
git clone https://github.com/YOUR_USERNAME/slb-bot-futures.git

# Enter the folder
cd slb-bot-futures

# Install dependencies
npm install

# Create your .env file
cp .env.example .env
nano .env  # Edit with your keys

# Run the bot
npm start

# Run in background (recommended)
nohup npm start > bot.log 2>&1 &
```

### Option 2: Curl Download
```bash
# Download the files directly
mkdir -p ~/slb-bot-futures && cd ~/slb-bot-futures
curl -O https://raw.githubusercontent.com/YOUR_USERNAME/slb-bot-futures/main/index.js
curl -O https://raw.githubusercontent.com/YOUR_USERNAME/slb-bot-futures/main/package.json
curl -O https://raw.githubusercontent.com/YOUR_USERNAME/slb-bot-futures/main/.env.example

# Install and run
npm install
cp .env.example .env
nano .env
npm start
```

## Environment Variables (.env)
```
SOLANA_RPC_URL=https://your-quicknode-url.com
PRIVATE_KEY=your_base58_private_key_from_phantom
LEVERAGE=50
SYMBOL=SOL-PERP
TRADE_AMOUNT_USDC=10
STOP_LOSS_PERCENT=0.8
TRAILING_TP_START_PERCENT=2.0
TRAILING_TP_DISTANCE_PERCENT=0.5
```

## How the Bot Thinks

### Entry Logic (When to Open a Trade)
1. **EMA Crossover**: Short EMA (20) must be above Long EMA (50) for LONG, below for SHORT
2. **RSI Check**: RSI below 40 for LONG (oversold), above 60 for SHORT (overbought)
3. **Bollinger Bands**: Price below middle band for LONG, above for SHORT
4. **Volume Filter**: Current volume must be 1.5x higher than average (real momentum, not fake)

### Exit Logic (When to Close a Trade)
1. **Stop-Loss**: If price moves 0.8% against you, bot exits immediately
2. **Trailing Take-Profit**: 
   - Activates when profit reaches 2%
   - Follows price up/down, locks in gains
   - Exits when price drops 0.5% from the peak

## Security
- Uses official @drift-labs/sdk (verified, open-source)
- Private keys never leave your .env file
- .gitignore prevents .env from being pushed to GitHub
- No external API keys needed (Drift is on-chain)

## Monitoring
```bash
# View live logs
tail -f bot.log

# Check if bot is running
ps aux | grep node

# Stop the bot
pkill -f "node index.js"
```

## Requirements
- Node.js 18+
- USDC in your Drift account (deposit at app.drift.trade)
- SOL for transaction fees (~0.01 SOL)
