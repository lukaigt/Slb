# Solana Futures Trading Bot

## Overview
This project is an AI-driven perpetual futures trading bot designed for the Solana mainnet, leveraging the Drift Protocol. Its primary purpose is to execute fast, aggressive trading decisions (LONG/SHORT/WAIT) based on a sophisticated scoring engine and momentum phase detection. The bot aims for early entry into trades, monitoring positions frequently, and employs a robust set of safety mechanisms to manage risk. It simultaneously trades on SOL-PERP, BTC-PERP, and ETH-PERP markets, with a focus on fee-aware profitability and strict risk-reward ratios. The vision is to provide an efficient, automated trading solution with integrated safety features.

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Tell the truth, never promise impossible things
- Keep bot simple, avoid over-complication
- No paid APIs (use free tiers / cheap models)
- Security is critical (no key exposure, keys in .env only)
- Dashboard for monitoring is important
- User deploys to VPS manually via GitHub (push here, pull on VPS)

## System Architecture

### UI/UX Decisions
The bot includes a dark-theme web dashboard providing real-time monitoring and insights. This dashboard displays:
- System health, operational mode, AI model, and safety status.
- Market-specific data: price, trend, imbalance, volatility, current position, P&L, AI-determined SL/TP, and hold time.
- Detailed support/resistance levels with strength indicators and detected candle patterns.
- A comprehensive table of 9 technical indicators across 3 timeframes, color-coded for easy interpretation.
- Session statistics including win rate, P&L, and total trades.
- Daily safety status, showing daily P&L against limits and pause status.
- References to best/worst trades.
- A live log of AI decisions with reasoning.
- Recent trade history with entry/exit, P&L, exit reason, and AI reasoning.

### Technical Implementations
The core of the bot involves:
- **AI Brain (`ai_brain.js`)**: Utilizes GLM-4.7-Flash via OpenRouter to make all entry decisions (LONG/SHORT/WAIT). The AI is fed comprehensive market context, including price, trend, orderbook imbalance, volatility, indicators, S/R levels, candle patterns, open positions, daily P&L, BTC trend correlation, and past trade lessons. Its responses include action, stopLoss, takeProfit, confidence, reason, and maxHoldMinutes. The AI's decision-making is guided by a detailed system prompt covering indicator usage, trap detection, wick analysis, momentum exhaustion, volatility regimes, correlation awareness, and dynamic SL/TP anchoring.
- **Technical Indicators (`indicators.js`)**: Implements 9 indicators (RSI, EMA, MACD, Bollinger Bands, ATR, Stochastic RSI, ADX) across 1-minute, 5-minute, and 15-minute timeframes. A sophisticated Support/Resistance Calculator identifies swing highs/lows, clusters levels, and scores their strength. A Candle Pattern Analyzer detects key patterns on the 5-minute timeframe. OHLC candles are constructed from 15-second price samples, and price history is persisted for indicator continuity.
- **Safety Layer (`self_tuner.js`)**: Enforces critical safety rules that the AI cannot override, including a 10% daily loss limit and a 4-consecutive-loss pause, both resetting at midnight UTC.
- **Data Flow**: Prices and orderbook data are collected every 15 seconds. Indicators, S/R, and candle patterns are computed frequently. The AI receives a full data packet every 3 minutes (configurable) to make trading decisions. Open positions are monitored every 15 seconds against SL/TP/trailing stops/circuit breakers/max hold times, and safety checks are performed before every trade.
- **Trade Execution**: Uses the Drift SDK for on-chain perpetual orders, supporting both simulation and live trading. It manages positions across all 3 markets simultaneously. Dynamic SL/TP are anchored to S/R levels and ATR. Advanced profit protection includes stepped profit locking and P&L-based trailing take-profit. Emergency SL/TP defaults are assigned, and there are mechanisms for closing stagnant positions, enforcing max hold times, and an emergency circuit breaker at -25% P&L. Strict R:R (3:1 minimum) and minimum TP (1.0%) are enforced.

### System Design Choices
- **AI-driven decisions**: AI is central to trade entry, leveraging a comprehensive context.
- **Aggressive but Safe**: Bot is tuned for early, aggressive entries, balanced by stringent safety mechanisms.
- **Multi-market capability**: Trades SOL-PERP, BTC-PERP, and ETH-PERP concurrently.
- **Real-time Monitoring**: The dashboard provides full transparency into bot operations and market conditions.
- **Robust Risk Management**: Features like dynamic SL/TP, circuit breakers, daily loss limits, and consecutive loss pauses are integrated for capital preservation.

## External Dependencies
- **@drift-labs/sdk**: For interacting with the Drift Protocol for on-chain perpetual futures trading.
- **@solana/web3.js**: Solana blockchain SDK for network interactions.
- **axios**: Used for making HTTP requests, specifically for communication with the OpenRouter API.
- **bs58**: For Base58 encoding and decoding, primarily used for handling private keys.
- **dotenv**: For managing environment variables securely.
- **OpenRouter API**: Provides access to the GLM-4.7-Flash AI model for decision-making. (Configured via `OPENROUTER_API_KEY` and `AI_BASE_URL`).
- **Helius RPC**: Used as the Solana RPC endpoint for reliable blockchain data access (Configured via `SOLANA_RPC_URL`).