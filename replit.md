# Solana Futures Trading Bot

## Overview
This project is a rule-based perpetual futures scalping bot on Solana mainnet using Drift Protocol. The bot trades SOL-PERP, BTC-PERP, and ETH-PERP simultaneously using a mean-reversion signal scoring engine (no AI model). v16: replaced momentum-chasing signals with mean-reversion signals — buys dips near support when RSI/StochRSI show oversold, sells rips near resistance when overbought. 5m EMA trend filter ensures dips are bought in uptrends only. Fixed TP 0.30%, SL 0.50%, 0.07% actual Drift fees (Tier 1). Requires 5+ of 9 signals agreeing + at least one reversal trigger.

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
- System health, operational mode, signal engine status, and safety status.
- Interactive control buttons: Pause/Resume trading, Close All Positions, Reset Session Stats.
- Market-specific data: price, trend, score, phase, imbalance, current position, P&L, SL/TP, and hold time.
- Detailed support/resistance levels with strength indicators and detected candle patterns.
- A comprehensive table of 9 technical indicators across 3 timeframes, color-coded for easy interpretation.
- **Signal Performance Tracker**: shows each of the 9 signals with wins, losses, total trades, win rate, and a visual green/red bar — so the user can see which signals work and which don't.
- Session statistics including win rate, P&L, and total trades.
- Daily safety status, showing daily P&L against limits and pause status.
- References to best/worst trades.
- A live log of mean reversion engine decisions with reasoning.
- Recent trade history with entry/exit, P&L, exit reason, and trigger signals shown as tags.

### Technical Implementations
The core of the bot involves:
- **Signal Engine (`signal_engine.js`)**: Mean-reversion scoring system with 9 signals: RSI Reversal (≤30 LONG, ≥70 SHORT), StochRSI Reversal (K<25 crossing up, K>75 crossing down), Bollinger Bounce (price at lower/upper band), S/R Proximity (near support=LONG, near resistance=SHORT), MACD Divergence (histogram diverging from price), 5m EMA Trend (directional filter), ADX Strength (trend strength), Orderbook Flow (imbalance), Price Exhaustion (price at extremes of recent range). Needs 5+ agreeing + at least one reversal signal (RSI/StochRSI/BB) + 5m EMA trend confirmation + ATR volatility gate.
- **Entry Flow (`index.js`)**: Signal engine evaluated every 15 seconds per market. 1-minute cooldown after stop-loss exits. Entry requires 5+ of 9 signals agreeing, at least one reversal trigger, 5m trend agreement, sufficient ATR. Each trade records which signals triggered it.
- **Position Management**: 10-minute stagnation close (raw P&L between -1% and +1% = stalled trade). Hard TP close (no trailing — scalping takes profit immediately). Emergency circuit breaker at -20%. Max hold 30min default.
- **Technical Indicators (`indicators.js`)**: 9 indicators (RSI, EMA, MACD, Bollinger Bands, ATR, Stochastic RSI, ADX) across 1-minute, 5-minute, and 15-minute timeframes. Support/Resistance Calculator with strength scoring. Candle Pattern Analyzer on 5-minute timeframe. Directional score and momentum phase detection.
- **Safety Layer (`self_tuner.js`)**: Enforces critical safety rules: 10% daily loss limit, 4-consecutive-loss pause (only counts losses > 5% P&L as real losses), both resetting at midnight UTC.
- **Data Flow**: Prices and orderbook data collected every 15 seconds. Indicators, S/R, and candle patterns computed frequently. Signal engine called every 15 seconds per market when no position is open. Open positions monitored every 2 seconds.
- **Trade Execution**: Uses Drift SDK for on-chain perpetual orders, supporting both simulation and live trading. Manages positions across all 3 markets simultaneously. Fees: 0.07% round trip (Drift Tier 1 taker). Fixed TP 0.30%, SL 0.50%. Chain-synced positions get entry snapshots populated.
- **Signal Stats Tracking**: Each trade records its trigger signals. tradeMemory.signalStats tracks per-signal wins/losses persistently. Dashboard shows signal performance with visual bars.
- **AI Brain (`ai_brain.js`)**: Retained for logging/thinking utilities only. No longer used for entry decisions.

### System Design Choices
- **Mean-reversion scalping**: Buys oversold dips near support, sells overbought rips near resistance. Enters early (before the bounce) instead of late (after the move). 5m EMA trend filter prevents buying dips in downtrends.
- **Signal scoring system**: 9 independent signals, each votes LONG or SHORT. Need 5+ agreeing + at least one reversal signal for entry. This prevents entering without a clear mean-reversion setup.
- **Wider SL for noise tolerance**: SL 0.50%, TP 0.30%. Gives trades room to breathe. Needs higher win rate but should achieve it with better entry timing.
- **ATR volatility gate**: Only enters when 1m ATR shows enough market movement to reach TP target.
- **Fast cycles**: 15s check interval, 1min SL cooldown, 10min stagnation close, 30min max hold. Immediate re-entry after wins.
- **Multi-market capability**: Trades SOL-PERP, BTC-PERP, and ETH-PERP concurrently.
- **Real-time Monitoring**: Dashboard provides full transparency with signal performance tracking.
- **Robust Risk Management**: Circuit breaker, daily loss limits, consecutive loss pauses, post-stop-loss cooldown, stagnation close.

### Version History
- **v16**: Replaced momentum-chasing signals with mean-reversion signals. Buys dips (RSI ≤30, StochRSI reversal, Bollinger lower band, near support) and sells rips (RSI ≥70, StochRSI reversal, Bollinger upper band, near resistance). 5m EMA trend filter: only buy dips in uptrends, sell rips in downtrends. Requires 5+ signals (up from 4) + at least one reversal trigger. ATR volatility gate blocks entries in dead markets. SL widened to 0.50% (from 0.25%) for noise tolerance. TP kept at 0.30%.
- **v15**: Replaced AI (GLM-4.7-Flash) with hardcoded signal scoring engine. 9 momentum signals. Need 4+ agreeing. Zero API cost, fully deterministic. Result: 0% win rate — all signals chased momentum (entered at end of micro-moves, got stopped out by mean reversion).
- **v14.1**: Wider SL/TP (0.25%/0.30%). Stricter AI prompt. Result: 1W/5L (17%).
- **v14**: Scalping mode. Fixed TP 0.15%, SL 0.10%. Result: 8W/17L (32%) — SL too tight.
- **v13**: Rolled back to working entry logic. Natural AI prompt. Confidence 0.75.
- **v12.1**: Loosened v12 pre-filters. Still too restrictive.
- **v12**: Structured 6-step AI checklist and hard pre-filters. Too strict — 8 hours zero trades.

## External Dependencies
- **@drift-labs/sdk**: For interacting with the Drift Protocol for on-chain perpetual futures trading.
- **@solana/web3.js**: Solana blockchain SDK for network interactions.
- **axios**: Used for making HTTP requests (retained for ai_brain.js utility, not used for entry decisions).
- **bs58**: For Base58 encoding and decoding, primarily used for handling private keys.
- **dotenv**: For managing environment variables securely.
- **Helius RPC**: Used as the Solana RPC endpoint for reliable blockchain data access (Configured via `SOLANA_RPC_URL`).
