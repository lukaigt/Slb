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
const http = require('http');

dotenv.config();

const CONFIG = {
    RPC_URL: process.env.SOLANA_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    LEVERAGE: parseInt(process.env.LEVERAGE) || 50,
    SYMBOL: process.env.SYMBOL || 'SOL-PERP',
    TRADE_AMOUNT_USDC: parseFloat(process.env.TRADE_AMOUNT_USDC) || 10,
    
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true' || process.env.SIMULATION_MODE === '1',
    
    IMBALANCE_THRESHOLD: parseFloat(process.env.IMBALANCE_THRESHOLD) || 0.15,
    VOLATILITY_THRESHOLD: parseFloat(process.env.VOLATILITY_THRESHOLD) || 0.5,
    
    STOP_LOSS_PERCENT: parseFloat(process.env.STOP_LOSS_PERCENT) || 0.8,
    TAKE_PROFIT_ACTIVATION: parseFloat(process.env.TAKE_PROFIT_ACTIVATION) || 1.2,
    TRAILING_NORMAL: parseFloat(process.env.TRAILING_NORMAL) || 0.25,
    TRAILING_DANGER: parseFloat(process.env.TRAILING_DANGER) || 0.1,
    
    ORDER_COOLDOWN_MS: (parseInt(process.env.COOLDOWN_SECONDS) || 120) * 1000,
    BASE_INTERVAL_MS: parseInt(process.env.BASE_INTERVAL_MS) || 30000,
    DLOB_URL: 'https://dlob.drift.trade',
    DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT) || 3000,
    
    MEMORY_FILE: path.join(__dirname, 'trade_memory.json'),
};

const TIMEFRAMES = {
    fast: { 
        intervalMs: CONFIG.BASE_INTERVAL_MS,
        pointsNeeded: 20,
        name: '30s'
    },
    medium: { 
        intervalMs: CONFIG.BASE_INTERVAL_MS * 4,
        pointsNeeded: 10,
        name: '2m'
    },
    slow: { 
        intervalMs: CONFIG.BASE_INTERVAL_MS * 10,
        pointsNeeded: 6,
        name: '5m'
    }
};

const timeframeData = {
    fast: { prices: [], imbalances: [], lastUpdate: 0 },
    medium: { prices: [], imbalances: [], lastUpdate: 0 },
    slow: { prices: [], imbalances: [], lastUpdate: 0 }
};

let currentPosition = null;
let simulatedPosition = null;
let entryPrice = 0;
let highestPriceSinceEntry = 0;
let lowestPriceSinceEntry = Infinity;
let trailingStopActive = false;
let dangerMode = false;
let driftClient = null;
let marketIndex = 0;
let lastOrderTime = 0;
let tradeMemory = { 
    trades: [], 
    shadowTrades: [], 
    patternStats: {},
    sessionStats: {
        startTime: null,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalProfitPercent: 0,
        simulatedTrades: 0,
        simulatedWins: 0,
        simulatedLosses: 0,
        simulatedProfitPercent: 0
    }
};
let consecutiveLosses = 0;
let lastLossDirection = null;
let currentTradePattern = null;
let currentTradeDirection = null;
let botStatus = {
    running: false,
    lastPrice: 0,
    lastImbalance: 0,
    marketMode: 'UNKNOWN',
    priceAction: 'FLAT',
    volatility: 0,
    timeframeSignals: {},
    lastUpdate: null
};

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function loadMemory() {
    try {
        if (fs.existsSync(CONFIG.MEMORY_FILE)) {
            const data = fs.readFileSync(CONFIG.MEMORY_FILE, 'utf8');
            const loaded = JSON.parse(data);
            tradeMemory = {
                trades: loaded.trades || [],
                shadowTrades: loaded.shadowTrades || [],
                patternStats: loaded.patternStats || {},
                sessionStats: loaded.sessionStats || {
                    startTime: null,
                    totalTrades: 0,
                    wins: 0,
                    losses: 0,
                    totalProfitPercent: 0,
                    simulatedTrades: 0,
                    simulatedWins: 0,
                    simulatedLosses: 0,
                    simulatedProfitPercent: 0
                }
            };
            log(`Memory loaded: ${tradeMemory.trades.length} trades, ${tradeMemory.shadowTrades.length} shadow trades`);
            recalculateWeightedStats();
            analyzeMemoryOnStartup();
        } else {
            log('No memory file found, starting fresh');
            tradeMemory.sessionStats.startTime = new Date().toISOString();
        }
    } catch (error) {
        log(`Error loading memory: ${error.message}`);
        tradeMemory.sessionStats.startTime = new Date().toISOString();
    }
}

function saveMemory() {
    try {
        fs.writeFileSync(CONFIG.MEMORY_FILE, JSON.stringify(tradeMemory, null, 2));
    } catch (error) {
        log(`Error saving memory: ${error.message}`);
    }
}

function analyzeMemoryOnStartup() {
    const recentTrades = tradeMemory.trades.slice(-50);
    if (recentTrades.length < 5) {
        log('Not enough trade history for analysis');
        return;
    }
    
    const wins = recentTrades.filter(t => t.result === 'WIN').length;
    const winRate = (wins / recentTrades.length * 100).toFixed(1);
    const totalProfit = recentTrades.reduce((sum, t) => sum + (t.profitPercent || 0), 0);
    
    log(`═══ MEMORY ANALYSIS (Last ${recentTrades.length} trades) ═══`);
    log(`Win Rate: ${winRate}% | Total P&L: ${totalProfit.toFixed(2)}%`);
    
    const patternPerformance = {};
    for (const trade of recentTrades) {
        if (!trade.patternKey) continue;
        if (!patternPerformance[trade.patternKey]) {
            patternPerformance[trade.patternKey] = { wins: 0, losses: 0, profit: 0 };
        }
        if (trade.result === 'WIN') {
            patternPerformance[trade.patternKey].wins++;
        } else {
            patternPerformance[trade.patternKey].losses++;
        }
        patternPerformance[trade.patternKey].profit += trade.profitPercent || 0;
    }
    
    const sortedPatterns = Object.entries(patternPerformance)
        .map(([key, stats]) => ({
            pattern: key,
            winRate: stats.wins / (stats.wins + stats.losses) * 100,
            profit: stats.profit,
            count: stats.wins + stats.losses
        }))
        .filter(p => p.count >= 3)
        .sort((a, b) => b.winRate - a.winRate);
    
    if (sortedPatterns.length > 0) {
        log('Best patterns:');
        sortedPatterns.slice(0, 3).forEach(p => {
            log(`  ${p.pattern}: ${p.winRate.toFixed(0)}% win rate (${p.count} trades)`);
        });
    }
    
    if (sortedPatterns.length > 3) {
        log('Worst patterns:');
        sortedPatterns.slice(-2).forEach(p => {
            log(`  ${p.pattern}: ${p.winRate.toFixed(0)}% win rate (${p.count} trades)`);
        });
    }
}

