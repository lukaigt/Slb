'use strict';

function buildCandles(prices, timestamps, intervalMs) {
    if (!prices || prices.length < 2) return [];
    const candles = [];
    let i = 0;
    while (i < prices.length) {
        const startTime = timestamps[i];
        const endTime = startTime + intervalMs;
        let open = prices[i];
        let high = prices[i];
        let low = prices[i];
        let close = prices[i];
        while (i < prices.length && timestamps[i] < endTime) {
            if (prices[i] > high) high = prices[i];
            if (prices[i] < low) low = prices[i];
            close = prices[i];
            i++;
        }
        candles.push({ open, high, low, close, time: startTime });
    }
    return candles;
}

function calcEMA(data, period) {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = 0;
    for (let i = 0; i < period; i++) ema += data[i];
    ema /= period;
    for (let i = period; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
    }
    return ema;
}

function calcEMASeries(data, period) {
    if (data.length < period) return [];
    const k = 2 / (period + 1);
    const result = [];
    let ema = 0;
    for (let i = 0; i < period; i++) ema += data[i];
    ema /= period;
    result.push(ema);
    for (let i = period; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}

function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) avgGain += change;
        else avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
        }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calcRSISeries(closes, period = 14) {
    if (closes.length < period + 1) return [];
    const result = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) avgGain += change;
        else avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;
    if (avgLoss === 0) result.push(100);
    else result.push(100 - (100 / (1 + avgGain / avgLoss)));
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
        }
        if (avgLoss === 0) result.push(100);
        else result.push(100 - (100 / (1 + avgGain / avgLoss)));
    }
    return result;
}

function calcMACD(closes) {
    if (closes.length < 35) return null;
    const ema12 = calcEMASeries(closes, 12);
    const ema26 = calcEMASeries(closes, 26);
    if (ema12.length === 0 || ema26.length === 0) return null;
    const offset = closes.length - 26;
    const macdLine = [];
    for (let i = 0; i < ema26.length; i++) {
        const idx12 = ema12.length - ema26.length + i;
        if (idx12 >= 0) {
            macdLine.push(ema12[idx12] - ema26[i]);
        }
    }
    if (macdLine.length < 9) return null;
    const signalSeries = calcEMASeries(macdLine, 9);
    if (signalSeries.length === 0) return null;
    const macd = macdLine[macdLine.length - 1];
    const signal = signalSeries[signalSeries.length - 1];
    const histogram = macd - signal;
    return { macd, signal, histogram };
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const sd = Math.sqrt(variance);
    return {
        upper: sma + stdDev * sd,
        middle: sma,
        lower: sma - stdDev * sd,
        bandwidth: ((sma + stdDev * sd) - (sma - stdDev * sd)) / sma * 100
    };
}

function calcATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trValues = [];
    for (let i = 1; i < candles.length; i++) {
        const tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        );
        trValues.push(tr);
    }
    if (trValues.length < period) return null;
    let atr = 0;
    for (let i = 0; i < period; i++) atr += trValues[i];
    atr /= period;
    for (let i = period; i < trValues.length; i++) {
        atr = (atr * (period - 1) + trValues[i]) / period;
    }
    return atr;
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
    const rsiSeries = calcRSISeries(closes, rsiPeriod);
    if (rsiSeries.length < stochPeriod) return null;
    const stochK = [];
    for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
        const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
        const minRSI = Math.min(...window);
        const maxRSI = Math.max(...window);
        if (maxRSI === minRSI) stochK.push(50);
        else stochK.push(((rsiSeries[i] - minRSI) / (maxRSI - minRSI)) * 100);
    }
    if (stochK.length < kSmooth) return null;
    const smoothedK = [];
    for (let i = kSmooth - 1; i < stochK.length; i++) {
        let sum = 0;
        for (let j = 0; j < kSmooth; j++) sum += stochK[i - j];
        smoothedK.push(sum / kSmooth);
    }
    if (smoothedK.length < dSmooth) return null;
    const smoothedD = [];
    for (let i = dSmooth - 1; i < smoothedK.length; i++) {
        let sum = 0;
        for (let j = 0; j < dSmooth; j++) sum += smoothedK[i - j];
        smoothedD.push(sum / dSmooth);
    }
    return {
        k: smoothedK[smoothedK.length - 1],
        d: smoothedD[smoothedD.length - 1]
    };
}

