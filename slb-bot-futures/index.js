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
const aiBrain = require('./ai_brain');
const safety = require('./self_tuner');
const indicators = require('./indicators');
const signalEngine = require('./signal_engine');
const patternMemory = require('./pattern_memory');

dotenv.config();

const CONFIG = {
    RPC_URL: process.env.SOLANA_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    LEVERAGE: parseInt(process.env.LEVERAGE) || 20,
    TRADE_AMOUNT_USDC: parseFloat(process.env.TRADE_AMOUNT_USDC) || 10,
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true' || process.env.SIMULATION_MODE === '1',
    // COOLDOWN REMOVED - AI and safety layer handle trade frequency
    AI_INTERVAL_MS: parseInt(process.env.AI_INTERVAL_MS) || 15000,
    CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS) || 15000,
    DLOB_URL: 'https://dlob.drift.trade',
    DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT) || 3000,
    MEMORY_FILE: path.join(__dirname, 'trade_memory.json'),
    PRICE_HISTORY_FILE: path.join(__dirname, 'price_history.json'),
    MIN_CONFIDENCE: parseFloat(process.env.MIN_CONFIDENCE) || 0.75,
};

const MARKETS = {
    'SOL-PERP': { symbol: 'SOL-PERP', marketIndex: 0, positionMultiplier: 1.0 },
    'BTC-PERP': { symbol: 'BTC-PERP', marketIndex: 1, positionMultiplier: 1.2 },
    'ETH-PERP': { symbol: 'ETH-PERP', marketIndex: 2, positionMultiplier: 1.0 }
};

const ACTIVE_MARKETS = (process.env.ACTIVE_MARKETS || 'SOL-PERP,BTC-PERP,ETH-PERP').split(',').map(s => s.trim());

function createEmptyMarketState() {
    return {
        currentPosition: null,
        simulatedPosition: null,
        entryPrice: 0,
        highestPriceSinceEntry: 0,
        lowestPriceSinceEntry: Infinity,
        trailingStopActive: false,
        lastOrderTime: 0,
        currentTradeDirection: null,
        aiStopLoss: null,
        aiTakeProfit: null,
        aiMaxHoldMinutes: null,
        aiReason: null,
        entryTime: null,
        lastAiCall: 0,
        lastStopLossTime: 0,
        prices: [],
        priceTimestamps: [],
        imbalances: [],
        lastPrice: 0,
        lastImbalance: 0,
        volatility: 0,
        trend: 'UNKNOWN',
        rpcConnected: false,
        dlobConnected: false,
        indicators1m: null,
        indicators5m: null,
        indicators15m: null,
        supportResistance: null,
        candlePatterns: null,
        priceChangeHistory: [],
        directionalScore: null,
        momentumPhase: null,
        entryFingerprint: null,
        entryMode: null,
        lastSignalResult: null
    };
}

const marketStates = {};
for (const symbol of ACTIVE_MARKETS) {
    marketStates[symbol] = createEmptyMarketState();
}

