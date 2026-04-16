'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PATTERNS_FILE = path.join(DATA_DIR, 'patterns.json');
const STATS_FILE = path.join(DATA_DIR, 'learning_stats.json');

// ── Learning parameters (v19 — EV + Wilson + recency) ───────────────────────
const MIN_TRADES_FOR_LEARNING = 30;
const SIMILARITY_NEIGHBORS = 10;
const MIN_NEIGHBORS_FOR_DECISION = 5;
// Wilson lower confidence bound threshold. With 95% confidence, a 50% lower
// bound roughly corresponds to observed WR ≈ 55-60% at 10 samples — realistic
// for profitable scalping with decent R:R.
const WILSON_WR_THRESHOLD = 0.50;
// Minimum expected value per trade (in %, post-leverage-neutral — this is
// raw profitPercent averaged across weighted neighbors). If EV < this, skip.
const MIN_EV_THRESHOLD = 0.00;
// Recency half-life in days. A pattern from 14 days ago contributes half the
// weight of a pattern from today.
const RECENCY_HALF_LIFE_DAYS = 14;
// Feature weights — dimensions that define regime get larger say in k-NN
// distance. Everything else defaults to 1.0.
const FEATURE_WEIGHTS = {
    trend: 3.0,
    ema9_vs_21_15m: 2.5,
    ema9_vs_21_5m: 2.0,
    atr_pct_1m: 2.0,
    atr_pct_5m: 2.0,
    adx_1m: 1.5,
    adx_5m: 1.5,
    rsi_15m: 1.5,
    price_vs_ema50_1m: 1.5,
    // Hour is situational — medium weight
    hour: 1.2,
};

let patterns = { version: 2, trades: [] };
let learningStats = {
    totalStored: 0,
    wins: 0,
    losses: 0,
    byMarket: {},
    byDirection: { LONG: { wins: 0, losses: 0 }, SHORT: { wins: 0, losses: 0 } },
    byHour: {},
    patternMatchEntries: 0,
    patternMatchWins: 0,
    explorationEntries: 0,
    explorationWins: 0,
    lastUpdated: null
};

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('[PatternMemory] Created data/ directory for persistent storage');
    }
}

function load() {
    ensureDataDir();
    try {
        if (fs.existsSync(PATTERNS_FILE)) {
            const data = fs.readFileSync(PATTERNS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && Array.isArray(parsed.trades)) {
                patterns = parsed;
                if (patterns.version == null) patterns.version = 2;
            } else {
                console.log('[PatternMemory] Invalid patterns file (no trades array), starting fresh');
                patterns = { version: 2, trades: [] };
            }
            console.log(`[PatternMemory] Loaded ${patterns.trades.length} stored trade patterns`);
        }
    } catch (e) {
        console.log(`[PatternMemory] Error loading patterns: ${e.message}, starting fresh`);
        patterns = { version: 2, trades: [] };
    }
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === 'object') {
                learningStats = {
                    totalStored: parsed.totalStored || 0,
                    wins: parsed.wins || 0,
                    losses: parsed.losses || 0,
                    byMarket: parsed.byMarket || {},
                    byDirection: parsed.byDirection || { LONG: { wins: 0, losses: 0 }, SHORT: { wins: 0, losses: 0 } },
                    byHour: parsed.byHour || {},
                    patternMatchEntries: parsed.patternMatchEntries || 0,
                    patternMatchWins: parsed.patternMatchWins || 0,
                    explorationEntries: parsed.explorationEntries || 0,
                    explorationWins: parsed.explorationWins || 0,
                    lastUpdated: parsed.lastUpdated || null
                };
            }
        }
    } catch (e) {
        console.log(`[PatternMemory] Error loading stats: ${e.message}`);
    }
}

