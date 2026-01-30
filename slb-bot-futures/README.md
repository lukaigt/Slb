# Solana Futures Trading Bot (Drift Protocol)

## Overview
High-performance trading bot for Solana Perpetual Futures using Drift Protocol. Supports up to 50x leverage, Trailing Take-Profit, and Liquidation-based Stop-Loss.

## Setup
1. Clone the repository.
2. Install dependencies: `npm install`
3. Configure `.env` (use `.env.example` as a template).
4. Run the bot: `node index.js`

## Security
- Uses official `@drift-labs/sdk`.
- Private keys are stored locally in `.env` and never uploaded.
- `reduceOnly` flags ensure safety when closing positions.

## Strategy
- **Trend:** EMA 20/50 Crossover.
- **Momentum:** RSI + Bollinger Bands.
- **Volume:** Volume Rate of Change filter to avoid fake-outs.
- **Exit:** Trailing Take-Profit and dynamic Stop-Loss.
