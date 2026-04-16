'use strict';

const patternMemory = require('./pattern_memory');

// Signal categories: signals within the same category are correlated and
// should count as only ONE confirmation, regardless of how many fire.
// This prevents 7 oscillators all screaming "oversold" from satisfying
// the 5-signal threshold on their own.
const SIGNAL_CATEGORIES = {
    // All 1m oscillators measure "price dropped/rose recently" — highly correlated
    oscillator_1m: [
        'rsi_oversold_1m', 'rsi_overbought_1m',
        'stoch_bounce_1m', 'stoch_drop_1m',
        'cci_oversold_1m', 'cci_overbought_1m',
        'willr_oversold_1m', 'willr_overbought_1m',
        'bb_lower_1m', 'bb_upper_1m',
        'price_at_low', 'price_at_high',
        'roc_oversold', 'roc_overbought',
    ],
    // 5m timeframe momentum (independent timeframe)
    oscillator_5m: [
        'rsi_oversold_5m', 'rsi_overbought_5m',
    ],
    // Short-term trend: 1m EMA crossover
    trend_1m: [
        'ema_trend_1m',
    ],
    // Medium-term trend: 5m EMA crossover
    trend_5m: [
        'ema_trend_5m',
    ],
    // Price position vs longer-term EMA
    price_vs_ema50: [
        'price_above_ema50', 'price_below_ema50',
    ],
    // MACD divergence — momentum vs price
    macd_divergence: [
        'macd_bull_div', 'macd_bear_div',
    ],
    // ADX directional strength
    adx_strength: [
        'adx_bull_1m', 'adx_bear_1m',
    ],
    // Orderbook imbalance — supply/demand
    orderbook: [
        'orderbook_buy', 'orderbook_sell',
    ],
    // Support/resistance proximity — structure
    support_resistance: [
        'near_support', 'near_resistance',
    ],
    // Higher timeframe trend alignment
    trend_15m: [
        'ema_align_15m',
    ],
};

// Reverse map: signal name -> category name (built once at startup)
const SIGNAL_TO_CATEGORY = {};
for (const [cat, sigs] of Object.entries(SIGNAL_CATEGORIES)) {
    for (const sig of sigs) SIGNAL_TO_CATEGORY[sig] = cat;
}

// Given the raw signals map, compute scores by counting at most ONE vote per
// category. Returns { longScore, shortScore, activeCategories }.
function computeCategoryScores(signals) {
    const categoryVotes = {};

    for (const [sigName, dir] of Object.entries(signals)) {
        if (dir === 'NEUTRAL') continue;
        const cat = SIGNAL_TO_CATEGORY[sigName] || sigName; // uncategorized → its own category
        if (!categoryVotes[cat]) categoryVotes[cat] = { LONG: 0, SHORT: 0 };
        if (dir === 'LONG') categoryVotes[cat].LONG++;
        else if (dir === 'SHORT') categoryVotes[cat].SHORT++;
    }

    let longScore = 0, shortScore = 0;
    const activeCategories = {};

    for (const [cat, votes] of Object.entries(categoryVotes)) {
        if (votes.LONG > votes.SHORT) { longScore++; activeCategories[cat] = 'LONG'; }
        else if (votes.SHORT > votes.LONG) { shortScore++; activeCategories[cat] = 'SHORT'; }
        // Tie within a category counts as nothing
    }

    return { longScore, shortScore, activeCategories };
}