function calcADX(candles, period = 14) {
    if (candles.length < period * 2 + 1) return null;
    const plusDM = [], minusDM = [], tr = [];
    for (let i = 1; i < candles.length; i++) {
        const upMove = candles[i].high - candles[i - 1].high;
        const downMove = candles[i - 1].low - candles[i].low;
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        tr.push(Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        ));
    }
    if (tr.length < period) return null;
    let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
    for (let i = 0; i < period; i++) {
        smoothTR += tr[i];
        smoothPlusDM += plusDM[i];
        smoothMinusDM += minusDM[i];
    }
    const dxValues = [];
    for (let i = period; i < tr.length; i++) {
        smoothTR = smoothTR - (smoothTR / period) + tr[i];
        smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
        smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];
        const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
        const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
        const diSum = plusDI + minusDI;
        const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
        dxValues.push({ dx, plusDI, minusDI });
    }
    if (dxValues.length < period) return null;
    let adx = 0;
    for (let i = 0; i < period; i++) adx += dxValues[i].dx;
    adx /= period;
    for (let i = period; i < dxValues.length; i++) {
        adx = (adx * (period - 1) + dxValues[i].dx) / period;
    }
    const last = dxValues[dxValues.length - 1];
    return { adx, plusDI: last.plusDI, minusDI: last.minusDI };
}

function calculateAllIndicators(candles) {
    if (!candles || candles.length < 5) {
        return { ready: false, reason: 'Not enough candle data yet' };
    }
    const closes = candles.map(c => c.close);
    const result = { ready: true };

    result.ema9 = calcEMA(closes, 9);
    result.ema21 = calcEMA(closes, 21);
    result.ema50 = calcEMA(closes, 50);
    result.rsi = calcRSI(closes, 14);
    result.macd = calcMACD(closes);
    result.bollinger = calcBollingerBands(closes, 20, 2);
    result.atr = calcATR(candles, 14);
    result.stochRSI = calcStochRSI(closes, 14, 14, 3, 3);
    result.adx = calcADX(candles, 14);

    if (closes.length >= 22) {
        const prevCloses = closes.slice(0, -1);
        result.prevEma9 = calcEMA(prevCloses, 9);
        result.prevEma21 = calcEMA(prevCloses, 21);
    } else {
        result.prevEma9 = null;
        result.prevEma21 = null;
    }

    const available = [
        result.ema9, result.ema21, result.ema50, result.rsi, result.macd,
        result.bollinger, result.atr, result.stochRSI, result.adx
    ].filter(v => v !== null).length;
    result.indicatorsAvailable = available;
    result.indicatorsTotal = 9;

    return result;
}

