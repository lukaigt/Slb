const { 
    DriftClient, 
    Wallet, 
    initialize,
    PositionDirection,
    OrderType,
    MarketType,
    BN,
    convertToNumber,
    PRICE_PRECISION,
} = require('@drift-labs/sdk');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const CONFIG = {
    RPC_URL: process.env.SOLANA_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    LEVERAGE: parseInt(process.env.LEVERAGE) || 50,
    SYMBOL: process.env.SYMBOL || 'SOL-PERP',
    TRADE_AMOUNT_USDC: parseFloat(process.env.TRADE_AMOUNT_USDC) || 10,
    
    IMBALANCE_THRESHOLD: parseFloat(process.env.IMBALANCE_THRESHOLD) || 0.15,
    IMBALANCE_STABILITY_CHECKS: parseInt(process.env.IMBALANCE_STABILITY_CHECKS) || 5,
    TREND_LOOKBACK: parseInt(process.env.TREND_LOOKBACK) || 20,
    TREND_THRESHOLD_PERCENT: parseFloat(process.env.TREND_THRESHOLD_PERCENT) || 0.3,
    ABSORPTION_TICKS_REQUIRED: parseInt(process.env.ABSORPTION_TICKS_REQUIRED) || 3,
    
    STOP_LOSS_PERCENT: parseFloat(process.env.STOP_LOSS_PERCENT) || 0.8,
    TAKE_PROFIT_ACTIVATION: parseFloat(process.env.TAKE_PROFIT_ACTIVATION) || 1.2,
    TRAILING_NORMAL: parseFloat(process.env.TRAILING_NORMAL) || 0.25,
    TRAILING_DANGER: parseFloat(process.env.TRAILING_DANGER) || 0.1,
    
    ORDER_COOLDOWN_MS: (parseInt(process.env.COOLDOWN_SECONDS) || 120) * 1000,
    CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS) || 2000,
    DLOB_URL: 'https://dlob.drift.trade',
    
    MEMORY_FILE: path.join(__dirname, 'trade_memory.json'),
};

const priceHistory = [];
const imbalanceHistory = [];
let currentPosition = null;
let entryPrice = 0;
let highestPriceSinceEntry = 0;
let lowestPriceSinceEntry = Infinity;
let trailingStopActive = false;
let dangerMode = false;
let driftClient = null;
let marketIndex = 0;
let lastOrderTime = 0;
let tradeMemory = { trades: [], shadowTrades: [], patternStats: {} };
let consecutiveLosses = 0;
let lastLossDirection = null;

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function loadMemory() {
    try {
        if (fs.existsSync(CONFIG.MEMORY_FILE)) {
            const data = fs.readFileSync(CONFIG.MEMORY_FILE, 'utf8');
            tradeMemory = JSON.parse(data);
            log(`Memory loaded: ${tradeMemory.trades.length} trades, ${tradeMemory.shadowTrades.length} shadow trades`);
        } else {
            log('No memory file found, starting fresh');
            tradeMemory = { trades: [], shadowTrades: [], patternStats: {} };
        }
    } catch (error) {
        log(`Error loading memory: ${error.message}`);
        tradeMemory = { trades: [], shadowTrades: [], patternStats: {} };
    }
}

function saveMemory() {
    try {
        fs.writeFileSync(CONFIG.MEMORY_FILE, JSON.stringify(tradeMemory, null, 2));
    } catch (error) {
        log(`Error saving memory: ${error.message}`);
    }
}

function getPatternKey(imbalanceType, trend, priceAction) {
    return `${imbalanceType}_${trend}_${priceAction}`;
}

function getTimeWeight(timestamp) {
    const now = Date.now();
    const tradeTime = new Date(timestamp).getTime();
    const hoursAgo = (now - tradeTime) / (1000 * 60 * 60);
    
    if (hoursAgo < 1) return 1.0;
    if (hoursAgo < 24) return 0.9;
    if (hoursAgo < 24 * 7) return 0.7;
    if (hoursAgo < 24 * 30) return 0.5;
    return 0.3;
}

function updatePatternStats(patternKey, direction, result) {
    if (!tradeMemory.patternStats[patternKey]) {
        tradeMemory.patternStats[patternKey] = {
            longWins: 0, longLosses: 0, longWeightedWins: 0, longWeightedLosses: 0,
            shortWins: 0, shortLosses: 0, shortWeightedWins: 0, shortWeightedLosses: 0
        };
    }
    
    const stats = tradeMemory.patternStats[patternKey];
    const weight = 1.0;
    
    if (direction === 'LONG') {
        if (result === 'WIN') {
            stats.longWins++;
            stats.longWeightedWins += weight;
        } else {
            stats.longLosses++;
            stats.longWeightedLosses += weight;
        }
    } else {
        if (result === 'WIN') {
            stats.shortWins++;
            stats.shortWeightedWins += weight;
        } else {
            stats.shortLosses++;
            stats.shortWeightedLosses += weight;
        }
    }
}

