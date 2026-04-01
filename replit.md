# Solana Futures Trading Bot

## Overview
This project is a self-learning perpetual futures scalping bot on Solana mainnet using Drift Protocol. The bot trades SOL-PERP, BTC-PERP, and ETH-PERP simultaneously. v17: Pattern Memory Engine — stores every trade with full indicator fingerprints (38 data points), learns which setups win/lose via k-nearest-neighbor similarity matching, dynamically selects when to enter based on historical pattern win rates. Two phases: Learning (< 30 trades, enters freely to collect data) and Exploitation (30+ trades, only enters if similar past patterns won at 55%+ rate). 12 indicators per timeframe. Persistent data in `data/` directory survives code updates.

## User Preferences
- Always ask before modifying code
- Explain every decision in detail
- Tell the truth, never promise impossible things
- No paid APIs (use free tiers / cheap models)
- Security is critical (no key exposure, keys in .env only)
- Dashboard must show EVERYTHING — full transparency
- User deploys to VPS manually via GitHub (push here, pull on VPS)
- VPS deploy: `cd ~/Slb && git fetch --all && git reset --hard origin/main && cd slb-bot-futures && npm install && pm2 restart drift-bot`

## System Architecture

### UI/UX Decisions
Comprehensive dark-theme dashboard (v17) showing everything the bot does:
- System health, connections, uptime, heartbeat
- Learning Engine status: phase (LEARNING/EXPLOITATION), patterns stored, progress bar, pattern match win rate vs exploration win rate, win rate threshold
- Controls: Pause/Resume, Close All, Reset Stats
- Markets Overview: price, trend, score, phase, imbalance, volatility, data points, position, entry price, P&L, SL/TP, hold time, entry mode, last signal result
- All 12 Technical Indicators across 3 timeframes: RSI, EMA 9/21, EMA50, MACD Hist, BB Position, BB Width, ATR, ATR%, StochRSI K/D, ADX, +DI/-DI, CCI, Williams%R, ROC — all color-coded
- Support/Resistance levels with strength + Candle Patterns
- Pattern Memory stats: by market, by direction, by hour (24-hour heatmap)
- Live decision log with pattern matching reasoning
- Signal Performance Tracker: 25 signals with win/loss bars
- Stored Pattern History: last 10 patterns with full fingerprint data (RSI, StochK, BB, CCI, Will%R, ADX, Imbalance, Trend, triggers)
- Complete Trade History: last 50 trades with time, market, direction, entry/exit prices, P&L%, result, exit reason, hold time, entry mode, sim/live flag, trigger signals

### Technical Implementations
- **Pattern Memory (`pattern_memory.js`)**: Stores every trade with 38-dimension indicator fingerprint in `data/patterns.json`. K-nearest-neighbor similarity matching (k=10, euclidean distance on normalized vectors). Learning phase (< 30 trades): enters freely. Exploitation phase (30+ trades): checks if similar past trades won at 55%+ rate before entering. Stats tracked: by market, direction, hour, pattern-match vs exploration entries.
- **Signal Engine (`signal_engine.js`)**: 25 possible signals across multiple indicators and timeframes. RSI oversold/overbought (1m + 5m), StochRSI bounce/drop, Bollinger band touches, CCI oversold/overbought, Williams%R extremes, MACD divergence, EMA trend, ADX directional, orderbook flow, S/R proximity, price exhaustion, ROC extremes. Needs 3+ signals agreeing + ATR gate. Pattern memory decides final entry/skip.
- **Indicators (`indicators.js`)**: 12 indicators per timeframe: RSI, EMA (9/21/50), MACD, Bollinger Bands, ATR, Stochastic RSI, ADX (+DI/-DI), CCI, Williams %R, ROC. Computed on 1m, 5m, 15m candles. Support/Resistance Calculator, Candle Pattern Analyzer, Directional Score, Momentum Phase.
- **Position Management**: 10-minute stagnation close, hard TP 0.30%, SL 0.50%, circuit breaker at -20%, max hold 30min.
- **Safety Layer (`self_tuner.js`)**: 10% daily loss limit, 4-consecutive-loss pause, midnight UTC reset.
- **Persistent Storage**: `data/` directory gitignored — survives `git reset --hard` on VPS. Contains `patterns.json` (all trade fingerprints) and `learning_stats.json` (aggregated stats). Portable format readable by any system.
- **AI Brain (`ai_brain.js`)**: Retained for logging/thinking utilities only.

### System Design Choices
- **Self-learning via pattern memory**: Bot stores every trade with full market context. Over time learns which indicator combinations lead to wins. No fixed rules — the data decides.
- **Two-phase approach**: Learning phase trades freely to collect data. Exploitation phase only enters when similar past patterns show positive expectation.
- **Dynamic indicator usage**: 25 possible signals, bot uses as many as fire. Not limited to fixed number. Pattern matching weights all indicators via fingerprint similarity.
- **Persistent, portable data**: Stored in simple JSON files on VPS storage. Survives code updates. Can be read by any future system (bot, AI, analytics).
- **Comprehensive monitoring**: Dashboard shows absolutely everything — every indicator, every decision, every pattern match, every trade with full context.

### Version History
- **v17**: Self-learning Pattern Memory Engine. Stores every trade with 38-dimension fingerprint. K-NN similarity matching. Learning/Exploitation phases. 12 indicators per TF (added CCI, Williams%R, ROC). 25 signal types. Persistent data in `data/`. Comprehensive dashboard showing everything.
- **v16**: Mean-reversion signals. Buys dips, sells rips. 9 signals, 5+ required + reversal trigger + EMA trend + ATR gate. Result: too few trades.
- **v15**: Hardcoded signal engine. 9 momentum signals. Result: 0% win rate — chased momentum.
- **v14.1**: Wider SL/TP. Result: 17% win rate.
- **v14**: Scalping mode. Result: 32% win rate — SL too tight.

## External Dependencies
- **@drift-labs/sdk**: Drift Protocol for on-chain perpetual futures trading.
- **@solana/web3.js**: Solana blockchain SDK.
- **axios**: HTTP requests (ai_brain.js utility).
- **bs58**: Base58 encoding for private keys.
- **dotenv**: Environment variables.
- **Helius RPC**: Solana RPC endpoint (via `SOLANA_RPC_URL`).
