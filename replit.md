# Solana Futures Trading Bot

## Overview
This project is a self-learning perpetual futures scalping bot on Solana mainnet using Drift Protocol. The bot trades SOL-PERP, BTC-PERP, and ETH-PERP simultaneously. v18: Dynamic TP/SL Learning — bot tests different TP/SL combinations and learns which produce best results via ATR-scaled exploration/exploitation. Pattern Memory Engine (from v17) intact: 38-dim fingerprints, k-NN matching, persistent data/ storage. Dashboard uses smooth AJAX refresh (no full page reload).

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
Comprehensive dark-theme dashboard (v18) with smooth AJAX refresh (no full page reload):
- HTML shell loads once, JavaScript fetches /api/data every 5 seconds and updates DOM
- System health, connections, uptime, heartbeat
- Learning Engine status: phase (LEARNING/EXPLOITATION), patterns stored, progress bar, pattern match win rate vs exploration win rate, win rate threshold
- TP/SL Optimizer status: phase (LEARNING/OPTIMIZING), combos tested, combos with data, best combo, explore rate
- Controls: Pause/Resume, Close All, Reset Stats
- Markets Overview: price, trend, score, phase, imbalance, volatility, data points, position, entry price, P&L, SL/TP, TP/SL mode, hold time, entry mode, last signal result
- All 12 Technical Indicators across 3 timeframes: RSI, EMA 9/21, EMA50, MACD Hist, BB Position, BB Width, ATR, ATR%, StochRSI K/D, ADX, +DI/-DI, CCI, Williams%R, ROC — all color-coded
- Support/Resistance levels with strength + Candle Patterns
- Pattern Memory stats: by market, by direction, by hour (24-hour heatmap)
- Live decision log with pattern matching reasoning
- Signal Performance Tracker: 25 signals with win/loss bars
- Signal Combo Tracker: which signal combinations won/lost historically
- TP/SL Combo Performance: which TP/SL settings work best (TP%, SL%, trades, wins, losses, win rate, avg P&L, total P&L, best, worst, score, performance bar)
- Stored Pattern History: last 10 patterns with full fingerprint data
- Complete Trade History: last 50 trades with TP/SL used, TP/SL mode, trigger signals

### Technical Implementations
- **TP/SL Optimizer (`tp_sl_optimizer.js`)**: Pool of TP/SL combos (TP 0.15%-1.0%, SL 0.15%-2.0%). ATR-based volatility scaling (adjusts TP/SL ±3x based on current ATR%). Exploration/exploitation phases: learning (<20 trades, random combos), exploitation (20+ trades, selects best combo by score = 0.6×winRate + 0.4×avgProfit, 20% exploration rate). Persistent storage in `data/tp_sl_stats.json`. Exports getRecommendedTPSL(), recordResult(), getOptimizerStats(), getTopCombos().
- **Pattern Memory (`pattern_memory.js`)**: Stores every trade with 38-dimension indicator fingerprint in `data/patterns.json`. K-nearest-neighbor similarity matching (k=10, euclidean distance on normalized vectors). Learning phase (< 30 trades): enters freely. Exploitation phase (30+ trades): checks if similar past trades won at 55%+ rate before entering. Stats tracked: by market, direction, hour, pattern-match vs exploration entries.
- **Signal Engine (`signal_engine.js`)**: 25 possible signals across multiple indicators and timeframes. RSI oversold/overbought (1m + 5m), StochRSI bounce/drop, Bollinger band touches, CCI oversold/overbought, Williams%R extremes, MACD divergence, EMA trend, ADX directional, orderbook flow, S/R proximity, price exhaustion, ROC extremes. Needs 3+ signals agreeing + ATR gate. Pattern memory decides final entry/skip.
- **Indicators (`indicators.js`)**: 12 indicators per timeframe: RSI, EMA (9/21/50), MACD, Bollinger Bands, ATR, Stochastic RSI, ADX (+DI/-DI), CCI, Williams %R, ROC. Computed on 1m, 5m, 15m candles. Support/Resistance Calculator, Candle Pattern Analyzer, Directional Score, Momentum Phase.
- **Position Management**: 10-minute stagnation close, dynamic TP/SL via optimizer, circuit breaker at -20%, max hold 30min.
- **Safety Layer (`self_tuner.js`)**: 10% daily loss limit, 4-consecutive-loss pause, midnight UTC reset.
- **Persistent Storage**: `data/` directory gitignored — survives `git reset --hard` on VPS. Contains `patterns.json` (all trade fingerprints), `learning_stats.json` (aggregated stats), and `tp_sl_stats.json` (TP/SL combo performance). Portable format readable by any system.
- **AI Brain (`ai_brain.js`)**: Retained for logging/thinking utilities only.
- **Dashboard**: HTML shell served once at `/`, JSON data endpoint at `/api/data` fetched every 5s via AJAX. API endpoints: `/api/pause`, `/api/unpause`, `/api/close-all`, `/api/reset-stats`.

### System Design Choices
- **Self-learning via pattern memory**: Bot stores every trade with full market context. Over time learns which indicator combinations lead to wins. No fixed rules — the data decides.
- **Dynamic TP/SL learning**: Bot tests different TP/SL combinations scaled by ATR volatility. Learns which settings produce best results. No more hardcoded TP/SL.
- **Two-phase approach**: Learning phase trades freely to collect data. Exploitation phase only enters when similar past patterns show positive expectation.
- **Dynamic indicator usage**: 25 possible signals, bot uses as many as fire. Not limited to fixed number. Pattern matching weights all indicators via fingerprint similarity.
- **Persistent, portable data**: Stored in simple JSON files on VPS storage. Survives code updates. Can be read by any future system (bot, AI, analytics).
- **Smooth dashboard**: AJAX-based refresh preserves scroll position and avoids full page reload flicker.
- **Comprehensive monitoring**: Dashboard shows absolutely everything — every indicator, every decision, every pattern match, every trade with full context, every TP/SL combo tested.

### Version History
- **v18**: Dynamic TP/SL Learning. Bot tests different TP/SL combos and learns which work best via ATR-scaled exploration/exploitation. Dashboard smooth AJAX refresh (no full page reload). TP/SL Combo Performance tracker. Signal Combo Tracker. Trade history shows TP/SL mode used.
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
