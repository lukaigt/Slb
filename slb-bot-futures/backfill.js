'use strict';

/**
 * Historical Pattern Backfill Script
 * ------------------------------------
 * Pulls 30 days of 1-minute OHLCV data from Kraken (free, no API key).
 * Replays the exact same signal engine + indicator logic the live bot uses.
 * Simulates TP/SL outcomes from real historical price movement.
 * Saves all discovered patterns into data/patterns.json — ready for bot use immediately.
 *
 * Run once on VPS: node backfill.js
 * Takes ~30 minutes (API rate limiting). Do NOT run while bot is trading.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const { calculateAllIndicators, findSupportResistance } = require('./indicators');

// ── Config ────────────────────────────────────────────────────────────────────
const DAYS_TO_FETCH    = 30;      // how many days of history to download
const TP_PCT           = 0.35;   // 0.35% take profit for simulation
const SL_PCT           = 0.35;   // 0.35% stop loss for simulation
const MAX_HOLD_CANDLES = 30;     // max 30 minutes hold
const MIN_SIGNALS      = 2;      // same threshold as learning phase
const MIN_ATR_PCT      = 0.02;   // same ATR gate as learning phase
const API_DELAY_MS     = 1400;   // 1.4s between Kraken API calls (safe rate limit)
const WINDOW_1M        = 120;    // 1m candles to feed into indicators
const WINDOW_5M        = 100;    // 5m candles to feed into indicators
const WINDOW_15M       = 80;     // 15m candles to feed into indicators

const DATA_DIR      = path.join(__dirname, 'data');
const PATTERNS_FILE = path.join(DATA_DIR, 'patterns.json');
const STATS_FILE    = path.join(DATA_DIR, 'learning_stats.json');

const REST_PAIR_MAP = {
    'SOL-PERP':    'SOLUSD',
    'BTC-PERP':    'XXBTZUSD',
    'ETH-PERP':    'XETHZUSD',
    'DOGE-PERP':   'XDGUSD',
    'AVAX-PERP':   'AVAXUSD',
    'LINK-PERP':   'LINKUSD',
    'ADA-PERP':    'ADAUSD',
    'DOT-PERP':    'DOTUSD',
    'ATOM-PERP':   'ATOMUSD',
    'NEAR-PERP':   'NEARUSD',
    'SUI-PERP':    'SUIUSD',
    'LTC-PERP':    'XLTCZUSD',
    'XMR-PERP':    'XXMRZUSD',
    'ALGO-PERP':   'ALGOUSD',
    'HBAR-PERP':   'HBARUSD',
    'TRX-PERP':    'TRXUSD',
    'RENDER-PERP': 'RENDERUSD',
    'APT-PERP':    'APTUSD',
    'UNI-PERP':    'UNIUSD',
    'ARB-PERP':    'ARBUSD',
    'OP-PERP':     'OPUSD',
    'FIL-PERP':    'FILUSD',
    'POL-PERP':    'POLUSD'
};

const ALL_SYMBOLS = Object.keys(REST_PAIR_MAP);

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function round4(v) {
    return Math.round(v * 10000) / 10000;
}

// ── Kraken OHLCV Fetcher ──────────────────────────────────────────────────────
async function fetchCandlePage(restPair, since) {
    const url = `https://api.kraken.com/0/public/OHLC?pair=${restPair}&interval=1&since=${since}`;
    try {
        const raw = await httpsGet(url);
        const parsed = JSON.parse(raw);
        if (parsed.error && parsed.error.length > 0) {
            console.log(`  [WARN] Kraken error: ${parsed.error.join(', ')}`);
            return { candles: [], last: null };
        }
        const keys = Object.keys(parsed.result).filter(k => k !== 'last');
        if (keys.length === 0) return { candles: [], last: null };

        const raw2 = parsed.result[keys[0]];
        const last = parsed.result.last || null;

        const candles = raw2.map(c => ({
            time:   c[0] * 1000,        // Unix ms
            open:   parseFloat(c[1]),
            high:   parseFloat(c[2]),
            low:    parseFloat(c[3]),
            close:  parseFloat(c[4]),
            volume: parseFloat(c[6])
        }));

        return { candles, last };
    } catch (e) {
        console.log(`  [WARN] Fetch failed: ${e.message}`);
        return { candles: [], last: null };
    }
}

async function fetchAllCandles(symbol, restPair, days) {
    const allCandles = [];
    const nowSec  = Math.floor(Date.now() / 1000);
    const startSec = nowSec - days * 24 * 3600;
    let since = startSec;
    let page  = 0;
    const maxPages = Math.ceil(days * 24 * 60 / 720) + 5;

    console.log(`  Downloading ${days} days for ${symbol} (~${maxPages} pages)...`);

    while (page < maxPages) {
        const { candles, last } = await fetchCandlePage(restPair, since);

        if (candles.length === 0) break;
        allCandles.push(...candles);

        const lastCandleSec = candles[candles.length - 1].time / 1000;
        if (lastCandleSec >= nowSec - 120) break; // caught up to present

        // Use the 'last' token Kraken returns for next page
        since = last || (lastCandleSec + 1);
        page++;

        process.stdout.write(`\r    Page ${page}/${maxPages} — ${allCandles.length} candles`);
        await sleep(API_DELAY_MS);
    }
    process.stdout.write('\n');

    // Deduplicate and sort by time
    const seen   = new Set();
    const unique = allCandles.filter(c => {
        if (seen.has(c.time)) return false;
        seen.add(c.time);
        return true;
    });
    unique.sort((a, b) => a.time - b.time);

    console.log(`  Got ${unique.length} unique 1m candles for ${symbol}`);
    return unique;
}

// ── Timeframe Aggregation ─────────────────────────────────────────────────────
// Build an array of N-minute candles from 1m candles (aligned to complete groups)
function buildHigherTF(candles1m, factor) {
    const result = [];
    // align to factor boundaries
    for (let i = 0; i + factor - 1 < candles1m.length; i += factor) {
        const slice = candles1m.slice(i, i + factor);
        result.push({
            time:  slice[0].time,
            open:  slice[0].open,
            high:  Math.max(...slice.map(c => c.high)),
            low:   Math.min(...slice.map(c => c.low)),
            close: slice[slice.length - 1].close
        });
    }
    return result;
}

// ── Signal Evaluator (matches signal_engine.js exactly, no patternMemory dep) ──
function evaluateSignalsHistorical(ind1m, ind5m, ind15m, prices, sr) {
    if (!ind1m || !ind1m.ready || !ind5m || !ind5m.ready) return null;

    const price = prices[prices.length - 1];
    let longScore = 0, shortScore = 0;
    const signals = {};

    // RSI 1m
    if (ind1m.rsi != null) {
        if (ind1m.rsi <= 30)      { signals.rsi_oversold_1m   = 'LONG';  longScore++;  }
        else if (ind1m.rsi >= 70) { signals.rsi_overbought_1m = 'SHORT'; shortScore++; }
    }
    // RSI 5m
    if (ind5m.rsi != null) {
        if (ind5m.rsi <= 35)      { signals.rsi_oversold_5m   = 'LONG';  longScore++;  }
        else if (ind5m.rsi >= 65) { signals.rsi_overbought_5m = 'SHORT'; shortScore++; }
    }
    // StochRSI 1m
    if (ind1m.stochRSI) {
        const { k, d } = ind1m.stochRSI;
        if (k < 20 && k > d)      { signals.stoch_bounce_1m = 'LONG';  longScore++;  }
        else if (k > 80 && k < d) { signals.stoch_drop_1m   = 'SHORT'; shortScore++; }
    }
    // Bollinger 1m
    if (ind1m.bollinger && price) {
        const range = ind1m.bollinger.upper - ind1m.bollinger.lower;
        if (range > 0) {
            const pos = (price - ind1m.bollinger.lower) / range;
            if (pos <= 0.05)      { signals.bb_lower_1m = 'LONG';  longScore++;  }
            else if (pos >= 0.95) { signals.bb_upper_1m = 'SHORT'; shortScore++; }
        }
    }
    // CCI 1m
    if (ind1m.cci != null) {
        if (ind1m.cci <= -100)      { signals.cci_oversold_1m   = 'LONG';  longScore++;  }
        else if (ind1m.cci >= 100)  { signals.cci_overbought_1m = 'SHORT'; shortScore++; }
    }
    // Williams %R 1m
    if (ind1m.willR != null) {
        if (ind1m.willR <= -80)      { signals.willr_oversold_1m   = 'LONG';  longScore++;  }
        else if (ind1m.willR >= -20) { signals.willr_overbought_1m = 'SHORT'; shortScore++; }
    }
    // MACD divergence 1m
    if (ind1m.macd && prices.length >= 8) {
        const priceTrend = prices[prices.length - 1] - prices[prices.length - 8];
        const hist = ind1m.macd.histogram;
        if (priceTrend < 0 && hist > 0) { signals.macd_bull_div = 'LONG';  longScore++;  }
        else if (priceTrend > 0 && hist < 0) { signals.macd_bear_div = 'SHORT'; shortScore++; }
    }
    // EMA trend 5m
    if (ind5m.ema9 != null && ind5m.ema21 != null && ind5m.ema9 !== ind5m.ema21) {
        if (ind5m.ema9 > ind5m.ema21) { signals.ema_trend_5m = 'LONG';  longScore++;  }
        else                           { signals.ema_trend_5m = 'SHORT'; shortScore++; }
    }
    // ADX 1m
    if (ind1m.adx && ind1m.adx.adx > 20) {
        if (ind1m.adx.plusDI > ind1m.adx.minusDI)      { signals.adx_bull_1m = 'LONG';  longScore++;  }
        else if (ind1m.adx.minusDI > ind1m.adx.plusDI) { signals.adx_bear_1m = 'SHORT'; shortScore++; }
    }
    // S/R proximity (no orderbook in historical — omitted)
    if (sr && price) {
        let sDist = Infinity, rDist = Infinity;
        if (sr.supports) {
            for (const s of sr.supports) {
                const d = Math.abs(s.distancePercent);
                if (d < 0.30 && s.strength !== 'WEAK' && d < sDist) sDist = d;
            }
        }
        if (sr.resistances) {
            for (const r of sr.resistances) {
                const d = Math.abs(r.distancePercent);
                if (d < 0.30 && r.strength !== 'WEAK' && d < rDist) rDist = d;
            }
        }
        if (sDist < rDist && sDist < Infinity)      { signals.near_support     = 'LONG';  longScore++;  }
        else if (rDist < sDist && rDist < Infinity) { signals.near_resistance  = 'SHORT'; shortScore++; }
    }
    // Price at 8-candle high/low
    if (prices.length >= 8) {
        const lookback = prices.slice(-8);
        const maxP = Math.max(...lookback), minP = Math.min(...lookback);
        const range = maxP - minP;
        if (range > 0) {
            const pos = (price - minP) / range;
            if (pos <= 0.10)      { signals.price_at_low  = 'LONG';  longScore++;  }
            else if (pos >= 0.90) { signals.price_at_high = 'SHORT'; shortScore++; }
        }
    }
    // ROC 1m
    if (ind1m.roc != null) {
        if (ind1m.roc < -0.15)      { signals.roc_oversold   = 'LONG';  longScore++;  }
        else if (ind1m.roc > 0.15)  { signals.roc_overbought = 'SHORT'; shortScore++; }
    }

    const direction = longScore > shortScore ? 'LONG'
                    : shortScore > longScore ? 'SHORT' : null;

    return { direction, longScore, shortScore, signals };
}

// ── Fingerprint Builder (mirrors pattern_memory.createFingerprint exactly) ────
function buildFingerprint(ind1m, ind5m, ind15m, price, prices, sr, imbalance, trend, hourUTC) {
    const fp = {};

    fp.rsi_1m  = ind1m.rsi  != null ? round4(ind1m.rsi)  : null;
    fp.rsi_5m  = ind5m.rsi  != null ? round4(ind5m.rsi)  : null;
    fp.rsi_15m = ind15m && ind15m.rsi != null ? round4(ind15m.rsi) : null;

    if (ind1m.macd) {
        fp.macd_hist_1m   = round4(ind1m.macd.histogram);
        fp.macd_line_1m   = round4(ind1m.macd.macd);
        fp.macd_signal_1m = round4(ind1m.macd.signal);
    }
    if (ind5m.macd) fp.macd_hist_5m = round4(ind5m.macd.histogram);

    if (ind1m.ema9 != null && ind1m.ema21 != null && price > 0) {
        fp.ema9_vs_21_1m   = round4(((ind1m.ema9 - ind1m.ema21) / price) * 100);
        fp.ema9_vs_price_1m = round4(((ind1m.ema9 - price) / price) * 100);
    }
    if (ind1m.ema50 != null && price > 0) {
        fp.price_vs_ema50_1m = round4(((price - ind1m.ema50) / price) * 100);
    }
    if (ind5m.ema9 != null && ind5m.ema21 != null && price > 0) {
        fp.ema9_vs_21_5m = round4(((ind5m.ema9 - ind5m.ema21) / price) * 100);
    }
    if (ind15m && ind15m.ema9 != null && ind15m.ema21 != null && price > 0) {
        fp.ema9_vs_21_15m = round4(((ind15m.ema9 - ind15m.ema21) / price) * 100);
    }

    if (ind1m.bollinger && price > 0) {
        const range = ind1m.bollinger.upper - ind1m.bollinger.lower;
        fp.bb_position_1m = range > 0 ? round4((price - ind1m.bollinger.lower) / range) : 0.5;
        fp.bb_width_1m    = round4(ind1m.bollinger.bandwidth);
    }
    if (ind5m.bollinger && price > 0) {
        const range = ind5m.bollinger.upper - ind5m.bollinger.lower;
        fp.bb_position_5m = range > 0 ? round4((price - ind5m.bollinger.lower) / range) : 0.5;
    }

    if (ind1m.stochRSI) { fp.stoch_k_1m = round4(ind1m.stochRSI.k); fp.stoch_d_1m = round4(ind1m.stochRSI.d); }
    if (ind5m.stochRSI) { fp.stoch_k_5m = round4(ind5m.stochRSI.k); }

    if (ind1m.adx) { fp.adx_1m = round4(ind1m.adx.adx); fp.plus_di_1m = round4(ind1m.adx.plusDI); fp.minus_di_1m = round4(ind1m.adx.minusDI); }
    if (ind5m.adx) { fp.adx_5m = round4(ind5m.adx.adx); }

    if (ind1m.atr != null && price > 0) fp.atr_pct_1m = round4((ind1m.atr / price) * 100);
    if (ind5m.atr != null && price > 0) fp.atr_pct_5m = round4((ind5m.atr / price) * 100);

    if (ind1m.cci  != null) fp.cci_1m   = round4(ind1m.cci);
    if (ind1m.willR != null) fp.willr_1m = round4(ind1m.willR);
    if (ind1m.roc  != null) fp.roc_1m   = round4(ind1m.roc);
    if (ind5m.cci  != null) fp.cci_5m   = round4(ind5m.cci);
    if (ind5m.willR != null) fp.willr_5m = round4(ind5m.willR);

    fp.imbalance = 0; // no orderbook in historical data

    let supportDist = null, resistanceDist = null;
    let supportStrength = 0, resistanceStrength = 0;
    if (sr && sr.supports && sr.supports.length > 0) {
        const n = sr.supports[0];
        supportDist     = round4(Math.abs(n.distancePercent));
        supportStrength = n.strength === 'STRONG' ? 3 : n.strength === 'MODERATE' ? 2 : 1;
    }
    if (sr && sr.resistances && sr.resistances.length > 0) {
        const n = sr.resistances[0];
        resistanceDist     = round4(Math.abs(n.distancePercent));
        resistanceStrength = n.strength === 'STRONG' ? 3 : n.strength === 'MODERATE' ? 2 : 1;
    }
    fp.sr_support_dist       = supportDist;
    fp.sr_resistance_dist    = resistanceDist;
    fp.sr_support_strength   = supportStrength;
    fp.sr_resistance_strength = resistanceStrength;

    if (prices.length >= 4)  fp.price_change_1m = round4(((prices[prices.length - 1] - prices[prices.length - 4])  / prices[prices.length - 4])  * 100);
    if (prices.length >= 20) fp.price_change_5m = round4(((prices[prices.length - 1] - prices[prices.length - 20]) / prices[prices.length - 20]) * 100);

    const trendMap = { 'BULLISH': 1, 'BEARISH': -1, 'RANGING': 0 };
    fp.trend = trendMap[trend] != null ? trendMap[trend] : 0;
    fp.hour  = hourUTC;

    return fp;
}

// ── Trade Outcome Simulator ───────────────────────────────────────────────────
function simulateTrade(candles1m, entryIdx, direction, tpPct, slPct) {
    const entryPrice = candles1m[entryIdx].close;
    const tpPrice = direction === 'LONG'
        ? entryPrice * (1 + tpPct / 100)
        : entryPrice * (1 - tpPct / 100);
    const slPrice = direction === 'LONG'
        ? entryPrice * (1 - slPct / 100)
        : entryPrice * (1 + slPct / 100);

    for (let j = entryIdx + 1; j <= entryIdx + MAX_HOLD_CANDLES && j < candles1m.length; j++) {
        const c = candles1m[j];
        if (direction === 'LONG') {
            if (c.high >= tpPrice) return { result: 'WIN',  exitPrice: tpPrice, exitReason: 'TP_HIT',  holdMin: j - entryIdx };
            if (c.low  <= slPrice) return { result: 'LOSS', exitPrice: slPrice, exitReason: 'SL_HIT',  holdMin: j - entryIdx };
        } else {
            if (c.low  <= tpPrice) return { result: 'WIN',  exitPrice: tpPrice, exitReason: 'TP_HIT',  holdMin: j - entryIdx };
            if (c.high >= slPrice) return { result: 'LOSS', exitPrice: slPrice, exitReason: 'SL_HIT',  holdMin: j - entryIdx };
        }
    }

    // Neither TP nor SL hit — stagnation close
    const finalIdx  = Math.min(entryIdx + MAX_HOLD_CANDLES, candles1m.length - 1);
    const exitPrice = candles1m[finalIdx].close;
    const profitPct = direction === 'LONG'
        ? (exitPrice - entryPrice) / entryPrice * 100
        : (entryPrice - exitPrice) / entryPrice * 100;

    return {
        result:     profitPct >= 0 ? 'WIN' : 'LOSS',
        exitPrice,
        exitReason: 'STAGNATION',
        holdMin:    finalIdx - entryIdx
    };
}

// ── Process One Coin ──────────────────────────────────────────────────────────
function processCoin(symbol, candles1m) {
    if (candles1m.length < 1600) {
        console.log(`  [SKIP] ${symbol}: not enough candles (${candles1m.length})`);
        return [];
    }

    const candles5m  = buildHigherTF(candles1m, 5);
    const candles15m = buildHigherTF(candles1m, 15);

    const newPatterns = [];
    // Need at least WINDOW_1M 1m candles, WINDOW_5M 5m candles (= 5*WINDOW_5M 1m), WINDOW_15M 15m (= 15*WINDOW_15M 1m)
    const startIdx = Math.max(WINDOW_1M, 5 * WINDOW_5M, 15 * WINDOW_15M);

    let signalCount = 0;

    for (let i = startIdx; i < candles1m.length - MAX_HOLD_CANDLES - 1; i++) {
        // Build 1m window
        const win1m = candles1m.slice(i - WINDOW_1M, i);

        // Find corresponding 5m and 15m indices (last complete candle before i)
        const idx5m  = Math.floor(i / 5)  - 1;
        const idx15m = Math.floor(i / 15) - 1;

        if (idx5m  < WINDOW_5M  || idx5m  >= candles5m.length)  continue;
        if (idx15m < WINDOW_15M || idx15m >= candles15m.length) continue;

        const win5m  = candles5m.slice(idx5m  - WINDOW_5M  + 1, idx5m  + 1);
        const win15m = candles15m.slice(idx15m - WINDOW_15M + 1, idx15m + 1);

        const ind1m  = calculateAllIndicators(win1m);
        const ind5m  = calculateAllIndicators(win5m);
        const ind15m = calculateAllIndicators(win15m);

        if (!ind1m.ready || !ind5m.ready || !ind15m.ready) continue;

        // ATR gate (same as learning phase)
        const price  = candles1m[i - 1].close;
        if (!price || price <= 0) continue;
        if (!ind1m.atr) continue;
        const atrPct = (ind1m.atr / price) * 100;
        if (atrPct < MIN_ATR_PCT) continue;

        const prices     = win1m.map(c => c.close);
        const timestamps = win1m.map(c => c.time);
        const sr         = findSupportResistance(prices, timestamps, price);

        // Evaluate signals (standalone — no patternMemory.shouldEnter)
        const sigResult = evaluateSignalsHistorical(ind1m, ind5m, ind15m, prices, sr);
        if (!sigResult || !sigResult.direction) continue;

        const { direction, longScore, shortScore, signals } = sigResult;
        const dominantScore = Math.max(longScore, shortScore);
        if (dominantScore < MIN_SIGNALS) continue;

        // NOTE: No trend filter in backfill — we capture ALL patterns (LONG and SHORT)
        // regardless of trend direction. The live bot applies the trend filter when trading.
        // Including all patterns gives the k-NN more data to learn from.

        // Determine trend label for fingerprint
        let trend = 'RANGING';
        if (ind15m.ema9 != null && ind15m.ema21 != null) {
            trend = ind15m.ema9 > ind15m.ema21 ? 'BULLISH' : 'BEARISH';
        }

        // Simulate the trade outcome from real price data
        const sim = simulateTrade(candles1m, i - 1, direction, TP_PCT, SL_PCT);

        const entryPrice  = price;
        const entryTs     = candles1m[i - 1].time;
        const hourUTC     = new Date(entryTs).getUTCHours();

        const profitPercent = direction === 'LONG'
            ? round4((sim.exitPrice - entryPrice) / entryPrice * 100)
            : round4((entryPrice - sim.exitPrice) / entryPrice * 100);

        // Build fingerprint (same 38 dims as live bot)
        const fingerprint = buildFingerprint(
            ind1m, ind5m, ind15m,
            price, prices, sr,
            0,     // imbalance = 0 (no orderbook in history)
            trend,
            hourUTC
        );

        const activeSignals = Object.entries(signals)
            .filter(([, d]) => d === direction)
            .map(([s]) => s);

        const entry = {
            id:             Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            timestamp:      new Date(entryTs).toISOString(),
            symbol,
            direction,
            entryPrice:     round4(entryPrice),
            exitPrice:      round4(sim.exitPrice),
            profitPercent,
            result:         sim.result,
            exitReason:     sim.exitReason,
            holdTimeMin:    sim.holdMin,
            fingerprint,
            entryMode:      'BACKFILL',
            triggerSignals: activeSignals,
            tpUsed:         TP_PCT,
            slUsed:         SL_PCT,
            tpSlMode:       'BACKFILL',
            tpSlBase:       `${TP_PCT}/${SL_PCT}`
        };

        newPatterns.push(entry);
        signalCount++;

        // Skip forward to avoid overlapping trades from same setup
        i += 4;
    }

    console.log(`  ${symbol}: found ${newPatterns.length} historical patterns`);
    return newPatterns;
}

// ── Load / Save patterns.json ─────────────────────────────────────────────────
function loadExistingPatterns() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
        if (fs.existsSync(PATTERNS_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
            if (parsed && Array.isArray(parsed.trades)) {
                console.log(`Loaded ${parsed.trades.length} existing patterns from disk.`);
                return parsed;
            }
        }
    } catch (e) {
        console.log(`[WARN] Could not load existing patterns: ${e.message}`);
    }
    return { version: 1, trades: [] };
}

function rebuildStats(trades) {
    const stats = {
        totalStored:          trades.length,
        wins:                 0,
        losses:               0,
        byMarket:             {},
        byDirection:          { LONG: { wins: 0, losses: 0 }, SHORT: { wins: 0, losses: 0 } },
        byHour:               {},
        patternMatchEntries:  0,
        patternMatchWins:     0,
        explorationEntries:   0,
        explorationWins:      0,
        lastUpdated:          new Date().toISOString()
    };

    for (const t of trades) {
        const win = t.result === 'WIN';
        if (win) stats.wins++; else stats.losses++;

        if (!stats.byMarket[t.symbol]) stats.byMarket[t.symbol] = { wins: 0, losses: 0 };
        if (win) stats.byMarket[t.symbol].wins++; else stats.byMarket[t.symbol].losses++;

        const dir = t.direction;
        if (stats.byDirection[dir]) {
            if (win) stats.byDirection[dir].wins++; else stats.byDirection[dir].losses++;
        }

        const h = new Date(t.timestamp).getUTCHours().toString();
        if (!stats.byHour[h]) stats.byHour[h] = { wins: 0, losses: 0 };
        if (win) stats.byHour[h].wins++; else stats.byHour[h].losses++;

        if (t.entryMode === 'PATTERN_MATCH') {
            stats.patternMatchEntries++;
            if (win) stats.patternMatchWins++;
        } else {
            stats.explorationEntries++;
            if (win) stats.explorationWins++;
        }
    }

    return stats;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(60));
    console.log(' Solana Bot — Historical Pattern Backfill');
    console.log(`  Fetching ${DAYS_TO_FETCH} days per coin (${ALL_SYMBOLS.length} coins)`);
    console.log(`  TP: ${TP_PCT}%  SL: ${SL_PCT}%  Max hold: ${MAX_HOLD_CANDLES}m`);
    console.log('='.repeat(60));

    // Safety check: warn if existing patterns already have many backfill entries
    const existing = loadExistingPatterns();
    const alreadyBackfilled = existing.trades.filter(t => t.entryMode === 'BACKFILL').length;
    if (alreadyBackfilled > 3000) {
        console.log(`\n[WARN] Already have ${alreadyBackfilled} backfilled patterns.`);
        console.log('       Run again anyway? (Ctrl+C to cancel, or wait 10s to continue)');
        await sleep(10000);
    }

    const allNewPatterns = [];
    let coinsDone = 0;

    for (const symbol of ALL_SYMBOLS) {
        console.log(`\n[${++coinsDone}/${ALL_SYMBOLS.length}] ${symbol}`);
        const restPair = REST_PAIR_MAP[symbol];

        try {
            const candles = await fetchAllCandles(symbol, restPair, DAYS_TO_FETCH);
            const patterns = processCoin(symbol, candles);
            allNewPatterns.push(...patterns);
        } catch (e) {
            console.log(`  [ERROR] ${symbol}: ${e.message}`);
        }

        // Progress summary
        console.log(`  Running total: ${allNewPatterns.length} new patterns found`);
    }

    console.log('\n' + '='.repeat(60));
    console.log(` Backfill complete — ${allNewPatterns.length} new patterns`);

    // Merge with existing patterns, append new ones
    const combined = [...existing.trades, ...allNewPatterns];
    const finalData = { version: 1, trades: combined };

    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(finalData, null, 2));
    console.log(` Saved ${combined.length} total patterns → ${PATTERNS_FILE}`);

    // Rebuild and save stats
    const stats = rebuildStats(combined);
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

    const winRate = stats.wins + stats.losses > 0
        ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
        : 'N/A';

    console.log(` Win rate across all patterns: ${winRate}%`);
    console.log(` Wins: ${stats.wins}  Losses: ${stats.losses}`);
    console.log('='.repeat(60));
    console.log(' Restart your bot now — it will load all patterns on startup.');
    console.log('='.repeat(60));
}

main().catch(e => {
    console.error('[FATAL]', e.message);
    process.exit(1);
});