function save() {
    ensureDataDir();
    try {
        fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
    } catch (e) {
        console.log(`[PatternMemory] Error saving patterns: ${e.message}`);
    }
    try {
        learningStats.lastUpdated = new Date().toISOString();
        fs.writeFileSync(STATS_FILE, JSON.stringify(learningStats, null, 2));
    } catch (e) {
        console.log(`[PatternMemory] Error saving stats: ${e.message}`);
    }
}

function createFingerprint(marketState) {
    const ind1m = marketState.indicators1m || {};
    const ind5m = marketState.indicators5m || {};
    const ind15m = marketState.indicators15m || {};
    const price = marketState.lastPrice || 0;
    const sr = marketState.supportResistance || {};
    const imbalance = marketState.lastImbalance || 0;

    const fp = {};

    fp.rsi_1m = ind1m.rsi != null ? round(ind1m.rsi) : null;
    fp.rsi_5m = ind5m.rsi != null ? round(ind5m.rsi) : null;
    fp.rsi_15m = ind15m.rsi != null ? round(ind15m.rsi) : null;

    if (ind1m.macd && price > 0) {
        fp.macd_hist_1m = round((ind1m.macd.histogram / price) * 100);
        fp.macd_line_1m = round((ind1m.macd.macd    / price) * 100);
        fp.macd_signal_1m = round((ind1m.macd.signal  / price) * 100);
    }
    if (ind5m.macd && price > 0) {
        fp.macd_hist_5m = round((ind5m.macd.histogram / price) * 100);
    }

    if (ind1m.ema9 != null && ind1m.ema21 != null && price > 0) {
        fp.ema9_vs_21_1m = round(((ind1m.ema9 - ind1m.ema21) / price) * 100);
        fp.ema9_vs_price_1m = round(((ind1m.ema9 - price) / price) * 100);
    }
    if (ind1m.ema50 != null && price > 0) {
        fp.price_vs_ema50_1m = round(((price - ind1m.ema50) / price) * 100);
    }
    if (ind5m.ema9 != null && ind5m.ema21 != null && price > 0) {
        fp.ema9_vs_21_5m = round(((ind5m.ema9 - ind5m.ema21) / price) * 100);
    }
    if (ind15m.ema9 != null && ind15m.ema21 != null && price > 0) {
        fp.ema9_vs_21_15m = round(((ind15m.ema9 - ind15m.ema21) / price) * 100);
    }

    if (ind1m.bollinger && price > 0) {
        const range = ind1m.bollinger.upper - ind1m.bollinger.lower;
        fp.bb_position_1m = range > 0 ? round((price - ind1m.bollinger.lower) / range) : 0.5;
        fp.bb_width_1m = round(ind1m.bollinger.bandwidth);
    }
    if (ind5m.bollinger && price > 0) {
        const range = ind5m.bollinger.upper - ind5m.bollinger.lower;
        fp.bb_position_5m = range > 0 ? round((price - ind5m.bollinger.lower) / range) : 0.5;
    }

    if (ind1m.stochRSI) {
        fp.stoch_k_1m = round(ind1m.stochRSI.k);
        fp.stoch_d_1m = round(ind1m.stochRSI.d);
    }
    if (ind5m.stochRSI) {
        fp.stoch_k_5m = round(ind5m.stochRSI.k);
    }

    if (ind1m.adx) {
        fp.adx_1m = round(ind1m.adx.adx);
        fp.plus_di_1m = round(ind1m.adx.plusDI);
        fp.minus_di_1m = round(ind1m.adx.minusDI);
    }
    if (ind5m.adx) {
        fp.adx_5m = round(ind5m.adx.adx);
    }

    if (ind1m.atr != null && price > 0) {
        fp.atr_pct_1m = round((ind1m.atr / price) * 100);
    }
    if (ind5m.atr != null && price > 0) {
        fp.atr_pct_5m = round((ind5m.atr / price) * 100);
    }

    if (ind1m.cci != null) fp.cci_1m = round(ind1m.cci);
    if (ind1m.willR != null) fp.willr_1m = round(ind1m.willR);
    if (ind1m.roc != null) fp.roc_1m = round(ind1m.roc);
    if (ind5m.cci != null) fp.cci_5m = round(ind5m.cci);
    if (ind5m.willR != null) fp.willr_5m = round(ind5m.willR);

    fp.imbalance = round(imbalance);

    let supportDist = null, resistanceDist = null;
    let supportStrength = 0, resistanceStrength = 0;
    if (sr.supports && sr.supports.length > 0) {
        const nearest = sr.supports[0];
        supportDist = round(Math.abs(nearest.distancePercent));
        supportStrength = nearest.strength === 'STRONG' ? 3 : nearest.strength === 'MODERATE' ? 2 : 1;
    }
    if (sr.resistances && sr.resistances.length > 0) {
        const nearest = sr.resistances[0];
        resistanceDist = round(Math.abs(nearest.distancePercent));
        resistanceStrength = nearest.strength === 'STRONG' ? 3 : nearest.strength === 'MODERATE' ? 2 : 1;
    }
    fp.sr_support_dist = supportDist;
    fp.sr_resistance_dist = resistanceDist;
    fp.sr_support_strength = supportStrength;
    fp.sr_resistance_strength = resistanceStrength;

    const prices = marketState.prices || [];
    if (prices.length >= 4) {
        fp.price_change_1m = round(((prices[prices.length - 1] - prices[prices.length - 4]) / prices[prices.length - 4]) * 100);
    }
    if (prices.length >= 20) {
        fp.price_change_5m = round(((prices[prices.length - 1] - prices[prices.length - 20]) / prices[prices.length - 20]) * 100);
    }

    const trendMap = { 'BULLISH': 1, 'BEARISH': -1, 'RANGING': 0 };
    fp.trend = trendMap[marketState.trend] != null ? trendMap[marketState.trend] : 0;

    fp.hour = new Date().getUTCHours();

    return fp;
}