function recalculateWeightedStats() {
    const resolvedShadows = tradeMemory.shadowTrades.filter(t => t.resolved && t.hypotheticalResult);
    const allTrades = [...tradeMemory.trades, ...resolvedShadows];
    const newStats = {};
    
    for (const trade of allTrades) {
        const patternKey = trade.patternKey;
        if (!patternKey) continue;
        
        if (!newStats[patternKey]) {
            newStats[patternKey] = {
                longWins: 0, longLosses: 0, longWeightedWins: 0, longWeightedLosses: 0,
                shortWins: 0, shortLosses: 0, shortWeightedWins: 0, shortWeightedLosses: 0
            };
        }
        
        const stats = newStats[patternKey];
        const weight = getTimeWeight(trade.timestamp);
        const direction = trade.direction || trade.signalDirection;
        const result = trade.result || trade.hypotheticalResult;
        
        if (!result) continue;
        
        if (direction === 'LONG') {
            if (result === 'WIN') {
                stats.longWins++;
                stats.longWeightedWins += weight;
            } else {
                stats.longLosses++;
                stats.longWeightedLosses += weight;
            }
        } else if (direction === 'SHORT') {
            if (result === 'WIN') {
                stats.shortWins++;
                stats.shortWeightedWins += weight;
            } else {
                stats.shortLosses++;
                stats.shortWeightedLosses += weight;
            }
        }
    }
    
    tradeMemory.patternStats = newStats;
}

function getBestDirection(patternKey) {
    const stats = tradeMemory.patternStats[patternKey];
    if (!stats) return null;
    
    const longTotal = stats.longWeightedWins + stats.longWeightedLosses;
    const shortTotal = stats.shortWeightedWins + stats.shortWeightedLosses;
    
    if (longTotal < 3 && shortTotal < 3) return null;
    
    const longWinRate = longTotal > 0 ? stats.longWeightedWins / longTotal : 0;
    const shortWinRate = shortTotal > 0 ? stats.shortWeightedWins / shortTotal : 0;
    
    if (longWinRate > shortWinRate && longWinRate > 0.5) return 'LONG';
    if (shortWinRate > longWinRate && shortWinRate > 0.5) return 'SHORT';
    
    return null;
}

function recordTrade(pattern, direction, entryPx, exitPx, result, profitPercent, exitReason) {
    const trade = {
        timestamp: new Date().toISOString(),
        type: 'real',
        patternKey: getPatternKey(pattern.imbalanceType, pattern.trend, pattern.priceAction),
        pattern: pattern,
        direction: direction,
        entryPrice: entryPx,
        exitPrice: exitPx,
        result: result,
        profitPercent: profitPercent,
        exitReason: exitReason
    };
    
    tradeMemory.trades.push(trade);
    recalculateWeightedStats();
    saveMemory();
    
    log(`Trade recorded: ${direction} ${result} ${profitPercent.toFixed(2)}% | Pattern: ${trade.patternKey}`);
}

function recordShadowTrade(pattern, signalDirection, whySkipped, priceAtSignal) {
    const shadowTrade = {
        timestamp: new Date().toISOString(),
        type: 'shadow',
        patternKey: getPatternKey(pattern.imbalanceType, pattern.trend, pattern.priceAction),
        pattern: pattern,
        signalDirection: signalDirection,
        whySkipped: whySkipped,
        priceAtSignal: priceAtSignal,
        priceAfter: null,
        hypotheticalResult: null,
        hypotheticalProfit: null,
        resolved: false
    };
    
    tradeMemory.shadowTrades.push(shadowTrade);
    saveMemory();
}