function getPatternKey(imbalanceType, trend, priceAction, volatility) {
    const volLevel = volatility > CONFIG.VOLATILITY_THRESHOLD ? 'high_vol' : 'low_vol';
    return `${imbalanceType}_${trend}_${priceAction}_${volLevel}`;
}

function getTimeWeight(timestamp) {
    const now = Date.now();
    const tradeTime = new Date(timestamp).getTime();
    const hoursAgo = (now - tradeTime) / (1000 * 60 * 60);
    
    if (hoursAgo < 1) return 1.0;
    if (hoursAgo < 6) return 0.9;
    if (hoursAgo < 24) return 0.7;
    if (hoursAgo < 24 * 3) return 0.5;
    if (hoursAgo < 24 * 7) return 0.3;
    return 0.1;
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
                shortWins: 0, shortLosses: 0, shortWeightedWins: 0, shortWeightedLosses: 0,
                avgProfit: 0, avgLoss: 0, profitSum: 0, lossSum: 0
            };
        }
        
        const stats = newStats[patternKey];
        const weight = getTimeWeight(trade.timestamp);
        const direction = trade.direction || trade.signalDirection;
        const result = trade.result || trade.hypotheticalResult;
        const profit = trade.profitPercent || trade.hypotheticalProfit || 0;
        
        if (!result) continue;
        
        if (direction === 'LONG') {
            if (result === 'WIN') {
                stats.longWins++;
                stats.longWeightedWins += weight;
                stats.profitSum += profit;
            } else {
                stats.longLosses++;
                stats.longWeightedLosses += weight;
                stats.lossSum += Math.abs(profit);
            }
        } else if (direction === 'SHORT') {
            if (result === 'WIN') {
                stats.shortWins++;
                stats.shortWeightedWins += weight;
                stats.profitSum += profit;
            } else {
                stats.shortLosses++;
                stats.shortWeightedLosses += weight;
                stats.lossSum += Math.abs(profit);
            }
        }
    }
    
    for (const key in newStats) {
        const stats = newStats[key];
        const totalWins = stats.longWins + stats.shortWins;
        const totalLosses = stats.longLosses + stats.shortLosses;
        stats.avgProfit = totalWins > 0 ? stats.profitSum / totalWins : 0;
        stats.avgLoss = totalLosses > 0 ? stats.lossSum / totalLosses : 0;
    }
    
    tradeMemory.patternStats = newStats;
}

function getAdaptiveConfidence(patternKey) {
    const stats = tradeMemory.patternStats[patternKey];
    if (!stats) return { direction: null, confidence: 0, expectedValue: 0 };
    
    const longTotal = stats.longWeightedWins + stats.longWeightedLosses;
    const shortTotal = stats.shortWeightedWins + stats.shortWeightedLosses;
    
    if (longTotal < 3 && shortTotal < 3) return { direction: null, confidence: 0, expectedValue: 0 };
    
    const longWinRate = longTotal > 0 ? stats.longWeightedWins / longTotal : 0;
    const shortWinRate = shortTotal > 0 ? stats.shortWeightedWins / shortTotal : 0;
    
    const longEV = longWinRate * stats.avgProfit - (1 - longWinRate) * stats.avgLoss;
    const shortEV = shortWinRate * stats.avgProfit - (1 - shortWinRate) * stats.avgLoss;
    
    if (longWinRate > shortWinRate && longWinRate > 0.55 && longEV > 0) {
        return { direction: 'LONG', confidence: longWinRate, expectedValue: longEV };
    }
    if (shortWinRate > longWinRate && shortWinRate > 0.55 && shortEV > 0) {
        return { direction: 'SHORT', confidence: shortWinRate, expectedValue: shortEV };
    }
    
    return { direction: null, confidence: 0, expectedValue: 0 };
}

function recordTrade(pattern, direction, entryPx, exitPx, result, profitPercent, exitReason, isSimulated = false) {
    const trade = {
        timestamp: new Date().toISOString(),
        type: isSimulated ? 'simulated' : 'real',
        patternKey: pattern.patternKey,
        pattern: pattern,
        direction: direction,
        entryPrice: entryPx,
        exitPrice: exitPx,
        result: result,
        profitPercent: profitPercent,
        exitReason: exitReason
    };
    
    tradeMemory.trades.push(trade);
    
    if (isSimulated) {
        tradeMemory.sessionStats.simulatedTrades++;
        if (result === 'WIN') {
            tradeMemory.sessionStats.simulatedWins++;
        } else {
            tradeMemory.sessionStats.simulatedLosses++;
        }
        tradeMemory.sessionStats.simulatedProfitPercent += profitPercent;
    } else {
        tradeMemory.sessionStats.totalTrades++;
        if (result === 'WIN') {
            tradeMemory.sessionStats.wins++;
        } else {
            tradeMemory.sessionStats.losses++;
        }
        tradeMemory.sessionStats.totalProfitPercent += profitPercent;
    }
    
    recalculateWeightedStats();
    saveMemory();
    
    const modeStr = isSimulated ? '[SIM]' : '[REAL]';
    log(`${modeStr} Trade recorded: ${direction} ${result} ${profitPercent.toFixed(2)}% | Pattern: ${pattern.patternKey}`);
}

