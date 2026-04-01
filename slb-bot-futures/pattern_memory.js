'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PATTERNS_FILE = path.join(DATA_DIR, 'patterns.json');
const STATS_FILE = path.join(DATA_DIR, 'learning_stats.json');

const MIN_TRADES_FOR_LEARNING = 30;
const SIMILARITY_NEIGHBORS = 10;
const MIN_NEIGHBORS_FOR_DECISION = 5;
const WIN_RATE_THRESHOLD = 0.55;

let patterns = { version: 1, trades: [] };
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
            } else {
                console.log('[PatternMemory] Invalid patterns file (no trades array), starting fresh');
                patterns = { version: 1, trades: [] };
            }
            console.log(`[PatternMemory] Loaded ${patterns.trades.length} stored trade patterns`);
        }
    } catch (e) {
        console.log(`[PatternMemory] Error loading patterns: ${e.message}, starting fresh`);
        patterns = { version: 1, trades: [] };
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

    if (ind1m.macd) {
        fp.macd_hist_1m = round(ind1m.macd.histogram);
        fp.macd_line_1m = round(ind1m.macd.macd);
        fp.macd_signal_1m = round(ind1m.macd.signal);
    }
    if (ind5m.macd) {
        fp.macd_hist_5m = round(ind5m.macd.histogram);
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
        macd_hist_1m: [-0.5, 0.5], macd_hist_5m: [-0.5, 0.5],
        macd_line_1m: [-1, 1], macd_signal_1m: [-1, 1],
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

function calcSimilarity(fp1, fp2) {
    const allKeys = new Set([...Object.keys(fp1), ...Object.keys(fp2)]);
    let sumSqDiff = 0;
    let dims = 0;
    for (const key of allKeys) {
        const v1 = normalizeValue(key, fp1[key]);
        const v2 = normalizeValue(key, fp2[key]);
        if (v1 == null || v2 == null) continue;
        const diff = v1 - v2;
        sumSqDiff += diff * diff;
        dims++;
    }
    if (dims === 0) return 0;
    const euclidean = Math.sqrt(sumSqDiff / dims);
    return Math.max(0, 1 - euclidean);
}

function findSimilarTrades(fingerprint, direction, symbol) {
    const candidates = patterns.trades.filter(t =>
        t.direction === direction && t.result && t.fingerprint
    );

    if (candidates.length === 0) return { neighbors: [], winRate: 0, count: 0 };

    const scored = candidates.map(t => ({
        trade: t,
        similarity: calcSimilarity(fingerprint, t.fingerprint)
    }));

    scored.sort((a, b) => b.similarity - a.similarity);

    const neighbors = scored.slice(0, SIMILARITY_NEIGHBORS);
    const wins = neighbors.filter(n => n.trade.result === 'WIN').length;
    const total = neighbors.length;

    return {
        neighbors: neighbors.map(n => ({
            similarity: round(n.similarity * 100),
            result: n.trade.result,
            profitPercent: n.trade.profitPercent,
            symbol: n.trade.symbol,
            direction: n.trade.direction,
            exitReason: n.trade.exitReason,
            timestamp: n.trade.timestamp
        })),
        winRate: total > 0 ? wins / total : 0,
        count: total,
        wins,
        losses: total - wins
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

    if (match.winRate >= WIN_RATE_THRESHOLD) {
        return {
            enter: true,
            mode: 'PATTERN_MATCH',
            reason: `Pattern match: ${match.wins}W/${match.losses}L (${(match.winRate * 100).toFixed(0)}% WR) from ${match.count} similar trades. ENTERING.`,
            matchData: match
        };
    }

    return {
        enter: false,
        mode: 'PATTERN_REJECT',
        reason: `Pattern match: ${match.wins}W/${match.losses}L (${(match.winRate * 100).toFixed(0)}% WR) from ${match.count} similar trades. SKIPPING — below ${(WIN_RATE_THRESHOLD * 100).toFixed(0)}% threshold.`,
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
    MIN_TRADES_FOR_LEARNING,
    WIN_RATE_THRESHOLD
};