function resolveShadowTrades(currentPrice) {
    let updated = false;
    
    for (const shadow of tradeMemory.shadowTrades) {
        if (shadow.resolved) continue;
        
        const signalTime = new Date(shadow.timestamp).getTime();
        const now = Date.now();
        const minutesPassed = (now - signalTime) / (1000 * 60);
        
        if (minutesPassed >= 5) {
            shadow.priceAfter = currentPrice;
            const priceChange = ((currentPrice - shadow.priceAtSignal) / shadow.priceAtSignal) * 100;
            
            if (shadow.signalDirection === 'LONG') {
                shadow.hypotheticalProfit = priceChange;
                shadow.hypotheticalResult = priceChange > 0 ? 'WIN' : 'LOSS';
            } else {
                shadow.hypotheticalProfit = -priceChange;
                shadow.hypotheticalResult = priceChange < 0 ? 'WIN' : 'LOSS';
            }
            
            shadow.resolved = true;
            updated = true;
            
            log(`Shadow trade resolved: ${shadow.signalDirection} would have ${shadow.hypotheticalResult} (${shadow.hypotheticalProfit.toFixed(2)}%)`);
        }
    }
    
    if (updated) {
        recalculateWeightedStats();
        saveMemory();
    }
}

async function fetchOrderBook() {
    try {
        const response = await fetch(
            `${CONFIG.DLOB_URL}/l2?marketName=${CONFIG.SYMBOL}&depth=20`
        );
        
        if (!response.ok) {
            return null;
        }
        
        const data = await response.json();
        
        if (!data || !data.bids || !data.asks || !Array.isArray(data.bids) || !Array.isArray(data.asks)) {
            return null;
        }
        
        return data;
    } catch (error) {
        return null;
    }
}

function calculateImbalance(orderBook) {
    if (!orderBook || !orderBook.bids || !orderBook.asks) {
        return 0;
    }
    
    let totalBids = 0;
    let totalAsks = 0;
    
    for (const bid of orderBook.bids.slice(0, 15)) {
        const size = Array.isArray(bid) ? parseFloat(bid[1]) : parseFloat(bid.size || 0);
        if (!isNaN(size)) totalBids += size;
    }
    
    for (const ask of orderBook.asks.slice(0, 15)) {
        const size = Array.isArray(ask) ? parseFloat(ask[1]) : parseFloat(ask.size || 0);
        if (!isNaN(size)) totalAsks += size;
    }
    
    if (totalBids + totalAsks === 0) return 0;
    
    return (totalBids - totalAsks) / (totalBids + totalAsks);
}

function isImbalanceStable(targetType) {
    if (imbalanceHistory.length < CONFIG.IMBALANCE_STABILITY_CHECKS) return false;
    
    const recent = imbalanceHistory.slice(-CONFIG.IMBALANCE_STABILITY_CHECKS);
    let matchCount = 0;
    const threshold = CONFIG.IMBALANCE_THRESHOLD * 0.7;
    
    for (const imb of recent) {
        if (targetType === 'bullish' && imb > threshold) matchCount++;
        else if (targetType === 'bearish' && imb < -threshold) matchCount++;
    }
    
    return matchCount >= CONFIG.IMBALANCE_STABILITY_CHECKS - 1;
}

function detectMarketMode() {
    if (priceHistory.length < CONFIG.TREND_LOOKBACK) return 'UNKNOWN';
    
    const oldPrice = priceHistory[priceHistory.length - CONFIG.TREND_LOOKBACK];
    const currentPrice = priceHistory[priceHistory.length - 1];
    const priceChangePercent = ((currentPrice - oldPrice) / oldPrice) * 100;
    
    if (priceChangePercent > CONFIG.TREND_THRESHOLD_PERCENT) return 'UPTREND';
    if (priceChangePercent < -CONFIG.TREND_THRESHOLD_PERCENT) return 'DOWNTREND';
    return 'RANGING';
}

function detectPriceAction() {
    if (priceHistory.length < 5) return 'FLAT';
    
    const recent = priceHistory.slice(-5);
    let upTicks = 0;
    let downTicks = 0;
    
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] > recent[i-1]) upTicks++;
        else if (recent[i] < recent[i-1]) downTicks++;
    }
    
    if (upTicks >= 3) return 'RISING';
    if (downTicks >= 3) return 'FALLING';
    return 'FLAT';
}