function evaluateSignals(marketState) {
    const ind1m = marketState.indicators1m;
    const ind5m = marketState.indicators5m;
    const imbalance = marketState.lastImbalance || 0;
    const trend = marketState.trend;
    const prices = marketState.prices || [];
    const sr = marketState.supportResistance;
    const price = marketState.lastPrice;

    const result = {
        action: 'WAIT',
        direction: null,
        signals: {},
        longScore: 0,
        shortScore: 0,
        totalSignals: 0,
        activeCategories: {},
        reason: '',
        failReason: '',
        confidence: 0,
        entryMode: 'NONE',
        patternMatch: null,
        fingerprint: null,
        indicatorSnapshot: {}
    };

    if (!ind1m || !ind1m.ready || !ind5m || !ind5m.ready) {
        result.failReason = 'Indicators not ready';
        return result;
    }

    // ── Raw signal computation ─────────────────────────────────────────────
    // All signals are computed as before. Scores are NOT incremented here —
    // scoring happens after deduplication by category below.

    if (ind1m.rsi != null) {
        if (ind1m.rsi <= 30) result.signals.rsi_oversold_1m = 'LONG';
        else if (ind1m.rsi >= 70) result.signals.rsi_overbought_1m = 'SHORT';
        if (ind1m.rsi >= 40 && ind1m.rsi <= 60) result.signals.rsi_neutral_1m = 'NEUTRAL';
    }

    if (ind5m.rsi != null) {
        if (ind5m.rsi <= 35) result.signals.rsi_oversold_5m = 'LONG';
        else if (ind5m.rsi >= 65) result.signals.rsi_overbought_5m = 'SHORT';
    }

    if (ind1m.stochRSI) {
        const k = ind1m.stochRSI.k, d = ind1m.stochRSI.d;
        if (k < 20 && k > d) result.signals.stoch_bounce_1m = 'LONG';
        else if (k > 80 && k < d) result.signals.stoch_drop_1m = 'SHORT';
    }

    if (ind1m.bollinger && price) {
        const range = ind1m.bollinger.upper - ind1m.bollinger.lower;
        if (range > 0) {
            const pos = (price - ind1m.bollinger.lower) / range;
            if (pos <= 0.05) result.signals.bb_lower_1m = 'LONG';
            else if (pos >= 0.95) result.signals.bb_upper_1m = 'SHORT';
        }
    }

    if (ind1m.cci != null) {
        if (ind1m.cci <= -100) result.signals.cci_oversold_1m = 'LONG';
        else if (ind1m.cci >= 100) result.signals.cci_overbought_1m = 'SHORT';
    }

    if (ind1m.willR != null) {
        if (ind1m.willR <= -80) result.signals.willr_oversold_1m = 'LONG';
        else if (ind1m.willR >= -20) result.signals.willr_overbought_1m = 'SHORT';
    }

    if (ind1m.macd && prices.length >= 8) {
        const priceTrend = prices[prices.length - 1] - prices[prices.length - 8];
        const hist = ind1m.macd.histogram;
        if (priceTrend < 0 && hist > 0) result.signals.macd_bull_div = 'LONG';
        else if (priceTrend > 0 && hist < 0) result.signals.macd_bear_div = 'SHORT';
    }

    if (ind5m.ema9 != null && ind5m.ema21 != null && ind5m.ema9 !== ind5m.ema21) {
        if (ind5m.ema9 > ind5m.ema21) result.signals.ema_trend_5m = 'LONG';
        else result.signals.ema_trend_5m = 'SHORT';
    }

    if (ind1m.adx) {
        if (ind1m.adx.adx > 20) {
            if (ind1m.adx.plusDI > ind1m.adx.minusDI) result.signals.adx_bull_1m = 'LONG';
            else if (ind1m.adx.minusDI > ind1m.adx.plusDI) result.signals.adx_bear_1m = 'SHORT';
        }
    }

    if (Math.abs(imbalance) > 0.15) {
        if (imbalance > 0) result.signals.orderbook_buy = 'LONG';
        else result.signals.orderbook_sell = 'SHORT';
    }

    if (sr && price) {
        let sDist = Infinity, rDist = Infinity;
        if (sr.supports) for (const s of sr.supports) {
            const d = Math.abs(s.distancePercent);
            if (d < 0.30 && (s.strength !== 'WEAK') && d < sDist) sDist = d;
        }
        if (sr.resistances) for (const r of sr.resistances) {
            const d = Math.abs(r.distancePercent);
            if (d < 0.30 && (r.strength !== 'WEAK') && d < rDist) rDist = d;
        }
        if (sDist < rDist && sDist < Infinity) result.signals.near_support = 'LONG';
        else if (rDist < sDist && rDist < Infinity) result.signals.near_resistance = 'SHORT';
    }

    if (prices.length >= 8) {
        const lookback = prices.slice(-8);
        const maxP = Math.max(...lookback), minP = Math.min(...lookback);
        const range = maxP - minP;
        if (range > 0) {
            const pos = (price - minP) / range;
            if (pos <= 0.10) result.signals.price_at_low = 'LONG';
            else if (pos >= 0.90) result.signals.price_at_high = 'SHORT';
        }
    }

    if (ind1m.roc != null) {
        if (ind1m.roc < -0.15) result.signals.roc_oversold = 'LONG';
        else if (ind1m.roc > 0.15) result.signals.roc_overbought = 'SHORT';
    }

    if (ind1m.ema50 != null && price) {
        if (price > ind1m.ema50 * 1.001) result.signals.price_above_ema50 = 'LONG';
        else if (price < ind1m.ema50 * 0.999) result.signals.price_below_ema50 = 'SHORT';
    }

    if (ind1m.ema9 != null && ind1m.ema21 != null && ind1m.ema9 !== ind1m.ema21) {
        if (ind1m.ema9 > ind1m.ema21) result.signals.ema_trend_1m = 'LONG';
        else result.signals.ema_trend_1m = 'SHORT';
    }

    const ind15m = marketState.indicators15m;
    if (ind15m && ind15m.ema9 != null && ind15m.ema21 != null && ind15m.ema9 !== ind15m.ema21) {
        if (ind15m.ema9 > ind15m.ema21) result.signals.ema_align_15m = 'LONG';
        else result.signals.ema_align_15m = 'SHORT';
    }

    // ── Category-deduplicated scoring ──────────────────────────────────────
    // Each independent category can contribute at most 1 point in one direction.
    // This prevents correlated oscillators from inflating the count.
    const catScores = computeCategoryScores(result.signals);
    result.longScore = catScores.longScore;
    result.shortScore = catScores.shortScore;
    result.activeCategories = catScores.activeCategories;
    result.totalSignals = Object.keys(result.signals).length;

    const direction = result.longScore > result.shortScore ? 'LONG'
        : result.shortScore > result.longScore ? 'SHORT' : null;

    if (!direction) {
        result.failReason = `Categories split L:${result.longScore} S:${result.shortScore}`;
        return result;
    }

    // Hard trend filter: block trades that fight the 15m EMA trend.
    // v19 — also require 5m trend alignment. Both 5m and 15m must agree with
    // the intended direction (or at least not fight it). This blocks counter-trend
    // entries where only the 1m oscillators look attractive.
    const trend15m = (ind15m && ind15m.ema9 != null && ind15m.ema21 != null)
        ? (ind15m.ema9 > ind15m.ema21 ? 'UP' : 'DOWN') : null;
    const trend5m = (ind5m && ind5m.ema9 != null && ind5m.ema21 != null)
        ? (ind5m.ema9 > ind5m.ema21 ? 'UP' : 'DOWN') : null;

    if (trend15m) {
        if (direction === 'SHORT' && trend15m === 'UP') {
            result.failReason = `Trend filter blocked SHORT — 15m trend is UP (EMA9 ${ind15m.ema9.toFixed(4)} > EMA21 ${ind15m.ema21.toFixed(4)})`;
            return result;
        }
        if (direction === 'LONG' && trend15m === 'DOWN') {
            result.failReason = `Trend filter blocked LONG — 15m trend is DOWN (EMA9 ${ind15m.ema9.toFixed(4)} < EMA21 ${ind15m.ema21.toFixed(4)})`;
            return result;
        }
    }
    if (trend5m) {
        if (direction === 'SHORT' && trend5m === 'UP') {
            result.failReason = `Trend filter blocked SHORT — 5m trend is UP (EMA9 ${ind5m.ema9.toFixed(4)} > EMA21 ${ind5m.ema21.toFixed(4)}). Multi-TF alignment requires 5m agreement.`;
            return result;
        }
        if (direction === 'LONG' && trend5m === 'DOWN') {
            result.failReason = `Trend filter blocked LONG — 5m trend is DOWN (EMA9 ${ind5m.ema9.toFixed(4)} < EMA21 ${ind5m.ema21.toFixed(4)}). Multi-TF alignment requires 5m agreement.`;
            return result;
        }
    }

    // Hour-of-day filter — skip entries during historically losing UTC hours.
    // Only activates after the hour has 20+ trades recorded AND WR < 40%.
    const nowHour = new Date().getUTCHours();
    const hourStats = patternMemory.getHourStats(nowHour);
    if (!hourStats.allowed) {
        result.failReason = `Hour ${nowHour}:00 UTC blocked — ${hourStats.wins}W/${hourStats.losses}L = ${(hourStats.winRate*100).toFixed(0)}% WR (< 40% with ${hourStats.totalTrades} samples).`;
        return result;
    }

    const dominantScore = Math.max(result.longScore, result.shortScore);

    const pmStats = patternMemory.getStats();
    const isLearning = pmStats.isLearning;
    const minCategories = isLearning ? 2 : 4;

    if (dominantScore < minCategories) {
        const activeCats = Object.keys(result.activeCategories).filter(c => result.activeCategories[c] === direction);
        result.failReason = `Only ${dominantScore} independent signal categories for ${direction} (need ${minCategories}+). Categories: ${activeCats.join(', ')}`;
        return result;
    }

    if (!ind1m.atr || !price || price <= 0) {
        result.failReason = 'ATR or price unavailable — cannot assess volatility';
        return result;
    }
    const atrPct = (ind1m.atr / price) * 100;
    const minATR = isLearning ? 0.02 : 0.05;
    if (atrPct < minATR) {
        result.failReason = `ATR too low (${atrPct.toFixed(3)}%) — dead market (need ${minATR}%+)`;
        return result;
    }

    result.indicatorSnapshot = buildSnapshot(marketState);
    const fingerprint = patternMemory.createFingerprint(marketState);
    result.fingerprint = fingerprint;

    const decision = patternMemory.shouldEnter(fingerprint, direction, marketState.symbol || '');

    if (!decision.enter) {
        result.failReason = decision.reason;
        result.entryMode = decision.mode;
        result.patternMatch = decision.matchData;
        return result;
    }

    result.action = direction;
    result.direction = direction;
    result.entryMode = decision.mode;
    result.patternMatch = decision.matchData;
    result.confidence = Math.min(0.95, 0.50 + (dominantScore * 0.10));

    const activeCatList = Object.keys(result.activeCategories)
        .filter(c => result.activeCategories[c] === direction);

    result.reason = `${direction} | ${dominantScore} categories | ${decision.mode} | ${activeCatList.join(', ')}`;

    return result;
}