function recordShadowTrade(pattern, signalDirection, whySkipped, priceAtSignal) {
    const shadowTrade = {
        timestamp: new Date().toISOString(),
        type: 'shadow',
        patternKey: pattern.patternKey,
        pattern: pattern,
        signalDirection: signalDirection,
        whySkipped: whySkipped,
        priceAtSignal: priceAtSignal,
        priceHistory: [priceAtSignal],
        highestPrice: priceAtSignal,
        lowestPrice: priceAtSignal,
        priceAfter: null,
        hypotheticalResult: null,
        hypotheticalProfit: null,
        hypotheticalExitReason: null,
        resolved: false
    };
    
    tradeMemory.shadowTrades.push(shadowTrade);
    saveMemory();
}

function resolveShadowTrades(currentPrice) {
    let updated = false;
    
    for (const shadow of tradeMemory.shadowTrades) {
        if (shadow.resolved) continue;
        
        if (!shadow.priceHistory) shadow.priceHistory = [shadow.priceAtSignal];
        if (!shadow.highestPrice) shadow.highestPrice = shadow.priceAtSignal;
        if (!shadow.lowestPrice) shadow.lowestPrice = shadow.priceAtSignal;
        
        shadow.priceHistory.push(currentPrice);
        if (currentPrice > shadow.highestPrice) shadow.highestPrice = currentPrice;
        if (currentPrice < shadow.lowestPrice) shadow.lowestPrice = currentPrice;
        
        const signalTime = new Date(shadow.timestamp).getTime();
        const now = Date.now();
        const minutesPassed = (now - signalTime) / (1000 * 60);
        
        let result = null;
        let exitReason = null;
        let profitPercent = 0;
        
        if (shadow.signalDirection === 'LONG') {
            const worstDrop = ((shadow.lowestPrice - shadow.priceAtSignal) / shadow.priceAtSignal) * 100;
            const bestGain = ((shadow.highestPrice - shadow.priceAtSignal) / shadow.priceAtSignal) * 100;
            
            if (worstDrop <= -CONFIG.STOP_LOSS_PERCENT) {
                result = 'LOSS';
                exitReason = 'stop_loss';
                profitPercent = -CONFIG.STOP_LOSS_PERCENT;
            } else if (bestGain >= CONFIG.TAKE_PROFIT_ACTIVATION) {
                const dropFromHigh = ((shadow.highestPrice - currentPrice) / shadow.highestPrice) * 100;
                if (dropFromHigh >= CONFIG.TRAILING_NORMAL || minutesPassed >= 5) {
                    result = 'WIN';
                    exitReason = 'trailing_tp';
                    profitPercent = bestGain - CONFIG.TRAILING_NORMAL;
                }
            } else if (minutesPassed >= 10) {
                profitPercent = ((currentPrice - shadow.priceAtSignal) / shadow.priceAtSignal) * 100;
                result = profitPercent > 0 ? 'WIN' : 'LOSS';
                exitReason = 'timeout';
            }
        } else {
            const worstRise = ((shadow.highestPrice - shadow.priceAtSignal) / shadow.priceAtSignal) * 100;
            const bestGain = ((shadow.priceAtSignal - shadow.lowestPrice) / shadow.priceAtSignal) * 100;
            
            if (worstRise >= CONFIG.STOP_LOSS_PERCENT) {
                result = 'LOSS';
                exitReason = 'stop_loss';
                profitPercent = -CONFIG.STOP_LOSS_PERCENT;
            } else if (bestGain >= CONFIG.TAKE_PROFIT_ACTIVATION) {
                const riseFromLow = ((currentPrice - shadow.lowestPrice) / shadow.lowestPrice) * 100;
                if (riseFromLow >= CONFIG.TRAILING_NORMAL || minutesPassed >= 5) {
                    result = 'WIN';
                    exitReason = 'trailing_tp';
                    profitPercent = bestGain - CONFIG.TRAILING_NORMAL;
                }
            } else if (minutesPassed >= 10) {
                profitPercent = ((shadow.priceAtSignal - currentPrice) / shadow.priceAtSignal) * 100;
                result = profitPercent > 0 ? 'WIN' : 'LOSS';
                exitReason = 'timeout';
            }
        }
        
        if (result) {
            shadow.priceAfter = currentPrice;
            shadow.hypotheticalResult = result;
            shadow.hypotheticalProfit = profitPercent;
            shadow.hypotheticalExitReason = exitReason;
            shadow.resolved = true;
            updated = true;
            
            log(`Shadow resolved: ${shadow.signalDirection} ${result} (${profitPercent.toFixed(2)}%) via ${exitReason}`);
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
        
        if (!response.ok) return null;
        
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
    if (!orderBook || !orderBook.bids || !orderBook.asks) return 0;
    
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

function calculateVolatility(timeframe) {
    const data = timeframeData[timeframe];
    if (data.prices.length < 5) return 0;
    
    const recent = data.prices.slice(-10);
    let totalChange = 0;
    
    for (let i = 1; i < recent.length; i++) {
        totalChange += Math.abs((recent[i] - recent[i-1]) / recent[i-1] * 100);
    }
    
    return totalChange / (recent.length - 1);
}

function detectMarketMode(timeframe) {
    const data = timeframeData[timeframe];
    const config = TIMEFRAMES[timeframe];
    
    if (data.prices.length < config.pointsNeeded) return 'UNKNOWN';
    
    const oldPrice = data.prices[data.prices.length - config.pointsNeeded];
    const currentPrice = data.prices[data.prices.length - 1];
    const priceChangePercent = ((currentPrice - oldPrice) / oldPrice) * 100;
    
    const threshold = 0.3 * (config.pointsNeeded / 20);
    
    if (priceChangePercent > threshold) return 'UPTREND';
    if (priceChangePercent < -threshold) return 'DOWNTREND';
    return 'RANGING';
}

function detectPriceAction(timeframe) {
    const data = timeframeData[timeframe];
    if (data.prices.length < 5) return 'FLAT';
    
    const recent = data.prices.slice(-5);
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

function isImbalanceStable(timeframe, targetType) {
    const data = timeframeData[timeframe];
    if (data.imbalances.length < 4) return false;
    
    const recent = data.imbalances.slice(-4);
    let matchCount = 0;
    const threshold = CONFIG.IMBALANCE_THRESHOLD * 0.7;
    
    for (const imb of recent) {
        if (targetType === 'bullish' && imb > threshold) matchCount++;
        else if (targetType === 'bearish' && imb < -threshold) matchCount++;
    }
    
    return matchCount >= 3;
}

function analyzeTimeframe(timeframe, currentPrice, imbalance) {
    const data = timeframeData[timeframe];
    const config = TIMEFRAMES[timeframe];
    
    if (data.prices.length < config.pointsNeeded) {
        return { ready: false, signal: null, mode: 'BUILDING', priceAction: 'UNKNOWN' };
    }
    
    const mode = detectMarketMode(timeframe);
    const priceAction = detectPriceAction(timeframe);
    const volatility = calculateVolatility(timeframe);
    
    let signal = null;
    let signalStrength = 0;
    
    if (mode === 'UPTREND' && (priceAction === 'FALLING' || priceAction === 'FLAT')) {
        signal = 'LONG';
        signalStrength = 0.7;
    } else if (mode === 'DOWNTREND' && (priceAction === 'RISING' || priceAction === 'FLAT')) {
        signal = 'SHORT';
        signalStrength = 0.7;
    } else if (mode === 'RANGING') {
        if (imbalance < -CONFIG.IMBALANCE_THRESHOLD && isImbalanceStable(timeframe, 'bearish') && priceAction !== 'FALLING') {
            signal = 'LONG';
            signalStrength = 0.5;
        } else if (imbalance > CONFIG.IMBALANCE_THRESHOLD && isImbalanceStable(timeframe, 'bullish') && priceAction !== 'RISING') {
            signal = 'SHORT';
            signalStrength = 0.5;
        }
    }
    
    return { 
        ready: true, 
        signal, 
        signalStrength,
        mode, 
        priceAction, 
        volatility,
        dataPoints: data.prices.length 
    };
}

function getConsensusSignal(currentPrice, imbalance) {
    const analyses = {};
    let readyCount = 0;
    let signalsWithDirection = [];
    
    for (const tf of Object.keys(TIMEFRAMES)) {
        analyses[tf] = analyzeTimeframe(tf, currentPrice, imbalance);
        if (analyses[tf].ready) {
            readyCount++;
            if (analyses[tf].signal) {
                signalsWithDirection.push({ tf, signal: analyses[tf].signal, strength: analyses[tf].signalStrength });
            }
        }
    }
    
    botStatus.timeframeSignals = analyses;
    
    if (readyCount < 2) {
        return { signal: null, reason: 'not_enough_timeframes', confidence: 0 };
    }
    
    const avgVolatility = Object.values(analyses)
        .filter(a => a.ready)
        .reduce((sum, a) => sum + (a.volatility || 0), 0) / readyCount;
    
    if (avgVolatility > CONFIG.VOLATILITY_THRESHOLD) {
        return { signal: null, reason: 'high_volatility', confidence: 0, volatility: avgVolatility };
    }
    
    if (signalsWithDirection.length < 2) {
        return { signal: null, reason: 'not_enough_signals', confidence: 0, volatility: avgVolatility };
    }
    
    const firstSignal = signalsWithDirection[0].signal;
    const allAgree = signalsWithDirection.every(s => s.signal === firstSignal);
    
    if (!allAgree) {
        return { signal: null, reason: 'conflicting_signals', confidence: 0, volatility: avgVolatility };
    }
    
    const totalStrength = signalsWithDirection.reduce((sum, s) => sum + s.strength, 0);
    const avgStrength = totalStrength / signalsWithDirection.length;
    
    return { 
        signal: firstSignal, 
        reason: 'consensus', 
        confidence: avgStrength, 
        volatility: avgVolatility,
        agreementCount: signalsWithDirection.length 
    };
}

function shouldOpenPosition(signal, pattern) {
    if (!signal.signal) return { open: false, reason: signal.reason };
    
    const direction = signal.signal;
    const now = Date.now();
    
    if (now - lastOrderTime < CONFIG.ORDER_COOLDOWN_MS) {
        return { open: false, reason: 'cooldown', hasSignal: true };
    }
    
    const memoryAnalysis = getAdaptiveConfidence(pattern.patternKey);
    
    if (memoryAnalysis.direction && memoryAnalysis.direction !== direction && memoryAnalysis.confidence > 0.6) {
        return { open: false, reason: `memory_prefers_${memoryAnalysis.direction.toLowerCase()}`, hasSignal: true };
    }
    
    if (direction === 'LONG' && lastLossDirection === 'LONG' && consecutiveLosses >= 2) {
        return { open: false, reason: 'consecutive_long_losses', hasSignal: true };
    }
    if (direction === 'SHORT' && lastLossDirection === 'SHORT' && consecutiveLosses >= 2) {
        return { open: false, reason: 'consecutive_short_losses', hasSignal: true };
    }
    
    return { open: true, reason: signal.reason, direction, confidence: signal.confidence };
}

function checkDangerSignals(imbalance, marketMode) {
    if (!currentPosition && !simulatedPosition) return false;
    
    const pos = CONFIG.SIMULATION_MODE ? simulatedPosition : currentPosition;
    
    if (pos === 'LONG') {
        if (marketMode === 'DOWNTREND' || imbalance < -0.2) {
            if (!dangerMode) log(`⚠️ DANGER MODE: Market turning against LONG`);
            return true;
        }
    } else if (pos === 'SHORT') {
        if (marketMode === 'UPTREND' || imbalance > 0.2) {
            if (!dangerMode) log(`⚠️ DANGER MODE: Market turning against SHORT`);
            return true;
        }
    }
    
    return false;
}

function checkStopLoss(currentPrice) {
    const pos = CONFIG.SIMULATION_MODE ? simulatedPosition : currentPosition;
    if (!pos) return false;

    const priceMovePercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    if (pos === 'LONG') {
        if (priceMovePercent <= -CONFIG.STOP_LOSS_PERCENT) {
            log(`✗ STOP LOSS (LONG): Entry=$${entryPrice.toFixed(4)}, Current=$${currentPrice.toFixed(4)}`);
            return true;
        }
    } else if (pos === 'SHORT') {
        if (priceMovePercent >= CONFIG.STOP_LOSS_PERCENT) {
            log(`✗ STOP LOSS (SHORT): Entry=$${entryPrice.toFixed(4)}, Current=$${currentPrice.toFixed(4)}`);
            return true;
        }
    }

    return false;
}

function checkTrailingTakeProfit(currentPrice) {
    const pos = CONFIG.SIMULATION_MODE ? simulatedPosition : currentPosition;
    if (!pos) return false;

    const trailingDistance = dangerMode ? CONFIG.TRAILING_DANGER : CONFIG.TRAILING_NORMAL;
    let profitPercent = 0;

    if (pos === 'LONG') {
        profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
        if (currentPrice > highestPriceSinceEntry) highestPriceSinceEntry = currentPrice;
        if (profitPercent >= CONFIG.TAKE_PROFIT_ACTIVATION) trailingStopActive = true;
        if (trailingStopActive) {
            const dropFromHigh = ((highestPriceSinceEntry - currentPrice) / highestPriceSinceEntry) * 100;
            if (dropFromHigh >= trailingDistance) {
                log(`✓ TRAILING TP (LONG): Profit=${profitPercent.toFixed(2)}%`);
                return true;
            }
        }
    } else if (pos === 'SHORT') {
        profitPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
        if (currentPrice < lowestPriceSinceEntry) lowestPriceSinceEntry = currentPrice;
        if (profitPercent >= CONFIG.TAKE_PROFIT_ACTIVATION) trailingStopActive = true;
        if (trailingStopActive) {
            const riseFromLow = ((currentPrice - lowestPriceSinceEntry) / lowestPriceSinceEntry) * 100;
            if (riseFromLow >= trailingDistance) {
                log(`✓ TRAILING TP (SHORT): Profit=${profitPercent.toFixed(2)}%`);
                return true;
            }
        }
    }

    return false;
}

async function openPosition(direction, pattern) {
    const currentPrice = timeframeData.fast.prices[timeframeData.fast.prices.length - 1];
    
    if (CONFIG.SIMULATION_MODE) {
        log(`[SIM] Opening ${direction} at $${currentPrice.toFixed(4)}`);
        simulatedPosition = direction;
    } else {
        try {
            const notionalValue = CONFIG.TRADE_AMOUNT_USDC * CONFIG.LEVERAGE;
            const baseAssetAmountRaw = notionalValue / currentPrice;
            const baseAssetAmount = driftClient.convertToPerpPrecision(baseAssetAmountRaw);

            log(`Opening ${direction}: $${CONFIG.TRADE_AMOUNT_USDC} x ${CONFIG.LEVERAGE}x`);

            const orderParams = {
                orderType: OrderType.MARKET,
                marketType: MarketType.PERP,
                marketIndex: marketIndex,
                direction: direction === 'LONG' ? PositionDirection.LONG : PositionDirection.SHORT,
                baseAssetAmount: baseAssetAmount,
            };

            const txSig = await driftClient.placePerpOrder(orderParams);
            log(`Order placed. TX: ${txSig}`);
            currentPosition = direction;
        } catch (error) {
            log(`Error opening position: ${error.message}`);
            return false;
        }
    }

    lastOrderTime = Date.now();
    entryPrice = currentPrice;
    highestPriceSinceEntry = currentPrice;
    lowestPriceSinceEntry = currentPrice;
    trailingStopActive = false;
    dangerMode = false;
    currentTradePattern = pattern;
    currentTradeDirection = direction;

    return true;
}

async function closePosition(exitReason) {
    const currentPrice = timeframeData.fast.prices[timeframeData.fast.prices.length - 1];
    const pos = CONFIG.SIMULATION_MODE ? simulatedPosition : currentPosition;
    
    if (!pos) return true;
    
    let profitPercent = 0;
    if (pos === 'LONG') {
        profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
        profitPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
    }
    
    const result = profitPercent > 0 ? 'WIN' : 'LOSS';
    
    if (CONFIG.SIMULATION_MODE) {
        log(`[SIM] Closing ${pos}: ${result} ${profitPercent.toFixed(2)}%`);
        simulatedPosition = null;
    } else {
        try {
            const user = driftClient.getUser();
            const perpPosition = user.getPerpPosition(marketIndex);

            if (!perpPosition || perpPosition.baseAssetAmount.eq(new BN(0))) {
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
            currentPosition = null;
        } catch (error) {
            log(`Error closing position: ${error.message}`);
            return false;
        }
    }

    if (currentTradePattern) {
        recordTrade(currentTradePattern, currentTradeDirection, entryPrice, currentPrice, result, profitPercent, exitReason, CONFIG.SIMULATION_MODE);
    }
    
    if (result === 'LOSS') {
        if (lastLossDirection === pos) {
            consecutiveLosses++;
        } else {
            consecutiveLosses = 1;
            lastLossDirection = pos;
        }
    } else {
        if (lastLossDirection && pos !== lastLossDirection) {
            consecutiveLosses = 0;
            lastLossDirection = null;
        }
    }

    lastOrderTime = Date.now();
    resetPositionState();

    return true;
}

function resetPositionState() {
    if (CONFIG.SIMULATION_MODE) {
        simulatedPosition = null;
    } else {
        currentPosition = null;
    }
    entryPrice = 0;
    highestPriceSinceEntry = 0;
    lowestPriceSinceEntry = Infinity;
    trailingStopActive = false;
    dangerMode = false;
    currentTradePattern = null;
    currentTradeDirection = null;
}

async function syncPositionFromChain() {
    if (CONFIG.SIMULATION_MODE) return;
    
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
            resetPositionState();
        }
    } catch (error) {
        log(`Error syncing position: ${error.message}`);
    }
}

async function fetchPrice() {
    try {
        const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
        if (!oracleData) return null;
        return convertToNumber(oracleData.price, PRICE_PRECISION);
    } catch (error) {
        return null;
    }
}

function updateTimeframeData(price, imbalance) {
    const now = Date.now();
    
    for (const [tfName, config] of Object.entries(TIMEFRAMES)) {
        const data = timeframeData[tfName];
        
        if (now - data.lastUpdate >= config.intervalMs || data.lastUpdate === 0) {
            data.prices.push(price);
            data.imbalances.push(imbalance);
            data.lastUpdate = now;
            
            const maxPoints = config.pointsNeeded * 3;
            if (data.prices.length > maxPoints) {
                data.prices = data.prices.slice(-maxPoints);
                data.imbalances = data.imbalances.slice(-maxPoints);
            }
        }
    }
}

async function tradingLoop() {
    try {
        const price = await fetchPrice();
        if (!price) return;

        await syncPositionFromChain();
        
        const orderBook = await fetchOrderBook();
        if (!orderBook) return;
        
        const imbalance = calculateImbalance(orderBook);
        
        updateTimeframeData(price, imbalance);
        resolveShadowTrades(price);
        
        const fastAnalysis = analyzeTimeframe('fast', price, imbalance);
        botStatus.lastPrice = price;
        botStatus.lastImbalance = imbalance;
        botStatus.marketMode = fastAnalysis.mode;
        botStatus.priceAction = fastAnalysis.priceAction;
        botStatus.volatility = fastAnalysis.volatility || 0;
        botStatus.lastUpdate = new Date().toISOString();
        
        const fastData = timeframeData.fast;
        if (fastData.prices.length < TIMEFRAMES.fast.pointsNeeded) {
            log(`Building history... Fast: ${fastData.prices.length}/${TIMEFRAMES.fast.pointsNeeded}`);
            return;
        }

        const pos = CONFIG.SIMULATION_MODE ? simulatedPosition : currentPosition;
        const modeStr = CONFIG.SIMULATION_MODE ? '🔵 SIM' : '🟢 LIVE';
        const posStr = pos ? (dangerMode ? '🔴 ' + pos : '🟢 ' + pos) : '⚪ NONE';
        
        log(`${modeStr} $${price.toFixed(2)} | ${fastAnalysis.mode} | Imb: ${(imbalance * 100).toFixed(0)}% | Vol: ${(botStatus.volatility).toFixed(2)}% | Pos: ${posStr}`);

        if (pos) {
            dangerMode = checkDangerSignals(imbalance, fastAnalysis.mode);
            
            if (checkStopLoss(price)) {
                await closePosition('stop_loss');
                return;
            }

            if (checkTrailingTakeProfit(price)) {
                await closePosition('trailing_tp');
                return;
            }
        } else {
            const consensus = getConsensusSignal(price, imbalance);
            
            let imbalanceType = 'neutral';
            if (imbalance > CONFIG.IMBALANCE_THRESHOLD) imbalanceType = 'bullish';
            else if (imbalance < -CONFIG.IMBALANCE_THRESHOLD) imbalanceType = 'bearish';
            
            const pattern = {
                patternKey: getPatternKey(imbalanceType, fastAnalysis.mode, fastAnalysis.priceAction, botStatus.volatility),
                imbalanceType,
                trend: fastAnalysis.mode,
                priceAction: fastAnalysis.priceAction,
                volatility: botStatus.volatility
            };
            
            const decision = shouldOpenPosition(consensus, pattern);
            
            if (decision.open) {
                log(`✓ ${decision.direction} SIGNAL: ${decision.reason} (confidence: ${(decision.confidence * 100).toFixed(0)}%)`);
                await openPosition(decision.direction, pattern);
            } else if (decision.hasSignal) {
                recordShadowTrade(pattern, consensus.signal, decision.reason, price);
            }
        }
    } catch (error) {
        log(`Trading loop error: ${error.message}`);
    }
}

function generateDashboardHTML() {
    const pos = CONFIG.SIMULATION_MODE ? simulatedPosition : currentPosition;
    const stats = tradeMemory.sessionStats;
    const simStats = CONFIG.SIMULATION_MODE ? stats : null;
    
    const recentTrades = tradeMemory.trades.slice(-20).reverse();
    const recentShadows = tradeMemory.shadowTrades.slice(-10).reverse();
    
    const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100).toFixed(1) : '0.0';
    const simWinRate = stats.simulatedTrades > 0 ? (stats.simulatedWins / stats.simulatedTrades * 100).toFixed(1) : '0.0';
    
    const topPatterns = Object.entries(tradeMemory.patternStats)
        .map(([key, s]) => {
            const total = s.longWins + s.longLosses + s.shortWins + s.shortLosses;
            const wins = s.longWins + s.shortWins;
            return { pattern: key, winRate: total > 0 ? wins / total * 100 : 0, count: total };
        })
        .filter(p => p.count >= 3)
        .sort((a, b) => b.winRate - a.winRate);

    return `<!DOCTYPE html>
<html>
<head>
    <title>Trading Bot Dashboard</title>
    <meta http-equiv="refresh" content="5">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { color: #00d4ff; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: #16213e; border-radius: 10px; padding: 20px; }
        .card h2 { color: #00d4ff; font-size: 1.1em; margin-bottom: 15px; border-bottom: 1px solid #333; padding-bottom: 10px; }
        .stat-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #222; }
        .stat-label { color: #888; }
        .stat-value { font-weight: bold; }
        .positive { color: #00ff88; }
        .negative { color: #ff4444; }
        .neutral { color: #ffaa00; }
        .sim-mode { background: #0066cc; color: white; padding: 5px 15px; border-radius: 20px; display: inline-block; }
        .live-mode { background: #00aa44; color: white; padding: 5px 15px; border-radius: 20px; display: inline-block; }
        table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; }
        th { color: #00d4ff; }
        .trade-win { color: #00ff88; }
        .trade-loss { color: #ff4444; }
        .timeframe-card { display: flex; flex-direction: column; gap: 5px; }
        .tf-row { display: flex; justify-content: space-between; padding: 5px; background: #1a1a2e; border-radius: 5px; }
        .signal-long { color: #00ff88; font-weight: bold; }
        .signal-short { color: #ff4444; font-weight: bold; }
        .signal-none { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Solana Trading Bot Dashboard</h1>
        
        <div class="grid">
            <div class="card">
                <h2>Bot Status</h2>
                <div class="stat-row">
                    <span class="stat-label">Mode</span>
                    <span class="${CONFIG.SIMULATION_MODE ? 'sim-mode' : 'live-mode'}">${CONFIG.SIMULATION_MODE ? '🔵 SIMULATION' : '🟢 LIVE'}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Status</span>
                    <span class="stat-value ${botStatus.running ? 'positive' : 'negative'}">${botStatus.running ? 'Running' : 'Stopped'}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Current Price</span>
                    <span class="stat-value">$${botStatus.lastPrice.toFixed(4)}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Market Mode</span>
                    <span class="stat-value ${botStatus.marketMode === 'UPTREND' ? 'positive' : botStatus.marketMode === 'DOWNTREND' ? 'negative' : 'neutral'}">${botStatus.marketMode}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Order Book</span>
                    <span class="stat-value ${botStatus.lastImbalance > 0 ? 'positive' : 'negative'}">${(botStatus.lastImbalance * 100).toFixed(1)}%</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Volatility</span>
                    <span class="stat-value ${botStatus.volatility > CONFIG.VOLATILITY_THRESHOLD ? 'negative' : 'positive'}">${botStatus.volatility.toFixed(3)}%</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Position</span>
                    <span class="stat-value ${pos === 'LONG' ? 'positive' : pos === 'SHORT' ? 'negative' : ''}">${pos || 'NONE'}</span>
                </div>
                ${pos ? `<div class="stat-row">
                    <span class="stat-label">Entry Price</span>
                    <span class="stat-value">$${entryPrice.toFixed(4)}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Current P&L</span>
                    <span class="stat-value ${((pos === 'LONG' ? botStatus.lastPrice - entryPrice : entryPrice - botStatus.lastPrice) / entryPrice * 100) > 0 ? 'positive' : 'negative'}">${((pos === 'LONG' ? botStatus.lastPrice - entryPrice : entryPrice - botStatus.lastPrice) / entryPrice * 100).toFixed(2)}%</span>
                </div>` : ''}
                <div class="stat-row">
                    <span class="stat-label">Last Update</span>
                    <span class="stat-value">${botStatus.lastUpdate || 'Never'}</span>
                </div>
            </div>
            
            <div class="card">
                <h2>Timeframe Signals</h2>
                <div class="timeframe-card">
                    ${Object.entries(TIMEFRAMES).map(([tf, config]) => {
                        const analysis = botStatus.timeframeSignals[tf] || { ready: false };
                        return `<div class="tf-row">
                            <span>${config.name} (${analysis.dataPoints || 0}/${config.pointsNeeded})</span>
                            <span>${analysis.mode || 'BUILDING'}</span>
                            <span class="${analysis.signal === 'LONG' ? 'signal-long' : analysis.signal === 'SHORT' ? 'signal-short' : 'signal-none'}">${analysis.signal || '-'}</span>
                        </div>`;
                    }).join('')}
                </div>
            </div>
            
            <div class="card">
                <h2>Session Statistics</h2>
                <div class="stat-row">
                    <span class="stat-label">Real Trades</span>
                    <span class="stat-value">${stats.totalTrades}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Real Wins/Losses</span>
                    <span class="stat-value"><span class="positive">${stats.wins}</span> / <span class="negative">${stats.losses}</span></span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Real Win Rate</span>
                    <span class="stat-value ${parseFloat(winRate) >= 50 ? 'positive' : 'negative'}">${winRate}%</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Real P&L</span>
                    <span class="stat-value ${stats.totalProfitPercent >= 0 ? 'positive' : 'negative'}">${stats.totalProfitPercent.toFixed(2)}%</span>
                </div>
                <div class="stat-row" style="margin-top: 10px; border-top: 2px solid #444; padding-top: 10px;">
                    <span class="stat-label">Simulated Trades</span>
                    <span class="stat-value">${stats.simulatedTrades}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Sim Wins/Losses</span>
                    <span class="stat-value"><span class="positive">${stats.simulatedWins}</span> / <span class="negative">${stats.simulatedLosses}</span></span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Sim Win Rate</span>
                    <span class="stat-value ${parseFloat(simWinRate) >= 50 ? 'positive' : 'negative'}">${simWinRate}%</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Sim P&L</span>
                    <span class="stat-value ${stats.simulatedProfitPercent >= 0 ? 'positive' : 'negative'}">${stats.simulatedProfitPercent.toFixed(2)}%</span>
                </div>
            </div>
            
            <div class="card">
                <h2>All-Time Memory</h2>
                <div class="stat-row">
                    <span class="stat-label">Total Trades</span>
                    <span class="stat-value">${tradeMemory.trades.length}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Shadow Trades</span>
                    <span class="stat-value">${tradeMemory.shadowTrades.length}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Patterns Learned</span>
                    <span class="stat-value">${Object.keys(tradeMemory.patternStats).length}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Consecutive Losses</span>
                    <span class="stat-value ${consecutiveLosses >= 2 ? 'negative' : ''}">${consecutiveLosses} ${lastLossDirection ? `(${lastLossDirection})` : ''}</span>
                </div>
            </div>
        </div>
        
        <div class="grid" style="margin-top: 20px;">
            <div class="card" style="grid-column: span 2;">
                <h2>Top Performing Patterns</h2>
                <table>
                    <tr><th>Pattern</th><th>Win Rate</th><th>Trades</th></tr>
                    ${topPatterns.slice(0, 8).map(p => `
                        <tr>
                            <td>${p.pattern}</td>
                            <td class="${p.winRate >= 55 ? 'positive' : p.winRate < 45 ? 'negative' : ''}">${p.winRate.toFixed(1)}%</td>
                            <td>${p.count}</td>
                        </tr>
                    `).join('')}
                </table>
            </div>
            
            <div class="card" style="grid-column: span 2;">
                <h2>Recent Trades</h2>
                <table>
                    <tr><th>Time</th><th>Type</th><th>Direction</th><th>Result</th><th>P&L</th><th>Exit</th></tr>
                    ${recentTrades.map(t => `
                        <tr>
                            <td>${new Date(t.timestamp).toLocaleTimeString()}</td>
                            <td>${t.type === 'simulated' ? '🔵' : '🟢'}</td>
                            <td class="${t.direction === 'LONG' ? 'positive' : 'negative'}">${t.direction}</td>
                            <td class="${t.result === 'WIN' ? 'trade-win' : 'trade-loss'}">${t.result}</td>
                            <td class="${t.profitPercent >= 0 ? 'positive' : 'negative'}">${t.profitPercent?.toFixed(2) || 0}%</td>
                            <td>${t.exitReason || '-'}</td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        </div>
        
        <div class="grid" style="margin-top: 20px;">
            <div class="card" style="grid-column: span 2;">
                <h2>Recent Shadow Trades (Signals Not Taken)</h2>
                <table>
                    <tr><th>Time</th><th>Signal</th><th>Why Skipped</th><th>Would Have</th><th>Result</th></tr>
                    ${recentShadows.map(s => `
                        <tr>
                            <td>${new Date(s.timestamp).toLocaleTimeString()}</td>
                            <td class="${s.signalDirection === 'LONG' ? 'positive' : 'negative'}">${s.signalDirection}</td>
                            <td>${s.whySkipped}</td>
                            <td>${s.resolved ? (s.hypotheticalProfit?.toFixed(2) || 0) + '%' : 'Pending...'}</td>
                            <td class="${s.hypotheticalResult === 'WIN' ? 'trade-win' : s.hypotheticalResult === 'LOSS' ? 'trade-loss' : ''}">${s.hypotheticalResult || '-'}</td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        </div>
        
        <p style="text-align: center; margin-top: 20px; color: #666;">Auto-refreshes every 5 seconds | Base interval: ${CONFIG.BASE_INTERVAL_MS/1000}s</p>
    </div>
</body>
</html>`;
}

function startDashboard() {
    const server = http.createServer((req, res) => {
        if (req.url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                botStatus,
                position: CONFIG.SIMULATION_MODE ? simulatedPosition : currentPosition,
                entryPrice,
                stats: tradeMemory.sessionStats,
                config: {
                    simulationMode: CONFIG.SIMULATION_MODE,
                    symbol: CONFIG.SYMBOL,
                    leverage: CONFIG.LEVERAGE
                }
            }));
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(generateDashboardHTML());
        }
    });
    
    server.listen(CONFIG.DASHBOARD_PORT, '0.0.0.0', () => {
        log(`Dashboard running at http://0.0.0.0:${CONFIG.DASHBOARD_PORT}`);
    });
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
    log('   ADAPTIVE SOLANA FUTURES BOT v4 - DRIFT PROTOCOL');
    log('   Multi-Timeframe + Memory Learning + Dashboard');
    log('═══════════════════════════════════════════════════════════');
    log(`Mode: ${CONFIG.SIMULATION_MODE ? '🔵 SIMULATION (Paper Trading)' : '🟢 LIVE TRADING'}`);
    log(`Leverage: ${CONFIG.LEVERAGE}x`);
    log(`Symbol: ${CONFIG.SYMBOL}`);
    log(`Trade Size: ${CONFIG.TRADE_AMOUNT_USDC} USDC`);
    log(`Base Interval: ${CONFIG.BASE_INTERVAL_MS / 1000}s`);
    log(`Timeframes: ${Object.entries(TIMEFRAMES).map(([k, v]) => `${v.name}(${v.pointsNeeded}pts)`).join(', ')}`);
    log(`Volatility Filter: ${CONFIG.VOLATILITY_THRESHOLD}%`);
    log(`Stop Loss: ${CONFIG.STOP_LOSS_PERCENT}% | TP Activation: ${CONFIG.TAKE_PROFIT_ACTIVATION}%`);
    log(`Dashboard: http://0.0.0.0:${CONFIG.DASHBOARD_PORT}`);
    log('═══════════════════════════════════════════════════════════');

    if (!CONFIG.RPC_URL) {
        log('ERROR: Missing SOLANA_RPC_URL in .env file');
        process.exit(1);
    }
    
    if (!CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY) {
        log('ERROR: Missing PRIVATE_KEY in .env file (required for live trading)');
        process.exit(1);
    }

    loadMemory();
    startDashboard();

    try {
        const connection = new Connection(CONFIG.RPC_URL, { commitment: 'confirmed' });

        let keypair;
        
        if (CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY) {
            keypair = Keypair.generate();
            log(`Simulation mode: Using temporary wallet ${keypair.publicKey.toBase58().slice(0, 8)}...`);
        } else {
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
            keypair = Keypair.fromSecretKey(privateKeyBytes);
            log(`Wallet: ${keypair.publicKey.toBase58()}`);
        }
        
        const wallet = new Wallet(keypair);

        const sdkConfig = initialize({ env: 'mainnet-beta' });

        driftClient = new DriftClient({
            connection,
            wallet,
            programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
            accountSubscription: { 
                type: 'websocket',
                resubTimeoutMs: 30000,
                resyncIntervalMs: 60000,
            },
        });

        log('Connecting to Drift Protocol...');
        await driftClient.subscribe();
        log('Connected to Drift Protocol!');

        if (!CONFIG.SIMULATION_MODE) {
            const user = driftClient.getUser();
            if (!user) {
                log('ERROR: No Drift user account found.');
                process.exit(1);
            }
        }

        marketIndex = await findMarketIndex(CONFIG.SYMBOL);

        log('Testing DLOB API...');
        const testOrderBook = await fetchOrderBook();
        if (testOrderBook) {
            log('DLOB API connected!');
        }

        botStatus.running = true;
        
        if (!tradeMemory.sessionStats.startTime) {
            tradeMemory.sessionStats.startTime = new Date().toISOString();
        }

        log('Starting trading loop...');
        setInterval(tradingLoop, CONFIG.BASE_INTERVAL_MS);

        process.on('SIGINT', async () => {
            log('Shutting down...');
            botStatus.running = false;
            saveMemory();
            const pos = CONFIG.SIMULATION_MODE ? simulatedPosition : currentPosition;
            if (pos) {
                log(`WARNING: Open ${CONFIG.SIMULATION_MODE ? 'simulated' : 'real'} position will remain.`);
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