function countAbsorptionTicks() {
    if (priceHistory.length < CONFIG.ABSORPTION_TICKS_REQUIRED + 1) return { bullish: 0, bearish: 0 };
    if (imbalanceHistory.length < CONFIG.ABSORPTION_TICKS_REQUIRED) return { bullish: 0, bearish: 0 };
    
    let bullishTicks = 0;
    let bearishTicks = 0;
    
    const recentPrices = priceHistory.slice(-CONFIG.ABSORPTION_TICKS_REQUIRED - 1);
    const recentImbalances = imbalanceHistory.slice(-CONFIG.ABSORPTION_TICKS_REQUIRED);
    const threshold = CONFIG.IMBALANCE_THRESHOLD * 0.7;
    
    for (let i = 0; i < CONFIG.ABSORPTION_TICKS_REQUIRED; i++) {
        const priceUp = recentPrices[i + 1] >= recentPrices[i];
        const priceDown = recentPrices[i + 1] <= recentPrices[i];
        const imbalanceBearish = recentImbalances[i] < -threshold;
        const imbalanceBullish = recentImbalances[i] > threshold;
        
        if (imbalanceBearish && priceUp) bullishTicks++;
        if (imbalanceBullish && priceDown) bearishTicks++;
    }
    
    return { bullish: bullishTicks, bearish: bearishTicks };
}

function getCurrentPattern(imbalance, marketMode, priceAction) {
    let imbalanceType = 'neutral';
    if (imbalance > CONFIG.IMBALANCE_THRESHOLD) imbalanceType = 'bullish';
    else if (imbalance < -CONFIG.IMBALANCE_THRESHOLD) imbalanceType = 'bearish';
    
    return {
        imbalance: imbalance,
        imbalanceType: imbalanceType,
        trend: marketMode,
        priceAction: priceAction
    };
}

function shouldOpenLong(imbalance, marketMode, priceAction, absorptionTicks, pattern) {
    if (priceHistory.length < CONFIG.TREND_LOOKBACK || imbalanceHistory.length < CONFIG.IMBALANCE_STABILITY_CHECKS) {
        return { open: false, reason: 'building_history', hasSignal: false };
    }
    
    const patternKey = getPatternKey(pattern.imbalanceType, pattern.trend, pattern.priceAction);
    const memoryDirection = getBestDirection(patternKey);
    
    let hasSignal = false;
    let signalReason = '';
    
    if (marketMode === 'UPTREND' && (priceAction === 'FALLING' || priceAction === 'FLAT')) {
        hasSignal = true;
        signalReason = 'trend_dip';
    }
    
    if (!hasSignal && marketMode === 'RANGING') {
        if (absorptionTicks.bullish >= CONFIG.ABSORPTION_TICKS_REQUIRED && isImbalanceStable('bearish')) {
            hasSignal = true;
            signalReason = 'absorption';
        }
    }
    
    if (!hasSignal && memoryDirection === 'LONG') {
        const stats = tradeMemory.patternStats[patternKey];
        if (stats) {
            const total = stats.longWeightedWins + stats.longWeightedLosses;
            if (total > 0) {
                const winRate = stats.longWeightedWins / total;
                if (winRate > 0.6) {
                    hasSignal = true;
                    signalReason = 'memory';
                }
            }
        }
    }
    
    if (!hasSignal) {
        return { open: false, reason: 'no_signal', hasSignal: false };
    }
    
    const now = Date.now();
    if (now - lastOrderTime < CONFIG.ORDER_COOLDOWN_MS) {
        return { open: false, reason: 'cooldown', hasSignal: true };
    }
    
    if (memoryDirection === 'SHORT') {
        return { open: false, reason: 'memory_prefers_short', hasSignal: true };
    }
    
    if (lastLossDirection === 'LONG' && consecutiveLosses >= 2) {
        return { open: false, reason: 'consecutive_long_losses', hasSignal: true };
    }
    
    log(`✓ LONG SIGNAL (${signalReason}): Mode=${marketMode} | Price=${priceAction}`);
    return { open: true, reason: signalReason, hasSignal: true };
}

