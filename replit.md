# Solana Futures Trading Bot

## Overview
This project is an AI-driven perpetual futures scalping bot on Solana mainnet using Drift Protocol. The bot trades SOL-PERP, BTC-PERP, and ETH-PERP simultaneously using GLM-4.7-Flash for entry decisions. v14 scalping mode: fast in/out trades targeting 0.15% TP and 0.10% SL, with 0.07% actual Drift fees (Tier 1). The AI reads 1m/5m momentum for quick entries and the system compounds small profits through high trade frequency.

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
- **AI Brain (`ai_brain.js`)**: Utilizes GLM-4.7-Flash via OpenRouter with a scalping-focused prompt. 1m chart is primary for entry timing, 5m confirms direction, 15m is background trend filter. Fixed TP 0.15% / SL 0.10% price moves (AI decides direction only, not SL/TP). Temperature 0.2. Confidence threshold 0.75. Max hold 2-30min.
- **Entry Flow (`index.js`)**: 1-minute cooldown after stop-loss exits (reduced from 2min). All other decisions made by AI. AI checked every 15 seconds per market. No R:R enforcement — scalping uses tight, asymmetric targets.
- **Position Management**: 10-minute stagnation close (fee-adjusted P&L between -2.5% and +1.5% — accounts for 1.4% fee offset on flat trades). Hard TP close (no trailing — scalping takes profit immediately). Emergency circuit breaker at -20%. Max hold 30min default.
- **Technical Indicators (`indicators.js`)**: 9 indicators (RSI, EMA, MACD, Bollinger Bands, ATR, Stochastic RSI, ADX) across 1-minute, 5-minute, and 15-minute timeframes. Support/Resistance Calculator with strength scoring. Candle Pattern Analyzer on 5-minute timeframe. Directional score and momentum phase detection (informational, not blocking).
- **Safety Layer (`self_tuner.js`)**: Enforces critical safety rules that the AI cannot override: 10% daily loss limit, 4-consecutive-loss pause (only counts losses > 5% P&L as real losses), both resetting at midnight UTC.
- **Data Flow**: Prices and orderbook data collected every 15 seconds. Indicators, S/R, and candle patterns computed frequently. AI called every 15 seconds per market when no position is open. Open positions monitored every 2 seconds.
- **Trade Execution**: Uses Drift SDK for on-chain perpetual orders, supporting both simulation and live trading. Manages positions across all 3 markets simultaneously. Fees: 0.07% round trip (Drift Tier 1 taker). Fixed TP 0.15%, SL 0.10%.

### System Design Choices
- **Scalping mode**: High frequency, small targets. ~$0.16 net profit per win on $10 bet at 20x with 0.07% fees. Needs ~68% win rate to be profitable.
- **AI is the brain**: No pre-filters gatekeeping the AI. The AI sees all data and decides freely. Higher confidence threshold (0.75) ensures quality.
- **Fast cycles**: 15s AI interval, 1min SL cooldown, 10min stagnation close, 30min max hold. Immediate re-entry after wins.
- **Multi-market capability**: Trades SOL-PERP, BTC-PERP, and ETH-PERP concurrently.
- **Real-time Monitoring**: Dashboard provides full transparency with interactive control buttons.
- **Robust Risk Management**: Circuit breaker, daily loss limits, consecutive loss pauses, post-stop-loss cooldown, stagnation close, stepped profit protection.

### Version History
- **v14**: Scalping mode. Fixed TP 0.15%, SL 0.10%. AI every 15s. 10min stagnation close (fee-adjusted P&L range -2.5% to +1.5%). 30min max hold. 1min SL cooldown, no cooldown after wins. Fee corrected to 0.07% (actual Drift Tier 1). Hard TP close (no trailing). Immediate re-evaluation after wins. Scalping-focused AI prompt (1m primary, 5m confirms).
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
