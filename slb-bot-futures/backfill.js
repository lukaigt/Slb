'use strict';

/**
 * Historical Pattern Backfill Script — v2
 * ----------------------------------------
 * Kraken's 1m OHLC API only returns the most recent ~720 candles regardless
 * of the `since` parameter. So instead of trying to paginate 30 days of 1m data,
 * we fetch THREE intervals separately:
 *
 *   1m  candles → 720 candles = ~12 hours  (for 1m indicators + entry signals)
 *   5m  candles → 720 candles = ~60 hours  (for 5m indicators, native data)
 *   15m candles → 720 candles = ~7.5 days  (for 15m indicators, native data)
 *
 * This gives us rich indicator context across all 3 timeframes.
 * We process all 1m candles and simulate trade outcomes from real price data.
 *
 * Runtime: ~3-4 minutes (3 API calls per coin × 23 coins × 1.4s delay)
 * Expected output: 1,000 – 3,000 patterns across all 23 coins.
 *
 * Run once on VPS (stop bot first):  node backfill.js
 * Then restart:  pm2 start drift-bot
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const { calculateAllIndicators, findSupportResistance } = require('./indicators');
const { computeCategoryScores } = require('./signal_engine');

// ── Config ────────────────────────────────────────────────────────────────────
const TP_PCT           = 0.35;
const SL_PCT           = 0.35;
const MAX_HOLD_CANDLES = 30;
const MIN_SIGNALS      = 2;
const MIN_ATR_PCT      = 0.02;
const API_DELAY_MS     = 1500;

const WINDOW_1M  = 100;
const WINDOW_5M  = 100;
const WINDOW_15M = 60;

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function r4(v) { return Math.round(v * 10000) / 10000; }

// ── Kraken OHLC Fetcher (single call, recent data) ────────────────────────────
async function fetchCandles(restPair, interval) {
    const url = `https://api.kraken.com/0/public/OHLC?pair=${restPair}&interval=${interval}`;
    try {
        const raw    = await httpsGet(url);
        const parsed = JSON.parse(raw);
        if (parsed.error && parsed.error.length > 0) {
            console.log(`    [WARN] ${restPair} ${interval}m: ${parsed.error.join(', ')}`);
            return [];
        }
        const keys = Object.keys(parsed.result).filter(k => k !== 'last');
        if (keys.length === 0) return [];
        return parsed.result[keys[0]].map(c => ({
            time:   c[0] * 1000,
            open:   parseFloat(c[1]),
            high:   parseFloat(c[2]),
            low:    parseFloat(c[3]),
            close:  parseFloat(c[4]),
            volume: parseFloat(c[6])
        }));
    } catch (e) {
        console.log(`    [WARN] ${restPair} ${interval}m fetch error: ${e.message}`);
        return [];
    }
}

// Find the last candle in `sorted` whose time is <= targetTime. Returns index or -1.
function findCandleBefore(sorted, targetTime) {
    let lo = 0, hi = sorted.length - 1, result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].time <= targetTime) { result = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return result;
}

// ── Signal Evaluator (mirrors signal_engine.js, no patternMemory dep) ─────────
// Uses the same category-based deduplication: correlated oscillators that all
// fire together (rsi, cci, willr, bb, stoch, roc, price_at_low) count as ONE
// confirmation (oscillator_1m), not as five separate votes.
function evaluateSignals(ind1m, ind5m, ind15m, prices, sr, price) {
    if (!ind1m || !ind1m.ready || !ind5m || !ind5m.ready) return null;

    const signals = {};

    if (ind1m.rsi != null) {
        if (ind1m.rsi <= 30)      signals.rsi_oversold_1m   = 'LONG';
        else if (ind1m.rsi >= 70) signals.rsi_overbought_1m = 'SHORT';
    }
    if (ind5m.rsi != null) {
        if (ind5m.rsi <= 35)      signals.rsi_oversold_5m   = 'LONG';
        else if (ind5m.rsi >= 65) signals.rsi_overbought_5m = 'SHORT';
    }
    if (ind1m.stochRSI) {
        const { k, d } = ind1m.stochRSI;
        if (k < 20 && k > d)      signals.stoch_bounce_1m = 'LONG';
        else if (k > 80 && k < d) signals.stoch_drop_1m   = 'SHORT';
    }
    if (ind1m.bollinger && price) {
        const rng = ind1m.bollinger.upper - ind1m.bollinger.lower;
        if (rng > 0) {
            const pos = (price - ind1m.bollinger.lower) / rng;
            if (pos <= 0.05)      signals.bb_lower_1m = 'LONG';
            else if (pos >= 0.95) signals.bb_upper_1m = 'SHORT';
        }
    }
    if (ind1m.cci != null) {
        if (ind1m.cci <= -100)     signals.cci_oversold_1m   = 'LONG';
        else if (ind1m.cci >= 100) signals.cci_overbought_1m = 'SHORT';
    }
    if (ind1m.willR != null) {
        if (ind1m.willR <= -80)      signals.willr_oversold_1m   = 'LONG';
        else if (ind1m.willR >= -20) signals.willr_overbought_1m = 'SHORT';
    }
    if (ind1m.macd && prices.length >= 8) {
        const pt   = prices[prices.length - 1] - prices[prices.length - 8];
        const hist = ind1m.macd.histogram;
        if (pt < 0 && hist > 0)      signals.macd_bull_div = 'LONG';
        else if (pt > 0 && hist < 0) signals.macd_bear_div = 'SHORT';
    }
    if (ind5m.ema9 != null && ind5m.ema21 != null && ind5m.ema9 !== ind5m.ema21) {
        if (ind5m.ema9 > ind5m.ema21) signals.ema_trend_5m = 'LONG';
        else                           signals.ema_trend_5m = 'SHORT';
    }
    if (ind1m.adx && ind1m.adx.adx > 20) {
        if (ind1m.adx.plusDI > ind1m.adx.minusDI)      signals.adx_bull_1m = 'LONG';
        else if (ind1m.adx.minusDI > ind1m.adx.plusDI) signals.adx_bear_1m = 'SHORT';
    }
    if (sr && price) {
        let sd = Infinity, rd = Infinity;
        if (sr.supports)    for (const s of sr.supports)    { const d = Math.abs(s.distancePercent); if (d < 0.30 && s.strength !== 'WEAK' && d < sd) sd = d; }
        if (sr.resistances) for (const r of sr.resistances) { const d = Math.abs(r.distancePercent); if (d < 0.30 && r.strength !== 'WEAK' && d < rd) rd = d; }
        if (sd < rd && sd < Infinity)      signals.near_support    = 'LONG';
        else if (rd < sd && rd < Infinity) signals.near_resistance = 'SHORT';
    }
    if (prices.length >= 8) {
        const lb = prices.slice(-8);
        const mx = Math.max(...lb), mn = Math.min(...lb), rng = mx - mn;
        if (rng > 0) {
            const pos = (price - mn) / rng;
            if (pos <= 0.10)      signals.price_at_low  = 'LONG';
            else if (pos >= 0.90) signals.price_at_high = 'SHORT';
        }
    }
    if (ind1m.roc != null) {
        if (ind1m.roc < -0.15)     signals.roc_oversold   = 'LONG';
        else if (ind1m.roc > 0.15) signals.roc_overbought = 'SHORT';
    }
    if (ind1m.ema50 != null && price) {
        if (price > ind1m.ema50 * 1.001)      signals.price_above_ema50 = 'LONG';
        else if (price < ind1m.ema50 * 0.999) signals.price_below_ema50 = 'SHORT';
    }
    if (ind1m.ema9 != null && ind1m.ema21 != null && ind1m.ema9 !== ind1m.ema21) {
        if (ind1m.ema9 > ind1m.ema21) signals.ema_trend_1m = 'LONG';
        else                           signals.ema_trend_1m = 'SHORT';
    }
    if (ind15m && ind15m.ema9 != null && ind15m.ema21 != null && ind15m.ema9 !== ind15m.ema21) {
        if (ind15m.ema9 > ind15m.ema21) signals.ema_align_15m = 'LONG';
        else                             signals.ema_align_15m = 'SHORT';
    }

    // Deduplicate by category: correlated signals count as one.
    const { longScore, shortScore } = computeCategoryScores(signals);
    const direction = longScore > shortScore ? 'LONG' : shortScore > longScore ? 'SHORT' : null;
    return { direction, longScore, shortScore, signals };
}

// ── Fingerprint Builder ───────────────────────────────────────────────────────
function buildFingerprint(ind1m, ind5m, ind15m, price, prices, sr, trend, hourUTC) {
    const fp = {};
    fp.rsi_1m  = ind1m.rsi  != null ? r4(ind1m.rsi)  : null;
    fp.rsi_5m  = ind5m.rsi  != null ? r4(ind5m.rsi)  : null;
    fp.rsi_15m = ind15m && ind15m.rsi != null ? r4(ind15m.rsi) : null;
    if (ind1m.macd && price > 0)  { fp.macd_hist_1m = r4((ind1m.macd.histogram / price) * 100); fp.macd_line_1m = r4((ind1m.macd.macd / price) * 100); fp.macd_signal_1m = r4((ind1m.macd.signal / price) * 100); }
    if (ind5m.macd && price > 0)  { fp.macd_hist_5m = r4((ind5m.macd.histogram / price) * 100); }
    if (ind1m.ema9 != null && ind1m.ema21 != null && price > 0) {
        fp.ema9_vs_21_1m    = r4(((ind1m.ema9 - ind1m.ema21) / price) * 100);
        fp.ema9_vs_price_1m = r4(((ind1m.ema9 - price) / price) * 100);
    }
    if (ind1m.ema50 != null && price > 0) fp.price_vs_ema50_1m = r4(((price - ind1m.ema50) / price) * 100);
    if (ind5m.ema9 != null && ind5m.ema21 != null && price > 0) fp.ema9_vs_21_5m = r4(((ind5m.ema9 - ind5m.ema21) / price) * 100);
    if (ind15m && ind15m.ema9 != null && ind15m.ema21 != null && price > 0) fp.ema9_vs_21_15m = r4(((ind15m.ema9 - ind15m.ema21) / price) * 100);
    if (ind1m.bollinger && price > 0) {
        const rng = ind1m.bollinger.upper - ind1m.bollinger.lower;
        fp.bb_position_1m = rng > 0 ? r4((price - ind1m.bollinger.lower) / rng) : 0.5;
        fp.bb_width_1m    = r4(ind1m.bollinger.bandwidth);
    }
    if (ind5m.bollinger && price > 0) {
        const rng = ind5m.bollinger.upper - ind5m.bollinger.lower;
        fp.bb_position_5m = rng > 0 ? r4((price - ind5m.bollinger.lower) / rng) : 0.5;
    }
    if (ind1m.stochRSI) { fp.stoch_k_1m = r4(ind1m.stochRSI.k); fp.stoch_d_1m = r4(ind1m.stochRSI.d); }
    if (ind5m.stochRSI) { fp.stoch_k_5m = r4(ind5m.stochRSI.k); }
    if (ind1m.adx) { fp.adx_1m = r4(ind1m.adx.adx); fp.plus_di_1m = r4(ind1m.adx.plusDI); fp.minus_di_1m = r4(ind1m.adx.minusDI); }
    if (ind5m.adx) { fp.adx_5m = r4(ind5m.adx.adx); }
    if (ind1m.atr != null && price > 0) fp.atr_pct_1m = r4((ind1m.atr / price) * 100);
    if (ind5m.atr != null && price > 0) fp.atr_pct_5m = r4((ind5m.atr / price) * 100);
    if (ind1m.cci  != null) fp.cci_1m   = r4(ind1m.cci);
    if (ind1m.willR != null) fp.willr_1m = r4(ind1m.willR);
    if (ind1m.roc  != null) fp.roc_1m   = r4(ind1m.roc);
    if (ind5m.cci  != null) fp.cci_5m   = r4(ind5m.cci);
    if (ind5m.willR != null) fp.willr_5m = r4(ind5m.willR);
    fp.imbalance = 0;
    let sd = null, rd = null, ss = 0, rs = 0;
    if (sr && sr.supports    && sr.supports.length    > 0) { sd = r4(Math.abs(sr.supports[0].distancePercent));    ss = sr.supports[0].strength    === 'STRONG' ? 3 : sr.supports[0].strength    === 'MODERATE' ? 2 : 1; }
    if (sr && sr.resistances && sr.resistances.length > 0) { rd = r4(Math.abs(sr.resistances[0].distancePercent)); rs = sr.resistances[0].strength === 'STRONG' ? 3 : sr.resistances[0].strength === 'MODERATE' ? 2 : 1; }
    fp.sr_support_dist = sd; fp.sr_resistance_dist = rd;
    fp.sr_support_strength = ss; fp.sr_resistance_strength = rs;
    if (prices.length >= 4)  fp.price_change_1m = r4(((prices[prices.length-1] - prices[prices.length-4])  / prices[prices.length-4])  * 100);
    if (prices.length >= 20) fp.price_change_5m = r4(((prices[prices.length-1] - prices[prices.length-20]) / prices[prices.length-20]) * 100);
    const tm = { 'BULLISH': 1, 'BEARISH': -1, 'RANGING': 0 };
    fp.trend = tm[trend] != null ? tm[trend] : 0;
    fp.hour  = hourUTC;
    return fp;
}

// ── Trade Outcome Simulator ───────────────────────────────────────────────────
function simulateTrade(candles1m, entryIdx, direction) {
    const entryPrice = candles1m[entryIdx].close;
    const tpPrice = direction === 'LONG' ? entryPrice * (1 + TP_PCT / 100) : entryPrice * (1 - TP_PCT / 100);
    const slPrice = direction === 'LONG' ? entryPrice * (1 - SL_PCT / 100) : entryPrice * (1 + SL_PCT / 100);

    for (let j = entryIdx + 1; j <= entryIdx + MAX_HOLD_CANDLES && j < candles1m.length; j++) {
        const c = candles1m[j];
        if (direction === 'LONG') {
            if (c.high >= tpPrice) return { result: 'WIN',  exitPrice: tpPrice, exitReason: 'TP_HIT', holdMin: j - entryIdx };
            if (c.low  <= slPrice) return { result: 'LOSS', exitPrice: slPrice, exitReason: 'SL_HIT', holdMin: j - entryIdx };
        } else {
            if (c.low  <= tpPrice) return { result: 'WIN',  exitPrice: tpPrice, exitReason: 'TP_HIT', holdMin: j - entryIdx };
            if (c.high >= slPrice) return { result: 'LOSS', exitPrice: slPrice, exitReason: 'SL_HIT', holdMin: j - entryIdx };
        }
    }
    const fi  = Math.min(entryIdx + MAX_HOLD_CANDLES, candles1m.length - 1);
    const ep  = candles1m[fi].close;
    const pct = direction === 'LONG' ? (ep - entryPrice) / entryPrice * 100 : (entryPrice - ep) / entryPrice * 100;
    return { result: pct >= 0 ? 'WIN' : 'LOSS', exitPrice: ep, exitReason: 'STAGNATION', holdMin: fi - entryIdx };
}

// ── Process One Coin ──────────────────────────────────────────────────────────
function processCoin(symbol, candles1m, candles5m, candles15m) {
    if (candles1m.length < WINDOW_1M + MAX_HOLD_CANDLES + 5) {
        console.log(`  [SKIP] ${symbol}: only ${candles1m.length} 1m candles (need ${WINDOW_1M + MAX_HOLD_CANDLES + 5}+)`);
        return [];
    }
    if (candles5m.length < WINDOW_5M + 5) {
        console.log(`  [SKIP] ${symbol}: only ${candles5m.length} 5m candles (need ${WINDOW_5M + 5}+)`);
        return [];
    }
    if (candles15m.length < WINDOW_15M + 5) {
        console.log(`  [SKIP] ${symbol}: only ${candles15m.length} 15m candles (need ${WINDOW_15M + 5}+)`);
        return [];
    }

    const patterns = [];

    // Process each 1m candle (starting after enough 1m history)
    for (let i = WINDOW_1M; i < candles1m.length - MAX_HOLD_CANDLES - 1; i++) {
        const candle  = candles1m[i];
        const price   = candle.close;
        if (!price || price <= 0) continue;

        // 1m window: last WINDOW_1M candles before this one
        const win1m   = candles1m.slice(i - WINDOW_1M, i);
        const prices  = win1m.map(c => c.close);
        const ts1m    = win1m.map(c => c.time);

        // Find corresponding 5m candle (last complete one before this 1m candle)
        const idx5m   = findCandleBefore(candles5m, candle.time - 1);
        if (idx5m < WINDOW_5M) continue;
        const win5m   = candles5m.slice(idx5m - WINDOW_5M + 1, idx5m + 1);

        // Find corresponding 15m candle
        const idx15m  = findCandleBefore(candles15m, candle.time - 1);
        if (idx15m < WINDOW_15M) continue;
        const win15m  = candles15m.slice(idx15m - WINDOW_15M + 1, idx15m + 1);

        const ind1m   = calculateAllIndicators(win1m);
        const ind5m   = calculateAllIndicators(win5m);
        const ind15m  = calculateAllIndicators(win15m);

        if (!ind1m.ready || !ind5m.ready) continue;
        if (!ind1m.atr) continue;
        const atrPct = (ind1m.atr / price) * 100;
        if (atrPct < MIN_ATR_PCT) continue;

        const sr      = findSupportResistance(prices, ts1m, price);
        const sigRes  = evaluateSignals(ind1m, ind5m, ind15m, prices, sr, price);
        if (!sigRes || !sigRes.direction) continue;

        const { direction, longScore, shortScore, signals } = sigRes;
        const dominantScore = Math.max(longScore, shortScore);
        if (dominantScore < MIN_SIGNALS) continue;

        // Simulate outcome
        const sim     = simulateTrade(candles1m, i, direction);
        const entryTs = candle.time;
        const hourUTC = new Date(entryTs).getUTCHours();

        const profitPct = direction === 'LONG'
            ? r4((sim.exitPrice - price) / price * 100)
            : r4((price - sim.exitPrice) / price * 100);

        let trend = 'RANGING';
        if (ind15m && ind15m.ready && ind15m.ema9 != null && ind15m.ema21 != null) {
            trend = ind15m.ema9 > ind15m.ema21 ? 'BULLISH' : 'BEARISH';
        }

        const fingerprint = buildFingerprint(ind1m, ind5m, ind15m.ready ? ind15m : null, price, prices, sr, trend, hourUTC);
        const activeSignals = Object.entries(signals).filter(([, d]) => d === direction).map(([s]) => s);

        patterns.push({
            id:             Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            timestamp:      new Date(entryTs).toISOString(),
            symbol,
            direction,
            entryPrice:     r4(price),
            exitPrice:      r4(sim.exitPrice),
            profitPercent:  profitPct,
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
        });

        i += 4; // skip forward to avoid clustering entries
    }

    console.log(`  ${symbol}: ${patterns.length} patterns (1m:${candles1m.length} 5m:${candles5m.length} 15m:${candles15m.length} candles)`);
    return patterns;
}

// ── Load / Save ───────────────────────────────────────────────────────────────
function loadExisting() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
        if (fs.existsSync(PATTERNS_FILE)) {
            const p = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
            if (p && Array.isArray(p.trades)) {
                console.log(`Loaded ${p.trades.length} existing patterns.`);
                return p;
            }
        }
    } catch (e) { console.log(`[WARN] Could not load patterns: ${e.message}`); }
    return { version: 1, trades: [] };
}

function rebuildStats(trades) {
    const s = { totalStored: trades.length, wins: 0, losses: 0, byMarket: {}, byDirection: { LONG: { wins: 0, losses: 0 }, SHORT: { wins: 0, losses: 0 } }, byHour: {}, patternMatchEntries: 0, patternMatchWins: 0, explorationEntries: 0, explorationWins: 0, lastUpdated: new Date().toISOString() };
    for (const t of trades) {
        const w = t.result === 'WIN';
        if (w) s.wins++; else s.losses++;
        if (!s.byMarket[t.symbol]) s.byMarket[t.symbol] = { wins: 0, losses: 0 };
        if (w) s.byMarket[t.symbol].wins++; else s.byMarket[t.symbol].losses++;
        if (s.byDirection[t.direction]) { if (w) s.byDirection[t.direction].wins++; else s.byDirection[t.direction].losses++; }
        const h = new Date(t.timestamp).getUTCHours().toString();
        if (!s.byHour[h]) s.byHour[h] = { wins: 0, losses: 0 };
        if (w) s.byHour[h].wins++; else s.byHour[h].losses++;
        if (t.entryMode === 'PATTERN_MATCH') { s.patternMatchEntries++; if (w) s.patternMatchWins++; }
        else { s.explorationEntries++; if (w) s.explorationWins++; }
    }
    return s;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(60));
    console.log(' Solana Bot — Historical Pattern Backfill v2');
    console.log(' Fetching 1m (12h) + 5m (60h) + 15m (7.5d) per coin');
    console.log(`  TP: ${TP_PCT}%  SL: ${SL_PCT}%  Coins: ${ALL_SYMBOLS.length}`);
    console.log('='.repeat(60));

    const existing     = loadExisting();
    const prevBackfill = existing.trades.filter(t => t.entryMode === 'BACKFILL').length;
    if (prevBackfill > 0) {
        console.log(`\n[INFO] Removing ${prevBackfill} old backfill patterns, replacing with fresh data.`);
        existing.trades = existing.trades.filter(t => t.entryMode !== 'BACKFILL');
    }

    const allNew = [];
    let done = 0;

    for (const symbol of ALL_SYMBOLS) {
        console.log(`\n[${++done}/${ALL_SYMBOLS.length}] ${symbol}`);
        const pair = REST_PAIR_MAP[symbol];

        try {
            const [c1m, c5m, c15m] = await Promise.all([
                fetchCandles(pair, 1),
                fetchCandles(pair, 5),
                fetchCandles(pair, 15)
            ]);
            console.log(`  Got: 1m=${c1m.length} 5m=${c5m.length} 15m=${c15m.length} candles`);
            const patterns = processCoin(symbol, c1m, c5m, c15m);
            allNew.push(...patterns);
            console.log(`  Running total: ${allNew.length} patterns`);
        } catch (e) {
            console.log(`  [ERROR] ${symbol}: ${e.message}`);
        }

        await sleep(API_DELAY_MS);
    }

    console.log('\n' + '='.repeat(60));
    console.log(` Backfill complete — ${allNew.length} new patterns`);

    const combined  = [...existing.trades, ...allNew];
    const finalData = { version: 1, trades: combined };
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(finalData, null, 2));
    console.log(` Saved ${combined.length} total patterns → ${PATTERNS_FILE}`);

    const stats  = rebuildStats(combined);
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

    const wr = stats.wins + stats.losses > 0 ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1) : 'N/A';
    console.log(` Win rate: ${wr}%  |  Wins: ${stats.wins}  Losses: ${stats.losses}`);
    console.log('='.repeat(60));
    console.log(' Restart your bot now — it will load all patterns on startup.');
    console.log('='.repeat(60));
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
