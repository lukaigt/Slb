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
const tpSlOptimizer = require('./tp_sl_optimizer');
const { KrakenFeed } = require('./kraken_feed');

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
    DATA_SOURCE: (process.env.DATA_SOURCE || 'kraken').toLowerCase() === 'drift' ? 'drift' : 'kraken',
    DLOB_URL: 'https://dlob.drift.trade',
    DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT) || 3000,
    MEMORY_FILE: path.join(__dirname, 'trade_memory.json'),
    PRICE_HISTORY_FILE: path.join(__dirname, 'price_history.json'),
    MIN_CONFIDENCE: parseFloat(process.env.MIN_CONFIDENCE) || 0.75,
};

const MARKETS = {
    'SOL-PERP': { symbol: 'SOL-PERP', marketIndex: 0, positionMultiplier: 1.0 },
    'BTC-PERP': { symbol: 'BTC-PERP', marketIndex: 1, positionMultiplier: 1.2 },
    'ETH-PERP': { symbol: 'ETH-PERP', marketIndex: 2, positionMultiplier: 1.0 },
    'DOGE-PERP': { symbol: 'DOGE-PERP', marketIndex: 100, positionMultiplier: 1.0 },
    'AVAX-PERP': { symbol: 'AVAX-PERP', marketIndex: 101, positionMultiplier: 1.0 },
    'LINK-PERP': { symbol: 'LINK-PERP', marketIndex: 102, positionMultiplier: 1.0 },
    'ADA-PERP': { symbol: 'ADA-PERP', marketIndex: 103, positionMultiplier: 1.0 },
    'DOT-PERP': { symbol: 'DOT-PERP', marketIndex: 104, positionMultiplier: 1.0 },
    'ATOM-PERP': { symbol: 'ATOM-PERP', marketIndex: 105, positionMultiplier: 1.0 },
    'NEAR-PERP': { symbol: 'NEAR-PERP', marketIndex: 106, positionMultiplier: 1.0 },
    'SUI-PERP': { symbol: 'SUI-PERP', marketIndex: 107, positionMultiplier: 1.0 },
    'LTC-PERP': { symbol: 'LTC-PERP', marketIndex: 108, positionMultiplier: 1.0 },
    'XMR-PERP': { symbol: 'XMR-PERP', marketIndex: 109, positionMultiplier: 1.0 },
    'ALGO-PERP': { symbol: 'ALGO-PERP', marketIndex: 110, positionMultiplier: 1.0 },
    'HBAR-PERP': { symbol: 'HBAR-PERP', marketIndex: 111, positionMultiplier: 1.0 },
    'TRX-PERP': { symbol: 'TRX-PERP', marketIndex: 112, positionMultiplier: 1.0 },
    'RENDER-PERP': { symbol: 'RENDER-PERP', marketIndex: 113, positionMultiplier: 1.0 },
    'APT-PERP': { symbol: 'APT-PERP', marketIndex: 114, positionMultiplier: 1.0 },
    'UNI-PERP': { symbol: 'UNI-PERP', marketIndex: 115, positionMultiplier: 1.0 },
    'ARB-PERP': { symbol: 'ARB-PERP', marketIndex: 116, positionMultiplier: 1.0 },
    'OP-PERP': { symbol: 'OP-PERP', marketIndex: 117, positionMultiplier: 1.0 },
    'FIL-PERP': { symbol: 'FIL-PERP', marketIndex: 118, positionMultiplier: 1.0 },
    'POL-PERP': { symbol: 'POL-PERP', marketIndex: 119, positionMultiplier: 1.0 }
};

const ALL_MARKETS_DEFAULT = 'SOL-PERP,BTC-PERP,ETH-PERP,DOGE-PERP,AVAX-PERP,LINK-PERP,ADA-PERP,DOT-PERP,ATOM-PERP,NEAR-PERP,SUI-PERP,LTC-PERP,XMR-PERP,ALGO-PERP,HBAR-PERP,TRX-PERP,RENDER-PERP,APT-PERP,UNI-PERP,ARB-PERP,OP-PERP,FIL-PERP,POL-PERP';
const ACTIVE_MARKETS = (process.env.ACTIVE_MARKETS || ALL_MARKETS_DEFAULT).split(',').map(s => s.trim());

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
        lastSignalResult: null,
        tpSlMode: null,
        tpSlBase: null
    };
}

const marketStates = {};
for (const symbol of ACTIVE_MARKETS) {
    marketStates[symbol] = createEmptyMarketState();
}