function normalizeValue(key, val) {
    if (val == null) return null;
    const ranges = {
        rsi_1m: [0, 100], rsi_5m: [0, 100], rsi_15m: [0, 100],
        macd_hist_1m: [-0.3, 0.3], macd_hist_5m: [-0.3, 0.3],
        macd_line_1m: [-0.5, 0.5], macd_signal_1m: [-0.5, 0.5],
        ema9_vs_21_1m: [-1, 1], ema9_vs_price_1m: [-1, 1],
        price_vs_ema50_1m: [-2, 2],
        ema9_vs_21_5m: [-1, 1], ema9_vs_21_15m: [-1, 1],
        bb_position_1m: [0, 1], bb_position_5m: [0, 1],
        bb_width_1m: [0, 5],
        stoch_k_1m: [0, 100], stoch_d_1m: [0, 100], stoch_k_5m: [0, 100],
        adx_1m: [0, 80], adx_5m: [0, 80],
        plus_di_1m: [0, 60], minus_di_1m: [0, 60],
        atr_pct_1m: [0, 1], atr_pct_5m: [0, 1],
        cci_1m: [-200, 200], cci_5m: [-200, 200],
        willr_1m: [-100, 0], willr_5m: [-100, 0],
        roc_1m: [-2, 2],
        imbalance: [-1, 1],
        sr_support_dist: [0, 2], sr_resistance_dist: [0, 2],
        sr_support_strength: [0, 3], sr_resistance_strength: [0, 3],
        price_change_1m: [-1, 1], price_change_5m: [-2, 2],
        trend: [-1, 1], hour: [0, 23]
    };
    const r = ranges[key];
    if (!r) return 0.5;
    const clamped = Math.max(r[0], Math.min(r[1], val));
    return (clamped - r[0]) / (r[1] - r[0]);
}