function buildSnapshot(marketState) {
    const snap = {};
    const ind1m = marketState.indicators1m || {};
    const ind5m = marketState.indicators5m || {};

    snap.rsi_1m = ind1m.rsi != null ? r(ind1m.rsi) : null;
    snap.rsi_5m = ind5m.rsi != null ? r(ind5m.rsi) : null;
    snap.ema9_1m = ind1m.ema9 != null ? r(ind1m.ema9) : null;
    snap.ema21_1m = ind1m.ema21 != null ? r(ind1m.ema21) : null;
    snap.ema50_1m = ind1m.ema50 != null ? r(ind1m.ema50) : null;
    snap.ema9_5m = ind5m.ema9 != null ? r(ind5m.ema9) : null;
    snap.ema21_5m = ind5m.ema21 != null ? r(ind5m.ema21) : null;
    if (ind1m.macd) { snap.macd_h_1m = r(ind1m.macd.histogram); snap.macd_l_1m = r(ind1m.macd.macd); }
    if (ind5m.macd) { snap.macd_h_5m = r(ind5m.macd.histogram); }
    if (ind1m.bollinger) { snap.bb_upper_1m = r(ind1m.bollinger.upper); snap.bb_lower_1m = r(ind1m.bollinger.lower); snap.bb_bw_1m = r(ind1m.bollinger.bandwidth); }
    if (ind1m.stochRSI) { snap.stoch_k_1m = r(ind1m.stochRSI.k); snap.stoch_d_1m = r(ind1m.stochRSI.d); }
    if (ind5m.stochRSI) { snap.stoch_k_5m = r(ind5m.stochRSI.k); }
    if (ind1m.adx) { snap.adx_1m = r(ind1m.adx.adx); snap.pdi_1m = r(ind1m.adx.plusDI); snap.mdi_1m = r(ind1m.adx.minusDI); }
    if (ind5m.adx) { snap.adx_5m = r(ind5m.adx.adx); }
    snap.atr_1m = ind1m.atr != null ? r(ind1m.atr) : null;
    snap.atr_5m = ind5m.atr != null ? r(ind5m.atr) : null;
    snap.cci_1m = ind1m.cci != null ? r(ind1m.cci) : null;
    snap.willr_1m = ind1m.willR != null ? r(ind1m.willR) : null;
    snap.roc_1m = ind1m.roc != null ? r(ind1m.roc) : null;
    snap.cci_5m = ind5m.cci != null ? r(ind5m.cci) : null;
    snap.willr_5m = ind5m.willR != null ? r(ind5m.willR) : null;
    snap.imbalance = r(marketState.lastImbalance || 0);
    snap.trend = marketState.trend || 'UNKNOWN';
    snap.price = marketState.lastPrice || 0;

    return snap;
}