function generateSignal(ind5m, ind15m, currentPrice) {
    const result = { action: 'WAIT', reason: '', stopLoss: null, takeProfit: null, confidence: 0, maxHoldMinutes: 120 };

    if (!ind5m || !ind5m.ready || !ind15m || !ind15m.ready) {
        result.reason = 'Indicators not ready';
        return result;
    }
    if (!ind5m.ema9 || !ind5m.ema21 || !ind5m.prevEma9 || !ind5m.prevEma21) {
        result.reason = 'EMA data insufficient for crossover detection';
        return result;
    }
    if (!ind15m.ema50 || !ind15m.adx || !ind5m.rsi || !ind5m.atr) {
        result.reason = 'Missing critical indicators (EMA50/ADX/RSI/ATR)';
        return result;
    }

    const adx = ind15m.adx.adx;
    if (adx < 20) {
        result.reason = `ADX ${adx.toFixed(1)} < 20 - no trend`;
        return result;
    }

    const bullishCross = ind5m.prevEma9 <= ind5m.prevEma21 && ind5m.ema9 > ind5m.ema21;
    const bearishCross = ind5m.prevEma9 >= ind5m.prevEma21 && ind5m.ema9 < ind5m.ema21;

    if (!bullishCross && !bearishCross) {
        result.reason = 'No EMA 9/21 crossover on 5m';
        return result;
    }

    const ema15mBullish = ind15m.ema9 && ind15m.ema21 && ind15m.ema9 > ind15m.ema21;
    const macd15mBullish = ind15m.macd && ind15m.macd.histogram > 0;

    const atrPrice = (ind5m.atr / currentPrice) * 100;
    const slPercent = Math.max(0.3, Math.min(1.0, atrPrice * 1.5));
    const tpPercent = Math.max(slPercent * 2.0, Math.min(2.5, atrPrice * 3.0));

    if (bullishCross) {
        if (currentPrice < ind15m.ema50) {
            result.reason = `Bullish cross but price $${currentPrice.toFixed(2)} below 15m EMA50 $${ind15m.ema50.toFixed(2)}`;
            return result;
        }
        if (!ema15mBullish) {
            result.reason = '15m EMAs not bullish - no alignment';
            return result;
        }
        if (ind5m.rsi > 70) {
            result.reason = `RSI ${ind5m.rsi.toFixed(1)} > 70 - too overbought for LONG entry`;
            return result;
        }
        if (ind5m.rsi < 35) {
            result.reason = `RSI ${ind5m.rsi.toFixed(1)} < 35 - momentum too weak for LONG`;
            return result;
        }

        let conf = 0.6;
        if (adx > 30) conf += 0.1;
        if (adx > 40) conf += 0.05;
        if (macd15mBullish) conf += 0.1;
        if (ind5m.macd && ind5m.macd.histogram > 0) conf += 0.05;
        if (ind5m.stochRSI && ind5m.stochRSI.k < 80) conf += 0.05;
        conf = Math.min(0.95, conf);

        result.action = 'LONG';
        result.stopLoss = slPercent;
        result.takeProfit = tpPercent;
        result.confidence = conf;
        result.reason = `5m EMA9/21 bullish cross | 15m aligned bullish | ADX ${adx.toFixed(1)} | RSI ${ind5m.rsi.toFixed(1)} | ATR-SL ${slPercent.toFixed(2)}%`;
        result.maxHoldMinutes = adx > 35 ? 180 : 120;
        return result;
    }

    if (bearishCross) {
        if (currentPrice > ind15m.ema50) {
            result.reason = `Bearish cross but price $${currentPrice.toFixed(2)} above 15m EMA50 $${ind15m.ema50.toFixed(2)}`;
            return result;
        }
        if (ema15mBullish) {
            result.reason = '15m EMAs still bullish - no alignment for SHORT';
            return result;
        }
        if (ind5m.rsi < 30) {
            result.reason = `RSI ${ind5m.rsi.toFixed(1)} < 30 - too oversold for SHORT entry`;
            return result;
        }
        if (ind5m.rsi > 65) {
            result.reason = `RSI ${ind5m.rsi.toFixed(1)} > 65 - momentum too strong for SHORT`;
            return result;
        }

        let conf = 0.6;
        if (adx > 30) conf += 0.1;
        if (adx > 40) conf += 0.05;
        if (!macd15mBullish) conf += 0.1;
        if (ind5m.macd && ind5m.macd.histogram < 0) conf += 0.05;
        if (ind5m.stochRSI && ind5m.stochRSI.k > 20) conf += 0.05;
        conf = Math.min(0.95, conf);

        result.action = 'SHORT';
        result.stopLoss = slPercent;
        result.takeProfit = tpPercent;
        result.confidence = conf;
        result.reason = `5m EMA9/21 bearish cross | 15m aligned bearish | ADX ${adx.toFixed(1)} | RSI ${ind5m.rsi.toFixed(1)} | ATR-SL ${slPercent.toFixed(2)}%`;
        result.maxHoldMinutes = adx > 35 ? 180 : 120;
        return result;
    }

    return result;
}