// Weighted Euclidean distance — same math as before but each dim contributes
// its FEATURE_WEIGHTS multiplier squared. Returns similarity = 1 − normalized
// weighted distance ∈ [0, 1].
function calcSimilarity(fp1, fp2) {
    const allKeys = new Set([...Object.keys(fp1), ...Object.keys(fp2)]);
    let sumSqDiff = 0;
    let sumWeights = 0;
    for (const key of allKeys) {
        const v1 = normalizeValue(key, fp1[key]);
        const v2 = normalizeValue(key, fp2[key]);
        if (v1 == null || v2 == null) continue;
        const w = FEATURE_WEIGHTS[key] != null ? FEATURE_WEIGHTS[key] : 1.0;
        const diff = v1 - v2;
        sumSqDiff += w * diff * diff;
        sumWeights += w;
    }
    if (sumWeights === 0) return 0;
    const euclidean = Math.sqrt(sumSqDiff / sumWeights);
    return Math.max(0, 1 - euclidean);
}

// Exponential decay weight for a pattern given its age in days.
// weight = 0.5^(ageDays / halfLife) — recent trades count more.
function recencyWeight(timestamp) {
    if (!timestamp) return 0.5;
    const ageMs = Date.now() - new Date(timestamp).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 0) return 1.0;
    return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

// Wilson score lower bound (95% confidence). Returns 0 when n=0.
// Used because a raw 80% WR on 5 trades is statistically weaker than 70% on 50.
function wilsonLowerBound(wins, total, zScore) {
    if (total === 0) return 0;
    const z = zScore != null ? zScore : 1.96;
    const p = wins / total;
    const denom = 1 + (z * z) / total;
    const center = p + (z * z) / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return Math.max(0, (center - margin) / denom);
}

function findSimilarTrades(fingerprint, direction, symbol) {
    const currentRegime = fingerprint.trend != null ? fingerprint.trend : null;

    // Strict filter: same coin + same direction + same regime.
    // If too few results, shouldEnter() falls through to exploration — intentional.
    const candidates = patterns.trades.filter(t =>
        t.direction === direction &&
        t.symbol === symbol &&
        t.result &&
        t.fingerprint &&
        (currentRegime == null || t.fingerprint.trend == null || t.fingerprint.trend === currentRegime)
    );

    if (candidates.length === 0) {
        return { neighbors: [], winRate: 0, wilsonWR: 0, expectedValue: 0, count: 0, wins: 0, losses: 0 };
    }

    const scored = candidates.map(t => ({
        trade: t,
        similarity: calcSimilarity(fingerprint, t.fingerprint)
    }));

    scored.sort((a, b) => b.similarity - a.similarity);
    const neighbors = scored.slice(0, SIMILARITY_NEIGHBORS);

    // Similarity × recency weighted aggregation. A near-match from 2 days ago
    // should dominate over a distant-match from 20 days ago. Combined weight
    // = similarity * recencyWeight. Old losses fade out AND loose matches
    // contribute less to the running vote.
    let weightedWins = 0, weightedTotal = 0;
    let weightedProfit = 0;
    let rawWins = 0;
    for (const n of neighbors) {
        const w = Math.max(0, n.similarity) * recencyWeight(n.trade.timestamp);
        weightedTotal += w;
        if (n.trade.result === 'WIN') {
            weightedWins += w;
            rawWins++;
        }
        const p = n.trade.profitPercent != null ? n.trade.profitPercent : 0;
        weightedProfit += w * p;
    }

    const total = neighbors.length;
    const rawLosses = total - rawWins;

    // Effective sample size for Wilson — use recency-weighted total, floor at
    // actual sample count so small-n bias still applies.
    const effN = Math.max(total, Math.round(weightedTotal));
    const effWins = Math.round((weightedWins / Math.max(1e-9, weightedTotal)) * effN);

    const winRate = total > 0 ? rawWins / total : 0;
    const weightedWR = weightedTotal > 0 ? weightedWins / weightedTotal : 0;
    const wilsonWR = wilsonLowerBound(effWins, effN);
    const expectedValue = weightedTotal > 0 ? weightedProfit / weightedTotal : 0;

    return {
        neighbors: neighbors.map(n => ({
            similarity: round(n.similarity * 100),
            result: n.trade.result,
            profitPercent: n.trade.profitPercent,
            symbol: n.trade.symbol,
            direction: n.trade.direction,
            exitReason: n.trade.exitReason,
            timestamp: n.trade.timestamp,
            recencyWeight: round(recencyWeight(n.trade.timestamp))
        })),
        winRate,
        weightedWinRate: round(weightedWR),
        wilsonWR: round(wilsonWR),
        expectedValue: round(expectedValue),
        count: total,
        wins: rawWins,
        losses: rawLosses
    };
}