function shouldOpenShort(imbalance, marketMode, priceAction, absorptionTicks, pattern) {
    if (priceHistory.length < CONFIG.TREND_LOOKBACK || imbalanceHistory.length < CONFIG.IMBALANCE_STABILITY_CHECKS) {
        return { open: false, reason: 'building_history', hasSignal: false };
    }
    
    const patternKey = getPatternKey(pattern.imbalanceType, pattern.trend, pattern.priceAction);
    const memoryDirection = getBestDirection(patternKey);
    
    let hasSignal = false;
    let signalReason = '';
    
    if (marketMode === 'DOWNTREND' && (priceAction === 'RISING' || priceAction === 'FLAT')) {
        hasSignal = true;
        signalReason = 'trend_rally';
    }
    
    if (!hasSignal && marketMode === 'RANGING') {
        if (absorptionTicks.bearish >= CONFIG.ABSORPTION_TICKS_REQUIRED && isImbalanceStable('bullish')) {
            hasSignal = true;
            signalReason = 'absorption';
        }
    }
    
    if (!hasSignal && memoryDirection === 'SHORT') {
        const stats = tradeMemory.patternStats[patternKey];
        if (stats) {
            const total = stats.shortWeightedWins + stats.shortWeightedLosses;
            if (total > 0) {
                const winRate = stats.shortWeightedWins / total;
                if (winRate > 0.6) {
                    hasSignal = true;
                    signalReason = 'memory';
                }
            }
        }
    }
    
    if (!hasSignal) {
        return { open: false, reason: 'no_signal', hasSignal: false };
    }
    
    const now = Date.now();
    if (now - lastOrderTime < CONFIG.ORDER_COOLDOWN_MS) {
        return { open: false, reason: 'cooldown', hasSignal: true };
    }
    
    if (memoryDirection === 'LONG') {
        return { open: false, reason: 'memory_prefers_long', hasSignal: true };
    }
    
    if (lastLossDirection === 'SHORT' && consecutiveLosses >= 2) {
        return { open: false, reason: 'consecutive_short_losses', hasSignal: true };
    }
    
    log(`✓ SHORT SIGNAL (${signalReason}): Mode=${marketMode} | Price=${priceAction}`);
    return { open: true, reason: signalReason, hasSignal: true };
}

function checkDangerSignals(imbalance, marketMode) {
    if (!currentPosition) return false;
    
    if (currentPosition === 'LONG') {
        if (marketMode === 'DOWNTREND' || imbalance < -0.2) {
            if (!dangerMode) {
                log(`⚠️ DANGER MODE: Market turning against LONG`);
            }
            return true;
        }
    } else if (currentPosition === 'SHORT') {
        if (marketMode === 'UPTREND' || imbalance > 0.2) {
            if (!dangerMode) {
                log(`⚠️ DANGER MODE: Market turning against SHORT`);
            }
            return true;
        }
    }
    
    return false;
}

function checkStopLoss(currentPrice) {
    if (!currentPosition) return false;

    const priceMovePercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    if (currentPosition === 'LONG') {
        if (priceMovePercent <= -CONFIG.STOP_LOSS_PERCENT) {
            log(`✗ STOP LOSS (LONG): Entry=$${entryPrice.toFixed(4)}, Current=$${currentPrice.toFixed(4)}, Loss=${priceMovePercent.toFixed(2)}%`);
            return true;
        }
    } else if (currentPosition === 'SHORT') {
        if (priceMovePercent >= CONFIG.STOP_LOSS_PERCENT) {
            log(`✗ STOP LOSS (SHORT): Entry=$${entryPrice.toFixed(4)}, Current=$${currentPrice.toFixed(4)}, Loss=${(-priceMovePercent).toFixed(2)}%`);
            return true;
        }
    }

    return false;
}

function checkTrailingTakeProfit(currentPrice) {
    if (!currentPosition) return false;

    const trailingDistance = dangerMode ? CONFIG.TRAILING_DANGER : CONFIG.TRAILING_NORMAL;
    let profitPercent = 0;

    if (currentPosition === 'LONG') {
        profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

        if (currentPrice > highestPriceSinceEntry) {
            highestPriceSinceEntry = currentPrice;
        }

        if (profitPercent >= CONFIG.TAKE_PROFIT_ACTIVATION) {
            trailingStopActive = true;
        }

        if (trailingStopActive) {
            const dropFromHigh = ((highestPriceSinceEntry - currentPrice) / highestPriceSinceEntry) * 100;
            if (dropFromHigh >= trailingDistance) {
                log(`✓ TRAILING TP (LONG): High=$${highestPriceSinceEntry.toFixed(4)}, Current=$${currentPrice.toFixed(4)}, Profit=${profitPercent.toFixed(2)}% | Mode=${dangerMode ? 'DANGER' : 'NORMAL'}`);
                return true;
            }
        }
    } else if (currentPosition === 'SHORT') {
        profitPercent = ((entryPrice - currentPrice) / entryPrice) * 100;

        if (currentPrice < lowestPriceSinceEntry) {
            lowestPriceSinceEntry = currentPrice;
        }

        if (profitPercent >= CONFIG.TAKE_PROFIT_ACTIVATION) {
            trailingStopActive = true;
        }

        if (trailingStopActive) {
            const riseFromLow = ((currentPrice - lowestPriceSinceEntry) / lowestPriceSinceEntry) * 100;
            if (riseFromLow >= trailingDistance) {
                log(`✓ TRAILING TP (SHORT): Low=$${lowestPriceSinceEntry.toFixed(4)}, Current=$${currentPrice.toFixed(4)}, Profit=${profitPercent.toFixed(2)}% | Mode=${dangerMode ? 'DANGER' : 'NORMAL'}`);
                return true;
            }
        }
    }

    return false;
}

