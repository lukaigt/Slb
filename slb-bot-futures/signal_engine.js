'use strict';

const SIGNAL_DEFINITIONS = [
    { id: 'ema_cross_1m', name: '1m EMA Cross' },
    { id: 'macd_hist_1m', name: '1m MACD Hist' },
    { id: 'rsi_momentum_1m', name: '1m RSI Zone' },
    { id: 'ema_trend_5m', name: '5m EMA Trend' },
    { id: 'macd_hist_5m', name: '5m MACD Hist' },
    { id: 'adx_direction', name: 'ADX Direction' },
    { id: 'imbalance_flow', name: 'Orderbook Flow' },
    { id: 'stoch_momentum', name: 'StochRSI Mom' },
    { id: 'price_momentum', name: 'Price Momentum' },
];

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
    };

    if (!ind1m || !ind1m.ready || !ind5m || !ind5m.ready) {
        result.failReason = 'Indicators not ready';
        return result;
    }

    if (ind1m.ema9 !== null && ind1m.ema21 !== null && ind1m.ema9 !== ind1m.ema21) {
        if (ind1m.ema9 > ind1m.ema21) {
            result.signals.ema_cross_1m = 'LONG';
            result.longScore++;
        } else {
            result.signals.ema_cross_1m = 'SHORT';
            result.shortScore++;
        }
    }

    if (ind1m.macd && ind1m.macd.histogram !== undefined) {
        if (ind1m.macd.histogram > 0) {
            result.signals.macd_hist_1m = 'LONG';
            result.longScore++;
        } else if (ind1m.macd.histogram < 0) {
            result.signals.macd_hist_1m = 'SHORT';
            result.shortScore++;
        }
    }

    if (ind1m.rsi !== null) {
        if (ind1m.rsi >= 50 && ind1m.rsi <= 65) {
            result.signals.rsi_momentum_1m = 'LONG';
            result.longScore++;
        } else if (ind1m.rsi >= 35 && ind1m.rsi < 50) {
            result.signals.rsi_momentum_1m = 'SHORT';
            result.shortScore++;
        }
    }

    if (ind5m.ema9 !== null && ind5m.ema21 !== null && ind5m.ema9 !== ind5m.ema21) {
        if (ind5m.ema9 > ind5m.ema21) {
            result.signals.ema_trend_5m = 'LONG';
            result.longScore++;
        } else {
            result.signals.ema_trend_5m = 'SHORT';
            result.shortScore++;
        }
    }

    if (ind5m.macd && ind5m.macd.histogram !== undefined) {
        if (ind5m.macd.histogram > 0) {
            result.signals.macd_hist_5m = 'LONG';
            result.longScore++;
        } else if (ind5m.macd.histogram < 0) {
            result.signals.macd_hist_5m = 'SHORT';
            result.shortScore++;
        }
    }

    const adx1m = ind1m.adx ? ind1m.adx.adx : 0;
    const adx5m = ind5m.adx ? ind5m.adx.adx : 0;
    if (adx1m > 15 || adx5m > 15) {
        const bestAdx = adx5m >= adx1m ? ind5m.adx : ind1m.adx;
        if (bestAdx && bestAdx.plusDI > bestAdx.minusDI) {
            result.signals.adx_direction = 'LONG';
            result.longScore++;
        } else if (bestAdx && bestAdx.minusDI > bestAdx.plusDI) {
            result.signals.adx_direction = 'SHORT';
            result.shortScore++;
        }
    }

    if (Math.abs(imbalance) > 0.15) {
        if (imbalance > 0) {
            result.signals.imbalance_flow = 'LONG';
            result.longScore++;
        } else {
            result.signals.imbalance_flow = 'SHORT';
            result.shortScore++;
        }
    }

    if (ind1m.stochRSI) {
        const k = ind1m.stochRSI.k;
        const d = ind1m.stochRSI.d;
        if (k > d && k > 20 && k < 80) {
            result.signals.stoch_momentum = 'LONG';
            result.longScore++;
        } else if (k < d && k > 20 && k < 80) {
            result.signals.stoch_momentum = 'SHORT';
            result.shortScore++;
        }
    }

    if (prices.length >= 4) {
        const priceChange1m = ((prices[prices.length - 1] - prices[prices.length - 4]) / prices[prices.length - 4]) * 100;
        if (priceChange1m > 0.03) {
            result.signals.price_momentum = 'LONG';
            result.longScore++;
        } else if (priceChange1m < -0.03) {
            result.signals.price_momentum = 'SHORT';
            result.shortScore++;
        }
    }

    result.totalSignals = Object.keys(result.signals).length;

    const dominantScore = Math.max(result.longScore, result.shortScore);
    const direction = result.longScore > result.shortScore ? 'LONG' : result.shortScore > result.longScore ? 'SHORT' : null;

    if (!direction) {
        result.failReason = `Signals split evenly L:${result.longScore} S:${result.shortScore} — no clear direction`;
        return result;
    }

    if (dominantScore < 4) {
        result.failReason = `Only ${dominantScore} signals for ${direction} (need 4+). L:${result.longScore} S:${result.shortScore}`;
        return result;
    }

    if (!result.signals.ema_cross_1m || !result.signals.ema_trend_5m) {
        result.failReason = `EMA signals not ready (1m: ${result.signals.ema_cross_1m || 'none'}, 5m: ${result.signals.ema_trend_5m || 'none'})`;
        return result;
    }
    if (result.signals.ema_cross_1m !== result.signals.ema_trend_5m) {
        result.failReason = `1m/5m EMA disagree (1m: ${result.signals.ema_cross_1m}, 5m: ${result.signals.ema_trend_5m})`;
        return result;
    }

    if (adx1m < 15 && adx5m < 15) {
        result.failReason = `ADX too low (1m: ${adx1m.toFixed(1)}, 5m: ${adx5m.toFixed(1)}) — dead market`;
        return result;
    }

    if (trend === 'RANGING') {
        result.failReason = 'Market is RANGING — no entry';
        return result;
    }

    if (sr && price) {
        if (direction === 'LONG' && sr.resistances) {
            const nearRes = sr.resistances.find(r => r.strength === 'STRONG' && r.distancePercent < 0.20);
            if (nearRes) {
                result.failReason = `LONG blocked: strong resistance $${nearRes.price.toFixed(2)} (${nearRes.distancePercent.toFixed(2)}% away)`;
                return result;
            }
        }
        if (direction === 'SHORT' && sr.supports) {
            const nearSup = sr.supports.find(s => s.strength === 'STRONG' && Math.abs(s.distancePercent) < 0.20);
            if (nearSup) {
                result.failReason = `SHORT blocked: strong support $${nearSup.price.toFixed(2)} (${Math.abs(nearSup.distancePercent).toFixed(2)}% away)`;
                return result;
            }
        }
    }

    result.action = direction;
    result.direction = direction;
    result.confidence = Math.min(0.95, 0.50 + (dominantScore * 0.07));

    const activeSignals = Object.entries(result.signals)
        .filter(([, dir]) => dir === direction)
        .map(([sig]) => {
            const def = SIGNAL_DEFINITIONS.find(d => d.id === sig);
            return def ? def.name : sig;
        });

    result.reason = `${direction} | Score ${dominantScore}/${result.totalSignals} | ${activeSignals.join(', ')}`;

    return result;
}

function getSignalDefinitions() {
    return SIGNAL_DEFINITIONS;
}

module.exports = {
    evaluateSignals,
    getSignalDefinitions,
    SIGNAL_DEFINITIONS,
};
