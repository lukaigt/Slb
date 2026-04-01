'use strict';

const SIGNAL_DEFINITIONS = [
    { id: 'rsi_reversal', name: 'RSI Reversal' },
    { id: 'stoch_reversal', name: 'StochRSI Reversal' },
    { id: 'bb_bounce', name: 'Bollinger Bounce' },
    { id: 'sr_proximity', name: 'S/R Proximity' },
    { id: 'macd_divergence', name: 'MACD Divergence' },
    { id: 'ema_trend_5m', name: '5m EMA Trend' },
    { id: 'adx_strength', name: 'ADX Strength' },
    { id: 'imbalance_flow', name: 'Orderbook Flow' },
    { id: 'price_exhaustion', name: 'Price Exhaustion' },
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

    if (ind1m.rsi !== null) {
        if (ind1m.rsi <= 30) {
            result.signals.rsi_reversal = 'LONG';
            result.longScore++;
        } else if (ind1m.rsi >= 70) {
            result.signals.rsi_reversal = 'SHORT';
            result.shortScore++;
        }
    }

    if (ind1m.stochRSI) {
        const k = ind1m.stochRSI.k;
        const d = ind1m.stochRSI.d;
        if (k < 25 && k > d) {
            result.signals.stoch_reversal = 'LONG';
            result.longScore++;
        } else if (k > 75 && k < d) {
            result.signals.stoch_reversal = 'SHORT';
            result.shortScore++;
        }
    }

    if (ind1m.bollinger && price) {
        const bbRange = ind1m.bollinger.upper - ind1m.bollinger.lower;
        if (bbRange > 0) {
            const bbPosition = (price - ind1m.bollinger.lower) / bbRange;
            if (bbPosition <= 0.05) {
                result.signals.bb_bounce = 'LONG';
                result.longScore++;
            } else if (bbPosition >= 0.95) {
                result.signals.bb_bounce = 'SHORT';
                result.shortScore++;
            }
        }
    }

    if (sr && price) {
        let nearestSupport = null;
        let nearestResistance = null;
        if (sr.supports) {
            for (const s of sr.supports) {
                const dist = Math.abs(s.distancePercent);
                if (dist < 0.30 && (s.strength === 'STRONG' || s.strength === 'MODERATE')) {
                    if (!nearestSupport || dist < Math.abs(nearestSupport.distancePercent)) {
                        nearestSupport = s;
                    }
                }
            }
        }
        if (sr.resistances) {
            for (const r of sr.resistances) {
                const dist = Math.abs(r.distancePercent);
                if (dist < 0.30 && (r.strength === 'STRONG' || r.strength === 'MODERATE')) {
                    if (!nearestResistance || dist < Math.abs(nearestResistance.distancePercent)) {
                        nearestResistance = r;
                    }
                }
            }
        }
        if (nearestSupport) {
            result.signals.sr_proximity = 'LONG';
            result.longScore++;
        } else if (nearestResistance) {
            result.signals.sr_proximity = 'SHORT';
            result.shortScore++;
        }
    }

    if (ind1m.macd && prices.length >= 8) {
        const recentPrices = prices.slice(-8);
        const priceTrend = recentPrices[recentPrices.length - 1] - recentPrices[0];
        const hist = ind1m.macd.histogram;
        if (priceTrend < 0 && hist > -0.001 && hist < 0.01) {
            result.signals.macd_divergence = 'LONG';
            result.longScore++;
        } else if (priceTrend > 0 && hist < 0.001 && hist > -0.01) {
            result.signals.macd_divergence = 'SHORT';
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

    const adx1m = ind1m.adx ? ind1m.adx.adx : 0;
    const adx5m = ind5m.adx ? ind5m.adx.adx : 0;
    if (adx1m > 20 || adx5m > 20) {
        const bestAdx = adx5m >= adx1m ? ind5m.adx : ind1m.adx;
        if (bestAdx && bestAdx.plusDI > bestAdx.minusDI) {
            result.signals.adx_strength = 'LONG';
            result.longScore++;
        } else if (bestAdx && bestAdx.minusDI > bestAdx.plusDI) {
            result.signals.adx_strength = 'SHORT';
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

    if (prices.length >= 8) {
        const lookback = prices.slice(-8);
        const maxP = Math.max(...lookback);
        const minP = Math.min(...lookback);
        const range = maxP - minP;
        if (range > 0 && price) {
            const posInRange = (price - minP) / range;
            if (posInRange <= 0.10) {
                result.signals.price_exhaustion = 'LONG';
                result.longScore++;
            } else if (posInRange >= 0.90) {
                result.signals.price_exhaustion = 'SHORT';
                result.shortScore++;
            }
        }
    }

    result.totalSignals = Object.keys(result.signals).length;

    const dominantScore = Math.max(result.longScore, result.shortScore);
    const direction = result.longScore > result.shortScore ? 'LONG' : result.shortScore > result.longScore ? 'SHORT' : null;

    if (!direction) {
        result.failReason = `Signals split evenly L:${result.longScore} S:${result.shortScore} — no clear direction`;
        return result;
    }

    if (dominantScore < 5) {
        result.failReason = `Only ${dominantScore} signals for ${direction} (need 5+). L:${result.longScore} S:${result.shortScore}`;
        return result;
    }

    const hasReversal = result.signals.rsi_reversal === direction ||
                        result.signals.stoch_reversal === direction ||
                        result.signals.bb_bounce === direction;
    if (!hasReversal) {
        result.failReason = `No reversal signal (RSI/StochRSI/BB) for ${direction} — need at least one mean-reversion trigger`;
        return result;
    }

    if (!result.signals.ema_trend_5m) {
        result.failReason = '5m EMA trend not available';
        return result;
    }
    if (result.signals.ema_trend_5m !== direction) {
        result.failReason = `5m trend ${result.signals.ema_trend_5m} disagrees with ${direction} reversal — only buy dips in uptrends, sell rips in downtrends`;
        return result;
    }

    const atr1m = ind1m.atr;
    if (!atr1m || !price) {
        result.failReason = 'ATR or price unavailable — cannot verify volatility';
        return result;
    }
    const atrPct = (atr1m / price) * 100;
    if (atrPct < 0.08) {
        result.failReason = `ATR too low (${atrPct.toFixed(3)}%) — not enough volatility to reach TP`;
        return result;
    }

    if (trend === 'RANGING') {
        result.failReason = 'Market is RANGING — no entry';
        return result;
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