let currentTradePattern = null;
let currentTradeDirection = null;

async function openPosition(direction, pattern) {
    try {
        const currentPrice = priceHistory[priceHistory.length - 1];
        const notionalValue = CONFIG.TRADE_AMOUNT_USDC * CONFIG.LEVERAGE;
        const baseAssetAmountRaw = notionalValue / currentPrice;
        const baseAssetAmount = driftClient.convertToPerpPrecision(baseAssetAmountRaw);

        log(`Opening ${direction}: $${CONFIG.TRADE_AMOUNT_USDC} x ${CONFIG.LEVERAGE}x = $${notionalValue.toFixed(2)} notional`);

        const orderParams = {
            orderType: OrderType.MARKET,
            marketType: MarketType.PERP,
            marketIndex: marketIndex,
            direction: direction === 'LONG' ? PositionDirection.LONG : PositionDirection.SHORT,
            baseAssetAmount: baseAssetAmount,
        };

        const txSig = await driftClient.placePerpOrder(orderParams);
        log(`Order placed. TX: ${txSig}`);

        lastOrderTime = Date.now();
        currentPosition = direction;
        entryPrice = currentPrice;
        highestPriceSinceEntry = currentPrice;
        lowestPriceSinceEntry = currentPrice;
        trailingStopActive = false;
        dangerMode = false;
        currentTradePattern = pattern;
        currentTradeDirection = direction;

        return true;
    } catch (error) {
        log(`Error opening position: ${error.message}`);
        return false;
    }
}

async function closePosition(exitReason) {
    try {
        log(`Closing ${currentPosition} position (${exitReason})...`);

        const user = driftClient.getUser();
        const perpPosition = user.getPerpPosition(marketIndex);

        if (!perpPosition || perpPosition.baseAssetAmount.eq(new BN(0))) {
            log('No open position found on-chain, resetting state...');
            resetPositionState();
            return true;
        }

        const baseAssetAmount = perpPosition.baseAssetAmount.abs();
        const closeDirection = perpPosition.baseAssetAmount.gt(new BN(0)) 
            ? PositionDirection.SHORT 
            : PositionDirection.LONG;

        const orderParams = {
            orderType: OrderType.MARKET,
            marketType: MarketType.PERP,
            marketIndex: marketIndex,
            direction: closeDirection,
            baseAssetAmount: baseAssetAmount,
            reduceOnly: true,
        };

        const txSig = await driftClient.placePerpOrder(orderParams);
        log(`Position closed. TX: ${txSig}`);

        const exitPrice = priceHistory[priceHistory.length - 1];
        let profitPercent = 0;

        if (currentPosition === 'LONG') {
            profitPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
        } else {
            profitPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
        }

        const result = profitPercent > 0 ? 'WIN' : 'LOSS';
        
        log(`Trade result: Entry=$${entryPrice.toFixed(4)}, Exit=$${exitPrice.toFixed(4)}, P&L=${profitPercent.toFixed(2)}% | ${result}`);

        if (currentTradePattern) {
            recordTrade(currentTradePattern, currentTradeDirection, entryPrice, exitPrice, result, profitPercent, exitReason);
        }
        
        if (result === 'LOSS') {
            if (lastLossDirection === currentPosition) {
                consecutiveLosses++;
            } else {
                consecutiveLosses = 1;
                lastLossDirection = currentPosition;
            }
            log(`Consecutive ${currentPosition} losses: ${consecutiveLosses}`);
        } else {
            if (lastLossDirection && currentPosition !== lastLossDirection) {
                log(`Opposite direction won - resetting ${lastLossDirection} loss streak`);
                consecutiveLosses = 0;
                lastLossDirection = null;
            } else if (!lastLossDirection) {
                consecutiveLosses = 0;
            }
        }

        lastOrderTime = Date.now();
        resetPositionState();

        return true;
    } catch (error) {
        log(`Error closing position: ${error.message}`);
        return false;
    }
}

function resetPositionState() {
    currentPosition = null;
    entryPrice = 0;
    highestPriceSinceEntry = 0;
    lowestPriceSinceEntry = Infinity;
    trailingStopActive = false;
    dangerMode = false;
    currentTradePattern = null;
    currentTradeDirection = null;
}

