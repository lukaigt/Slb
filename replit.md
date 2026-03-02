# Solana Futures Trading Bot

## Overview
This project is an AI-driven perpetual futures trading bot designed for the Solana mainnet, leveraging the Drift Protocol. Its primary purpose is to execute selective, high-quality trading decisions (LONG/SHORT/WAIT) based on a structured 6-step AI checklist, pre-filters, and momentum phase detection. The bot trades SOL-PERP, BTC-PERP, and ETH-PERP simultaneously, filtering out bad conditions before even asking the AI, and employing robust risk management. The vision is quality over quantity — fewer trades, higher win rate.

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
- Interactive control buttons: Pause/Resume trading, Close All Positions, Reset Session Stats.
- Market-specific data: price, trend, score, phase, imbalance, current position, P&L, AI-determined SL/TP, and hold time.
- Detailed support/resistance levels with strength indicators and detected candle patterns.
- A comprehensive table of 9 technical indicators across 3 timeframes, color-coded for easy interpretation.
- Session statistics including win rate, P&L, and total trades.
- Daily safety status, showing daily P&L against limits and pause status.
- References to best/worst trades.
- A live log of AI decisions with reasoning (including pre-filter blocks).
- Recent trade history with entry/exit, P&L, exit reason, and AI reasoning.

### Technical Implementations
The core of the bot involves:
- **AI Brain (`ai_brain.js`)**: Utilizes GLM-4.7-Flash via OpenRouter with a structured 6-step decision checklist: (1) Is market tradeable? (2) What direction? (3) Is timing right? (4) Confirm with indicators (5) Set SL/TP using S/R (6) Final checks. The AI is instructed to say WAIT 60-70% of the time and only take high-quality setups where multiple signals align. Temperature set to 0.2 for consistency. No raw price history is sent — only processed indicators, scores, and S/R levels.
- **Pre-Filters (`index.js`)**: Hard-coded gates that block obviously bad conditions BEFORE calling the AI, saving API calls and preventing bad entries: volatility filter (too dead or too wild), 5m indicator readiness check, 15m ADX trend strength check (< 15 = no trend), score/phase alignment check (conflicting signals blocked), and 2-minute cooldown after stop-loss exits.
- **Technical Indicators (`indicators.js`)**: Implements 9 indicators (RSI, EMA, MACD, Bollinger Bands, ATR, Stochastic RSI, ADX) across 1-minute, 5-minute, and 15-minute timeframes. EARLY phase detection requires 0.10% 1-min move (up from 0.05%) with 0.05% counter-confirmation and orderbook agreement. A sophisticated Support/Resistance Calculator identifies swing highs/lows, clusters levels, and scores their strength. A Candle Pattern Analyzer detects key patterns on the 5-minute timeframe.
- **Safety Layer (`self_tuner.js`)**: Enforces critical safety rules that the AI cannot override, including a 10% daily loss limit and a 4-consecutive-loss pause (only counts losses > 5% P&L as real losses — noise stop-outs don't count), both resetting at midnight UTC.
- **Data Flow**: Prices and orderbook data are collected every 15 seconds. Indicators, S/R, and candle patterns are computed frequently. Pre-filters run first, then AI receives a focused data packet (no raw price history). Open positions are monitored every 15 seconds against SL/TP/trailing stops/circuit breakers/max hold times.
- **Trade Execution**: Uses the Drift SDK for on-chain perpetual orders, supporting both simulation and live trading. It manages positions across all 3 markets simultaneously. Dynamic SL/TP are anchored to S/R levels and ATR. Advanced profit protection includes stepped profit locking and P&L-based trailing take-profit. R:R minimum is 2:1. TP range 0.8-3.0%, SL range 0.4-1.0%. Emergency circuit breaker at -20% P&L.

### System Design Choices
- **Selective AI decisions**: AI uses a structured checklist to filter trades — quality over quantity.
- **Pre-filter layer**: Hard-coded gates block bad conditions before wasting an AI call.
- **Multi-market capability**: Trades SOL-PERP, BTC-PERP, and ETH-PERP concurrently.
- **Real-time Monitoring**: The dashboard provides full transparency into bot operations and market conditions, with interactive control buttons (pause/resume, close all positions, reset stats).
- **Robust Risk Management**: Features like dynamic SL/TP, circuit breakers, daily loss limits, consecutive loss pauses, post-stop-loss cooldowns, and pre-entry filters are integrated for capital preservation.

## External Dependencies
- **@drift-labs/sdk**: For interacting with the Drift Protocol for on-chain perpetual futures trading.
- **@solana/web3.js**: Solana blockchain SDK for network interactions.
- **axios**: Used for making HTTP requests, specifically for communication with the OpenRouter API.
- **bs58**: For Base58 encoding and decoding, primarily used for handling private keys.
- **dotenv**: For managing environment variables securely.
- **OpenRouter API**: Provides access to the GLM-4.7-Flash AI model for decision-making. (Configured via `OPENROUTER_API_KEY` and `AI_BASE_URL`).
- **Helius RPC**: Used as the Solana RPC endpoint for reliable blockchain data access (Configured via `SOLANA_RPC_URL`).
