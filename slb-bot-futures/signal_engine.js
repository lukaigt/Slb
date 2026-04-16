'use strict';

const patternMemory = require('./pattern_memory');

// Each category counts as ONE independent vote in the signal threshold check.
// Prevents correlated oscillators (RSI/CCI/WilliamsR/BB all oversold at once)
// from satisfying the threshold alone. Requires genuinely different market
// forces to agree before a trade fires.
const SIGNAL_CATEGORIES = {
    // Oscillator — all measure "price has recently dropped/risen"
    rsi_oversold_1m:     'oscillator',
    rsi_overbought_1m:   'oscillator',
    stoch_bounce_1m:     'oscillator',
    stoch_drop_1m:       'oscillator',
    bb_lower_1m:         'oscillator',
    bb_upper_1m:         'oscillator',
    cci_oversold_1m:     'oscillator',
    cci_overbought_1m:   'oscillator',
    willr_oversold_1m:   'oscillator',
    willr_overbought_1m: 'oscillator',
    roc_oversold:        'oscillator',
    roc_overbought:      'oscillator',
    price_at_low:        'oscillator',
    price_at_high:       'oscillator',
    // Momentum — longer timeframe or divergence-based
    rsi_oversold_5m:     'momentum',
    rsi_overbought_5m:   'momentum',
    macd_bull_div:       'momentum',
    macd_bear_div:       'momentum',
    // Trend — EMA-based direction across timeframes
    ema_trend_1m:        'trend',
    ema_trend_5m:        'trend',
    ema_align_15m:       'trend',
    price_above_ema50:   'trend',
    price_below_ema50:   'trend',
    // Strength — trend momentum quality
    adx_bull_1m:         'strength',
    adx_bear_1m:         'strength',
    // Structure — price near key S/R level
    near_support:        'structure',
    near_resistance:     'structure',
    // Flow — orderbook pressure
    orderbook_buy:       'flow',
    orderbook_sell:      'flow',
};

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

    if (ind1m.rsi != null) {
        if (ind1m.rsi <= 30) { result.signals.rsi_oversold_1m = 'LONG'; result.longScore++; }
        else if (ind1m.rsi >= 70) { result.signals.rsi_overbought_1m = 'SHORT'; result.shortScore++; }
        if (ind1m.rsi >= 40 && ind1m.rsi <= 60) { result.signals.rsi_neutral_1m = 'NEUTRAL'; }
    }

    if (ind5m.rsi != null) {
        if (ind5m.rsi <= 35) { result.signals.rsi_oversold_5m = 'LONG'; result.longScore++; }
        else if (ind5m.rsi >= 65) { result.signals.rsi_overbought_5m = 'SHORT'; result.shortScore++; }
    }

    if (ind1m.stochRSI) {
        const k = ind1m.stochRSI.k, d = ind1m.stochRSI.d;
        if (k < 20 && k > d) { result.signals.stoch_bounce_1m = 'LONG'; result.longScore++; }
        else if (k > 80 && k < d) { result.signals.stoch_drop_1m = 'SHORT'; result.shortScore++; }
    }

    if (ind1m.bollinger && price) {
        const range = ind1m.bollinger.upper - ind1m.bollinger.lower;
        if (range > 0) {
            const pos = (price - ind1m.bollinger.lower) / range;
            if (pos <= 0.05) { result.signals.bb_lower_1m = 'LONG'; result.longScore++; }
            else if (pos >= 0.95) { result.signals.bb_upper_1m = 'SHORT'; result.shortScore++; }
        }
    }

    if (ind1m.cci != null) {
        if (ind1m.cci <= -100) { result.signals.cci_oversold_1m = 'LONG'; result.longScore++; }
        else if (ind1m.cci >= 100) { result.signals.cci_overbought_1m = 'SHORT'; result.shortScore++; }
    }

    if (ind1m.willR != null) {
        if (ind1m.willR <= -80) { result.signals.willr_oversold_1m = 'LONG'; result.longScore++; }
        else if (ind1m.willR >= -20) { result.signals.willr_overbought_1m = 'SHORT'; result.shortScore++; }
    }

    if (ind1m.macd && prices.length >= 8) {
        const priceTrend = prices[prices.length - 1] - prices[prices.length - 8];
        const hist = ind1m.macd.histogram;
        if (priceTrend < 0 && hist > 0) { result.signals.macd_bull_div = 'LONG'; result.longScore++; }
        else if (priceTrend > 0 && hist < 0) { result.signals.macd_bear_div = 'SHORT'; result.shortScore++; }
    }

    if (ind5m.ema9 != null && ind5m.ema21 != null && ind5m.ema9 !== ind5m.ema21) {
        if (ind5m.ema9 > ind5m.ema21) { result.signals.ema_trend_5m = 'LONG'; result.longScore++; }
        else { result.signals.ema_trend_5m = 'SHORT'; result.shortScore++; }
    }

    if (ind1m.adx) {
        if (ind1m.adx.adx > 20) {
            if (ind1m.adx.plusDI > ind1m.adx.minusDI) { result.signals.adx_bull_1m = 'LONG'; result.longScore++; }
            else if (ind1m.adx.minusDI > ind1m.adx.plusDI) { result.signals.adx_bear_1m = 'SHORT'; result.shortScore++; }
        }
    }

    if (Math.abs(imbalance) > 0.15) {
        if (imbalance > 0) { result.signals.orderbook_buy = 'LONG'; result.longScore++; }
        else { result.signals.orderbook_sell = 'SHORT'; result.shortScore++; }
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
        if (sDist < rDist && sDist < Infinity) { result.signals.near_support = 'LONG'; result.longScore++; }
        else if (rDist < sDist && rDist < Infinity) { result.signals.near_resistance = 'SHORT'; result.shortScore++; }
    }

    if (prices.length >= 8) {
        const lookback = prices.slice(-8);
        const maxP = Math.max(...lookback), minP = Math.min(...lookback);
        const range = maxP - minP;
        if (range > 0) {
            const pos = (price - minP) / range;
            if (pos <= 0.10) { result.signals.price_at_low = 'LONG'; result.longScore++; }
            else if (pos >= 0.90) { result.signals.price_at_high = 'SHORT'; result.shortScore++; }
        }
    }

    if (ind1m.roc != null) {
        if (ind1m.roc < -0.15) { result.signals.roc_oversold = 'LONG'; result.longScore++; }
        else if (ind1m.roc > 0.15) { result.signals.roc_overbought = 'SHORT'; result.shortScore++; }
    }

    // Price position vs EMA50 — trend-following signal that fires in sustained moves
    if (ind1m.ema50 != null && price) {
        if (price > ind1m.ema50 * 1.001) { result.signals.price_above_ema50 = 'LONG';  result.longScore++;  }
        else if (price < ind1m.ema50 * 0.999) { result.signals.price_below_ema50 = 'SHORT'; result.shortScore++; }
    }

    // 1m EMA9 vs EMA21 — short-term trend direction signal
    if (ind1m.ema9 != null && ind1m.ema21 != null && ind1m.ema9 !== ind1m.ema21) {
        if (ind1m.ema9 > ind1m.ema21) { result.signals.ema_trend_1m = 'LONG';  result.longScore++;  }
        else                           { result.signals.ema_trend_1m = 'SHORT'; result.shortScore++; }
    }

    // 15m EMA alignment — strongest trend-following signal (higher timeframe bias)
    const ind15m = marketState.indicators15m;
    if (ind15m && ind15m.ema9 != null && ind15m.ema21 != null && ind15m.ema9 !== ind15m.ema21) {
        if (ind15m.ema9 > ind15m.ema21) { result.signals.ema_align_15m = 'LONG';  result.longScore++;  }
        else                             { result.signals.ema_align_15m = 'SHORT'; result.shortScore++; }
    }

    result.totalSignals = Object.keys(result.signals).length;

    // ── Category scoring ─────────────────────────────────────────────────────
    // Each category counts as ONE independent vote regardless of how many
    // individual signals fire within it. Prevents 7 correlated oscillators
    // satisfying the threshold alone.
    const longCats = new Set();
    const shortCats = new Set();
    for (const [sig, dir] of Object.entries(result.signals)) {
        const cat = SIGNAL_CATEGORIES[sig];
        if (!cat) continue;
        if (dir === 'LONG') longCats.add(cat);
        else if (dir === 'SHORT') shortCats.add(cat);
    }
    result.longCategoryScore  = longCats.size;
    result.shortCategoryScore = shortCats.size;
    result.longCategories     = [...longCats];
    result.shortCategories    = [...shortCats];

    const direction = result.longCategoryScore > result.shortCategoryScore ? 'LONG'
        : result.shortCategoryScore > result.longCategoryScore ? 'SHORT' : null;

    if (!direction) {
        result.failReason = `Categories split L:${result.longCategoryScore} S:${result.shortCategoryScore}`;
        return result;
    }

    // Hard trend filter: block trades that fight the 15m EMA trend
    if (ind15m && ind15m.ema9 != null && ind15m.ema21 != null) {
        const trend15m = ind15m.ema9 > ind15m.ema21 ? 'UP' : 'DOWN';
        if (direction === 'SHORT' && trend15m === 'UP') {
            result.failReason = `Trend filter blocked SHORT — 15m trend is UP (EMA9 ${ind15m.ema9.toFixed(4)} > EMA21 ${ind15m.ema21.toFixed(4)})`;
            return result;
        }
        if (direction === 'LONG' && trend15m === 'DOWN') {
            result.failReason = `Trend filter blocked LONG — 15m trend is DOWN (EMA9 ${ind15m.ema9.toFixed(4)} < EMA21 ${ind15m.ema21.toFixed(4)})`;
            return result;
        }
    }

    const dominantCatScore = direction === 'LONG' ? result.longCategoryScore : result.shortCategoryScore;

    const pmStats = patternMemory.getStats();
    const isLearning = pmStats.isLearning;
    const minCategories = isLearning ? 2 : 4;

    if (dominantCatScore < minCategories) {
        result.failReason = `Only ${dominantCatScore} independent signal categories for ${direction} (need ${minCategories}+). Categories: ${[...(direction === 'LONG' ? longCats : shortCats)].join(', ')}`;
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
    result.confidence = Math.min(0.95, 0.50 + (dominantCatScore * 0.10));

    const activeSignals = Object.entries(result.signals)
        .filter(([, dir]) => dir === direction)
        .map(([sig]) => sig);

    result.reason = `${direction} | ${dominantCatScore} categories | ${decision.mode} | ${activeSignals.join(', ')}`;

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
        { id: 'rsi_oversold_1m', name: 'RSI Oversold 1m' },
        { id: 'rsi_overbought_1m', name: 'RSI Overbought 1m' },
        { id: 'rsi_oversold_5m', name: 'RSI Oversold 5m' },
        { id: 'rsi_overbought_5m', name: 'RSI Overbought 5m' },
        { id: 'stoch_bounce_1m', name: 'StochRSI Bounce' },
        { id: 'stoch_drop_1m', name: 'StochRSI Drop' },
        { id: 'bb_lower_1m', name: 'BB Lower Touch' },
        { id: 'bb_upper_1m', name: 'BB Upper Touch' },
        { id: 'cci_oversold_1m', name: 'CCI Oversold' },
        { id: 'cci_overbought_1m', name: 'CCI Overbought' },
        { id: 'willr_oversold_1m', name: 'Williams%R Oversold' },
        { id: 'willr_overbought_1m', name: 'Williams%R Overbought' },
        { id: 'macd_bull_div', name: 'MACD Bull Divergence' },
        { id: 'macd_bear_div', name: 'MACD Bear Divergence' },
        { id: 'ema_trend_5m', name: '5m EMA Trend' },
        { id: 'adx_bull_1m', name: 'ADX Bullish' },
        { id: 'adx_bear_1m', name: 'ADX Bearish' },
        { id: 'orderbook_buy', name: 'Orderbook Buyers' },
        { id: 'orderbook_sell', name: 'Orderbook Sellers' },
        { id: 'near_support', name: 'Near Support' },
        { id: 'near_resistance', name: 'Near Resistance' },
        { id: 'price_at_low', name: 'Price At Low' },
        { id: 'price_at_high', name: 'Price At High' },
        { id: 'roc_oversold', name: 'ROC Oversold' },
        { id: 'roc_overbought', name: 'ROC Overbought' },
        { id: 'price_above_ema50', name: 'Price Above EMA50' },
        { id: 'price_below_ema50', name: 'Price Below EMA50' },
        { id: 'ema_trend_1m', name: '1m EMA Trend' },
        { id: 'ema_align_15m', name: '15m EMA Alignment' },
    ];
}

const SIGNAL_DEFINITIONS = getSignalDefinitions();

module.exports = {
    evaluateSignals,
    getSignalDefinitions,
    SIGNAL_DEFINITIONS,
    SIGNAL_CATEGORIES,
    buildSnapshot
};