function r(v) { return Math.round(v * 100) / 100; }

function getSignalDefinitions() {
    return [
        { id: 'rsi_oversold_1m',     name: 'RSI Oversold 1m',        category: 'oscillator_1m' },
        { id: 'rsi_overbought_1m',   name: 'RSI Overbought 1m',       category: 'oscillator_1m' },
        { id: 'rsi_oversold_5m',     name: 'RSI Oversold 5m',         category: 'oscillator_5m' },
        { id: 'rsi_overbought_5m',   name: 'RSI Overbought 5m',       category: 'oscillator_5m' },
        { id: 'stoch_bounce_1m',     name: 'StochRSI Bounce',         category: 'oscillator_1m' },
        { id: 'stoch_drop_1m',       name: 'StochRSI Drop',           category: 'oscillator_1m' },
        { id: 'bb_lower_1m',         name: 'BB Lower Touch',          category: 'oscillator_1m' },
        { id: 'bb_upper_1m',         name: 'BB Upper Touch',          category: 'oscillator_1m' },
        { id: 'cci_oversold_1m',     name: 'CCI Oversold',            category: 'oscillator_1m' },
        { id: 'cci_overbought_1m',   name: 'CCI Overbought',          category: 'oscillator_1m' },
        { id: 'willr_oversold_1m',   name: 'Williams%R Oversold',     category: 'oscillator_1m' },
        { id: 'willr_overbought_1m', name: 'Williams%R Overbought',   category: 'oscillator_1m' },
        { id: 'macd_bull_div',       name: 'MACD Bull Divergence',    category: 'macd_divergence' },
        { id: 'macd_bear_div',       name: 'MACD Bear Divergence',    category: 'macd_divergence' },
        { id: 'ema_trend_5m',        name: '5m EMA Trend',            category: 'trend_5m' },
        { id: 'adx_bull_1m',         name: 'ADX Bullish',             category: 'adx_strength' },
        { id: 'adx_bear_1m',         name: 'ADX Bearish',             category: 'adx_strength' },
        { id: 'orderbook_buy',       name: 'Orderbook Buyers',        category: 'orderbook' },
        { id: 'orderbook_sell',      name: 'Orderbook Sellers',       category: 'orderbook' },
        { id: 'near_support',        name: 'Near Support',            category: 'support_resistance' },
        { id: 'near_resistance',     name: 'Near Resistance',         category: 'support_resistance' },
        { id: 'price_at_low',        name: 'Price At Low',            category: 'oscillator_1m' },
        { id: 'price_at_high',       name: 'Price At High',           category: 'oscillator_1m' },
        { id: 'roc_oversold',        name: 'ROC Oversold',            category: 'oscillator_1m' },
        { id: 'roc_overbought',      name: 'ROC Overbought',          category: 'oscillator_1m' },
        { id: 'price_above_ema50',   name: 'Price Above EMA50',       category: 'price_vs_ema50' },
        { id: 'price_below_ema50',   name: 'Price Below EMA50',       category: 'price_vs_ema50' },
        { id: 'ema_trend_1m',        name: '1m EMA Trend',            category: 'trend_1m' },
        { id: 'ema_align_15m',       name: '15m EMA Alignment',       category: 'trend_15m' },
    ];
}

const SIGNAL_DEFINITIONS = getSignalDefinitions();

module.exports = {
    evaluateSignals,
    getSignalDefinitions,
    SIGNAL_DEFINITIONS,
    SIGNAL_CATEGORIES,
    SIGNAL_TO_CATEGORY,
    buildSnapshot,
    computeCategoryScores,
};