let driftClient = null;
let krakenFeed = null;
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
    if (CONFIG.DATA_SOURCE === 'kraken' && krakenFeed) {
        const book = krakenFeed.getOrderBook(symbol);
        if (book && book.bids.length > 0 && book.asks.length > 0) return book;
        const restBook = await krakenFeed.fetchOrderBookREST(symbol);
        return restBook;
    }
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
    if (CONFIG.DATA_SOURCE === 'kraken' && krakenFeed) {
        const price = krakenFeed.getPrice(symbol);
        if (price && price > 0 && !krakenFeed.isPriceStale(symbol)) return price;
    }
    try {
        const orderBook = await fetchOrderBook(symbol);
        if (!orderBook || !orderBook.bids || !orderBook.asks) return null;
        if (orderBook.bids.length === 0 || orderBook.asks.length === 0) return null;
        const bestBid = Array.isArray(orderBook.bids[0]) ? parseFloat(orderBook.bids[0][0]) : parseFloat(orderBook.bids[0].price);
        const bestAsk = Array.isArray(orderBook.asks[0]) ? parseFloat(orderBook.asks[0][0]) : parseFloat(orderBook.asks[0].price);
        if (CONFIG.DATA_SOURCE === 'drift') return (bestBid + bestAsk) / 2 / 1e6;
        return (bestBid + bestAsk) / 2;
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

function isSimulated(marketConfig) {
    return CONFIG.SIMULATION_MODE || (marketConfig && marketConfig.marketIndex >= 100);
}

function getPosition(marketState, marketConfig) {
    return isSimulated(marketConfig) ? marketState.simulatedPosition : marketState.currentPosition;
}

async function openPosition(direction, marketState, marketConfig, symbol) {
    const currentPrice = marketState.lastPrice;

    if (isSimulated(marketConfig)) {
        const label = marketConfig.marketIndex >= 100 ? 'SIM/Kraken' : 'SIM';
        log(`[${symbol}] [${label}] Opening ${direction} at $${currentPrice.toFixed(4)}`);
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
    const pos = getPosition(marketState, marketConfig);
    if (!pos) return true;

    if (!marketState.entryPrice || marketState.entryPrice <= 0 || !currentPrice || currentPrice <= 0) {
        log(`[${symbol}] ERROR: Invalid prices. Entry: ${marketState.entryPrice}, Current: ${currentPrice}`);
        resetPositionState(marketState, marketConfig);
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

    if (isSimulated(marketConfig)) {
        log(`[${symbol}] [SIM] Closing ${pos}: ${result} ${profitPercent.toFixed(2)}%`);
        marketState.simulatedPosition = null;
    } else {
        try {
            const user = driftClient.getUser();
            const perpPosition = user.getPerpPosition(marketConfig.marketIndex);
            if (!perpPosition || perpPosition.baseAssetAmount.eq(new BN(0))) {
                resetPositionState(marketState, marketConfig);
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
        tpSlMode: marketState.tpSlMode || null,
        aiReason: marketState.aiReason,
        triggerSignals: marketState.triggerSignals || [],
        simulated: isSimulated(marketConfig),
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
        triggerSignals: marketState.triggerSignals || [],
        tpUsed: marketState.aiTakeProfit || null,
        slUsed: marketState.aiStopLoss || null,
        tpSlMode: marketState.tpSlMode || null,
        tpSlBase: marketState.tpSlBase || null
    });

    if (marketState.tpSlBase) {
        tpSlOptimizer.recordResult(marketState.tpSlBase.tp, marketState.tpSlBase.sl, result, profitPercent, symbol);
    } else if (marketState.aiTakeProfit != null && marketState.aiStopLoss != null) {
        tpSlOptimizer.recordResult(marketState.aiTakeProfit, marketState.aiStopLoss, result, profitPercent, symbol);
    }

    aiBrain.recordTradeResult(symbol, pos, result, profitPercent, exitReason);
    safety.recordTradeResult(profitPercent, result === 'WIN');

    resetPositionState(marketState, marketConfig);

    if (result === 'WIN') {
        marketState.lastAiCall = 0;
    }

    return true;
}

function resetPositionState(marketState, marketConfig) {
    if (isSimulated(marketConfig)) {
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
    marketState.tpSlMode = null;
    marketState.tpSlBase = null;
}

async function syncPositionFromChain(marketState, marketConfig, symbol) {
    if (isSimulated(marketConfig)) return;
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
            resetPositionState(marketState, marketConfig);
        }
    } catch (error) {
        log(`[${symbol}] Error syncing position: ${error.message}`);
    }
}

function checkStopLoss(currentPrice, marketState, marketConfig, symbol) {
    const pos = getPosition(marketState, marketConfig);
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

function checkTakeProfit(currentPrice, marketState, marketConfig, symbol) {
    const pos = getPosition(marketState, marketConfig);
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

function checkMaxHoldTime(marketState, marketConfig, symbol) {
    const pos = getPosition(marketState, marketConfig);
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

        if (CONFIG.DATA_SOURCE === 'drift' && driftClient) {
            try { await syncPositionFromChain(marketState, marketConfig, symbol); } catch (e) {}
        }

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

        const pos = getPosition(marketState, marketConfig);
        const modeStr = isSimulated(marketConfig) ? 'SIM' : 'LIVE';
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
            if (marketState.aiStopLoss == null || marketState.aiTakeProfit == null) {
                const emergInd = marketState.indicators1m || {};
                const emergATR = (emergInd.atr != null && price > 0) ? (emergInd.atr / price) * 100 : null;
                const emergRec = tpSlOptimizer.getRecommendedTPSL(emergATR, symbol);
                if (marketState.aiStopLoss == null) {
                    marketState.aiStopLoss = emergRec.sl;
                    aiBrain.think(`[${symbol}] Emergency SL assigned: ${emergRec.sl.toFixed(2)}% [${emergRec.mode}]`, 'safety');
                }
                if (marketState.aiTakeProfit == null) {
                    marketState.aiTakeProfit = emergRec.tp;
                    aiBrain.think(`[${symbol}] Emergency TP assigned: ${emergRec.tp.toFixed(2)}% [${emergRec.mode}]`, 'safety');
                }
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

            // 1. Emergency Circuit Breaker (-10% P&L)
            if (pnl <= -10) {
                aiBrain.think(`[${symbol}] EMERGENCY CIRCUIT BREAKER: P&L at ${pnl.toFixed(1)}% exceeded -10% limit. Force closing.`, 'safety');
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
            if (checkStopLoss(price, marketState, marketConfig, symbol)) {
                marketState.lastStopLossTime = Date.now();
                await closePosition('stop_loss', marketState, marketConfig, symbol);
                return;
            }
            if (checkTakeProfit(price, marketState, marketConfig, symbol)) {
                await closePosition('take_profit', marketState, marketConfig, symbol);
                return;
            }
            if (checkMaxHoldTime(marketState, marketConfig, symbol)) {
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

            const ind1mForTPSL = marketState.indicators1m || {};
            const atrPct = (ind1mForTPSL.atr != null && marketState.lastPrice > 0) ? (ind1mForTPSL.atr / marketState.lastPrice) * 100 : null;
            const tpSlRec = tpSlOptimizer.getRecommendedTPSL(atrPct, symbol);
            marketState.aiStopLoss = tpSlRec.sl;
            marketState.aiTakeProfit = tpSlRec.tp;
            marketState.tpSlMode = tpSlRec.mode;
            marketState.tpSlBase = { tp: tpSlRec.baseTP, sl: tpSlRec.baseSL };
            marketState.aiMaxHoldMinutes = 30;
            marketState.aiReason = signal.reason;
            marketState.triggerSignals = Object.entries(signal.signals)
                .filter(([, dir]) => dir === signal.direction)
                .map(([sig]) => sig);
            marketState.entryFingerprint = signal.fingerprint;
            marketState.entryMode = signal.entryMode;

            aiBrain.think(`[${symbol}] ENTRY ${signal.action} [${signal.entryMode}] | Score: ${Math.max(signal.longScore, signal.shortScore)}/${signal.totalSignals} | SL: ${tpSlRec.sl.toFixed(2)}% | TP: ${tpSlRec.tp.toFixed(2)}% [${tpSlRec.mode}] | ${signal.reason}`, 'entry');
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
        if (!CONFIG.SIMULATION_MODE) {
            const dailyStats = safety.getStats();
            if (dailyStats && dailyStats.dailyProfitPercent <= -10) {
                if (!safety.isPaused()) {
                    log('CRITICAL: Daily loss limit (-10%) reached. Hard stopping bot.');
                    safety.pause('daily_loss_limit');
                }
                return;
            }
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

function generateDashboardData() {
    const stats = tradeMemory.sessionStats;
    const recentTrades = tradeMemory.trades.slice(-50).reverse();
    const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100).toFixed(1) : '0.0';
    const uptime = formatUptime(Date.now() - botStartTime);
    const heartbeatAgo = Math.round((Date.now() - lastHeartbeat) / 1000);
    const safetyStatus = safety.getStatus();
    const brainLog = aiBrain.getThinkingLog();
    const pmStats = patternMemory.getStats();
    const recentPatterns = patternMemory.getRecentPatterns(10);
    const tpSlStats = tpSlOptimizer.getOptimizerStats();
    const topCombos = tpSlOptimizer.getTopCombos(15);

    const anyRpcConnected = ACTIVE_MARKETS.some(s => botStatus.markets[s]?.rpcConnected);
    const anyDlobConnected = ACTIVE_MARKETS.some(s => botStatus.markets[s]?.dlobConnected);

    const allTrades = tradeMemory.trades.filter(t => Math.abs(t.profitPercent || 0) <= 100);
    const bestTrade = allTrades.length > 0 ? allTrades.reduce((best, t) => (!best || (t.profitPercent || 0) > (best.profitPercent || 0)) ? t : best, null) : null;
    const worstTrade = allTrades.length > 0 ? allTrades.reduce((worst, t) => (!worst || (t.profitPercent || 0) < (worst.profitPercent || 0)) ? t : worst, null) : null;

    const marketsData = {};
    for (const symbol of ACTIVE_MARKETS) {
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
        const lastSig = ms.lastSignalResult;
        marketsData[symbol] = {
            price: m.price || 0,
            trend: m.trend || 'BUILDING',
            score: m.directionalScore || 0,
            phase: m.momentumPhase || 'N/A',
            imbalance: m.imbalance || 0,
            volatility: m.volatility || 0,
            dataPoints: ms.prices ? ms.prices.length : 0,
            position: pos || null,
            entryPrice: ms.entryPrice || 0,
            pnl: pnlVal,
            sl: ms.aiStopLoss,
            tp: ms.aiTakeProfit,
            tpSlMode: ms.tpSlMode || null,
            holdMin,
            entryMode: ms.entryMode || null,
            lastSignal: lastSig ? {
                action: lastSig.action,
                longScore: lastSig.longScore,
                shortScore: lastSig.shortScore
            } : null,
            indicators: {}
        };
        for (const tf of ['1m', '5m', '15m']) {
            const ind = tf === '1m' ? ms.indicators1m : tf === '5m' ? ms.indicators5m : ms.indicators15m;
            if (!ind || !ind.ready) {
                marketsData[symbol].indicators[tf] = null;
                continue;
            }
            const price = ms.lastPrice || 1;
            let bbPos = null;
            if (ind.bollinger) {
                const r = ind.bollinger.upper - ind.bollinger.lower;
                bbPos = r > 0 ? ((price - ind.bollinger.lower) / r * 100) : null;
            }
            marketsData[symbol].indicators[tf] = {
                rsi: ind.rsi,
                ema9: ind.ema9, ema21: ind.ema21, ema50: ind.ema50,
                macdHist: ind.macd ? ind.macd.histogram : null,
                bbPos, bbWidth: ind.bollinger ? ind.bollinger.bandwidth : null,
                atr: ind.atr, atrPct: ind.atr != null ? (ind.atr / price) * 100 : null,
                stochK: ind.stochRSI ? ind.stochRSI.k : null,
                stochD: ind.stochRSI ? ind.stochRSI.d : null,
                adx: ind.adx ? ind.adx.adx : null,
                plusDI: ind.adx ? ind.adx.plusDI : null,
                minusDI: ind.adx ? ind.adx.minusDI : null,
                cci: ind.cci, willR: ind.willR, roc: ind.roc,
                available: ind.indicatorsAvailable || 0,
                total: ind.indicatorsTotal || 12
            };
        }
        const sr = ms.supportResistance;
        marketsData[symbol].supports = sr && sr.supports ? sr.supports : [];
        marketsData[symbol].resistances = sr && sr.resistances ? sr.resistances : [];
        marketsData[symbol].candlePatterns = ms.candlePatterns;
    }

    const comboMap = {};
    const allTradesForCombos = tradeMemory.trades || [];
    for (const t of allTradesForCombos) {
        if (!t.triggerSignals || t.triggerSignals.length === 0) continue;
        const key = t.triggerSignals.slice().sort().join(' + ');
        if (!comboMap[key]) comboMap[key] = { wins: 0, losses: 0, signals: t.triggerSignals };
        if (t.result === 'WIN') comboMap[key].wins++;
        else comboMap[key].losses++;
    }
    const combos = Object.entries(comboMap).map(([k, v]) => ({ key: k, ...v, total: v.wins + v.losses }));
    combos.sort((a, b) => b.total - a.total);

    return {
        version: 'v18.2',
        simulation: CONFIG.SIMULATION_MODE,
        leverage: CONFIG.LEVERAGE,
        uptime,
        heartbeatAgo,
        running: botStatus.running,
        dataSource: CONFIG.DATA_SOURCE,
        driftConnected: botStatus.driftConnected,
        krakenConnected: krakenFeed ? krakenFeed.isConnected() : false,
        rpcConnected: anyRpcConnected,
        dlobConnected: anyDlobConnected,
        paused: safetyStatus.paused,
        pauseReason: safetyStatus.pauseReason,
        stats: {
            totalTrades: stats.totalTrades,
            wins: stats.wins,
            losses: stats.losses,
            winRate,
            totalProfit: stats.totalProfitPercent,
            bestTrade: bestTrade ? { profit: bestTrade.profitPercent, dir: bestTrade.direction, symbol: bestTrade.symbol } : null,
            worstTrade: worstTrade ? { profit: worstTrade.profitPercent, dir: worstTrade.direction, symbol: worstTrade.symbol } : null
        },
        safety: {
            dailyProfit: safetyStatus.dailyPnl || 0,
            dailyLimit: safetyStatus.dailyLossLimit || -10,
            consecutiveLosses: safetyStatus.consecutiveLosses || 0,
            maxConsecutive: safetyStatus.maxConsecutiveLosses || 4,
            tradesToday: safetyStatus.dailyTrades || 0
        },
        pmStats,
        tpSlStats,
        topCombos,
        markets: marketsData,
        activeMarkets: ACTIVE_MARKETS,
        signalStats: tradeMemory.signalStats || {},
        signalDefs: signalEngine.getSignalDefinitions(),
        signalCombos: combos.slice(0, 20),
        recentPatterns,
        recentTrades: recentTrades.map(t => ({
            timestamp: t.timestamp,
            symbol: t.symbol,
            direction: t.direction,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            profitPercent: t.profitPercent,
            result: t.result,
            exitReason: t.exitReason,
            holdTimeMin: t.holdTimeMin,
            entryMode: t.entryMode || t.aiReason || '-',
            tpSlMode: t.tpSlMode || null,
            sl: t.aiStopLoss,
            tp: t.aiTakeProfit,
            simulated: t.simulated,
            triggerSignals: t.triggerSignals || []
        })),
        brainLog: brainLog.slice(0, 60).map(t => ({ time: t.time, category: t.category, message: t.message }))
    };
}

function generateDashboardHTML() {
    const d = generateDashboardData();

    const categoryColors = {
        entry: '#00ff88', exit: '#ff4444', monitor: '#00d4ff', ai_brain: '#ff00ff',
        scan: '#555', skip: '#888', safety: '#ff6600', trade_win: '#3fb950',
        trade_loss: '#f85149', error: '#ff0000', general: '#888'
    };

    function esc(s) { return s == null ? '-' : String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function tag(s) { return '<span class="tag">' + esc(s) + '</span>'; }
    function usd(v) { return v != null ? '$' + v.toFixed(2) : '-'; }

    let html = `<!DOCTYPE html>
<html>
<head>
    <title>v18.2 Self-Learning Bot - Boosted Learning</title>
    <meta charset="UTF-8">
    
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
    <h1>Self-Learning Bot <span style="color: #8957e5; font-size: 0.5em; vertical-align: middle;">v18.2 Boosted Learning</span></h1>
    <div class="subtitle">${d.dataSource === 'kraken' ? 'Kraken Feed' : 'Drift Protocol'} | ${d.leverage}x | ${d.tpSlStats.bestCombo ? 'Best TP/SL: ' + d.tpSlStats.bestCombo.tp.toFixed(2) + '/' + d.tpSlStats.bestCombo.sl.toFixed(2) + '%' : 'TP/SL: Learning...'} | Fee: 0.07% | ${d.pmStats.isLearning ? 'LEARNING PHASE' : 'EXPLOITATION PHASE'} | ${d.pmStats.totalStored} patterns | ${d.tpSlStats.isExploiting ? 'TP/SL OPTIMIZING' : 'TP/SL LEARNING (' + d.tpSlStats.learningProgress + '%)'}</div>

    <div class="grid">`;

    // System Health
    const dot = (ok) => '<span class="health-dot ' + (ok ? 'health-green' : 'health-red') + '"></span>';
    html += '<div class="card"><h2>System Health</h2>';
    html += '<div class="stat-row"><span class="stat-label">Status</span><span class="stat-value">' + (d.running ? dot(true) + 'Running' : dot(false) + 'Stopped') + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Mode</span><span class="stat-value">' + (d.simulation ? '<span class="sim-mode">SIMULATION</span>' : '<span class="live-mode">LIVE</span>') + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Data Feed</span><span class="stat-value">' + (d.dataSource === 'kraken' ? '<span style="color:#7B68EE;font-weight:bold;">KRAKEN</span>' : '<span style="color:#58a6ff;font-weight:bold;">DRIFT</span>') + '</span></div>';
    if (d.dataSource === 'kraken') {
        html += '<div class="stat-row"><span class="stat-label">Kraken WS</span><span class="stat-value">' + dot(d.krakenConnected) + (d.krakenConnected ? 'Live' : 'Connecting...') + '</span></div>';
    }
    html += '<div class="stat-row"><span class="stat-label">Drift</span><span class="stat-value">' + dot(d.driftConnected) + (d.driftConnected ? 'Connected' : 'Offline') + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">' + d.uptime + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Heartbeat</span><span class="stat-value">' + d.heartbeatAgo + 's ago</span></div>';
    html += '</div>';

    // Learning Engine
    html += '<div class="card"><h2>Learning Engine</h2>';
    html += '<div class="stat-row"><span class="stat-label">Phase</span><span class="stat-value">' + (d.pmStats.isLearning ? '<span class="learning-badge">LEARNING</span>' : '<span class="exploit-badge">EXPLOITATION</span>') + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Patterns Stored</span><span class="stat-value" style="color:#58a6ff;">' + d.pmStats.totalStored + '</span></div>';
    const prog = d.pmStats.learningProgress;
    html += '<div style="margin:6px 0;"><div class="progress-bar"><div class="progress-fill" style="width:' + prog + '%;background:' + (prog >= 100 ? '#238636' : '#8957e5') + ';"></div><div class="progress-text">' + prog + '% — ' + d.pmStats.totalStored + '/30</div></div></div>';
    const pmWR = d.pmStats.patternMatchWinRate;
    const exWR = d.pmStats.explorationWinRate;
    html += '<div class="stat-row"><span class="stat-label">Pattern Match WR</span><span class="stat-value ' + (pmWR >= 50 ? 'positive' : pmWR > 0 ? 'negative' : '') + '">' + (pmWR > 0 ? pmWR.toFixed(0) + '%' : '-') + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Exploration WR</span><span class="stat-value ' + (exWR >= 50 ? 'positive' : exWR > 0 ? 'negative' : '') + '">' + (exWR > 0 ? exWR.toFixed(0) + '%' : '-') + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">WR Threshold</span><span class="stat-value">55%</span></div>';
    html += '</div>';

    // TP/SL Optimizer
    html += '<div class="card"><h2>TP/SL Optimizer</h2>';
    html += '<div class="stat-row"><span class="stat-label">Phase</span><span class="stat-value">' + (d.tpSlStats.isExploiting ? '<span class="exploit-badge">OPTIMIZING</span>' : '<span class="learning-badge">LEARNING</span>') + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Combos Tested</span><span class="stat-value" style="color:#58a6ff;">' + d.tpSlStats.totalCombos + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Mature Combos (' + (d.tpSlStats.minComboTrades||30) + '+ trades)</span><span class="stat-value">' + d.tpSlStats.combosWithData + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Total TP/SL Trades</span><span class="stat-value">' + d.tpSlStats.totalTrades + '</span></div>';
    const tpProg = d.tpSlStats.learningProgress;
    html += '<div style="margin:6px 0;"><div class="progress-bar"><div class="progress-fill" style="width:' + tpProg + '%;background:' + (tpProg >= 100 ? '#238636' : '#d29922') + ';"></div><div class="progress-text">TP/SL ' + tpProg + '% — ' + d.tpSlStats.totalTrades + '/30</div></div></div>';
    if (d.tpSlStats.bestCombo) {
        const bc = d.tpSlStats.bestCombo;
        html += '<div class="stat-row"><span class="stat-label">Best Combo</span><span class="stat-value positive">TP ' + bc.tp.toFixed(2) + '% / SL ' + bc.sl.toFixed(2) + '%</span></div>';
        html += '<div class="stat-row"><span class="stat-label">Best WR / Avg P&L</span><span class="stat-value">' + bc.winRate + '% / ' + (bc.avgProfit >= 0 ? '+' : '') + bc.avgProfit.toFixed(2) + '%</span></div>';
    } else {
        html += '<div class="stat-row"><span class="stat-label">Best Combo</span><span class="stat-value" style="color:#484f58;">Collecting data...</span></div>';
    }
    html += '<div class="stat-row"><span class="stat-label">Explore Rate</span><span class="stat-value">' + d.tpSlStats.explorationRate + '%</span></div>';
    html += '</div>';

    // Controls
    html += '<div class="card"><h2>Controls</h2>';
    if (d.paused) {
        html += '<div style="margin-bottom:8px;"><span class="paused-badge">PAUSED</span> <span style="color:#8b949e;font-size:0.8em;">' + esc(d.pauseReason) + '</span></div>';
        html += '<button class="btn btn-green" onclick="botAction(&#39;unpause&#39;)">Resume Bot</button>';
    } else {
        html += '<button class="btn btn-orange" onclick="botAction(&#39;pause&#39;)">Pause Bot</button>';
    }
    html += '<button class="btn btn-red" onclick="if(confirm(&#39;Close all positions?&#39;))botAction(&#39;close-all&#39;)">Close All Positions</button>';
    html += '<button class="btn btn-gray" onclick="if(confirm(&#39;Reset session stats?&#39;))botAction(&#39;reset-stats&#39;)">Reset Stats</button>';
    html += '<button class="btn btn-gray" onclick="location.reload()" style="margin-top:4px;background:#1f6feb;">Refresh Dashboard</button>';
    html += '<div class="btn-status" id="btnStatus"></div>';
    html += '</div>';

    // Session Stats
    html += '<div class="card"><h2>Session Stats</h2>';
    html += '<div class="stat-row"><span class="stat-label">Trades</span><span class="stat-value">' + d.stats.totalTrades + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Win / Loss</span><span class="stat-value"><span class="positive">' + d.stats.wins + 'W</span> / <span class="negative">' + d.stats.losses + 'L</span></span></div>';
    html += '<div class="stat-row"><span class="stat-label">Win Rate</span><span class="stat-value ' + (parseFloat(d.stats.winRate) >= 50 ? 'positive' : parseFloat(d.stats.winRate) > 0 ? 'negative' : '') + '">' + d.stats.winRate + '%</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Total P&L</span><span class="stat-value ' + (d.stats.totalProfit >= 0 ? 'positive' : 'negative') + '">' + (d.stats.totalProfit >= 0 ? '+' : '') + d.stats.totalProfit.toFixed(2) + '%</span></div>';
    html += '<div style="display:flex;gap:8px;margin-top:8px;">';
    if (d.stats.bestTrade) html += '<div style="flex:1;padding:8px;border-radius:6px;background:#0d1117;"><div style="color:#3fb950;font-weight:bold;font-size:0.8em;">Best</div><div style="font-size:1.1em;color:#3fb950;">+' + d.stats.bestTrade.profit.toFixed(2) + '%</div><div style="font-size:0.75em;color:#8b949e;">' + d.stats.bestTrade.dir + ' ' + (d.stats.bestTrade.symbol||'') + '</div></div>';
    else html += '<div style="flex:1;padding:8px;border-radius:6px;background:#0d1117;"><div style="color:#3fb950;font-weight:bold;font-size:0.8em;">Best</div><div style="color:#484f58;font-size:0.8em;">None</div></div>';
    if (d.stats.worstTrade) html += '<div style="flex:1;padding:8px;border-radius:6px;background:#0d1117;"><div style="color:#f85149;font-weight:bold;font-size:0.8em;">Worst</div><div style="font-size:1.1em;color:#f85149;">' + d.stats.worstTrade.profit.toFixed(2) + '%</div><div style="font-size:0.75em;color:#8b949e;">' + d.stats.worstTrade.dir + ' ' + (d.stats.worstTrade.symbol||'') + '</div></div>';
    else html += '<div style="flex:1;padding:8px;border-radius:6px;background:#0d1117;"><div style="color:#f85149;font-weight:bold;font-size:0.8em;">Worst</div><div style="color:#484f58;font-size:0.8em;">None</div></div>';
    html += '</div></div>';

    // Safety
    html += '<div class="card"><h2>Safety Layer</h2>';
    html += '<div class="stat-row"><span class="stat-label">Daily P&L</span><span class="stat-value ' + (d.safety.dailyProfit >= 0 ? 'positive' : 'negative') + '">' + (d.safety.dailyProfit >= 0 ? '+' : '') + d.safety.dailyProfit.toFixed(2) + '%</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Daily Limit</span><span class="stat-value">' + d.safety.dailyLimit + '%</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Consec Losses</span><span class="stat-value ' + (d.safety.consecutiveLosses >= 3 ? 'negative' : '') + '">' + d.safety.consecutiveLosses + ' / ' + d.safety.maxConsecutive + '</span></div>';
    html += '<div class="stat-row"><span class="stat-label">Trades Today</span><span class="stat-value">' + d.safety.tradesToday + '</span></div>';
    html += '</div>';

    html += '</div>'; // end grid row 1

    // Markets Overview
    html += '<div class="grid"><div class="card full-width"><h2>Markets Overview</h2><div style="overflow-x:auto;"><table>';
    html += '<thead><tr><th>Market</th><th>Price</th><th>Trend</th><th>Score</th><th>Phase</th><th>Imbalance</th><th>Volatility</th><th>Data Pts</th><th>Position</th><th>Entry $</th><th>P&L</th><th>SL/TP</th><th>TP/SL Mode</th><th>Hold</th><th>Entry Mode</th><th>Last Signal</th></tr></thead><tbody>';
    for (const sym of d.activeMarkets) {
        const m = d.markets[sym] || {};
        const scoreC = m.score > 8 ? 'positive' : m.score < -8 ? 'negative' : 'neutral';
        const trendC = (m.trend||'').indexOf('UP') >= 0 ? 'positive' : (m.trend||'').indexOf('DOWN') >= 0 ? 'negative' : 'neutral';
        const posC = m.position === 'LONG' ? 'positive' : m.position === 'SHORT' ? 'negative' : '';
        const pnlC = m.pnl >= 0 ? 'positive' : 'negative';
        const lastSigText = m.lastSignal ? (m.lastSignal.action !== 'WAIT' ? m.lastSignal.action : 'WAIT') + ' L:' + m.lastSignal.longScore + ' S:' + m.lastSignal.shortScore : '-';
        const lastSigC = m.lastSignal && m.lastSignal.action !== 'WAIT' ? 'positive' : '';
        html += '<tr><td><strong>' + sym + '</strong></td>';
        html += '<td>' + usd(m.price) + '</td>';
        html += '<td class="' + trendC + '">' + m.trend + '</td>';
        html += '<td class="' + scoreC + '"><strong>' + m.score + '</strong></td>';
        html += '<td>' + m.phase + '</td>';
        html += '<td class="' + (m.imbalance > 0 ? 'positive' : 'negative') + '">' + (m.imbalance * 100).toFixed(1) + '%</td>';
        html += '<td>' + (m.volatility).toFixed(3) + '%</td>';
        html += '<td style="color:#8b949e;">' + m.dataPoints + '</td>';
        html += '<td class="' + posC + '" style="font-weight:bold;">' + (m.position || 'NONE') + '</td>';
        html += '<td>' + (m.position ? usd(m.entryPrice) : '-') + '</td>';
        html += '<td class="' + pnlC + '" style="font-weight:bold;">' + (m.position ? m.pnl.toFixed(2) + '%' : '-') + '</td>';
        html += '<td>' + (m.position && m.sl != null ? m.sl.toFixed(2) + ' / ' + (m.tp != null ? m.tp.toFixed(2) : '?') : '-') + '</td>';
        html += '<td>' + (m.position && m.tpSlMode ? tag(m.tpSlMode) : '-') + '</td>';
        html += '<td>' + m.holdMin + '</td>';
        html += '<td>' + (m.position && m.entryMode ? tag(m.entryMode) : '-') + '</td>';
        html += '<td class="' + lastSigC + '" style="font-size:0.78em;">' + lastSigText + '</td></tr>';
    }
    html += '</tbody></table></div></div></div>';

    // Indicators
    html += '<div class="grid"><div class="card full-width"><h2>All Technical Indicators (12 per timeframe)</h2><div style="overflow-x:auto;"><table>';
    html += '<thead><tr><th>Market</th><th>TF</th><th>RSI</th><th>EMA 9/21</th><th>EMA50</th><th>MACD Hist</th><th>BB Pos</th><th>BB Width</th><th>ATR</th><th>ATR%</th><th>StochRSI K/D</th><th>ADX</th><th>+DI/-DI</th><th>CCI</th><th>Will%R</th><th>ROC</th><th>Ready</th></tr></thead><tbody>';
    for (const sym of d.activeMarkets) {
        const m = d.markets[sym];
        for (const tf of ['1m','5m','15m']) {
            const ind = m.indicators[tf];
            if (!ind) {
                html += '<tr><td>' + (tf === '1m' ? '<strong>'+sym+'</strong>' : '') + '</td><td>' + tf + '</td><td colspan="15" style="color:#484f58;">Building data...</td></tr>';
                continue;
            }
            const rsiC = ind.rsi != null ? (ind.rsi > 70 ? 'negative' : ind.rsi < 30 ? 'positive' : '') : '';
            const emaT = ind.ema9 != null && ind.ema21 != null ? (ind.ema9 > ind.ema21 ? 'BULL' : 'BEAR') : '-';
            const emaC = emaT === 'BULL' ? 'positive' : emaT === 'BEAR' ? 'negative' : '';
            const macdH = ind.macdHist != null ? (ind.macdHist > 0 ? '+' : '') + ind.macdHist.toFixed(4) : '-';
            const macdC = ind.macdHist != null ? (ind.macdHist > 0 ? 'positive' : 'negative') : '';
            const stC = ind.stochK != null ? (ind.stochK > 80 ? 'negative' : ind.stochK < 20 ? 'positive' : '') : '';
            const adxC = ind.adx != null ? (ind.adx > 25 ? 'positive' : 'neutral') : '';
            const cciC = ind.cci != null ? (ind.cci > 100 ? 'negative' : ind.cci < -100 ? 'positive' : '') : '';
            const wrC = ind.willR != null ? (ind.willR < -80 ? 'positive' : ind.willR > -20 ? 'negative' : '') : '';
            const rocC = ind.roc != null ? (ind.roc > 0.15 ? 'positive' : ind.roc < -0.15 ? 'negative' : '') : '';
            html += '<tr><td>' + (tf === '1m' ? '<strong>'+sym+'</strong>' : '') + '</td><td>' + tf + '</td>';
            html += '<td class="' + rsiC + '">' + (ind.rsi != null ? ind.rsi.toFixed(1) : '-') + '</td>';
            html += '<td class="' + emaC + '">' + emaT + '</td>';
            html += '<td style="font-size:0.78em;">' + (ind.ema50 != null ? usd(ind.ema50) : '-') + '</td>';
            html += '<td class="' + macdC + '">' + macdH + '</td>';
            html += '<td>' + (ind.bbPos != null ? ind.bbPos.toFixed(0) + '%' : '-') + '</td>';
            html += '<td>' + (ind.bbWidth != null ? ind.bbWidth.toFixed(2) : '-') + '</td>';
            html += '<td style="font-size:0.78em;">' + (ind.atr != null ? ind.atr.toFixed(4) : '-') + '</td>';
            html += '<td>' + (ind.atrPct != null ? ind.atrPct.toFixed(3) + '%' : '-') + '</td>';
            html += '<td class="' + stC + '">' + (ind.stochK != null ? ind.stochK.toFixed(0) : '-') + '/' + (ind.stochD != null ? ind.stochD.toFixed(0) : '-') + '</td>';
            html += '<td class="' + adxC + '">' + (ind.adx != null ? ind.adx.toFixed(1) : '-') + '</td>';
            html += '<td style="font-size:0.78em;">' + (ind.plusDI != null ? '+' + ind.plusDI.toFixed(0) + '/-' + ind.minusDI.toFixed(0) : '-') + '</td>';
            html += '<td class="' + cciC + '">' + (ind.cci != null ? ind.cci.toFixed(0) : '-') + '</td>';
            html += '<td class="' + wrC + '">' + (ind.willR != null ? ind.willR.toFixed(0) : '-') + '</td>';
            html += '<td class="' + rocC + '">' + (ind.roc != null ? ind.roc.toFixed(3) + '%' : '-') + '</td>';
            html += '<td style="color:#484f58;">' + ind.available + '/' + ind.total + '</td></tr>';
        }
    }
    html += '</tbody></table></div></div></div>';

    // S/R + Candle Patterns
    html += '<div class="grid"><div class="card full-width"><h2>Support / Resistance & Candle Patterns</h2><table>';
    html += '<thead><tr><th>Market</th><th>Supports</th><th>Resistances</th><th>Candle Patterns (5m)</th></tr></thead><tbody>';
    for (const sym of d.activeMarkets) {
        const m = d.markets[sym];
        const supText = m.supports && m.supports.length > 0 ? m.supports.map(s => usd(s.price)+' ['+s.strength+'] '+Math.abs(s.distancePercent).toFixed(2)+'%').join('<br>') : '<span style="color:#484f58;">Building...</span>';
        const resText = m.resistances && m.resistances.length > 0 ? m.resistances.map(r => usd(r.price)+' ['+r.strength+'] '+r.distancePercent.toFixed(2)+'%').join('<br>') : '<span style="color:#484f58;">Building...</span>';
        const cp = m.candlePatterns;
        const cpText = cp && cp.patterns && cp.patterns.length > 0 ? cp.patterns.slice(-3).map(p => { const c2 = p.signal.indexOf('BULLISH')>=0?'positive':p.signal.indexOf('BEARISH')>=0?'negative':'neutral'; return '<span class="'+c2+'">'+p.type+'</span>'; }).join(', ') : '<span style="color:#484f58;">' + (cp?cp.summary:'Building...') + '</span>';
        html += '<tr><td><strong>' + sym + '</strong></td><td>' + supText + '</td><td>' + resText + '</td><td>' + cpText + '</td></tr>';
    }
    html += '</tbody></table></div></div>';

    // Pattern Memory Stats
    html += '<div class="grid"><div class="card full-width"><h2>Pattern Memory - Learning Stats</h2>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;">';
    const byM = d.pmStats.byMarket || {};
    for (const mk of Object.keys(byM)) {
        const md = byM[mk]; const mt = md.wins + md.losses; const mwr = mt > 0 ? (md.wins/mt*100).toFixed(0) : 0;
        html += '<div style="background:#0d1117;padding:10px;border-radius:6px;"><div style="font-weight:bold;color:#58a6ff;margin-bottom:4px;">' + mk + '</div><div style="font-size:0.85em;">W: <span class="positive">' + md.wins + '</span> L: <span class="negative">' + md.losses + '</span> WR: <span class="' + (mwr>=50?'positive':'negative') + '">' + mwr + '%</span></div></div>';
    }
    if (Object.keys(byM).length === 0) html += '<div style="color:#484f58;padding:10px;">No market data yet</div>';
    const byD = d.pmStats.byDirection || {};
    for (const dk of Object.keys(byD)) {
        const dd = byD[dk]; const dt2 = dd.wins + dd.losses; const dwr = dt2 > 0 ? (dd.wins/dt2*100).toFixed(0) : 0;
        html += '<div style="background:#0d1117;padding:10px;border-radius:6px;"><div style="font-weight:bold;color:' + (dk==='LONG'?'#3fb950':'#f85149') + ';margin-bottom:4px;">' + dk + '</div><div style="font-size:0.85em;">W: <span class="positive">' + dd.wins + '</span> L: <span class="negative">' + dd.losses + '</span> WR: <span class="' + (dwr>=50?'positive':'negative') + '">' + dwr + '%</span></div></div>';
    }
    html += '</div>';
    // Hourly heatmap
    const byH = d.pmStats.byHour || {};
    if (Object.keys(byH).length > 0) {
        html += '<div style="margin-top:10px;"><div style="color:#58a6ff;font-weight:600;margin-bottom:6px;">Win Rate by Hour (UTC)</div><div style="display:flex;flex-wrap:wrap;gap:4px;">';
        for (let h = 0; h < 24; h++) {
            const hd = byH[h.toString()] || {wins:0,losses:0}; const ht2 = hd.wins+hd.losses; const hwr = ht2 > 0 ? Math.round(hd.wins/ht2*100) : -1;
            const bg = hwr < 0 ? '#21262d' : hwr >= 60 ? '#238636' : hwr >= 40 ? '#d29922' : '#da3633';
            html += '<div style="width:30px;height:30px;background:'+bg+';border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.7em;" title="'+h+':00 UTC - '+(ht2>0?hwr+'% ('+ht2+' trades)':'no trades')+'">'+h+'</div>';
        }
        html += '</div></div>';
    }
    html += '</div></div>';

    // Live Decisions
    html += '<div class="grid"><div class="card full-width"><h2>Live Decisions & Pattern Matching</h2><div style="max-height:350px;overflow-y:auto;">';
    if (d.brainLog.length === 0) html += '<div style="color:#484f58;padding:20px;text-align:center;">Waiting for decisions...</div>';
    for (const t of d.brainLog) {
        const col = categoryColors[t.category] || '#888';
        html += '<div class="thinking-entry" style="border-left-color:'+col+';"><span class="thinking-time">'+new Date(t.time).toLocaleTimeString()+'</span><span style="color:'+col+';font-weight:600;text-transform:uppercase;font-size:0.72em;">['+t.category+']</span> '+esc(t.message)+'</div>';
    }
    html += '</div></div></div>';

    // Signal Performance
    html += '<div class="grid"><div class="card full-width"><h2>Signal Performance Tracker (25 signals)</h2><div style="overflow-x:auto;"><table>';
    html += '<thead><tr><th style="min-width:130px;">Signal</th><th>Wins</th><th>Losses</th><th>Total</th><th>Win Rate</th><th style="min-width:150px;">Performance</th></tr></thead><tbody>';
    for (const def of d.signalDefs) {
        const s = d.signalStats[def.id] || {wins:0,losses:0}; const total = s.wins+s.losses;
        const wr = total > 0 ? (s.wins/total*100).toFixed(0) : '-'; const wrC2 = total > 0 ? (s.wins/total >= 0.5 ? 'positive' : 'negative') : '';
        const winPct2 = total > 0 ? (s.wins/total*100) : 0;
        html += '<tr><td style="font-weight:600;">'+def.name+'</td><td class="positive">'+s.wins+'</td><td class="negative">'+s.losses+'</td><td>'+total+'</td>';
        html += '<td class="'+wrC2+'" style="font-weight:bold;">'+(total>0?wr+'%':'-')+'</td>';
        html += '<td><div style="display:flex;height:14px;border-radius:3px;overflow:hidden;background:#21262d;">'+(total>0?'<div style="width:'+winPct2+'%;background:#238636;"></div><div style="width:'+(100-winPct2)+'%;background:#da3633;"></div>':'')+'</div></td></tr>';
    }
    html += '</tbody></table></div></div></div>';

    // Signal Combos
    html += '<div class="grid"><div class="card full-width"><h2>Signal Combo Tracker - Which Combinations Win?</h2><div style="overflow-x:auto;"><table>';
    html += '<thead><tr><th>Combo</th><th>Times</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th style="min-width:120px;">Performance</th></tr></thead><tbody>';
    if (d.signalCombos.length === 0) html += '<tr><td colspan="6" style="color:#484f58;text-align:center;padding:15px;">No combo data yet</td></tr>';
    for (const c of d.signalCombos) {
        const cwr = (c.wins/c.total*100).toFixed(0); const cwrC = c.wins/c.total >= 0.5 ? 'positive' : 'negative'; const cwP = c.wins/c.total*100;
        const sigLabels = c.signals.map(s2 => { const df = d.signalDefs.find(dd => dd.id===s2); return df?df.name:s2; });
        html += '<tr><td>'+sigLabels.map(n => tag(n)).join(' ')+'</td><td>'+c.total+'</td><td class="positive">'+c.wins+'</td><td class="negative">'+c.losses+'</td>';
        html += '<td class="'+cwrC+'" style="font-weight:bold;">'+cwr+'%</td>';
        html += '<td><div style="display:flex;height:14px;border-radius:3px;overflow:hidden;background:#21262d;"><div style="width:'+cwP+'%;background:#238636;"></div><div style="width:'+(100-cwP)+'%;background:#da3633;"></div></div></td></tr>';
    }
    html += '</tbody></table></div></div></div>';

    // TP/SL Combo Performance
    html += '<div class="grid"><div class="card full-width"><h2>TP/SL Combo Performance - Which Settings Work Best?</h2><div style="overflow-x:auto;"><table>';
    html += '<thead><tr><th>TP %</th><th>SL %</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th>Avg P&L</th><th>Total P&L</th><th>Best</th><th>Worst</th><th>Score</th><th style="min-width:100px;">Performance</th></tr></thead><tbody>';
    if (d.topCombos.length === 0) html += '<tr><td colspan="12" style="color:#484f58;text-align:center;padding:15px;">No TP/SL data yet</td></tr>';
    for (const tc of d.topCombos) {
        const tcWrC = tc.winRate >= 50 ? 'positive' : 'negative'; const tcPct = tc.total > 0 ? tc.winRate : 0;
        html += '<tr><td style="font-weight:600;color:#58a6ff;">' + tc.tp.toFixed(2) + '%</td><td style="font-weight:600;color:#d29922;">' + tc.sl.toFixed(2) + '%</td>';
        html += '<td>' + tc.total + '</td><td class="positive">' + tc.wins + '</td><td class="negative">' + tc.losses + '</td>';
        html += '<td class="' + tcWrC + '" style="font-weight:bold;">' + tc.winRate.toFixed(1) + '%</td>';
        html += '<td class="' + (tc.avgProfit >= 0 ? 'positive' : 'negative') + '">' + (tc.avgProfit >= 0 ? '+' : '') + tc.avgProfit.toFixed(2) + '%</td>';
        html += '<td class="' + (tc.totalProfit >= 0 ? 'positive' : 'negative') + '">' + (tc.totalProfit >= 0 ? '+' : '') + tc.totalProfit.toFixed(2) + '%</td>';
        html += '<td class="positive">' + (tc.bestProfit >= 0 ? '+' : '') + tc.bestProfit.toFixed(2) + '%</td>';
        html += '<td class="negative">' + tc.worstProfit.toFixed(2) + '%</td>';
        html += '<td>' + (tc.score != null ? tc.score.toFixed(3) : '-') + '</td>';
        html += '<td><div style="display:flex;height:14px;border-radius:3px;overflow:hidden;background:#21262d;">' + (tc.total > 0 ? '<div style="width:'+tcPct+'%;background:#238636;"></div><div style="width:'+(100-tcPct)+'%;background:#da3633;"></div>' : '') + '</div></td></tr>';
    }
    html += '</tbody></table></div></div></div>';

    // Pattern History
    html += '<div class="grid"><div class="card full-width"><h2>Stored Pattern History (Last 10)</h2><div style="overflow-x:auto;"><table>';
    html += '<thead><tr><th>Time</th><th>Market</th><th>Dir</th><th>Result</th><th>P&L</th><th>Exit</th><th>Hold</th><th>Mode</th><th>RSI 1m</th><th>StochK</th><th>BB Pos</th><th>CCI</th><th>Will%R</th><th>ADX</th><th>Imb</th><th>Trend</th><th>Triggers</th></tr></thead><tbody>';
    if (d.recentPatterns.length === 0) html += '<tr><td colspan="17" style="color:#484f58;text-align:center;padding:15px;">No patterns stored yet</td></tr>';
    for (const p of d.recentPatterns) {
        const fp = p.fingerprint || {};
        html += '<tr><td style="font-size:0.75em;">' + new Date(p.timestamp).toLocaleTimeString() + '</td>';
        html += '<td>' + (p.symbol||'-') + '</td>';
        html += '<td class="' + (p.direction==='LONG'?'positive':'negative') + '">' + (p.direction||'-') + '</td>';
        html += '<td class="' + (p.result==='WIN'?'positive':'negative') + '" style="font-weight:bold;">' + (p.result||'-') + '</td>';
        html += '<td class="' + ((p.profitPercent||0)>=0?'positive':'negative') + '">' + ((p.profitPercent||0)>=0?'+':'') + (p.profitPercent||0).toFixed(2) + '%</td>';
        html += '<td>' + (p.exitReason||'-') + '</td>';
        html += '<td>' + (p.holdTimeMin||0).toFixed(0) + 'm</td>';
        html += '<td>' + tag(p.entryMode||'-') + '</td>';
        html += '<td class="fp-val">' + (fp.rsi_1m!=null?fp.rsi_1m.toFixed(1):'-') + '</td>';
        html += '<td class="fp-val">' + (fp.stoch_k_1m!=null?fp.stoch_k_1m.toFixed(0):'-') + '</td>';
        html += '<td class="fp-val">' + (fp.bb_position_1m!=null?(fp.bb_position_1m*100).toFixed(0)+'%':'-') + '</td>';
        html += '<td class="fp-val">' + (fp.cci_1m!=null?fp.cci_1m.toFixed(0):'-') + '</td>';
        html += '<td class="fp-val">' + (fp.willr_1m!=null?fp.willr_1m.toFixed(0):'-') + '</td>';
        html += '<td class="fp-val">' + (fp.adx_1m!=null?fp.adx_1m.toFixed(0):'-') + '</td>';
        html += '<td class="fp-val">' + (fp.imbalance!=null?(fp.imbalance*100).toFixed(0)+'%':'-') + '</td>';
        html += '<td>' + (fp.trend===1?'<span class="positive">UP</span>':fp.trend===-1?'<span class="negative">DN</span>':'RNG') + '</td>';
        html += '<td>' + ((p.triggerSignals||[]).slice(0,4).map(s3 => tag(s3)).join(' ')||'-') + '</td></tr>';
    }
    html += '</tbody></table></div></div></div>';

    // Trade History
    html += '<div class="grid"><div class="card full-width"><h2>Complete Trade History (Last 50)</h2><div style="overflow-x:auto;"><table>';
    html += '<thead><tr><th>Time</th><th>Market</th><th>Dir</th><th>Entry $</th><th>Exit $</th><th>P&L %</th><th>Result</th><th>Exit Reason</th><th>TP/SL Used</th><th>TP/SL Mode</th><th>Hold</th><th>Entry Mode</th><th>Sim</th><th style="min-width:220px;">Trigger Signals</th></tr></thead><tbody>';
    if (d.recentTrades.length === 0) html += '<tr><td colspan="14" style="color:#484f58;text-align:center;padding:20px;">No trades yet</td></tr>';
    for (const t2 of d.recentTrades) {
        const sigDisp = t2.triggerSignals.length > 0 ? t2.triggerSignals.map(sig2 => { const df2 = d.signalDefs.find(dd2 => dd2.id===sig2); return tag(df2?df2.name:sig2); }).join(' ') : '<span style="color:#484f58;font-size:0.75em;">no data</span>';
        html += '<tr><td style="font-size:0.75em;">' + new Date(t2.timestamp).toLocaleTimeString() + '<br>' + new Date(t2.timestamp).toLocaleDateString() + '</td>';
        html += '<td>' + (t2.symbol||'-') + '</td>';
        html += '<td class="' + (t2.direction==='LONG'?'positive':'negative') + '">' + t2.direction + '</td>';
        html += '<td>' + usd(t2.entryPrice) + '</td>';
        html += '<td>' + usd(t2.exitPrice) + '</td>';
        html += '<td class="' + (t2.profitPercent>=0?'positive':'negative') + '" style="font-weight:bold;">' + (t2.profitPercent>=0?'+':'') + t2.profitPercent.toFixed(2) + '%</td>';
        html += '<td class="' + (t2.result==='WIN'?'positive':'negative') + '" style="font-weight:bold;">' + t2.result + '</td>';
        html += '<td>' + t2.exitReason + '</td>';
        html += '<td style="font-size:0.78em;">' + (t2.tp!=null?'TP:'+t2.tp.toFixed(2)+' SL:'+t2.sl.toFixed(2):'-') + '</td>';
        html += '<td>' + (t2.tpSlMode ? tag(t2.tpSlMode) : '-') + '</td>';
        html += '<td>' + (t2.holdTimeMin||'?') + 'm</td>';
        html += '<td>' + tag(t2.entryMode) + '</td>';
        html += '<td>' + (t2.simulated?'SIM':'LIVE') + '</td>';
        html += '<td>' + sigDisp + '</td></tr>';
    }
    html += '</tbody></table></div></div></div>';

    // Button script
    html += `
    <script>
    function botAction(action) {
        var s = document.getElementById('btnStatus');
        if (s) { s.textContent = 'Processing...'; s.style.color = '#d29922'; }
        fetch('/api/' + action, { method: 'POST' })
            .then(function(r) { return r.json(); })
            .then(function(dd) {
                if (s) { s.textContent = dd.message || 'Done'; s.style.color = '#3fb950'; }
            })
            .catch(function(e) {
                if (s) { s.textContent = 'Error: ' + e.message; s.style.color = '#f85149'; }
            });
    }
    </script>
</div>
</body>
</html>`;

    return html;
}


function startDashboard() {
    const server = http.createServer(async (req, res) => {
        const sendJson = (data, code = 200) => {
            res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify(data));
        };

        if (req.url === '/api/data') {
            sendJson(generateDashboardData());
        } else if (req.url === '/api/status') {
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
                const mc = MARKETS[symbol];
                const pos = getPosition(ms, mc);
                if (pos) {
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
    log('   SELF-LEARNING BOT v18.2 - Boosted Learning');
    log(`   Data: ${CONFIG.DATA_SOURCE.toUpperCase()} | ${CONFIG.LEVERAGE}x Leverage | Pattern Matching`);
    log('═══════════════════════════════════════════════════════════');
    log(`Mode: ${CONFIG.SIMULATION_MODE ? 'SIMULATION (Paper Trading)' : 'LIVE TRADING'}`);
    log(`Data Source: ${CONFIG.DATA_SOURCE.toUpperCase()} (set DATA_SOURCE=drift to use Drift DLOB)`);
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

    if (CONFIG.DATA_SOURCE === 'drift' && !CONFIG.RPC_URL) {
        log('ERROR: Missing SOLANA_RPC_URL in .env file');
        process.exit(1);
    }

    if (!CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY && CONFIG.DATA_SOURCE === 'drift') {
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
    tpSlOptimizer.load();
    startDashboard();

    const pmS = patternMemory.getStats();
    aiBrain.think(`Bot v18.2 starting — ${CONFIG.DATA_SOURCE.toUpperCase()} data feed | Dynamic TP/SL Learning + Pattern Memory | ${pmS.totalStored} patterns stored | ${pmS.isLearning ? 'LEARNING PHASE' : 'EXPLOITATION PHASE'} | 12 indicators per TF`, 'ai_brain');

    try {
        if (CONFIG.DATA_SOURCE === 'kraken') {
            log('Starting Kraken live data feed...');
            krakenFeed = new KrakenFeed(ACTIVE_MARKETS);
            const history = await krakenFeed.bootstrapHistory();
            for (const symbol of ACTIVE_MARKETS) {
                if (history[symbol]) {
                    const h = history[symbol];
                    marketStates[symbol].prices = h.prices;
                    marketStates[symbol].priceTimestamps = h.timestamps;
                    marketStates[symbol].lastPrice = h.prices[h.prices.length - 1];
                    log(`[${symbol}] Loaded ${h.prices.length} historical prices from Kraken REST`);
                }
            }
            krakenFeed.connect();
            log('Kraken WebSocket feed started — real-time prices + orderbook');
        }

        let driftConnected = false;
        if (CONFIG.RPC_URL) {
            try {
                const connection = new Connection(CONFIG.RPC_URL, { commitment: 'confirmed' });

                let keypair;
                if (CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY) {
                    keypair = Keypair.generate();
                    log(`Simulation mode: Using temporary wallet ${keypair.publicKey.toBase58().slice(0, 8)}...`);
                } else if (CONFIG.PRIVATE_KEY) {
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
                        if (CONFIG.DATA_SOURCE === 'drift') process.exit(1);
                    }
                    if (privateKeyBytes) {
                        keypair = Keypair.fromSecretKey(privateKeyBytes);
                        log(`Wallet: ${keypair.publicKey.toBase58()}`);
                    }
                }

                if (keypair) {
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
                    driftConnected = true;

                    if (!CONFIG.SIMULATION_MODE) {
                        const user = driftClient.getUser();
                        if (!user) {
                            log('WARNING: No Drift user account found.');
                        }
                    }
                }
            } catch (driftErr) {
                log(`Drift connection failed: ${driftErr.message}`);
                if (CONFIG.DATA_SOURCE === 'drift') {
                    log('ERROR: Drift is required when DATA_SOURCE=drift. Exiting.');
                    process.exit(1);
                }
                log('Continuing with Kraken data feed only (no trading until Drift reconnects)');
                driftClient = null;
            }
        } else {
            log('No RPC URL configured — running with Kraken data only (learning mode)');
        }

        if (CONFIG.DATA_SOURCE === 'drift' && driftConnected) {
            log('Testing DLOB API...');
            for (const symbol of ACTIVE_MARKETS) {
                const testOrderBook = await fetchOrderBook(symbol);
                log(`[${symbol}] DLOB: ${testOrderBook ? 'Connected' : 'Failed'}`);
            }
        } else if (CONFIG.DATA_SOURCE === 'kraken') {
            log('Testing Kraken data feed...');
            for (const symbol of ACTIVE_MARKETS) {
                const price = krakenFeed.getPrice(symbol);
                log(`[${symbol}] Kraken: ${price ? '$' + price.toFixed(2) : 'Waiting for data...'}`);
            }
        }

        botStatus.running = true;
        botStatus.driftConnected = driftConnected;
        botStatus.dataSource = CONFIG.DATA_SOURCE;
        if (!tradeMemory.sessionStats.startTime) {
            tradeMemory.sessionStats.startTime = new Date().toISOString();
        }

        log(`Starting trading loop (data: ${CONFIG.DATA_SOURCE.toUpperCase()})...`);
        async function dynamicLoop() {
            await tradingLoop();
            const hasPos = ACTIVE_MARKETS.some(s => {
                const ms = marketStates[s];
                const mc = MARKETS[s];
                return ms && getPosition(ms, mc);
            });
            const interval = hasPos ? 2000 : CONFIG.CHECK_INTERVAL_MS;
            setTimeout(dynamicLoop, interval);
        }
        dynamicLoop();

        setInterval(savePriceHistory, 300000);

        if (driftClient) {
            setInterval(() => {
                const timeSinceHeartbeat = Date.now() - lastHeartbeat;
                const maxIdleTime = CONFIG.CHECK_INTERVAL_MS * 5;
                if (timeSinceHeartbeat > maxIdleTime) {
                    log(`WATCHDOG: No heartbeat for ${Math.round(timeSinceHeartbeat / 1000)}s`);
                    (async () => {
                        try {
                            await driftClient.unsubscribe();
                            await driftClient.subscribe();
                            log('Drift reconnection successful');
                            lastHeartbeat = Date.now();
                        } catch (err) {
                            log(`Drift reconnection failed: ${err.message}`);
                            if (CONFIG.DATA_SOURCE === 'drift') process.exit(1);
                        }
                    })();
                }
            }, 60000);
        } else if (CONFIG.DATA_SOURCE === 'kraken' && CONFIG.RPC_URL && !CONFIG.SIMULATION_MODE) {
            setInterval(() => {
                if (driftClient) return;
                log('Attempting Drift reconnection (trading will resume when connected)...');
                (async () => {
                    try {
                        const connection = new Connection(CONFIG.RPC_URL, { commitment: 'confirmed' });
                        let privateKeyBytes;
                        const cleanKey = CONFIG.PRIVATE_KEY.trim().replace(/['"]/g, '');
                        if (typeof bs58.decode === 'function') {
                            privateKeyBytes = bs58.decode(cleanKey);
                        } else if (typeof bs58.default?.decode === 'function') {
                            privateKeyBytes = bs58.default.decode(cleanKey);
                        }
                        if (!privateKeyBytes) return;
                        const keypair = Keypair.fromSecretKey(privateKeyBytes);
                        const wallet = new Wallet(keypair);
                        const sdkConfig = initialize({ env: 'mainnet-beta' });
                        const newClient = new DriftClient({
                            connection, wallet,
                            programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
                            accountSubscription: { type: 'websocket', resubTimeoutMs: 30000, resyncIntervalMs: 60000 },
                        });
                        await newClient.subscribe();
                        driftClient = newClient;
                        botStatus.driftConnected = true;
                        log('Drift reconnected! Live trading can resume.');
                    } catch (err) {
                        log(`Drift reconnection failed: ${err.message}`);
                    }
                })();
            }, 300000);
        }

        process.on('SIGINT', async () => {
            log('Shutting down...');
            botStatus.running = false;
            saveMemory();
            savePriceHistory();
            patternMemory.save();
            tpSlOptimizer.save();
            if (krakenFeed) krakenFeed.stop();
            const openPositions = ACTIVE_MARKETS.filter(s => {
                const ms = marketStates[s];
                const mc = MARKETS[s];
                return ms && getPosition(ms, mc);
            });
            if (openPositions.length > 0) {
                log(`WARNING: Open positions on: ${openPositions.join(', ')}`);
            }
            if (driftClient) {
                try { await driftClient.unsubscribe(); } catch (e) {}
            }
            process.exit(0);
        });

    } catch (error) {
        log(`Fatal error: ${error.message}`);
        console.error(error);
        process.exit(1);
    }
}

main();