function formatIndicatorsForAI(indicators, timeframeLabel) {
    if (!indicators || !indicators.ready) {
        return `\n${timeframeLabel} INDICATORS: Still building data...`;
    }
    let text = `\n${timeframeLabel} INDICATORS:`;

    if (indicators.rsi !== null) {
        const zone = indicators.rsi > 70 ? 'OVERBOUGHT' : indicators.rsi < 30 ? 'OVERSOLD' : 'NEUTRAL';
        text += `\n  RSI(14): ${indicators.rsi.toFixed(1)} [${zone}]`;
    }
    if (indicators.ema9 !== null && indicators.ema21 !== null) {
        const cross = indicators.ema9 > indicators.ema21 ? 'BULLISH' : 'BEARISH';
        text += `\n  EMA 9/21: ${indicators.ema9.toFixed(2)} / ${indicators.ema21.toFixed(2)} [${cross}]`;
    }
    if (indicators.ema50 !== null) {
        text += `\n  EMA 50: ${indicators.ema50.toFixed(2)}`;
    }
    if (indicators.macd) {
        const momentum = indicators.macd.histogram > 0 ? 'BULLISH' : 'BEARISH';
        const strength = Math.abs(indicators.macd.histogram) < 0.01 ? ' WEAK' : '';
        text += `\n  MACD: ${indicators.macd.macd.toFixed(4)} | Signal: ${indicators.macd.signal.toFixed(4)} | Hist: ${indicators.macd.histogram.toFixed(4)} [${momentum}${strength}]`;
    }
    if (indicators.bollinger) {
        const price = indicators.ema9 || indicators.bollinger.middle;
        const range = indicators.bollinger.upper - indicators.bollinger.lower;
        const position = range > 0 ? ((price - indicators.bollinger.lower) / range * 100).toFixed(0) : '50';
        text += `\n  Bollinger: Upper ${indicators.bollinger.upper.toFixed(2)} | Mid ${indicators.bollinger.middle.toFixed(2)} | Lower ${indicators.bollinger.lower.toFixed(2)} | Price at ${position}% [BW: ${indicators.bollinger.bandwidth.toFixed(2)}%]`;
    }
    if (indicators.atr !== null) {
        text += `\n  ATR(14): ${indicators.atr.toFixed(4)}`;
    }
    if (indicators.stochRSI) {
        const zone = indicators.stochRSI.k > 80 ? 'OVERBOUGHT' : indicators.stochRSI.k < 20 ? 'OVERSOLD' : 'NEUTRAL';
        text += `\n  StochRSI: K=${indicators.stochRSI.k.toFixed(1)} D=${indicators.stochRSI.d.toFixed(1)} [${zone}]`;
    }
    if (indicators.adx) {
        const strength = indicators.adx.adx > 40 ? 'VERY STRONG TREND' : indicators.adx.adx > 25 ? 'STRONG TREND' : indicators.adx.adx > 20 ? 'WEAK TREND' : 'NO TREND/CHOPPY';
        const direction = indicators.adx.plusDI > indicators.adx.minusDI ? 'BULLISH' : 'BEARISH';
        text += `\n  ADX: ${indicators.adx.adx.toFixed(1)} [${strength}] | +DI: ${indicators.adx.plusDI.toFixed(1)} -DI: ${indicators.adx.minusDI.toFixed(1)} [${direction}]`;
    }

    return text;
}

