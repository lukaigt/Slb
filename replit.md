# Solana Futures Trading Bot

## Overview
This project is a rule-based perpetual futures scalping bot on Solana mainnet using Drift Protocol. The bot trades SOL-PERP, BTC-PERP, and ETH-PERP simultaneously using a hardcoded signal scoring engine (no AI model). v15: replaced AI (GLM-4.7-Flash) with deterministic signal scoring system — 9 technical signals scored, needs 4+ agreeing to enter. Fixed TP 0.30%, SL 0.25%, 0.07% actual Drift fees (Tier 1). Signal performance tracking shows which signals win and lose.

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
- A live log of signal engine decisions with reasoning.
- Recent trade history with entry/exit, P&L, exit reason, and trigger signals shown as tags.

### Technical Implementations
The core of the bot involves:
- **Signal Engine (`signal_engine.js`)**: Hardcoded scoring system with 9 signals: 1m EMA Cross, 1m MACD Hist, 1m RSI Zone, 5m EMA Trend, 5m MACD Hist, ADX Direction, Orderbook Flow, StochRSI Momentum, Price Momentum. Each signal votes LONG or SHORT. Needs 4+ signals agreeing on same direction to enter. Hard filters: 1m/5m EMA must agree, ADX > 15 on at least one TF, trend not RANGING, not near strong S/R. No AI API calls — instant, free, consistent decisions.
- **Entry Flow (`index.js`)**: Signal engine evaluated every 15 seconds per market. 1-minute cooldown after stop-loss exits. Entry requires 4+ of 9 signals agreeing, all hard filters passing. Each trade records which signals triggered it.
- **Position Management**: 10-minute stagnation close (raw P&L between -1% and +1% = stalled trade). Hard TP close (no trailing — scalping takes profit immediately). Emergency circuit breaker at -20%. Max hold 30min default.
- **Technical Indicators (`indicators.js`)**: 9 indicators (RSI, EMA, MACD, Bollinger Bands, ATR, Stochastic RSI, ADX) across 1-minute, 5-minute, and 15-minute timeframes. Support/Resistance Calculator with strength scoring. Candle Pattern Analyzer on 5-minute timeframe. Directional score and momentum phase detection.
- **Safety Layer (`self_tuner.js`)**: Enforces critical safety rules: 10% daily loss limit, 4-consecutive-loss pause (only counts losses > 5% P&L as real losses), both resetting at midnight UTC.
- **Data Flow**: Prices and orderbook data collected every 15 seconds. Indicators, S/R, and candle patterns computed frequently. Signal engine called every 15 seconds per market when no position is open. Open positions monitored every 2 seconds.
- **Trade Execution**: Uses Drift SDK for on-chain perpetual orders, supporting both simulation and live trading. Manages positions across all 3 markets simultaneously. Fees: 0.07% round trip (Drift Tier 1 taker). Fixed TP 0.30%, SL 0.25%. Chain-synced positions get entry snapshots populated.
- **Signal Stats Tracking**: Each trade records its trigger signals. tradeMemory.signalStats tracks per-signal wins/losses persistently. Dashboard shows signal performance with visual bars.
- **AI Brain (`ai_brain.js`)**: Retained for logging/thinking utilities only. No longer used for entry decisions.

### System Design Choices
- **Rule-based scalping**: Deterministic signal scoring replaces AI language model. No API costs, no latency, no hallucinations. Consistent behavior — same market conditions = same decision every time.
- **Signal scoring system**: 9 independent signals, each votes LONG or SHORT. Need 4+ agreeing for entry. This prevents entering on weak/conflicting setups.
- **Wider targets for noise tolerance**: ~$0.46 net profit per win on $10 bet at 20x with 0.07% fees. Needs ~58% win rate to be profitable.
- **Fast cycles**: 15s check interval, 1min SL cooldown, 10min stagnation close, 30min max hold. Immediate re-entry after wins.
- **Multi-market capability**: Trades SOL-PERP, BTC-PERP, and ETH-PERP concurrently.
- **Real-time Monitoring**: Dashboard provides full transparency with signal performance tracking.
- **Robust Risk Management**: Circuit breaker, daily loss limits, consecutive loss pauses, post-stop-loss cooldown, stagnation close.

### Version History
- **v15**: Replaced AI (GLM-4.7-Flash) with hardcoded signal scoring engine. 9 signals scored (EMA, MACD, RSI, ADX, imbalance, StochRSI, price momentum across 1m/5m). Need 4+ agreeing + hard filters (1m/5m agree, ADX > 15, not ranging, not near S/R). Zero API cost, instant decisions, fully deterministic. Signal performance tracker on dashboard shows per-signal win/loss rates. Trigger signals saved per trade. Kept SL 0.25%, TP 0.30%.
- **v14.1**: Wider SL/TP (0.25%/0.30%) for noise tolerance — breakeven ~58% vs ~68%. Stricter AI prompt: 3+ confirming signals required (was 2+), 1m/5m must agree, no entries in RANGING markets. Explicit orderbook imbalance guide (positive=buyers, negative=sellers) to fix misinterpretation. Chain-synced positions now save entry snapshots and aiReason to fix null fields. Quality-over-quantity approach.
- **v14**: Scalping mode. Fixed TP 0.15%, SL 0.10%. AI every 15s. 10min stagnation close (P&L ±1%). 30min max hold. 1min SL cooldown, no cooldown after wins. Fee corrected to 0.07% (actual Drift Tier 1). Hard TP close (no trailing). Immediate re-evaluation after wins. SL triggers at exact value (no 0.90 multiplier). Scalping-focused AI prompt (1m primary, 5m confirms).
- **v13**: Rolled back to working entry logic. Removed all pre-filters except SL cooldown. Natural AI prompt instead of rigid checklist. Confidence 0.75. Added 30-min stagnation close. Kept all safety improvements.
- **v12.1**: Loosened v12 pre-filters (ADX 15→10, CHOPPY ±12→±8, EARLY 0.10%→0.07%). Still too restrictive.
- **v12**: Added structured 6-step AI checklist and hard pre-filters. Too strict — 8 hours zero trades.

## External Dependencies
- **@drift-labs/sdk**: For interacting with the Drift Protocol for on-chain perpetual futures trading.
- **@solana/web3.js**: Solana blockchain SDK for network interactions.
- **axios**: Used for making HTTP requests (retained for ai_brain.js utility, not used for entry decisions).
- **bs58**: For Base58 encoding and decoding, primarily used for handling private keys.
- **dotenv**: For managing environment variables securely.
- **Helius RPC**: Used as the Solana RPC endpoint for reliable blockchain data access (Configured via `SOLANA_RPC_URL`).