let driftClient = null;
let tradeMemory = { 
    trades: [], 
    sessionStats: {
        startTime: null,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalProfitPercent: 0
    },
    signalStats: {}
};
let botStatus = {
    running: false,
    markets: {},
    lastUpdate: null,
    driftConnected: false
};
let lastHeartbeat = Date.now();
let botStartTime = Date.now();
let lastLogTime = 0;

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function loadMemory() {
    try {
        if (fs.existsSync(CONFIG.MEMORY_FILE)) {
            const data = fs.readFileSync(CONFIG.MEMORY_FILE, 'utf8');
            const loaded = JSON.parse(data);
            tradeMemory = {
                trades: loaded.trades || [],
                sessionStats: loaded.sessionStats || {
                    startTime: null, totalTrades: 0, wins: 0, losses: 0, totalProfitPercent: 0
                },
                signalStats: loaded.signalStats || {}
            };
            log(`Memory loaded: ${tradeMemory.trades.length} trades, ${Object.keys(tradeMemory.signalStats).length} signal stats`);
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

function savePriceHistory() {
    try {
        const data = {};
        for (const symbol of ACTIVE_MARKETS) {
            const ms = marketStates[symbol];
            if (ms && ms.prices.length > 0) {
                data[symbol] = {
                    prices: ms.prices.slice(-3600),
                    timestamps: ms.priceTimestamps.slice(-3600)
                };
            }
        }
        fs.writeFileSync(CONFIG.PRICE_HISTORY_FILE, JSON.stringify(data));
    } catch (error) {
        log(`Warning: Failed to save price history: ${error.message}`);
    }
}

function loadPriceHistory() {
    try {
        if (fs.existsSync(CONFIG.PRICE_HISTORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.PRICE_HISTORY_FILE, 'utf8'));
            let loaded = 0;
            for (const symbol of ACTIVE_MARKETS) {
                if (data[symbol] && data[symbol].prices && data[symbol].timestamps) {
                    const ms = marketStates[symbol];
                    const maxAge = 16 * 60 * 60 * 1000;
                    const now = Date.now();
                    const validIndices = [];
                    for (let i = 0; i < data[symbol].timestamps.length; i++) {
                        if (now - data[symbol].timestamps[i] < maxAge) {
                            validIndices.push(i);
                        }
                    }
                    if (validIndices.length > 10) {
                        ms.prices = validIndices.map(i => data[symbol].prices[i]);
                        ms.priceTimestamps = validIndices.map(i => data[symbol].timestamps[i]);
                        ms.lastPrice = ms.prices[ms.prices.length - 1];
                        ms.trend = detectTrend(ms.prices);
                        ms.volatility = calculateVolatility(ms.prices);
                        loaded += validIndices.length;
                        log(`[${symbol}] Loaded ${validIndices.length} price points from history (max 16h old)`);
                    }
                }
            }
            if (loaded > 0) {
                log(`Price history restored: ${loaded} total data points`);
                recalculateAllIndicators();
            }
        }
    } catch (error) {
        log(`Error loading price history: ${error.message}`);
    }
}

function recalculateAllIndicators() {
    for (const symbol of ACTIVE_MARKETS) {
        const ms = marketStates[symbol];
        if (!ms || ms.prices.length < 5) continue;
        const candles1m = indicators.buildCandles(ms.prices, ms.priceTimestamps, 60000);
        const candles5m = indicators.buildCandles(ms.prices, ms.priceTimestamps, 300000);
        const candles15m = indicators.buildCandles(ms.prices, ms.priceTimestamps, 900000);
        ms.indicators1m = indicators.calculateAllIndicators(candles1m);
        ms.indicators5m = indicators.calculateAllIndicators(candles5m);
        ms.indicators15m = indicators.calculateAllIndicators(candles15m);
    }
}

async function fetchOrderBook(symbol) {
    try {
        const response = await fetch(`${CONFIG.DLOB_URL}/l2?marketName=${symbol}&depth=20`);
        if (!response.ok) return null;
        const data = await response.json();
        if (!data || !data.bids || !data.asks || !Array.isArray(data.bids) || !Array.isArray(data.asks)) return null;
        return data;
    } catch (error) {
        return null;
    }
}

async function fetchPriceForMarket(symbol) {
    try {
        const orderBook = await fetchOrderBook(symbol);
        if (!orderBook || !orderBook.bids || !orderBook.asks) return null;
        if (orderBook.bids.length === 0 || orderBook.asks.length === 0) return null;
        const bestBid = Array.isArray(orderBook.bids[0]) ? parseFloat(orderBook.bids[0][0]) : parseFloat(orderBook.bids[0].price);
        const bestAsk = Array.isArray(orderBook.asks[0]) ? parseFloat(orderBook.asks[0][0]) : parseFloat(orderBook.asks[0].price);
        return (bestBid + bestAsk) / 2 / 1e6;
    } catch (error) {
        return null;
    }
}

function calculateImbalance(orderBook) {
    if (!orderBook || !orderBook.bids || !orderBook.asks) return 0;
    let totalBids = 0, totalAsks = 0;
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

function detectTrend(prices) {
    if (prices.length < 5) return 'UNKNOWN';
    const recent = prices.slice(-40);
    const oldPrice = recent[0];
    const currentPrice = recent[recent.length - 1];
    const changePercent = ((currentPrice - oldPrice) / oldPrice) * 100;
    if (changePercent > 1.0) return 'STRONG_UPTREND';
    if (changePercent > 0.3) return 'UPTREND';
    if (changePercent > 0.1) return 'SLIGHT_UP';
    if (changePercent < -1.0) return 'STRONG_DOWNTREND';
    if (changePercent < -0.3) return 'DOWNTREND';
    if (changePercent < -0.1) return 'SLIGHT_DOWN';
    return 'RANGING';
}

function calculateVolatility(prices) {
    if (prices.length < 5) return 0;
    const recent = prices.slice(-40);
    let totalChange = 0;
    for (let i = 1; i < recent.length; i++) {
        totalChange += Math.abs((recent[i] - recent[i-1]) / recent[i-1] * 100);
    }
    return totalChange / (recent.length - 1);
}

async function openPosition(direction, marketState, marketConfig, symbol) {
    const currentPrice = marketState.lastPrice;

    if (CONFIG.SIMULATION_MODE) {
        log(`[${symbol}] [SIM] Opening ${direction} at $${currentPrice.toFixed(4)}`);
        marketState.simulatedPosition = direction;
    } else {
        try {
            const tradeAmount = CONFIG.TRADE_AMOUNT_USDC * marketConfig.positionMultiplier;
            const notionalValue = tradeAmount * CONFIG.LEVERAGE;
            const baseAssetAmountRaw = notionalValue / currentPrice;
            const baseAssetAmount = driftClient.convertToPerpPrecision(baseAssetAmountRaw);
            log(`[${symbol}] Opening ${direction}: $${tradeAmount.toFixed(2)} x ${CONFIG.LEVERAGE}x`);
            const orderParams = {
                orderType: OrderType.MARKET,
                marketType: MarketType.PERP,
                marketIndex: marketConfig.marketIndex,
                direction: direction === 'LONG' ? PositionDirection.LONG : PositionDirection.SHORT,
                baseAssetAmount: baseAssetAmount,
            };
            const txSig = await driftClient.placePerpOrder(orderParams);
            log(`[${symbol}] Order placed. TX: ${txSig}`);
            marketState.currentPosition = direction;
        } catch (error) {
            log(`[${symbol}] Error opening position: ${error.message}`);
            return false;
        }
    }

    marketState.entryPrice = currentPrice;
    marketState.entryTime = Date.now();
    marketState.highestPriceSinceEntry = currentPrice;
    marketState.lowestPriceSinceEntry = currentPrice;
    marketState.trailingStopActive = false;
    marketState.currentTradeDirection = direction;
    marketState.entrySnapshot = {
        trend: marketState.trend,
        volatility: marketState.volatility,
        imbalance: marketState.lastImbalance || 0,
        priceHistory: (marketState.prices || []).slice(-10),
        timestamp: Date.now()
    };
    return true;
}

async function closePosition(exitReason, marketState, marketConfig, symbol) {
    const currentPrice = marketState.lastPrice;
    const pos = CONFIG.SIMULATION_MODE ? marketState.simulatedPosition : marketState.currentPosition;
    if (!pos) return true;

    if (!marketState.entryPrice || marketState.entryPrice <= 0 || !currentPrice || currentPrice <= 0) {
        log(`[${symbol}] ERROR: Invalid prices. Entry: ${marketState.entryPrice}, Current: ${currentPrice}`);
        resetPositionState(marketState);
        return true;
    }

    let priceMove = 0;
    if (pos === 'LONG') {
        priceMove = ((currentPrice - marketState.entryPrice) / marketState.entryPrice) * 100;
    } else {
        priceMove = ((marketState.entryPrice - currentPrice) / marketState.entryPrice) * 100;
    }
    let profitPercent = priceMove * CONFIG.LEVERAGE;

    const ROUND_TRIP_FEE_PCT = 0.07;
    profitPercent -= (ROUND_TRIP_FEE_PCT * CONFIG.LEVERAGE);

    if (Math.abs(profitPercent) > 500) {
        profitPercent = profitPercent > 0 ? 500 : -500;
    }

    const result = profitPercent > 0 ? 'WIN' : 'LOSS';

    if (CONFIG.SIMULATION_MODE) {
        log(`[${symbol}] [SIM] Closing ${pos}: ${result} ${profitPercent.toFixed(2)}%`);
        marketState.simulatedPosition = null;
    } else {
        try {
            const user = driftClient.getUser();
            const perpPosition = user.getPerpPosition(marketConfig.marketIndex);
            if (!perpPosition || perpPosition.baseAssetAmount.eq(new BN(0))) {
                resetPositionState(marketState);
                return true;
            }
            const baseAssetAmount = perpPosition.baseAssetAmount.abs();
            const closeDirection = perpPosition.baseAssetAmount.gt(new BN(0)) 
                ? PositionDirection.SHORT : PositionDirection.LONG;
            const orderParams = {
                orderType: OrderType.MARKET,
                marketType: MarketType.PERP,
                marketIndex: marketConfig.marketIndex,
                direction: closeDirection,
                baseAssetAmount: baseAssetAmount,
                reduceOnly: true,
            };
            const txSig = await driftClient.placePerpOrder(orderParams);
            log(`[${symbol}] Position closed. TX: ${txSig}`);
            marketState.currentPosition = null;
        } catch (error) {
            log(`[${symbol}] Error closing position: ${error.message}`);
            return false;
        }
    }

    const holdTimeMin = marketState.entryTime ? ((Date.now() - marketState.entryTime) / 60000).toFixed(1) : '?';

    const exitSnapshot = {
        trend: marketState.trend,
        volatility: marketState.volatility,
        imbalance: marketState.lastImbalance || 0,
        timestamp: Date.now()
    };

    let lesson = '';
    if (result === 'LOSS' && marketState.entrySnapshot) {
        const es = marketState.entrySnapshot;
        if (exitReason === 'stop_loss') {
            lesson = `Entered ${pos} during ${es.trend} with ${(es.imbalance * 100).toFixed(0)}% imbalance and ${es.volatility.toFixed(2)}% volatility. Hit stop loss - market reversed against entry.`;
        } else if (exitReason === 'max_hold_time') {
            lesson = `Entered ${pos} during ${es.trend} with ${(es.imbalance * 100).toFixed(0)}% imbalance. Trade went nowhere within hold time - weak momentum.`;
        } else {
            lesson = `Entered ${pos} during ${es.trend}. Lost on ${exitReason}.`;
        }
    } else if (result === 'WIN' && marketState.entrySnapshot) {
        const es = marketState.entrySnapshot;
        lesson = `Entered ${pos} during ${es.trend} with ${(es.imbalance * 100).toFixed(0)}% imbalance and ${es.volatility.toFixed(2)}% volatility. Won via ${exitReason} - good setup.`;
    }

    const trade = {
        timestamp: new Date().toISOString(),
        symbol,
        direction: pos,
        entryPrice: marketState.entryPrice,
        exitPrice: currentPrice,
        result,
        profitPercent,
        exitReason,
        holdTimeMin,
        aiStopLoss: marketState.aiStopLoss,
        aiTakeProfit: marketState.aiTakeProfit,
        aiReason: marketState.aiReason,
        triggerSignals: marketState.triggerSignals || [],
        simulated: CONFIG.SIMULATION_MODE,
        entrySnapshot: marketState.entrySnapshot || null,
        exitSnapshot,
        lesson
    };

    if (trade.triggerSignals.length > 0) {
        if (!tradeMemory.signalStats) tradeMemory.signalStats = {};
        for (const sig of trade.triggerSignals) {
            if (!tradeMemory.signalStats[sig]) tradeMemory.signalStats[sig] = { wins: 0, losses: 0 };
            if (result === 'WIN') tradeMemory.signalStats[sig].wins++;
            else tradeMemory.signalStats[sig].losses++;
        }
    }
    tradeMemory.trades.push(trade);
    tradeMemory.sessionStats.totalTrades++;
    if (result === 'WIN') tradeMemory.sessionStats.wins++;
    else tradeMemory.sessionStats.losses++;
    tradeMemory.sessionStats.totalProfitPercent += profitPercent;
    saveMemory();

    patternMemory.storeTrade({
        timestamp: trade.timestamp,
        symbol,
        direction: pos,
        entryPrice: marketState.entryPrice,
        exitPrice: currentPrice,
        profitPercent,
        result,
        exitReason,
        holdTimeMin: parseFloat(holdTimeMin) || 0,
        fingerprint: marketState.entryFingerprint || {},
        entryMode: marketState.entryMode || 'UNKNOWN',
        triggerSignals: marketState.triggerSignals || []
    });

    aiBrain.recordTradeResult(symbol, pos, result, profitPercent, exitReason);
    safety.recordTradeResult(profitPercent, result === 'WIN');

    resetPositionState(marketState);

    if (result === 'WIN') {
        marketState.lastAiCall = 0;
    }

    return true;
}

function resetPositionState(marketState) {
    if (CONFIG.SIMULATION_MODE) {
        marketState.simulatedPosition = null;
    } else {
        marketState.currentPosition = null;
    }
    marketState.entryPrice = 0;
    marketState.entryTime = null;
    marketState.highestPriceSinceEntry = 0;
    marketState.lowestPriceSinceEntry = Infinity;
    marketState.trailingStopActive = false;
    marketState.currentTradeDirection = null;
    marketState.aiStopLoss = null;
    marketState.aiTakeProfit = null;
    marketState.aiMaxHoldMinutes = null;
    marketState.aiReason = null;
    marketState.entrySnapshot = null;
    marketState.triggerSignals = [];
    marketState.entryFingerprint = null;
    marketState.entryMode = null;
}

async function syncPositionFromChain(marketState, marketConfig, symbol) {
    if (CONFIG.SIMULATION_MODE) return;
    try {
        const user = driftClient.getUser();
        const perpPosition = user.getPerpPosition(marketConfig.marketIndex);
        if (perpPosition && !perpPosition.baseAssetAmount.eq(new BN(0))) {
            const isLong = perpPosition.baseAssetAmount.gt(new BN(0));
            const onChainDirection = isLong ? 'LONG' : 'SHORT';
            if (marketState.currentPosition !== onChainDirection) {
                log(`[${symbol}] Syncing position from chain: ${onChainDirection}`);
                marketState.currentPosition = onChainDirection;
                const quoteEntry = perpPosition.quoteEntryAmount;
                const baseAmount = perpPosition.baseAssetAmount.abs();
                const oracleData = driftClient.getOracleDataForPerpMarket(marketConfig.marketIndex);
                const oraclePrice = convertToNumber(oracleData.price, PRICE_PRECISION);
                if (!baseAmount.eq(new BN(0))) {
                    const entryPriceRaw = quoteEntry.abs().mul(PRICE_PRECISION).div(baseAmount);
                    const calcEntry = convertToNumber(entryPriceRaw, PRICE_PRECISION);
                    const priceDiff = Math.abs(calcEntry - oraclePrice) / oraclePrice * 100;
                    if (calcEntry > 0 && priceDiff < 50) {
                        marketState.entryPrice = calcEntry;
                    } else {
                        log(`[${symbol}] Synced entry price looks wrong ($${calcEntry.toFixed(2)} vs oracle $${oraclePrice.toFixed(2)}) - using oracle`);
                        marketState.entryPrice = oraclePrice;
                    }
                } else {
                    marketState.entryPrice = oraclePrice;
                }
                marketState.highestPriceSinceEntry = marketState.entryPrice;
                marketState.lowestPriceSinceEntry = marketState.entryPrice;
                if (!marketState.entryTime) marketState.entryTime = Date.now();
                if (!marketState.entrySnapshot) {
                    marketState.entrySnapshot = {
                        trend: marketState.trend || 'UNKNOWN',
                        volatility: marketState.volatility || 0,
                        imbalance: marketState.lastImbalance || 0,
                        priceHistory: (marketState.prices || []).slice(-10),
                        timestamp: Date.now()
                    };
                    marketState.aiReason = marketState.aiReason || 'Position synced from chain (no AI context)';
                    log(`[${symbol}] Entry snapshot created for chain-synced position`);
                }
            }
        } else if (marketState.currentPosition) {
            resetPositionState(marketState);
        }
    } catch (error) {
        log(`[${symbol}] Error syncing position: ${error.message}`);
    }
}

function checkStopLoss(currentPrice, marketState, symbol) {
    const pos = CONFIG.SIMULATION_MODE ? marketState.simulatedPosition : marketState.currentPosition;
    if (!pos || marketState.aiStopLoss === null || marketState.aiStopLoss === undefined) return false;

    const priceMovePercent = ((currentPrice - marketState.entryPrice) / marketState.entryPrice) * 100;

    const slThreshold = marketState.aiStopLoss;

    if (pos === 'LONG' && priceMovePercent <= -slThreshold) {
        log(`[${symbol}] STOP LOSS (LONG): price moved ${priceMovePercent.toFixed(2)}% | SL: ${marketState.aiStopLoss}% | Threshold: ${slThreshold.toFixed(3)}%`);
        aiBrain.think(`[${symbol}] STOP LOSS hit on LONG at ${priceMovePercent.toFixed(2)}% | SL was ${marketState.aiStopLoss}%`, 'exit');
        return true;
    }
    if (pos === 'SHORT' && priceMovePercent >= slThreshold) {
        log(`[${symbol}] STOP LOSS (SHORT): price moved ${priceMovePercent.toFixed(2)}% | SL: ${marketState.aiStopLoss}% | Threshold: ${slThreshold.toFixed(3)}%`);
        aiBrain.think(`[${symbol}] STOP LOSS hit on SHORT at ${priceMovePercent.toFixed(2)}% | SL was ${marketState.aiStopLoss}%`, 'exit');
        return true;
    }
    return false;
}

function checkTakeProfit(currentPrice, marketState, symbol) {
    const pos = CONFIG.SIMULATION_MODE ? marketState.simulatedPosition : marketState.currentPosition;
    if (!pos || !marketState.entryPrice || marketState.entryPrice <= 0) return false;

    const leverage = CONFIG.LEVERAGE;

    if (pos === 'LONG') {
        const priceMove = ((currentPrice - marketState.entryPrice) / marketState.entryPrice) * 100;
        const pnlPercent = priceMove * leverage;
        if (marketState.aiTakeProfit && priceMove >= marketState.aiTakeProfit) {
            log(`[${symbol}] TAKE PROFIT (LONG): price moved +${priceMove.toFixed(3)}% | TP: ${marketState.aiTakeProfit}% | P&L: ${pnlPercent.toFixed(1)}%`);
            aiBrain.think(`[${symbol}] TP HIT on LONG | Price move: +${priceMove.toFixed(3)}% | P&L: ${pnlPercent.toFixed(1)}%`, 'exit');
            return true;
        }
    } else if (pos === 'SHORT') {
        const priceMove = ((marketState.entryPrice - currentPrice) / marketState.entryPrice) * 100;
        const pnlPercent = priceMove * leverage;
        if (marketState.aiTakeProfit && priceMove >= marketState.aiTakeProfit) {
            log(`[${symbol}] TAKE PROFIT (SHORT): price moved +${priceMove.toFixed(3)}% | TP: ${marketState.aiTakeProfit}% | P&L: ${pnlPercent.toFixed(1)}%`);
            aiBrain.think(`[${symbol}] TP HIT on SHORT | Price move: +${priceMove.toFixed(3)}% | P&L: ${pnlPercent.toFixed(1)}%`, 'exit');
            return true;
        }
    }
    return false;
}

function checkMaxHoldTime(marketState, symbol) {
    const pos = CONFIG.SIMULATION_MODE ? marketState.simulatedPosition : marketState.currentPosition;
    if (!pos || !marketState.entryTime) return false;

    const maxHold = (marketState.aiMaxHoldMinutes || 30) * 60 * 1000;
    if (Date.now() - marketState.entryTime > maxHold) {
        log(`[${symbol}] MAX HOLD TIME reached (${marketState.aiMaxHoldMinutes || 30} min)`);
        aiBrain.think(`[${symbol}] Max hold time expired (${marketState.aiMaxHoldMinutes || 30} min) - closing position`, 'exit');
        return true;
    }
    return false;
}

async function processMarket(symbol) {
    const marketConfig = MARKETS[symbol];
    const marketState = marketStates[symbol];
    if (!marketConfig || !marketState) return;

    try {
        const orderBook = await fetchOrderBook(symbol);
        marketState.dlobConnected = !!orderBook;
        if (!orderBook) return;

        const price = await fetchPriceForMarket(symbol);
        marketState.rpcConnected = !!price;
        if (!price) return;

        try { await syncPositionFromChain(marketState, marketConfig, symbol); } catch (e) {}

        const imbalance = calculateImbalance(orderBook);

        const now = Date.now();
        marketState.prices.push(price);
        marketState.priceTimestamps.push(now);
        marketState.imbalances.push(imbalance);
        if (marketState.prices.length > 3600) {
            marketState.prices = marketState.prices.slice(-3600);
            marketState.priceTimestamps = marketState.priceTimestamps.slice(-3600);
        }
        if (marketState.imbalances.length > 60) marketState.imbalances = marketState.imbalances.slice(-60);

        marketState.lastPrice = price;
        marketState.lastImbalance = imbalance;
        marketState.trend = detectTrend(marketState.prices);
        marketState.volatility = calculateVolatility(marketState.prices);

        const candles1m = indicators.buildCandles(marketState.prices, marketState.priceTimestamps, 60000);
        const candles5m = indicators.buildCandles(marketState.prices, marketState.priceTimestamps, 300000);
        const candles15m = indicators.buildCandles(marketState.prices, marketState.priceTimestamps, 900000);
        marketState.indicators1m = indicators.calculateAllIndicators(candles1m);
        marketState.indicators5m = indicators.calculateAllIndicators(candles5m);
        marketState.indicators15m = indicators.calculateAllIndicators(candles15m);

        marketState.supportResistance = indicators.findSupportResistance(marketState.prices, marketState.priceTimestamps, price);
        marketState.candlePatterns = indicators.analyzeCandlePatterns(candles5m);

        const allPricesForScore = marketState.prices;
        const rawPriceChanges = {
            '1min': allPricesForScore.length >= 4 ? ((price - allPricesForScore[allPricesForScore.length - 4]) / allPricesForScore[allPricesForScore.length - 4]) * 100 : null,
            '5min': allPricesForScore.length >= 20 ? ((price - allPricesForScore[allPricesForScore.length - 20]) / allPricesForScore[allPricesForScore.length - 20]) * 100 : null,
            '10min': allPricesForScore.length >= 40 ? ((price - allPricesForScore[allPricesForScore.length - 40]) / allPricesForScore[allPricesForScore.length - 40]) * 100 : null,
            '15min': allPricesForScore.length >= 60 ? ((price - allPricesForScore[allPricesForScore.length - 60]) / allPricesForScore[allPricesForScore.length - 60]) * 100 : null,
            '30min': allPricesForScore.length >= 120 ? ((price - allPricesForScore[allPricesForScore.length - 120]) / allPricesForScore[allPricesForScore.length - 120]) * 100 : null,
            '1hr': allPricesForScore.length >= 240 ? ((price - allPricesForScore[allPricesForScore.length - 240]) / allPricesForScore[allPricesForScore.length - 240]) * 100 : null
        };
        marketState.priceChangeHistory.push(rawPriceChanges);
        if (marketState.priceChangeHistory.length > 4) {
            marketState.priceChangeHistory = marketState.priceChangeHistory.slice(-4);
        }
        const smoothedPriceChanges = {};
        const windows = ['1min', '5min', '10min', '15min', '30min', '1hr'];
        for (const w of windows) {
            const vals = marketState.priceChangeHistory.map(h => h[w]).filter(v => v !== null);
            smoothedPriceChanges[w] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        }
        marketState.directionalScore = indicators.calculateDirectionalScore(
            marketState.indicators1m, marketState.indicators5m, marketState.indicators15m,
            smoothedPriceChanges, imbalance, allPricesForScore
        );
        marketState.momentumPhase = marketState.directionalScore.momentumPhase;

        const pos = CONFIG.SIMULATION_MODE ? marketState.simulatedPosition : marketState.currentPosition;
        const modeStr = CONFIG.SIMULATION_MODE ? 'SIM' : 'LIVE';
        const posStr = pos || 'NONE';

        const ind1m = marketState.indicators1m || {};
        const indStatus = ind1m.ready ? `${ind1m.indicatorsAvailable}/${ind1m.indicatorsTotal}` : 'building';

        const dsInfo = marketState.directionalScore || {};
        const mpInfo = marketState.momentumPhase || {};
        botStatus.markets[symbol] = {
            price, imbalance, trend: marketState.trend, volatility: marketState.volatility,
            position: pos, rpcConnected: true, dlobConnected: true,
            dataPoints: marketState.prices.length, indicatorStatus: indStatus,
            directionalScore: dsInfo.score || 0, directionalBias: dsInfo.bias || 'N/A',
            momentumPhase: mpInfo.phase || 'N/A'
        };

        const scoreStr = dsInfo.score !== undefined ? `Score: ${dsInfo.score} [${dsInfo.bias}]` : 'Score: N/A';
        const phaseStr = mpInfo.phase || 'N/A';
        log(`[${symbol}] ${modeStr} $${price.toFixed(2)} | ${marketState.trend} | ${scoreStr} | ${phaseStr} | Pos: ${posStr}`);

        if (pos) {
            if (!marketState.entryPrice || marketState.entryPrice <= 0) {
                aiBrain.think(`[${symbol}] Position found but entry price invalid - using current price as entry`, 'error');
                marketState.entryPrice = price;
                marketState.highestPriceSinceEntry = price;
                marketState.lowestPriceSinceEntry = price;
                if (!marketState.entryTime) marketState.entryTime = Date.now();
            }
            if (marketState.aiStopLoss == null) {
                marketState.aiStopLoss = 0.50;
                aiBrain.think(`[${symbol}] Emergency SL assigned: 0.50% (position had no stop loss)`, 'safety');
            }
            if (marketState.aiTakeProfit == null) {
                marketState.aiTakeProfit = 0.30;
                aiBrain.think(`[${symbol}] Emergency TP assigned: 0.30% (position had no take profit)`, 'safety');
            }
            if (marketState.aiMaxHoldMinutes == null) {
                marketState.aiMaxHoldMinutes = 30;
            }
            const priceMovePct = pos === 'LONG'
                ? ((price - marketState.entryPrice) / marketState.entryPrice * 100)
                : ((marketState.entryPrice - price) / marketState.entryPrice * 100);
            let pnl = (priceMovePct * CONFIG.LEVERAGE) - (0.07 * CONFIG.LEVERAGE);
            if (Math.abs(pnl) > 500) {
                aiBrain.think(`[${symbol}] BROKEN POSITION: P&L shows ${pnl.toFixed(0)}% — entry price corrupted. Force closing to prevent further loss.`, 'safety');
                await closePosition('broken_entry_price', marketState, marketConfig, symbol);
                return;
            }
            const holdMin = marketState.entryTime ? ((Date.now() - marketState.entryTime) / 60000) : 0;
            aiBrain.think(`[${symbol}] Monitoring ${pos} | P&L: ${pnl.toFixed(1)}% | Hold: ${holdMin.toFixed(0)}min | SL: ${marketState.aiStopLoss}% | TP: ${marketState.aiTakeProfit}%`, 'monitor');

            // 1. Emergency Circuit Breaker (-20% P&L)
            if (pnl <= -20) {
                aiBrain.think(`[${symbol}] EMERGENCY CIRCUIT BREAKER: P&L at ${pnl.toFixed(1)}% exceeded -20% limit. Force closing.`, 'safety');
                await closePosition('circuit_breaker', marketState, marketConfig, symbol);
                return;
            }

            // 2. Stagnation Close (10 min going nowhere — scalping mode)
            const rawPnl = priceMovePct * CONFIG.LEVERAGE;
            if (holdMin >= 10 && rawPnl > -1.0 && rawPnl < 1.0) {
                aiBrain.think(`[${symbol}] STAGNATION CLOSE: Trade going nowhere for 10min (raw P&L: ${rawPnl.toFixed(1)}%) — cutting dead wood`, 'exit');
                await closePosition('stagnation', marketState, marketConfig, symbol);
                return;
            }

            // 4. Standard Stop Loss / Take Profit
            if (checkStopLoss(price, marketState, symbol)) {
                marketState.lastStopLossTime = Date.now();
                await closePosition('stop_loss', marketState, marketConfig, symbol);
                return;
            }
            if (checkTakeProfit(price, marketState, symbol)) {
                await closePosition('take_profit', marketState, marketConfig, symbol);
                return;
            }
            if (checkMaxHoldTime(marketState, symbol)) {
                await closePosition('max_hold_time', marketState, marketConfig, symbol);
                return;
            }
        } else {
            const now = Date.now();

            if (now - marketState.lastAiCall < CONFIG.AI_INTERVAL_MS) {
                return;
            }

            if (marketState.prices.length < 20) {
                log(`[${symbol}] Building price history... ${marketState.prices.length}/20`);
                return;
            }

            const safetyCheck = safety.canTrade();
            if (!safetyCheck.allowed) {
                aiBrain.think(`[${symbol}] SAFETY BLOCK: ${safetyCheck.reason} - no new trades`, 'safety');
                return;
            }

            if (marketState.lastStopLossTime && (now - marketState.lastStopLossTime < 60000)) {
                const waitSec = Math.round((60000 - (now - marketState.lastStopLossTime)) / 1000);
                aiBrain.think(`[${symbol}] COOLDOWN: ${waitSec}s remaining after stop loss`, 'skip');
                marketState.lastAiCall = now;
                return;
            }

            marketState.lastAiCall = now;

            marketState.symbol = symbol;
            const signal = signalEngine.evaluateSignals(marketState);
            marketState.lastSignalResult = signal;

            if (signal.action === 'WAIT') {
                const modeTag = signal.entryMode ? ` [${signal.entryMode}]` : '';
                aiBrain.think(`[${symbol}] SIGNAL: WAIT${modeTag} — ${signal.failReason} | L:${signal.longScore} S:${signal.shortScore}`, 'scan');
                return;
            }

            marketState.aiStopLoss = 0.50;
            marketState.aiTakeProfit = 0.30;
            marketState.aiMaxHoldMinutes = 30;
            marketState.aiReason = signal.reason;
            marketState.triggerSignals = Object.entries(signal.signals)
                .filter(([, dir]) => dir === signal.direction)
                .map(([sig]) => sig);
            marketState.entryFingerprint = signal.fingerprint;
            marketState.entryMode = signal.entryMode;

            aiBrain.think(`[${symbol}] ENTRY ${signal.action} [${signal.entryMode}] | Score: ${Math.max(signal.longScore, signal.shortScore)}/${signal.totalSignals} | SL: 0.50% | TP: 0.30% | ${signal.reason}`, 'entry');
            await openPosition(signal.action, marketState, marketConfig, symbol);
        }
    } catch (error) {
        log(`[${symbol}] Error: ${error.message}`);
    }
}

async function tradingLoop() {
    lastHeartbeat = Date.now();
    botStatus.lastUpdate = new Date().toISOString();

    try {
        // Daily Hard Stop Check
        const dailyStats = safety.getStats();
        if (dailyStats && dailyStats.dailyProfitPercent <= -10) {
            if (!safety.isPaused()) {
                log('CRITICAL: Daily loss limit (-10%) reached. Hard stopping bot.');
                safety.pause('daily_loss_limit');
            }
            return;
        }

        if (safety.isPaused()) {
            if (Date.now() - lastLogTime > 60000) {
                log('Bot is currently PAUSED by safety layer.');
                lastLogTime = Date.now();
            }
            return;
        }
        
        botStatus.driftConnected = !!driftClient;
        for (const symbol of ACTIVE_MARKETS) {
            await processMarket(symbol);
        }
    } catch (error) {
        log(`Trading loop error: ${error.message}`);
    }
}

function generateDashboardHTML() {
    const stats = tradeMemory.sessionStats;
    const recentTrades = tradeMemory.trades.slice(-50).reverse();
    const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100).toFixed(1) : '0.0';
    const uptime = formatUptime(Date.now() - botStartTime);
    const heartbeatAgo = Math.round((Date.now() - lastHeartbeat) / 1000);
    const safetyStatus = safety.getStatus();
    const brainLog = aiBrain.getThinkingLog();
    const pmStats = patternMemory.getStats();
    const recentPatterns = patternMemory.getRecentPatterns(10);

    const anyRpcConnected = ACTIVE_MARKETS.some(s => botStatus.markets[s]?.rpcConnected);
    const anyDlobConnected = ACTIVE_MARKETS.some(s => botStatus.markets[s]?.dlobConnected);

    const allTrades = tradeMemory.trades.filter(t => Math.abs(t.profitPercent || 0) <= 100);
    const bestTrade = allTrades.length > 0 ? allTrades.reduce((best, t) => (!best || (t.profitPercent || 0) > (best.profitPercent || 0)) ? t : best, null) : null;
    const worstTrade = allTrades.length > 0 ? allTrades.reduce((worst, t) => (!worst || (t.profitPercent || 0) < (worst.profitPercent || 0)) ? t : worst, null) : null;

    const categoryColors = {
        entry: '#00ff88', exit: '#ff4444', monitor: '#00d4ff', ai_brain: '#ff00ff',
        scan: '#555', skip: '#888', safety: '#ff6600', trade_win: '#3fb950',
        trade_loss: '#f85149', error: '#ff0000', general: '#888'
    };

    return `<!DOCTYPE html>
<html>
<head>
    <title>v17 Self-Learning Bot - Pattern Memory</title>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="5">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0d1117; color: #e6edf3; padding: 10px; font-size: 13px; }
        .container { max-width: 1800px; margin: 0 auto; }
        h1 { color: #58a6ff; margin-bottom: 8px; font-size: 1.3em; }
        .subtitle { color: #8b949e; font-size: 0.82em; margin-bottom: 12px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-bottom: 10px; }
        .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; }
        .card h2 { color: #58a6ff; font-size: 0.95em; margin-bottom: 10px; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
        .stat-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #21262d; font-size: 0.9em; }
        .stat-label { color: #8b949e; }
        .stat-value { font-weight: bold; }
        .positive { color: #3fb950; }
        .negative { color: #f85149; }
        .neutral { color: #d29922; }
        .sim-mode { background: #1f6feb; color: white; padding: 2px 10px; border-radius: 12px; display: inline-block; font-size: 0.8em; }
        .live-mode { background: #238636; color: white; padding: 2px 10px; border-radius: 12px; display: inline-block; font-size: 0.8em; }
        .paused-badge { background: #da3633; color: white; padding: 2px 10px; border-radius: 12px; display: inline-block; font-size: 0.8em; }
        .learning-badge { background: #8957e5; color: white; padding: 2px 10px; border-radius: 12px; display: inline-block; font-size: 0.8em; }
        .exploit-badge { background: #238636; color: white; padding: 2px 10px; border-radius: 12px; display: inline-block; font-size: 0.8em; }
        table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
        th, td { padding: 5px 6px; text-align: left; border-bottom: 1px solid #21262d; }
        th { color: #58a6ff; font-weight: 600; position: sticky; top: 0; background: #161b22; }
        .health-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
        .health-green { background: #3fb950; }
        .health-red { background: #f85149; }
        .full-width { grid-column: 1 / -1; }
        .span2 { grid-column: span 2; }
        .thinking-entry { padding: 5px 8px; margin: 2px 0; border-radius: 4px; font-size: 0.8em; border-left: 3px solid #30363d; background: #0d1117; word-break: break-word; }
        .thinking-time { color: #484f58; font-size: 0.78em; margin-right: 6px; }
        .progress-bar { height: 20px; border-radius: 4px; overflow: hidden; background: #21262d; position: relative; }
        .progress-fill { height: 100%; transition: width 0.3s; }
        .progress-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 0.75em; font-weight: bold; }
        .btn { padding: 8px 14px; border: none; border-radius: 6px; font-size: 0.85em; font-weight: 600; cursor: pointer; width: 100%; margin-bottom: 6px; }
        .btn:hover { opacity: 0.85; }
        .btn-green { background: #238636; color: white; }
        .btn-orange { background: #d29922; color: #0d1117; }
        .btn-red { background: #da3633; color: white; }
        .btn-gray { background: #30363d; color: #e6edf3; }
        .btn-status { font-size: 0.75em; color: #8b949e; text-align: center; min-height: 16px; margin-top: 3px; }
        .tag { background: #21262d; padding: 1px 5px; border-radius: 3px; margin: 1px; display: inline-block; font-size: 0.78em; }
        .fp-val { font-family: monospace; font-size: 0.78em; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Self-Learning Bot <span style="color: #8957e5; font-size: 0.5em; vertical-align: middle;">v17 Pattern Memory</span></h1>
        <div class="subtitle">Drift Protocol | ${CONFIG.LEVERAGE}x | TP: 0.30% SL: 0.50% | Fee: 0.07% | Learns from every trade | ${pmStats.isLearning ? 'LEARNING PHASE' : 'EXPLOITATION PHASE'} | ${pmStats.totalStored} patterns stored</div>
        
        <div class="grid">
            <div class="card">
                <h2>System Health</h2>
                <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${uptime}</span></div>
                <div class="stat-row"><span class="stat-label">Heartbeat</span><span class="stat-value ${heartbeatAgo > 60 ? 'negative' : 'positive'}">${heartbeatAgo}s ago</span></div>
                <div class="stat-row"><span class="stat-label"><span class="health-dot ${anyRpcConnected ? 'health-green' : 'health-red'}"></span>RPC</span><span class="stat-value">${anyRpcConnected ? 'OK' : 'DOWN'}</span></div>
                <div class="stat-row"><span class="stat-label"><span class="health-dot ${botStatus.driftConnected ? 'health-green' : 'health-red'}"></span>Drift</span><span class="stat-value">${botStatus.driftConnected ? 'OK' : 'DOWN'}</span></div>
                <div class="stat-row"><span class="stat-label"><span class="health-dot ${anyDlobConnected ? 'health-green' : 'health-red'}"></span>DLOB</span><span class="stat-value">${anyDlobConnected ? 'OK' : 'DOWN'}</span></div>
                <div class="stat-row"><span class="stat-label">Mode</span><span>${CONFIG.SIMULATION_MODE ? '<span class="sim-mode">SIMULATION</span>' : '<span class="live-mode">LIVE</span>'} ${safetyStatus.paused ? '<span class="paused-badge">PAUSED</span>' : ''}</span></div>
                <div class="stat-row"><span class="stat-label">Engine</span><span class="stat-value" style="color: #8957e5;">v17 Pattern Memory</span></div>
                <div class="stat-row"><span class="stat-label">Check Interval</span><span class="stat-value">${CONFIG.AI_INTERVAL_MS / 1000}s</span></div>
                <div class="stat-row"><span class="stat-label">Min Signals</span><span class="stat-value">3+ agreeing</span></div>
                <div class="stat-row"><span class="stat-label">TP / SL</span><span class="stat-value" style="color: #3fb950;">0.30% / 0.50%</span></div>
                <div class="stat-row"><span class="stat-label">Fee</span><span class="stat-value">0.07%</span></div>
                <div class="stat-row"><span class="stat-label">SL Cooldown</span><span class="stat-value">60s</span></div>
                <div class="stat-row"><span class="stat-label">Stagnation</span><span class="stat-value">10min</span></div>
                <div class="stat-row"><span class="stat-label">Max Hold</span><span class="stat-value">30min</span></div>
            </div>

            <div class="card">
                <h2>Learning Engine</h2>
                <div class="stat-row"><span class="stat-label">Phase</span><span>${pmStats.isLearning ? '<span class="learning-badge">LEARNING</span>' : '<span class="exploit-badge">EXPLOITATION</span>'}</span></div>
                <div class="stat-row"><span class="stat-label">Patterns Stored</span><span class="stat-value" style="color: #8957e5;">${pmStats.totalStored}</span></div>
                <div style="margin: 8px 0;">
                    <div style="color: #8b949e; font-size: 0.8em; margin-bottom: 3px;">Learning Progress (${pmStats.learningProgress}%)</div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${pmStats.learningProgress}%; background: ${pmStats.isLearning ? '#8957e5' : '#238636'};"></div>
                        <span class="progress-text">${pmStats.totalStored} / ${patternMemory.MIN_TRADES_FOR_LEARNING}</span>
                    </div>
                </div>
                <div class="stat-row"><span class="stat-label">Overall Win Rate</span><span class="stat-value ${pmStats.overallWinRate >= 50 ? 'positive' : 'negative'}">${pmStats.overallWinRate}%</span></div>
                <div class="stat-row"><span class="stat-label">Pattern Match Entries</span><span class="stat-value">${pmStats.patternMatchEntries}</span></div>
                <div class="stat-row"><span class="stat-label">Pattern Match WR</span><span class="stat-value ${pmStats.patternMatchWinRate >= 50 ? 'positive' : pmStats.patternMatchEntries > 0 ? 'negative' : ''}">${pmStats.patternMatchEntries > 0 ? pmStats.patternMatchWinRate + '%' : 'N/A'}</span></div>
                <div class="stat-row"><span class="stat-label">Exploration Entries</span><span class="stat-value">${pmStats.explorationEntries}</span></div>
                <div class="stat-row"><span class="stat-label">Exploration WR</span><span class="stat-value ${pmStats.explorationWinRate >= 50 ? 'positive' : pmStats.explorationEntries > 0 ? 'negative' : ''}">${pmStats.explorationEntries > 0 ? pmStats.explorationWinRate + '%' : 'N/A'}</span></div>
                <div class="stat-row"><span class="stat-label">Win Rate Threshold</span><span class="stat-value">${(patternMemory.WIN_RATE_THRESHOLD * 100).toFixed(0)}%</span></div>
            </div>

            <div class="card">
                <h2>Controls</h2>
                ${safetyStatus.paused 
                    ? '<button class="btn btn-green" onclick="botAction(\'unpause\')">Resume Trading</button>'
                    : '<button class="btn btn-orange" onclick="botAction(\'pause\')">Pause Trading</button>'
                }
                <button class="btn btn-red" onclick="if(confirm('Close ALL positions?')) botAction('close-all')">Close All Positions</button>
                <button class="btn btn-gray" onclick="if(confirm('Reset session stats?')) botAction('reset-stats')">Reset Session Stats</button>
                <div class="btn-status" id="btnStatus"></div>
                <div style="margin-top: 10px;">
                    <h2>Session Stats</h2>
                    <div class="stat-row"><span class="stat-label">Total Trades</span><span class="stat-value">${stats.totalTrades}</span></div>
                    <div class="stat-row"><span class="stat-label">W / L</span><span class="stat-value"><span class="positive">${stats.wins}</span> / <span class="negative">${stats.losses}</span></span></div>
                    <div class="stat-row"><span class="stat-label">Win Rate</span><span class="stat-value ${parseFloat(winRate) >= 50 ? 'positive' : 'negative'}">${winRate}%</span></div>
                    <div class="stat-row"><span class="stat-label">Total P&L</span><span class="stat-value ${stats.totalProfitPercent >= 0 ? 'positive' : 'negative'}">${stats.totalProfitPercent.toFixed(2)}%</span></div>
                </div>
            </div>

            <div class="card">
                <h2>Safety + Best/Worst</h2>
                <div class="stat-row"><span class="stat-label">Daily P&L</span><span class="stat-value ${safetyStatus.dailyPnl >= 0 ? 'positive' : 'negative'}">${safetyStatus.dailyPnl.toFixed(2)}%</span></div>
                <div class="stat-row"><span class="stat-label">Daily Limit</span><span class="stat-value">-${safetyStatus.dailyLossLimit}%</span></div>
                <div class="stat-row"><span class="stat-label">Daily Trades</span><span class="stat-value">${safetyStatus.dailyTrades}</span></div>
                <div class="stat-row"><span class="stat-label">Consec Loss</span><span class="stat-value ${safetyStatus.consecutiveLosses >= 4 ? 'negative' : ''}">${safetyStatus.consecutiveLosses} / ${safetyStatus.maxConsecutiveLosses}</span></div>
                <div class="stat-row"><span class="stat-label">Status</span><span class="${safetyStatus.paused ? 'negative' : 'positive'}">${safetyStatus.paused ? 'PAUSED' : 'ACTIVE'}</span></div>
                <div style="display:flex; gap:8px; margin-top:10px;">
                    <div style="flex:1; padding:8px; border-radius:6px; background:#0d1117;">
                        <div style="color: #3fb950; font-weight: bold; font-size: 0.8em;">Best</div>
                        ${bestTrade ? `<div style="font-size:1.1em;color:#3fb950;">+${(bestTrade.profitPercent||0).toFixed(2)}%</div><div style="font-size:0.75em;color:#8b949e;">${bestTrade.direction} ${bestTrade.symbol||''}</div>` : '<div style="color:#484f58;font-size:0.8em;">None</div>'}
                    </div>
                    <div style="flex:1; padding:8px; border-radius:6px; background:#0d1117;">
                        <div style="color: #f85149; font-weight: bold; font-size: 0.8em;">Worst</div>
                        ${worstTrade ? `<div style="font-size:1.1em;color:#f85149;">${(worstTrade.profitPercent||0).toFixed(2)}%</div><div style="font-size:0.75em;color:#8b949e;">${worstTrade.direction} ${worstTrade.symbol||''}</div>` : '<div style="color:#484f58;font-size:0.8em;">None</div>'}
                    </div>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Markets Overview</h2>
                <div style="overflow-x:auto;">
                <table>
                    <thead><tr><th>Market</th><th>Price</th><th>Trend</th><th>Score</th><th>Phase</th><th>Imbalance</th><th>Volatility</th><th>Data Pts</th><th>Position</th><th>Entry $</th><th>P&L</th><th>SL/TP</th><th>Hold</th><th>Entry Mode</th><th>Last Signal</th></tr></thead>
                    <tbody>
                        ${ACTIVE_MARKETS.map(symbol => {
                            const m = botStatus.markets[symbol] || {};
                            const ms = marketStates[symbol] || {};
                            const pos = m.position;
                            let pnlVal = 0;
                            if (pos && ms.entryPrice > 0 && m.price > 0) {
                                const pm = pos === 'LONG' 
                                    ? ((m.price - ms.entryPrice) / ms.entryPrice * 100)
                                    : ((ms.entryPrice - m.price) / ms.entryPrice * 100);
                                pnlVal = pm * CONFIG.LEVERAGE;
                                if (Math.abs(pnlVal) > 1000) pnlVal = 0;
                            }
                            const holdMin = pos && ms.entryTime ? ((Date.now() - ms.entryTime) / 60000).toFixed(0) + 'm' : '-';
                            const scoreVal = m.directionalScore || 0;
                            const scoreClass = scoreVal > 8 ? 'positive' : scoreVal < -8 ? 'negative' : 'neutral';
                            const lastSig = ms.lastSignalResult;
                            const lastSigText = lastSig ? (lastSig.action !== 'WAIT' ? lastSig.action + ' L:' + lastSig.longScore + ' S:' + lastSig.shortScore : 'WAIT L:' + lastSig.longScore + ' S:' + lastSig.shortScore) : '-';
                            const lastSigClass = lastSig && lastSig.action !== 'WAIT' ? 'positive' : '';
                            return `<tr>
                                <td><strong>${symbol}</strong></td>
                                <td>$${(m.price || 0).toFixed(2)}</td>
                                <td class="${(m.trend||'').includes('UP') ? 'positive' : (m.trend||'').includes('DOWN') ? 'negative' : 'neutral'}">${m.trend || 'BUILDING'}</td>
                                <td class="${scoreClass}"><strong>${scoreVal}</strong></td>
                                <td>${m.momentumPhase || 'N/A'}</td>
                                <td class="${(m.imbalance || 0) > 0 ? 'positive' : 'negative'}">${((m.imbalance || 0) * 100).toFixed(1)}%</td>
                                <td>${(m.volatility || 0).toFixed(3)}%</td>
                                <td style="color:#8b949e;">${ms.prices ? ms.prices.length : 0}</td>
                                <td class="${pos === 'LONG' ? 'positive' : pos === 'SHORT' ? 'negative' : ''}" style="font-weight:bold;">${pos || 'NONE'}</td>
                                <td>${pos ? '$' + (ms.entryPrice || 0).toFixed(2) : '-'}</td>
                                <td class="${pnlVal >= 0 ? 'positive' : 'negative'}" style="font-weight:bold;">${pos ? pnlVal.toFixed(2) + '%' : '-'}</td>
                                <td>${pos && ms.aiStopLoss != null ? ms.aiStopLoss.toFixed(2) + ' / ' + (ms.aiTakeProfit != null ? ms.aiTakeProfit.toFixed(2) : '?') : '-'}</td>
                                <td>${holdMin}</td>
                                <td>${pos && ms.entryMode ? '<span class="tag">' + ms.entryMode + '</span>' : '-'}</td>
                                <td class="${lastSigClass}" style="font-size:0.78em;">${lastSigText}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>All Technical Indicators (12 per timeframe)</h2>
                <div style="overflow-x:auto;">
                <table>
                    <thead><tr><th>Market</th><th>TF</th><th>RSI</th><th>EMA 9/21</th><th>EMA50</th><th>MACD Hist</th><th>BB Pos</th><th>BB Width</th><th>ATR</th><th>ATR%</th><th>StochRSI K/D</th><th>ADX</th><th>+DI/-DI</th><th>CCI</th><th>Will%R</th><th>ROC</th><th>Ready</th></tr></thead>
                    <tbody>
                        ${ACTIVE_MARKETS.map(symbol => {
                            const ms = marketStates[symbol] || {};
                            const price = ms.lastPrice || 1;
                            return ['1m', '5m', '15m'].map(tf => {
                                const ind = tf === '1m' ? ms.indicators1m : tf === '5m' ? ms.indicators5m : ms.indicators15m;
                                if (!ind || !ind.ready) return '<tr><td>' + (tf==='1m' ? '<strong>'+symbol+'</strong>' : '') + '</td><td>' + tf + '</td><td colspan="15" style="color:#484f58;">Building data...</td></tr>';
                                const rsiV = ind.rsi != null ? ind.rsi.toFixed(1) : '-';
                                const rsiC = ind.rsi > 70 ? 'negative' : ind.rsi < 30 ? 'positive' : '';
                                const emaT = ind.ema9 != null && ind.ema21 != null ? (ind.ema9 > ind.ema21 ? 'BULL' : 'BEAR') : '-';
                                const emaC = emaT === 'BULL' ? 'positive' : emaT === 'BEAR' ? 'negative' : '';
                                const ema50T = ind.ema50 != null ? '$' + ind.ema50.toFixed(2) : '-';
                                const macdH = ind.macd ? (ind.macd.histogram > 0 ? '+' : '') + ind.macd.histogram.toFixed(4) : '-';
                                const macdC = ind.macd ? (ind.macd.histogram > 0 ? 'positive' : 'negative') : '';
                                let bbPos = '-';
                                if (ind.bollinger) {
                                    const r = ind.bollinger.upper - ind.bollinger.lower;
                                    bbPos = r > 0 ? ((price - ind.bollinger.lower) / r * 100).toFixed(0) + '%' : '-';
                                }
                                const bbW = ind.bollinger ? ind.bollinger.bandwidth.toFixed(2) : '-';
                                const atrV = ind.atr != null ? ind.atr.toFixed(4) : '-';
                                const atrP = ind.atr != null ? ((ind.atr/price)*100).toFixed(3) + '%' : '-';
                                const stK = ind.stochRSI ? ind.stochRSI.k.toFixed(0) : '-';
                                const stD = ind.stochRSI ? ind.stochRSI.d.toFixed(0) : '-';
                                const stC = ind.stochRSI ? (ind.stochRSI.k > 80 ? 'negative' : ind.stochRSI.k < 20 ? 'positive' : '') : '';
                                const adxV = ind.adx ? ind.adx.adx.toFixed(1) : '-';
                                const adxC = ind.adx ? (ind.adx.adx > 25 ? 'positive' : 'neutral') : '';
                                const diV = ind.adx ? '+' + ind.adx.plusDI.toFixed(0) + '/-' + ind.adx.minusDI.toFixed(0) : '-';
                                const cciV = ind.cci != null ? ind.cci.toFixed(0) : '-';
                                const cciC = ind.cci != null ? (ind.cci > 100 ? 'negative' : ind.cci < -100 ? 'positive' : '') : '';
                                const wrV = ind.willR != null ? ind.willR.toFixed(0) : '-';
                                const wrC = ind.willR != null ? (ind.willR < -80 ? 'positive' : ind.willR > -20 ? 'negative' : '') : '';
                                const rocV = ind.roc != null ? ind.roc.toFixed(3) + '%' : '-';
                                const rocC = ind.roc != null ? (ind.roc > 0.15 ? 'positive' : ind.roc < -0.15 ? 'negative' : '') : '';
                                return '<tr>' +
                                    '<td>' + (tf==='1m' ? '<strong>'+symbol+'</strong>' : '') + '</td>' +
                                    '<td>' + tf + '</td>' +
                                    '<td class="' + rsiC + '">' + rsiV + '</td>' +
                                    '<td class="' + emaC + '">' + emaT + '</td>' +
                                    '<td style="font-size:0.78em;">' + ema50T + '</td>' +
                                    '<td class="' + macdC + '">' + macdH + '</td>' +
                                    '<td>' + bbPos + '</td>' +
                                    '<td>' + bbW + '</td>' +
                                    '<td style="font-size:0.78em;">' + atrV + '</td>' +
                                    '<td>' + atrP + '</td>' +
                                    '<td class="' + stC + '">' + stK + '/' + stD + '</td>' +
                                    '<td class="' + adxC + '">' + adxV + '</td>' +
                                    '<td style="font-size:0.78em;">' + diV + '</td>' +
                                    '<td class="' + cciC + '">' + cciV + '</td>' +
                                    '<td class="' + wrC + '">' + wrV + '</td>' +
                                    '<td class="' + rocC + '">' + rocV + '</td>' +
                                    '<td style="color:#484f58;">' + (ind.indicatorsAvailable||0) + '/' + (ind.indicatorsTotal||12) + '</td></tr>';
                            }).join('');
                        }).join('')}
                    </tbody>
                </table>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Support / Resistance & Candle Patterns</h2>
                <table>
                    <thead><tr><th>Market</th><th>Supports</th><th>Resistances</th><th>Candle Patterns (5m)</th></tr></thead>
                    <tbody>
                        ${ACTIVE_MARKETS.map(symbol => {
                            const ms = marketStates[symbol] || {};
                            const sr = ms.supportResistance;
                            const cp = ms.candlePatterns;
                            const supText = sr && sr.supports && sr.supports.length > 0
                                ? sr.supports.map(s => '$' + s.price.toFixed(2) + ' [' + s.strength + '] ' + Math.abs(s.distancePercent).toFixed(2) + '%').join('<br>')
                                : '<span style="color:#484f58;">Building...</span>';
                            const resText = sr && sr.resistances && sr.resistances.length > 0
                                ? sr.resistances.map(r => '$' + r.price.toFixed(2) + ' [' + r.strength + '] ' + r.distancePercent.toFixed(2) + '%').join('<br>')
                                : '<span style="color:#484f58;">Building...</span>';
                            const cpText = cp && cp.patterns && cp.patterns.length > 0
                                ? cp.patterns.slice(-3).map(p => '<span class="' + (p.signal.includes('BULLISH') ? 'positive' : p.signal.includes('BEARISH') ? 'negative' : 'neutral') + '">' + p.type + '</span>').join(', ')
                                : '<span style="color:#484f58;">' + (cp ? cp.summary : 'Building...') + '</span>';
                            return '<tr><td><strong>' + symbol + '</strong></td><td>' + supText + '</td><td>' + resText + '</td><td>' + cpText + '</td></tr>';
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Pattern Memory - Learning Stats by Market & Direction</h2>
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
                    ${Object.entries(pmStats.byMarket || {}).map(([mkt, d]) => {
                        const t = d.wins + d.losses;
                        const wr = t > 0 ? (d.wins / t * 100).toFixed(0) : 0;
                        return '<div style="background:#0d1117;padding:10px;border-radius:6px;">' +
                            '<div style="font-weight:bold;color:#58a6ff;margin-bottom:4px;">' + mkt + '</div>' +
                            '<div style="font-size:0.85em;">W: <span class="positive">' + d.wins + '</span> L: <span class="negative">' + d.losses + '</span> WR: <span class="' + (wr >= 50 ? 'positive' : 'negative') + '">' + wr + '%</span></div>' +
                            '</div>';
                    }).join('') || '<div style="color:#484f58;padding:10px;">No market data yet</div>'}
                    ${Object.entries(pmStats.byDirection || {}).map(([dir, d]) => {
                        const t = d.wins + d.losses;
                        const wr = t > 0 ? (d.wins / t * 100).toFixed(0) : 0;
                        return '<div style="background:#0d1117;padding:10px;border-radius:6px;">' +
                            '<div style="font-weight:bold;color:' + (dir === 'LONG' ? '#3fb950' : '#f85149') + ';margin-bottom:4px;">' + dir + '</div>' +
                            '<div style="font-size:0.85em;">W: <span class="positive">' + d.wins + '</span> L: <span class="negative">' + d.losses + '</span> WR: <span class="' + (wr >= 50 ? 'positive' : 'negative') + '">' + wr + '%</span></div>' +
                            '</div>';
                    }).join('')}
                </div>
                ${Object.keys(pmStats.byHour || {}).length > 0 ? '<div style="margin-top:10px;"><div style="color:#58a6ff;font-weight:600;margin-bottom:6px;">Win Rate by Hour (UTC)</div><div style="display:flex;flex-wrap:wrap;gap:4px;">' + 
                    Array.from({length: 24}, (_, h) => {
                        const hd = (pmStats.byHour || {})[h.toString()] || {wins:0,losses:0};
                        const ht = hd.wins + hd.losses;
                        const hwr = ht > 0 ? Math.round(hd.wins / ht * 100) : -1;
                        const bg = hwr < 0 ? '#21262d' : hwr >= 60 ? '#238636' : hwr >= 40 ? '#d29922' : '#da3633';
                        return '<div style="width:30px;height:30px;background:' + bg + ';border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.7em;" title="' + h + ':00 UTC - ' + (ht > 0 ? hwr + '% (' + ht + ' trades)' : 'no trades') + '">' + h + '</div>';
                    }).join('') + '</div></div>' : ''}
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Live Decisions & Pattern Matching</h2>
                <div style="max-height: 350px; overflow-y: auto;">
                    ${brainLog.slice(0, 60).map(t => {
                        const color = categoryColors[t.category] || '#888';
                        return '<div class="thinking-entry" style="border-left-color: ' + color + ';"><span class="thinking-time">' + new Date(t.time).toLocaleTimeString() + '</span><span style="color:' + color + ';font-weight:600;text-transform:uppercase;font-size:0.72em;">[' + t.category + ']</span> ' + t.message + '</div>';
                    }).join('') || '<div style="color: #484f58; padding: 20px; text-align: center;">Waiting for decisions...</div>'}
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Signal Performance Tracker (25 signals)</h2>
                <div style="overflow-x:auto;">
                <table>
                    <thead><tr><th style="min-width:130px;">Signal</th><th>Wins</th><th>Losses</th><th>Total</th><th>Win Rate</th><th style="min-width:150px;">Performance</th></tr></thead>
                    <tbody>
                        ${(() => {
                            const sigStats = tradeMemory.signalStats || {};
                            const defs = signalEngine.getSignalDefinitions();
                            return defs.map(def => {
                                const s = sigStats[def.id] || { wins: 0, losses: 0 };
                                const total = s.wins + s.losses;
                                const wr = total > 0 ? (s.wins / total * 100).toFixed(0) : '-';
                                const wrClass = total > 0 ? (s.wins / total >= 0.5 ? 'positive' : 'negative') : '';
                                const winPct = total > 0 ? (s.wins / total * 100) : 0;
                                return '<tr><td style="font-weight:600;">' + def.name + '</td>' +
                                    '<td class="positive">' + s.wins + '</td><td class="negative">' + s.losses + '</td><td>' + total + '</td>' +
                                    '<td class="' + wrClass + '" style="font-weight:bold;">' + (total > 0 ? wr + '%' : '-') + '</td>' +
                                    '<td><div style="display:flex;height:14px;border-radius:3px;overflow:hidden;background:#21262d;">' +
                                        (total > 0 ? '<div style="width:' + winPct + '%;background:#238636;"></div><div style="width:' + (100-winPct) + '%;background:#da3633;"></div>' : '') +
                                    '</div></td></tr>';
                            }).join('');
                        })()}
                    </tbody>
                </table>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Signal Combo Tracker — Which Combinations Win?</h2>
                <p style="color: #8b949e; font-size: 0.8em; margin-bottom: 10px;">Every trade uses multiple signals. This shows which combos actually worked.</p>
                <div style="overflow-x:auto;">
                <table>
                    <thead><tr><th>Combo (Signals Used Together)</th><th>Times</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th style="min-width:120px;">Performance</th></tr></thead>
                    <tbody>
                        ${(() => {
                            const comboMap = {};
                            const allT = tradeMemory.trades || [];
                            for (const t of allT) {
                                if (!t.triggerSignals || t.triggerSignals.length === 0) continue;
                                const key = t.triggerSignals.slice().sort().join(' + ');
                                if (!comboMap[key]) comboMap[key] = { wins: 0, losses: 0, signals: t.triggerSignals };
                                if (t.result === 'WIN') comboMap[key].wins++;
                                else comboMap[key].losses++;
                            }
                            const combos = Object.entries(comboMap).map(([k, v]) => ({
                                key: k, ...v, total: v.wins + v.losses
                            }));
                            combos.sort((a, b) => b.total - a.total);
                            if (combos.length === 0) return '<tr><td colspan="6" style="color:#484f58;text-align:center;padding:15px;">No combo data yet — trades will show combos after bot starts trading</td></tr>';
                            return combos.slice(0, 20).map(c => {
                                const wr = (c.wins / c.total * 100).toFixed(0);
                                const wrClass = c.wins / c.total >= 0.5 ? 'positive' : 'negative';
                                const winPct = c.wins / c.total * 100;
                                const sigLabels = c.signals.map(s => {
                                    const def = signalEngine.SIGNAL_DEFINITIONS.find(d => d.id === s);
                                    return def ? def.name : s;
                                });
                                return '<tr>' +
                                    '<td>' + sigLabels.map(n => '<span class="tag">' + n + '</span>').join(' ') + '</td>' +
                                    '<td>' + c.total + '</td>' +
                                    '<td class="positive">' + c.wins + '</td>' +
                                    '<td class="negative">' + c.losses + '</td>' +
                                    '<td class="' + wrClass + '" style="font-weight:bold;">' + wr + '%</td>' +
                                    '<td><div style="display:flex;height:14px;border-radius:3px;overflow:hidden;background:#21262d;">' +
                                        '<div style="width:' + winPct + '%;background:#238636;"></div><div style="width:' + (100-winPct) + '%;background:#da3633;"></div>' +
                                    '</div></td></tr>';
                            }).join('');
                        })()}
                    </tbody>
                </table>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Stored Pattern History (Last 10)</h2>
                <div style="overflow-x:auto;">
                <table>
                    <thead><tr><th>Time</th><th>Market</th><th>Dir</th><th>Result</th><th>P&L</th><th>Exit</th><th>Hold</th><th>Mode</th><th>RSI 1m</th><th>StochK</th><th>BB Pos</th><th>CCI</th><th>Will%R</th><th>ADX</th><th>Imb</th><th>Trend</th><th>Triggers</th></tr></thead>
                    <tbody>
                        ${recentPatterns.map(p => {
                            const fp = p.fingerprint || {};
                            return '<tr>' +
                                '<td style="font-size:0.75em;">' + new Date(p.timestamp).toLocaleTimeString() + '</td>' +
                                '<td>' + (p.symbol || '-') + '</td>' +
                                '<td class="' + (p.direction === 'LONG' ? 'positive' : 'negative') + '">' + (p.direction || '-') + '</td>' +
                                '<td class="' + (p.result === 'WIN' ? 'positive' : 'negative') + '" style="font-weight:bold;">' + (p.result || '-') + '</td>' +
                                '<td class="' + ((p.profitPercent||0) >= 0 ? 'positive' : 'negative') + '">' + ((p.profitPercent||0) >= 0 ? '+' : '') + (p.profitPercent||0).toFixed(2) + '%</td>' +
                                '<td>' + (p.exitReason || '-') + '</td>' +
                                '<td>' + (p.holdTimeMin||0).toFixed(0) + 'm</td>' +
                                '<td><span class="tag">' + (p.entryMode || '-') + '</span></td>' +
                                '<td class="fp-val">' + (fp.rsi_1m != null ? fp.rsi_1m.toFixed(1) : '-') + '</td>' +
                                '<td class="fp-val">' + (fp.stoch_k_1m != null ? fp.stoch_k_1m.toFixed(0) : '-') + '</td>' +
                                '<td class="fp-val">' + (fp.bb_position_1m != null ? (fp.bb_position_1m * 100).toFixed(0) + '%' : '-') + '</td>' +
                                '<td class="fp-val">' + (fp.cci_1m != null ? fp.cci_1m.toFixed(0) : '-') + '</td>' +
                                '<td class="fp-val">' + (fp.willr_1m != null ? fp.willr_1m.toFixed(0) : '-') + '</td>' +
                                '<td class="fp-val">' + (fp.adx_1m != null ? fp.adx_1m.toFixed(0) : '-') + '</td>' +
                                '<td class="fp-val">' + (fp.imbalance != null ? (fp.imbalance * 100).toFixed(0) + '%' : '-') + '</td>' +
                                '<td>' + (fp.trend === 1 ? '<span class="positive">UP</span>' : fp.trend === -1 ? '<span class="negative">DN</span>' : 'RNG') + '</td>' +
                                '<td>' + ((p.triggerSignals || []).slice(0, 4).map(s => '<span class="tag">' + s + '</span>').join(' ') || '-') + '</td>' +
                            '</tr>';
                        }).join('') || '<tr><td colspan="17" style="color: #484f58; text-align: center; padding: 15px;">No patterns stored yet — bot will learn as it trades...</td></tr>'}
                    </tbody>
                </table>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Complete Trade History (Last 50)</h2>
                <div style="overflow-x:auto;">
                <table>
                    <thead><tr><th>Time</th><th>Market</th><th>Dir</th><th>Entry $</th><th>Exit $</th><th>P&L %</th><th>Result</th><th>Exit Reason</th><th>Hold</th><th>Mode</th><th>Sim</th><th style="min-width:220px;">Trigger Signals</th></tr></thead>
                    <tbody>
                    ${recentTrades.map(t => {
                        const sigNames = (t.triggerSignals || []).map(sig => {
                            const def = signalEngine.SIGNAL_DEFINITIONS.find(d => d.id === sig);
                            return def ? def.name : sig;
                        });
                        const sigDisplay = sigNames.length > 0
                            ? sigNames.map(n => '<span class="tag">' + n + '</span>').join(' ')
                            : '<span style="color:#484f58;font-size:0.75em;">no data</span>';
                        return '<tr>' +
                            '<td style="font-size:0.75em;">' + new Date(t.timestamp).toLocaleTimeString() + '<br>' + new Date(t.timestamp).toLocaleDateString() + '</td>' +
                            '<td>' + (t.symbol || '-') + '</td>' +
                            '<td class="' + (t.direction === 'LONG' ? 'positive' : 'negative') + '">' + t.direction + '</td>' +
                            '<td>$' + (t.entryPrice || 0).toFixed(2) + '</td>' +
                            '<td>$' + (t.exitPrice || 0).toFixed(2) + '</td>' +
                            '<td class="' + (t.profitPercent >= 0 ? 'positive' : 'negative') + '" style="font-weight:bold;">' + (t.profitPercent >= 0 ? '+' : '') + t.profitPercent.toFixed(2) + '%</td>' +
                            '<td class="' + (t.result === 'WIN' ? 'positive' : 'negative') + '" style="font-weight:bold;">' + t.result + '</td>' +
                            '<td>' + t.exitReason + '</td>' +
                            '<td>' + (t.holdTimeMin || '?') + 'm</td>' +
                            '<td><span class="tag">' + (t.entryMode || t.aiReason || '-') + '</span></td>' +
                            '<td>' + (t.simulated ? 'SIM' : 'LIVE') + '</td>' +
                            '<td>' + sigDisplay + '</td></tr>';
                    }).join('') || '<tr><td colspan="12" style="color: #484f58; text-align: center; padding: 20px;">No trades yet — engine scanning markets...</td></tr>'}
                    </tbody>
                </table>
                </div>
            </div>
        </div>
    </div>
    <script>
        function botAction(action) {
            var s = document.getElementById('btnStatus');
            s.textContent = 'Processing...';
            s.style.color = '#d29922';
            fetch('/api/' + action, { method: 'POST' })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    s.textContent = d.message || 'Done';
                    s.style.color = '#3fb950';
                    setTimeout(function() { location.reload(); }, 1000);
                })
                .catch(function(e) {
                    s.textContent = 'Error: ' + e.message;
                    s.style.color = '#f85149';
                });
        }
    </script>
</body>
</html>`;
}

function startDashboard() {
    const server = http.createServer(async (req, res) => {
        const sendJson = (data, code = 200) => {
            res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify(data));
        };

        if (req.url === '/api/status') {
            sendJson({ status: botStatus, safety: safety.getStatus(), stats: tradeMemory.sessionStats });
        } else if (req.url === '/api/unpause' && req.method === 'POST') {
            safety.unpause();
            log('[DASHBOARD] Bot UNPAUSED by user');
            sendJson({ ok: true, message: 'Bot unpaused' });
        } else if (req.url === '/api/pause' && req.method === 'POST') {
            safety.pause('manual');
            log('[DASHBOARD] Bot PAUSED by user');
            sendJson({ ok: true, message: 'Bot paused' });
        } else if (req.url === '/api/close-all' && req.method === 'POST') {
            log('[DASHBOARD] CLOSE ALL POSITIONS requested by user');
            let closed = 0;
            for (const symbol of ACTIVE_MARKETS) {
                const ms = marketStates[symbol];
                const pos = CONFIG.SIMULATION_MODE ? ms.simulatedPosition : ms.currentPosition;
                if (pos) {
                    const mc = MARKETS[symbol];
                    await closePosition('manual_close', ms, mc, symbol);
                    closed++;
                }
            }
            sendJson({ ok: true, message: `Closed ${closed} position(s)` });
        } else if (req.url === '/api/reset-stats' && req.method === 'POST') {
            tradeMemory.sessionStats = {
                startTime: new Date().toISOString(),
                totalTrades: 0,
                wins: 0,
                losses: 0,
                totalProfitPercent: 0
            };
            tradeMemory.signalStats = {};
            saveMemory();
            log('[DASHBOARD] Session stats RESET by user');
            sendJson({ ok: true, message: 'Stats reset' });
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(generateDashboardHTML());
        }
    });

    server.listen(CONFIG.DASHBOARD_PORT, '0.0.0.0', () => {
        log(`Dashboard running on http://0.0.0.0:${CONFIG.DASHBOARD_PORT}`);
    });
}

async function main() {
    log('═══════════════════════════════════════════════════════════');
    log('   SELF-LEARNING BOT v17 - Pattern Memory Engine');
    log(`   Drift Protocol | ${CONFIG.LEVERAGE}x Leverage | Pattern Matching`);
    log('═══════════════════════════════════════════════════════════');
    log(`Mode: ${CONFIG.SIMULATION_MODE ? 'SIMULATION (Paper Trading)' : 'LIVE TRADING'}`);
    log(`Leverage: ${CONFIG.LEVERAGE}x`);
    log(`Active Markets: ${ACTIVE_MARKETS.join(', ')}`);
    log(`Trade Size: ${CONFIG.TRADE_AMOUNT_USDC} USDC per market`);
    log(`Signal Check Interval: ${CONFIG.AI_INTERVAL_MS / 1000}s`);
    log(`Position Check Interval: ${CONFIG.CHECK_INTERVAL_MS / 1000}s`);
    log(`Indicators: 12 per timeframe (RSI, EMA, MACD, BB, ATR, StochRSI, ADX, CCI, WilliamsR, ROC)`);
    log(`Pattern Memory: Stores every trade fingerprint in data/ (persistent)`);
    log(`Daily Loss Limit: ${safety.getStatus().dailyLossLimit}%`);
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

    if (!process.env.OPENROUTER_API_KEY) {
        log('WARNING: No OPENROUTER_API_KEY set - AI brain will not function');
    }

    loadMemory();
    loadPriceHistory();
    safety.loadConfig();
    patternMemory.load();
    startDashboard();

    const pmS = patternMemory.getStats();
    aiBrain.think(`Bot v17 starting — Pattern Memory Engine | ${pmS.totalStored} patterns stored | ${pmS.isLearning ? 'LEARNING PHASE' : 'EXPLOITATION PHASE'} | 12 indicators per TF`, 'ai_brain');

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

        log('Testing DLOB API...');
        for (const symbol of ACTIVE_MARKETS) {
            const testOrderBook = await fetchOrderBook(symbol);
            log(`[${symbol}] DLOB: ${testOrderBook ? 'Connected' : 'Failed'}`);
        }

        botStatus.running = true;
        if (!tradeMemory.sessionStats.startTime) {
            tradeMemory.sessionStats.startTime = new Date().toISOString();
        }

        log('Starting trading loop (mean reversion mode)...');
        async function dynamicLoop() {
            await tradingLoop();
            const hasPos = ACTIVE_MARKETS.some(s => {
                const ms = marketStates[s];
                return ms && (CONFIG.SIMULATION_MODE ? ms.simulatedPosition : ms.currentPosition);
            });
            const interval = hasPos ? 2000 : CONFIG.CHECK_INTERVAL_MS;
            setTimeout(dynamicLoop, interval);
        }
        dynamicLoop();

        setInterval(savePriceHistory, 300000);

        setInterval(() => {
            const timeSinceHeartbeat = Date.now() - lastHeartbeat;
            const maxIdleTime = CONFIG.CHECK_INTERVAL_MS * 5;
            if (timeSinceHeartbeat > maxIdleTime) {
                log(`WATCHDOG: No heartbeat for ${Math.round(timeSinceHeartbeat / 1000)}s`);
                (async () => {
                    try {
                        await driftClient.unsubscribe();
                        await driftClient.subscribe();
                        log('Reconnection successful');
                        lastHeartbeat = Date.now();
                    } catch (err) {
                        log(`Reconnection failed: ${err.message}`);
                        process.exit(1);
                    }
                })();
            }
        }, 60000);

        process.on('SIGINT', async () => {
            log('Shutting down...');
            botStatus.running = false;
            saveMemory();
            savePriceHistory();
            patternMemory.save();
            const openPositions = ACTIVE_MARKETS.filter(s => {
                const ms = marketStates[s];
                return ms && (CONFIG.SIMULATION_MODE ? ms.simulatedPosition : ms.currentPosition);
            });
            if (openPositions.length > 0) {
                log(`WARNING: Open positions on: ${openPositions.join(', ')}`);
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