async function syncPositionFromChain() {
    try {
        const user = driftClient.getUser();
        const perpPosition = user.getPerpPosition(marketIndex);

        if (perpPosition && !perpPosition.baseAssetAmount.eq(new BN(0))) {
            const isLong = perpPosition.baseAssetAmount.gt(new BN(0));
            const onChainDirection = isLong ? 'LONG' : 'SHORT';

            if (currentPosition !== onChainDirection) {
                log(`Syncing position from chain: ${onChainDirection}`);
                currentPosition = onChainDirection;
                
                const quoteEntry = perpPosition.quoteEntryAmount;
                const baseAmount = perpPosition.baseAssetAmount.abs();
                
                if (!baseAmount.eq(new BN(0))) {
                    const entryPriceRaw = quoteEntry.abs().mul(PRICE_PRECISION).div(baseAmount);
                    entryPrice = convertToNumber(entryPriceRaw, PRICE_PRECISION);
                } else {
                    const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
                    entryPrice = convertToNumber(oracleData.price, PRICE_PRECISION);
                }
                
                highestPriceSinceEntry = entryPrice;
                lowestPriceSinceEntry = entryPrice;
            }
        } else if (currentPosition) {
            log('Position closed on-chain, syncing state...');
            resetPositionState();
        }
    } catch (error) {
        log(`Error syncing position: ${error.message}`);
    }
}

async function fetchPrice() {
    try {
        const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
        if (!oracleData) {
            return null;
        }

        const price = convertToNumber(oracleData.price, PRICE_PRECISION);
        
        priceHistory.push(price);
        if (priceHistory.length > 500) priceHistory.shift();

        return price;
    } catch (error) {
        return null;
    }
}

async function tradingLoop() {
    try {
        const price = await fetchPrice();
        if (!price) return;

        await syncPositionFromChain();
        resolveShadowTrades(price);
        
        const orderBook = await fetchOrderBook();
        if (!orderBook) {
            return;
        }
        
        const imbalance = calculateImbalance(orderBook);
        
        imbalanceHistory.push(imbalance);
        if (imbalanceHistory.length > 200) imbalanceHistory.shift();
        
        const marketMode = detectMarketMode();
        const priceAction = detectPriceAction();
        const absorptionTicks = countAbsorptionTicks();
        const pattern = getCurrentPattern(imbalance, marketMode, priceAction);

        if (priceHistory.length < CONFIG.TREND_LOOKBACK || imbalanceHistory.length < CONFIG.IMBALANCE_STABILITY_CHECKS) {
            log(`Building history... Prices: ${priceHistory.length}/${CONFIG.TREND_LOOKBACK} | Imbalances: ${imbalanceHistory.length}/${CONFIG.IMBALANCE_STABILITY_CHECKS}`);
            return;
        }

        const modeStr = currentPosition ? (dangerMode ? '🔴 DANGER' : '🟢 NORMAL') : '⚪ NONE';
        const memoryCount = tradeMemory.trades.length + tradeMemory.shadowTrades.length;
        log(`$${price.toFixed(2)} | Mode: ${marketMode} | Imb: ${(imbalance * 100).toFixed(0)}% | Price: ${priceAction} | Pos: ${currentPosition || 'NONE'} ${modeStr} | Memory: ${memoryCount}`);

        if (currentPosition) {
            dangerMode = checkDangerSignals(imbalance, marketMode);
            
            if (checkStopLoss(price)) {
                await closePosition('stop_loss');
                return;
            }

            if (checkTrailingTakeProfit(price)) {
                await closePosition('trailing_tp');
                return;
            }
        } else {
            const longSignal = shouldOpenLong(imbalance, marketMode, priceAction, absorptionTicks, pattern);
            const shortSignal = shouldOpenShort(imbalance, marketMode, priceAction, absorptionTicks, pattern);
            
            if (longSignal.open) {
                await openPosition('LONG', pattern);
            } else if (shortSignal.open) {
                await openPosition('SHORT', pattern);
            } else {
                if (longSignal.hasSignal && !longSignal.open) {
                    recordShadowTrade(pattern, 'LONG', longSignal.reason, price);
                }
                if (shortSignal.hasSignal && !shortSignal.open) {
                    recordShadowTrade(pattern, 'SHORT', shortSignal.reason, price);
                }
            }
        }
    } catch (error) {
        log(`Trading loop error: ${error.message}`);
    }
}

