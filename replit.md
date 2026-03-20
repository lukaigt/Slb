# Solana Futures Trading Bot

## Overview
This project is an AI-driven perpetual futures trading bot designed for the Solana mainnet, leveraging the Drift Protocol. The bot trades SOL-PERP, BTC-PERP, and ETH-PERP simultaneously using GLM-4.7-Flash for entry decisions. The AI receives full market data (indicators, S/R levels, candle patterns, price changes, orderbook) and makes independent decisions. The vision is quality over quantity — the AI is the brain, safety systems protect capital.

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
- A live log of AI decisions with reasoning.
- Recent trade history with entry/exit, P&L, exit reason, and AI reasoning.

### Technical Implementations
The core of the bot involves:
- **AI Brain (`ai_brain.js`)**: Utilizes GLM-4.7-Flash via OpenRouter with a natural-style prompt that teaches the AI HOW to think about markets: S/R levels (absolute priority), trap/exhaustion detection, early trend catching, multi-timeframe analysis, and correlation. The AI receives all data and makes its own decisions — no rigid checklist, no forced behavior. Temperature 0.2. No raw price history sent — only processed indicators, scores, and S/R levels. Confidence threshold 0.75.
- **Entry Flow (`index.js`)**: The only pre-entry gate is a 2-minute cooldown after stop-loss exits. All other decisions are made by the AI. Directional score and momentum phase are sent as informational context, not as blockers.
- **Position Management**: 30-minute stagnation close (P&L between -2% and +2% = dead trade, close it). Stepped profit locking. P&L-based trailing take-profit. Emergency circuit breaker at -20%.
- **Technical Indicators (`indicators.js`)**: 9 indicators (RSI, EMA, MACD, Bollinger Bands, ATR, Stochastic RSI, ADX) across 1-minute, 5-minute, and 15-minute timeframes. Support/Resistance Calculator with strength scoring. Candle Pattern Analyzer on 5-minute timeframe. Directional score and momentum phase detection (informational, not blocking).
- **Safety Layer (`self_tuner.js`)**: Enforces critical safety rules that the AI cannot override: 10% daily loss limit, 4-consecutive-loss pause (only counts losses > 5% P&L as real losses), both resetting at midnight UTC.
- **Data Flow**: Prices and orderbook data collected every 15 seconds. Indicators, S/R, and candle patterns computed frequently. AI called every 30 seconds per market when no position is open. Open positions monitored every 2 seconds.
- **Trade Execution**: Uses Drift SDK for on-chain perpetual orders, supporting both simulation and live trading. Manages positions across all 3 markets simultaneously. Dynamic SL/TP anchored to S/R levels and ATR. R:R minimum 2:1. TP range 0.8-3.0%, SL range 0.4-1.0%.

### System Design Choices
- **AI is the brain**: No pre-filters gatekeeping the AI. The AI sees all data and decides freely. Higher confidence threshold (0.75) ensures quality.
- **Simple entry, robust protection**: Entry logic is simple (AI decides). Position management is robust (stagnation close, profit locking, trailing TP, circuit breaker).
- **Multi-market capability**: Trades SOL-PERP, BTC-PERP, and ETH-PERP concurrently.
- **Real-time Monitoring**: Dashboard provides full transparency with interactive control buttons.
- **Robust Risk Management**: Circuit breaker, daily loss limits, consecutive loss pauses, post-stop-loss cooldown, stagnation close, stepped profit protection.

### Version History
- **v13**: Rolled back to working entry logic. Removed all pre-filters except SL cooldown. Natural AI prompt instead of rigid checklist. Confidence 0.75. Added 30-min stagnation close. Kept all safety improvements.
- **v12.1**: Loosened v12 pre-filters (ADX 15→10, CHOPPY ±12→±8, EARLY 0.10%→0.07%). Still too restrictive.
- **v12**: Added structured 6-step AI checklist and hard pre-filters. Too strict — 8 hours zero trades.

## External Dependencies
- **@drift-labs/sdk**: For interacting with the Drift Protocol for on-chain perpetual futures trading.
- **@solana/web3.js**: Solana blockchain SDK for network interactions.
- **axios**: Used for making HTTP requests, specifically for communication with the OpenRouter API.
- **bs58**: For Base58 encoding and decoding, primarily used for handling private keys.
- **dotenv**: For managing environment variables securely.
- **OpenRouter API**: Provides access to the GLM-4.7-Flash AI model for decision-making. (Configured via `OPENROUTER_API_KEY` and `AI_BASE_URL`).
- **Helius RPC**: Used as the Solana RPC endpoint for reliable blockchain data access (Configured via `SOLANA_RPC_URL`).