function shouldEnter(fingerprint, direction, symbol) {
    const totalTrades = patterns.trades.length;
    const isLearning = totalTrades < MIN_TRADES_FOR_LEARNING;

    if (isLearning) {
        return {
            enter: true,
            mode: 'EXPLORATION',
            reason: `Learning phase (${totalTrades}/${MIN_TRADES_FOR_LEARNING} trades stored). Entering to collect data.`,
            matchData: null
        };
    }

    const match = findSimilarTrades(fingerprint, direction, symbol);

    if (match.count < MIN_NEIGHBORS_FOR_DECISION) {
        return {
            enter: true,
            mode: 'EXPLORATION',
            reason: `Only ${match.count} similar ${direction} patterns found (need ${MIN_NEIGHBORS_FOR_DECISION}). Entering to learn.`,
            matchData: match
        };
    }

    // Decision rule: Wilson-LCB WR must clear threshold AND expected value
    // must be positive. Either condition alone is insufficient.
    //   • WR alone can be a 4W/1L fluke → Wilson handles that.
    //   • Wilson alone can approve a 60% WR strategy that still loses money
    //     (big losses on the 40%) → EV gate handles that.
    const wrOk = match.wilsonWR >= WILSON_WR_THRESHOLD;
    const evOk = match.expectedValue > MIN_EV_THRESHOLD;

    if (wrOk && evOk) {
        return {
            enter: true,
            mode: 'PATTERN_MATCH',
            reason: `Pattern match: ${match.wins}W/${match.losses}L | raw WR ${(match.winRate*100).toFixed(0)}% | Wilson-LCB ${(match.wilsonWR*100).toFixed(0)}% | EV ${match.expectedValue>=0?'+':''}${match.expectedValue.toFixed(2)}% | ${match.count} neighbors. ENTERING.`,
            matchData: match
        };
    }

    // 5% exploration so the bot never fully freezes.
    if (Math.random() < 0.05) {
        return {
            enter: true,
            mode: 'EXPLORATION',
            reason: `Pattern below threshold (Wilson ${(match.wilsonWR*100).toFixed(0)}%, EV ${match.expectedValue.toFixed(2)}%) — exploring (5% rate) to keep learning.`,
            matchData: match
        };
    }

    const failBits = [];
    if (!wrOk) failBits.push(`Wilson-LCB ${(match.wilsonWR*100).toFixed(0)}% < ${(WILSON_WR_THRESHOLD*100).toFixed(0)}%`);
    if (!evOk) failBits.push(`EV ${match.expectedValue.toFixed(2)}% ≤ 0`);

    return {
        enter: false,
        mode: 'PATTERN_REJECT',
        reason: `Pattern reject: ${match.wins}W/${match.losses}L from ${match.count} neighbors — ${failBits.join(', ')}.`,
        matchData: match
    };
}