async function findMarketIndex(symbol) {
    const perpMarkets = driftClient.getPerpMarketAccounts();
    
    for (let i = 0; i < perpMarkets.length; i++) {
        const market = perpMarkets[i];
        const name = Buffer.from(market.name).toString('utf8').trim().replace(/\0/g, '');
        
        if (name === symbol || name.replace('-', '') === symbol.replace('-', '')) {
            log(`Found market: ${name} (Index: ${market.marketIndex})`);
            return market.marketIndex;
        }
    }

    log(`ERROR: Market "${symbol}" not found!`);
    process.exit(1);
}

async function main() {
    log('═══════════════════════════════════════════════════════════');
    log('   ADAPTIVE SOLANA FUTURES BOT - DRIFT PROTOCOL');
    log('   Market Mode Detection + Memory Learning System');
    log('═══════════════════════════════════════════════════════════');
    log(`Leverage: ${CONFIG.LEVERAGE}x`);
    log(`Symbol: ${CONFIG.SYMBOL}`);
    log(`Trade Size: ${CONFIG.TRADE_AMOUNT_USDC} USDC`);
    log(`Imbalance Threshold: ${(CONFIG.IMBALANCE_THRESHOLD * 100).toFixed(0)}%`);
    log(`Trend Threshold: ${CONFIG.TREND_THRESHOLD_PERCENT}%`);
    log(`Stop Loss: ${CONFIG.STOP_LOSS_PERCENT}%`);
    log(`Take Profit Activation: ${CONFIG.TAKE_PROFIT_ACTIVATION}%`);
    log(`Trailing (Normal): ${CONFIG.TRAILING_NORMAL}% | (Danger): ${CONFIG.TRAILING_DANGER}%`);
    log(`Check Interval: ${CONFIG.CHECK_INTERVAL_MS}ms`);
    log(`Cooldown: ${CONFIG.ORDER_COOLDOWN_MS / 1000}s`);
    log('═══════════════════════════════════════════════════════════');

    if (!CONFIG.RPC_URL || !CONFIG.PRIVATE_KEY) {
        log('ERROR: Missing RPC_URL or PRIVATE_KEY in .env file');
        process.exit(1);
    }

    loadMemory();

    try {
        const connection = new Connection(CONFIG.RPC_URL, {
            commitment: 'confirmed',
        });

        let privateKeyBytes;
        const cleanKey = CONFIG.PRIVATE_KEY.trim().replace(/['"]/g, '');
        try {
            if (typeof bs58.decode === 'function') {
                privateKeyBytes = bs58.decode(cleanKey);
            } else if (typeof bs58.default?.decode === 'function') {
                privateKeyBytes = bs58.default.decode(cleanKey);
            } else {
                throw new Error('bs58 decode not found');
            }
        } catch (e) {
            log(`Private key decode error: ${e.message}`);
            process.exit(1);
        }
        
        const keypair = Keypair.fromSecretKey(privateKeyBytes);
        const wallet = new Wallet(keypair);

        log(`Wallet: ${keypair.publicKey.toBase58()}`);

        const sdkConfig = initialize({ env: 'mainnet-beta' });

        driftClient = new DriftClient({
            connection,
            wallet,
            programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
            accountSubscription: {
                type: 'websocket',
            },
        });

        log('Connecting to Drift Protocol...');
        await driftClient.subscribe();
        log('Connected to Drift Protocol!');

        const user = driftClient.getUser();
        if (!user) {
            log('ERROR: No Drift user account found. Please create one at app.drift.trade first.');
            process.exit(1);
        }

        marketIndex = await findMarketIndex(CONFIG.SYMBOL);

        log('Testing DLOB API connection...');
        const testOrderBook = await fetchOrderBook();
        if (testOrderBook) {
            log('DLOB API connected successfully!');
            const testImbalance = calculateImbalance(testOrderBook);
            log(`Current order book imbalance: ${(testImbalance * 100).toFixed(1)}%`);
        } else {
            log('WARNING: Could not connect to DLOB API. Will retry during trading...');
        }

        log('Starting adaptive trading loop...');
        log('Press Ctrl+C to stop the bot safely.');

        setInterval(tradingLoop, CONFIG.CHECK_INTERVAL_MS);

        process.on('SIGINT', async () => {
            log('Shutting down...');
            saveMemory();
            if (currentPosition) {
                log('WARNING: Open position will remain. Close manually at app.drift.trade if needed.');
            }
            await driftClient.unsubscribe();
            process.exit(0);
        });

    } catch (error) {
        log(`Fatal error: ${error.message}`);
        console.error(error);
        process.exit(1);
    }
}

main();