function findSupportResistance(prices, timestamps, currentPrice) {
    if (!prices || prices.length < 100) return { supports: [], resistances: [] };

    const swingWindow = 40;
    const swingHighs = [];
    const swingLows = [];

    for (let i = swingWindow; i < prices.length - swingWindow; i++) {
        let isHigh = true;
        let isLow = true;
        for (let j = i - swingWindow; j <= i + swingWindow; j++) {
            if (j === i) continue;
            if (prices[j] >= prices[i]) isHigh = false;
            if (prices[j] <= prices[i]) isLow = false;
            if (!isHigh && !isLow) break;
        }
        if (isHigh) swingHighs.push({ price: prices[i], time: timestamps[i], index: i });
        if (isLow) swingLows.push({ price: prices[i], time: timestamps[i], index: i });
    }

    const allLevels = [
        ...swingHighs.map(s => ({ price: s.price, time: s.time, type: 'high' })),
        ...swingLows.map(s => ({ price: s.price, time: s.time, type: 'low' }))
    ];

    const clusters = [];
    const used = new Set();
    const clusterThreshold = currentPrice * 0.005;

    for (let i = 0; i < allLevels.length; i++) {
        if (used.has(i)) continue;
        const cluster = [allLevels[i]];
        used.add(i);
        for (let j = i + 1; j < allLevels.length; j++) {
            if (used.has(j)) continue;
            if (Math.abs(allLevels[j].price - allLevels[i].price) <= clusterThreshold) {
                cluster.push(allLevels[j]);
                used.add(j);
            }
        }
        const avgPrice = cluster.reduce((s, c) => s + c.price, 0) / cluster.length;
        const times = cluster.map(c => c.time).sort((a, b) => a - b);
        const timeSpanMs = times[times.length - 1] - times[0];
        const timeSpanMinutes = timeSpanMs / 60000;

        let strength;
        if (cluster.length >= 3 && timeSpanMinutes >= 60) strength = 'STRONG';
        else if (cluster.length >= 2 && timeSpanMinutes >= 30) strength = 'STRONG';
        else if (cluster.length >= 2 && timeSpanMinutes >= 10) strength = 'MODERATE';
        else if (cluster.length >= 2) strength = 'WEAK';
        else if (timeSpanMinutes >= 60) strength = 'MODERATE';
        else strength = 'WEAK';

        clusters.push({
            price: avgPrice,
            touches: cluster.length,
            strength,
            timeSpanMinutes: Math.round(timeSpanMinutes),
            distance: ((avgPrice - currentPrice) / currentPrice * 100)
        });
    }

    const supports = clusters
        .filter(c => c.price < currentPrice)
        .sort((a, b) => b.price - a.price)
        .slice(0, 5)
        .map(c => ({
            price: c.price,
            touches: c.touches,
            strength: c.strength,
            timeSpanMinutes: c.timeSpanMinutes,
            distancePercent: c.distance
        }));

    const resistances = clusters
        .filter(c => c.price > currentPrice)
        .sort((a, b) => a.price - b.price)
        .slice(0, 5)
        .map(c => ({
            price: c.price,
            touches: c.touches,
            strength: c.strength,
            timeSpanMinutes: c.timeSpanMinutes,
            distancePercent: c.distance
        }));

    return { supports, resistances };
}