function storeTrade(tradeData) {
    const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        timestamp: tradeData.timestamp || new Date().toISOString(),
        symbol: tradeData.symbol,
        direction: tradeData.direction,
        entryPrice: tradeData.entryPrice,
        exitPrice: tradeData.exitPrice,
        profitPercent: round(tradeData.profitPercent),
        result: tradeData.result,
        exitReason: tradeData.exitReason,
        holdTimeMin: tradeData.holdTimeMin,
        fingerprint: tradeData.fingerprint || {},
        entryMode: tradeData.entryMode || 'UNKNOWN',
        triggerSignals: tradeData.triggerSignals || [],
        tpUsed: tradeData.tpUsed || null,
        slUsed: tradeData.slUsed || null,
        tpSlMode: tradeData.tpSlMode || null,
        tpSlBase: tradeData.tpSlBase || null
    };

    patterns.trades.push(entry);

    learningStats.totalStored = patterns.trades.length;
    if (entry.result === 'WIN') learningStats.wins++;
    else learningStats.losses++;

    if (!learningStats.byMarket[entry.symbol]) {
        learningStats.byMarket[entry.symbol] = { wins: 0, losses: 0 };
    }
    if (entry.result === 'WIN') learningStats.byMarket[entry.symbol].wins++;
    else learningStats.byMarket[entry.symbol].losses++;

    if (learningStats.byDirection[entry.direction]) {
        if (entry.result === 'WIN') learningStats.byDirection[entry.direction].wins++;
        else learningStats.byDirection[entry.direction].losses++;
    }

    const hour = new Date(entry.timestamp).getUTCHours().toString();
    if (!learningStats.byHour[hour]) learningStats.byHour[hour] = { wins: 0, losses: 0 };
    if (entry.result === 'WIN') learningStats.byHour[hour].wins++;
    else learningStats.byHour[hour].losses++;

    if (entry.entryMode === 'PATTERN_MATCH') {
        learningStats.patternMatchEntries++;
        if (entry.result === 'WIN') learningStats.patternMatchWins++;
    } else {
        learningStats.explorationEntries++;
        if (entry.result === 'WIN') learningStats.explorationWins++;
    }

    save();
    return entry;
}

// Returns {hour, totalTrades, wins, losses, winRate, allowed} for a given UTC hour.
// allowed = false when that hour has ≥ 20 samples AND WR < 40%. Used as a
// time-of-day filter to block entries during historically losing windows.
function getHourStats(hour) {
    const h = String(hour);
    const bucket = learningStats.byHour[h] || { wins: 0, losses: 0 };
    const total = bucket.wins + bucket.losses;
    const wr = total > 0 ? bucket.wins / total : 0;
    const allowed = total < 20 || wr >= 0.40;
    return {
        hour: Number(h),
        totalTrades: total,
        wins: bucket.wins,
        losses: bucket.losses,
        winRate: round(wr),
        allowed
    };
}

function getStats() {
    return {
        ...learningStats,
        totalStored: patterns.trades.length,
        isLearning: patterns.trades.length < MIN_TRADES_FOR_LEARNING,
        learningProgress: Math.min(100, Math.round((patterns.trades.length / MIN_TRADES_FOR_LEARNING) * 100)),
        overallWinRate: (learningStats.wins + learningStats.losses) > 0
            ? round((learningStats.wins / (learningStats.wins + learningStats.losses)) * 100) : 0,
        patternMatchWinRate: learningStats.patternMatchEntries > 0
            ? round((learningStats.patternMatchWins / learningStats.patternMatchEntries) * 100) : 0,
        explorationWinRate: learningStats.explorationEntries > 0
            ? round((learningStats.explorationWins / learningStats.explorationEntries) * 100) : 0
    };
}

function getRecentPatterns(limit = 20) {
    return patterns.trades.slice(-limit).reverse();
}

function round(v) {
    return Math.round(v * 10000) / 10000;
}

module.exports = {
    load,
    save,
    createFingerprint,
    shouldEnter,
    storeTrade,
    findSimilarTrades,
    getStats,
    getRecentPatterns,
    getHourStats,
    wilsonLowerBound,
    recencyWeight,
    MIN_TRADES_FOR_LEARNING,
    WILSON_WR_THRESHOLD,
    MIN_EV_THRESHOLD,
    RECENCY_HALF_LIFE_DAYS,
    FEATURE_WEIGHTS
};