function analyzeCandlePatterns(candles) {
    if (!candles || candles.length < 5) return { patterns: [], summary: 'Not enough candle data' };

    const recent = candles.slice(-5);
    const patterns = [];

    for (let i = 0; i < recent.length; i++) {
        const c = recent[i];
        const body = Math.abs(c.close - c.open);
        const totalRange = c.high - c.low;
        if (totalRange === 0) continue;

        const upperWick = c.high - Math.max(c.open, c.close);
        const lowerWick = Math.min(c.open, c.close) - c.low;
        const isBullish = c.close > c.open;
        const bodyRatio = body / totalRange;
        const upperWickRatio = upperWick / totalRange;
        const lowerWickRatio = lowerWick / totalRange;

        if (bodyRatio < 0.1 && totalRange > 0) {
            patterns.push({ candle: i + 1, type: 'DOJI', signal: 'INDECISION', desc: 'tiny body, market undecided' });
        }

        if (upperWickRatio > 0.6 && bodyRatio < 0.3) {
            patterns.push({ candle: i + 1, type: 'SHOOTING_STAR', signal: 'BEARISH_REVERSAL', desc: 'long upper wick rejection, sellers pushing down' });
        }

        if (lowerWickRatio > 0.6 && bodyRatio < 0.3) {
            patterns.push({ candle: i + 1, type: 'HAMMER', signal: 'BULLISH_REVERSAL', desc: 'long lower wick defense, buyers pushing up' });
        }

        if (upperWickRatio > 0.4 && body > 0) {
            patterns.push({ candle: i + 1, type: 'UPPER_WICK_REJECTION', signal: 'BEARISH', desc: `upper wick ${(upperWickRatio * 100).toFixed(0)}% of range` });
        }

        if (lowerWickRatio > 0.4 && body > 0) {
            patterns.push({ candle: i + 1, type: 'LOWER_WICK_DEFENSE', signal: 'BULLISH', desc: `lower wick ${(lowerWickRatio * 100).toFixed(0)}% of range` });
        }

        if (i > 0) {
            const prev = recent[i - 1];
            const prevBullish = prev.close > prev.open;
            const prevBody = Math.abs(prev.close - prev.open);
            if (isBullish && !prevBullish && body > prevBody * 1.2 &&
                c.close > prev.open && c.open < prev.close) {
                patterns.push({ candle: i + 1, type: 'BULLISH_ENGULFING', signal: 'BULLISH_REVERSAL', desc: 'bullish candle engulfs previous bearish' });
            }
            if (!isBullish && prevBullish && body > prevBody * 1.2 &&
                c.open > prev.close && c.close < prev.open) {
                patterns.push({ candle: i + 1, type: 'BEARISH_ENGULFING', signal: 'BEARISH_REVERSAL', desc: 'bearish candle engulfs previous bullish' });
            }
        }
    }

    let summary = 'No significant patterns';
    if (patterns.length > 0) {
        const bullish = patterns.filter(p => p.signal.includes('BULLISH')).length;
        const bearish = patterns.filter(p => p.signal.includes('BEARISH')).length;
        if (bullish > bearish) summary = `Bullish bias (${bullish} bullish vs ${bearish} bearish patterns)`;
        else if (bearish > bullish) summary = `Bearish bias (${bearish} bearish vs ${bullish} bullish patterns)`;
        else summary = `Mixed signals (${bullish} bullish, ${bearish} bearish patterns)`;
    }

    return { patterns, summary };
}

function formatSRForAI(sr, currentPrice) {
    if (!sr) return '\nSUPPORT/RESISTANCE: Not enough data yet';
    let text = '\nSUPPORT/RESISTANCE LEVELS:';
    if (sr.resistances.length > 0) {
        for (const r of sr.resistances) {
            const span = r.timeSpanMinutes ? `, tested over ${r.timeSpanMinutes}min` : '';
            text += `\n  RESISTANCE: $${r.price.toFixed(2)} [${r.strength}, ${r.touches} touches${span}] ${r.distancePercent.toFixed(2)}% above`;
        }
    } else {
        text += '\n  RESISTANCE: None detected nearby';
    }
    if (sr.supports.length > 0) {
        for (const s of sr.supports) {
            const span = s.timeSpanMinutes ? `, tested over ${s.timeSpanMinutes}min` : '';
            text += `\n  SUPPORT: $${s.price.toFixed(2)} [${s.strength}, ${s.touches} touches${span}] ${Math.abs(s.distancePercent).toFixed(2)}% below`;
        }
    } else {
        text += '\n  SUPPORT: None detected nearby';
    }
    return text;
}

function formatCandlePatternsForAI(analysis) {
    if (!analysis || analysis.patterns.length === 0) return '\nCANDLE PATTERNS (5m): No significant patterns';
    let text = `\nCANDLE PATTERNS (5m): ${analysis.summary}`;
    for (const p of analysis.patterns.slice(-5)) {
        text += `\n  Candle ${p.candle}: ${p.type} [${p.signal}] - ${p.desc}`;
    }
    return text;
}

module.exports = {
    buildCandles,
    calculateAllIndicators,
    formatIndicatorsForAI,
    generateSignal,
    findSupportResistance,
    analyzeCandlePatterns,
    formatSRForAI,
    formatCandlePatternsForAI,
    calcEMA,
    calcRSI,
    calcMACD,
    calcBollingerBands,
    calcATR,
    calcStochRSI,
    calcADX
};
