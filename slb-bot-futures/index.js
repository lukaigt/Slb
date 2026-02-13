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

dotenv.config();

const CONFIG = {
    RPC_URL: process.env.SOLANA_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    LEVERAGE: parseInt(process.env.LEVERAGE) || 20,
    TRADE_AMOUNT_USDC: parseFloat(process.env.TRADE_AMOUNT_USDC) || 10,
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true' || process.env.SIMULATION_MODE === '1',
    COOLDOWN_MS: (parseInt(process.env.COOLDOWN_SECONDS) || 180) * 1000,
    AI_INTERVAL_MS: parseInt(process.env.AI_INTERVAL_MS) || 180000,
    CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS) || 15000,
    DLOB_URL: 'https://dlob.drift.trade',
    DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT) || 3000,
    MEMORY_FILE: path.join(__dirname, 'trade_memory.json'),
    PRICE_HISTORY_FILE: path.join(__dirname, 'price_history.json'),
    MIN_CONFIDENCE: parseFloat(process.env.MIN_CONFIDENCE) || 0.6,
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
        indicators15m: null
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
    }
};
let botStatus = {
    running: false,
    markets: {},
    lastUpdate: null,
    driftConnected: false
};
let lastHeartbeat = Date.now();
let botStartTime = Date.now();

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
                }
            };
            log(`Memory loaded: ${tradeMemory.trades.length} trades`);
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
                    prices: ms.prices.slice(-1200),
                    timestamps: ms.priceTimestamps.slice(-1200)
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
                    const maxAge = 60 * 60 * 1000;
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
                        log(`[${symbol}] Loaded ${validIndices.length} price points from history (max 1h old)`);
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
    const recent = prices.slice(-10);
    const oldPrice = recent[0];
    const currentPrice = recent[recent.length - 1];
    const changePercent = ((currentPrice - oldPrice) / oldPrice) * 100;
    if (changePercent > 0.15) return 'UPTREND';
    if (changePercent < -0.15) return 'DOWNTREND';
    return 'RANGING';
}

function calculateVolatility(prices) {
    if (prices.length < 5) return 0;
    const recent = prices.slice(-10);
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

    marketState.lastOrderTime = Date.now();
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
        simulated: CONFIG.SIMULATION_MODE,
        entrySnapshot: marketState.entrySnapshot || null,
        exitSnapshot,
        lesson
    };
    tradeMemory.trades.push(trade);
    tradeMemory.sessionStats.totalTrades++;
    if (result === 'WIN') tradeMemory.sessionStats.wins++;
    else tradeMemory.sessionStats.losses++;
    tradeMemory.sessionStats.totalProfitPercent += profitPercent;
    saveMemory();

    aiBrain.recordTradeResult(symbol, pos, result, profitPercent, exitReason);
    safety.recordTradeResult(profitPercent, result === 'WIN');

    const modeStr = CONFIG.SIMULATION_MODE ? '[SIM]' : '[REAL]';
    aiBrain.think(`${modeStr} ${symbol} ${pos} ${result} | P&L: ${profitPercent.toFixed(2)}% | Exit: ${exitReason} | Hold: ${holdTimeMin}min | Entry: $${marketState.entryPrice.toFixed(2)} Exit: $${currentPrice.toFixed(2)}`, result === 'WIN' ? 'trade_win' : 'trade_loss');

    marketState.lastOrderTime = Date.now();
    resetPositionState(marketState);
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
    if (!pos || !marketState.aiStopLoss) return false;

    const priceMovePercent = ((currentPrice - marketState.entryPrice) / marketState.entryPrice) * 100;

    if (pos === 'LONG' && priceMovePercent <= -marketState.aiStopLoss) {
        log(`[${symbol}] STOP LOSS (LONG): ${priceMovePercent.toFixed(2)}% | SL: ${marketState.aiStopLoss}%`);
        aiBrain.think(`[${symbol}] STOP LOSS hit on LONG at ${priceMovePercent.toFixed(2)}% | SL was ${marketState.aiStopLoss}%`, 'exit');
        return true;
    }
    if (pos === 'SHORT' && priceMovePercent >= marketState.aiStopLoss) {
        log(`[${symbol}] STOP LOSS (SHORT): ${priceMovePercent.toFixed(2)}% | SL: ${marketState.aiStopLoss}%`);
        aiBrain.think(`[${symbol}] STOP LOSS hit on SHORT at ${priceMovePercent.toFixed(2)}% | SL was ${marketState.aiStopLoss}%`, 'exit');
        return true;
    }
    return false;
}

const PROFIT_PROTECTION_FLOOR = 0.5;

function getSteppedTrailingDistance(pnlPercent) {
    if (pnlPercent >= 50) return 0.10;
    if (pnlPercent >= 30) return 0.15;
    if (pnlPercent >= 15) return 0.20;
    return 0.25;
}

function checkTakeProfit(currentPrice, marketState, symbol) {
    const pos = CONFIG.SIMULATION_MODE ? marketState.simulatedPosition : marketState.currentPosition;
    if (!pos || !marketState.entryPrice || marketState.entryPrice <= 0) return false;

    const leverage = CONFIG.LEVERAGE;

    if (pos === 'LONG') {
        const priceMove = ((currentPrice - marketState.entryPrice) / marketState.entryPrice) * 100;
        const pnlPercent = priceMove * leverage;
        if (currentPrice > marketState.highestPriceSinceEntry) marketState.highestPriceSinceEntry = currentPrice;

        if (marketState.aiTakeProfit && priceMove >= marketState.aiTakeProfit) {
            if (!marketState.trailingStopActive) {
                aiBrain.think(`[${symbol}] TRAILING ACTIVATED (AI TP hit) | P&L: ${pnlPercent.toFixed(1)}%`, 'exit');
            }
            marketState.trailingStopActive = true;
        }
        if (pnlPercent >= 10 && priceMove >= PROFIT_PROTECTION_FLOOR) {
            if (!marketState.trailingStopActive) {
                aiBrain.think(`[${symbol}] TRAILING ACTIVATED (Profit Floor) | P&L: ${pnlPercent.toFixed(1)}%`, 'exit');
            }
            marketState.trailingStopActive = true;
        }

        if (marketState.trailingStopActive) {
            const peakPriceMove = ((marketState.highestPriceSinceEntry - marketState.entryPrice) / marketState.entryPrice) * 100;
            const peakPnl = peakPriceMove * leverage;
            const trailingDistance = getSteppedTrailingDistance(peakPnl);
            const dropFromHigh = ((marketState.highestPriceSinceEntry - currentPrice) / marketState.highestPriceSinceEntry) * 100;
            if (dropFromHigh >= trailingDistance) {
                log(`[${symbol}] TRAILING TP (LONG): P&L=${pnlPercent.toFixed(1)}% | PeakP&L=${peakPnl.toFixed(1)}% | Trail=${trailingDistance}%`);
                aiBrain.think(`[${symbol}] TRAILING TP on LONG | P&L: ${pnlPercent.toFixed(1)}% | Peak P&L: ${peakPnl.toFixed(1)}% | Trail: ${trailingDistance}%`, 'exit');
                return true;
            }
        }
    } else if (pos === 'SHORT') {
        const priceMove = ((marketState.entryPrice - currentPrice) / marketState.entryPrice) * 100;
        const pnlPercent = priceMove * leverage;
        if (currentPrice < marketState.lowestPriceSinceEntry) marketState.lowestPriceSinceEntry = currentPrice;

        if (marketState.aiTakeProfit && priceMove >= marketState.aiTakeProfit) {
            if (!marketState.trailingStopActive) {
                aiBrain.think(`[${symbol}] TRAILING ACTIVATED (AI TP hit) | P&L: ${pnlPercent.toFixed(1)}%`, 'exit');
            }
            marketState.trailingStopActive = true;
        }
        if (pnlPercent >= 10 && priceMove >= PROFIT_PROTECTION_FLOOR) {
            if (!marketState.trailingStopActive) {
                aiBrain.think(`[${symbol}] TRAILING ACTIVATED (Profit Floor) | P&L: ${pnlPercent.toFixed(1)}%`, 'exit');
            }
            marketState.trailingStopActive = true;
        }

        if (marketState.trailingStopActive) {
            const peakPriceMove = ((marketState.entryPrice - marketState.lowestPriceSinceEntry) / marketState.entryPrice) * 100;
            const peakPnl = peakPriceMove * leverage;
            const trailingDistance = getSteppedTrailingDistance(peakPnl);
            const riseFromLow = ((currentPrice - marketState.lowestPriceSinceEntry) / marketState.lowestPriceSinceEntry) * 100;
            if (riseFromLow >= trailingDistance) {
                log(`[${symbol}] TRAILING TP (SHORT): P&L=${pnlPercent.toFixed(1)}% | PeakP&L=${peakPnl.toFixed(1)}% | Trail=${trailingDistance}%`);
                aiBrain.think(`[${symbol}] TRAILING TP on SHORT | P&L: ${pnlPercent.toFixed(1)}% | Peak P&L: ${peakPnl.toFixed(1)}% | Trail: ${trailingDistance}%`, 'exit');
                return true;
            }
        }
    }
    return false;
}

function checkMaxHoldTime(marketState, symbol) {
    const pos = CONFIG.SIMULATION_MODE ? marketState.simulatedPosition : marketState.currentPosition;
    if (!pos || !marketState.entryTime) return false;

    const maxHold = (marketState.aiMaxHoldMinutes || 120) * 60 * 1000;
    if (Date.now() - marketState.entryTime > maxHold) {
        log(`[${symbol}] MAX HOLD TIME reached (${marketState.aiMaxHoldMinutes || 120} min)`);
        aiBrain.think(`[${symbol}] Max hold time expired (${marketState.aiMaxHoldMinutes || 120} min) - closing position`, 'exit');
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
        if (marketState.prices.length > 1200) {
            marketState.prices = marketState.prices.slice(-1200);
            marketState.priceTimestamps = marketState.priceTimestamps.slice(-1200);
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

        const pos = CONFIG.SIMULATION_MODE ? marketState.simulatedPosition : marketState.currentPosition;
        const modeStr = CONFIG.SIMULATION_MODE ? 'SIM' : 'LIVE';
        const posStr = pos || 'NONE';

        const ind1m = marketState.indicators1m || {};
        const indStatus = ind1m.ready ? `${ind1m.indicatorsAvailable}/${ind1m.indicatorsTotal}` : 'building';

        botStatus.markets[symbol] = {
            price, imbalance, trend: marketState.trend, volatility: marketState.volatility,
            position: pos, rpcConnected: true, dlobConnected: true,
            dataPoints: marketState.prices.length, indicatorStatus: indStatus
        };

        log(`[${symbol}] ${modeStr} $${price.toFixed(2)} | ${marketState.trend} | Imb: ${(imbalance * 100).toFixed(0)}% | Vol: ${marketState.volatility.toFixed(2)}% | Pos: ${posStr}`);

        if (pos) {
            if (!marketState.entryPrice || marketState.entryPrice <= 0) {
                aiBrain.think(`[${symbol}] Position found but entry price invalid - using current price as entry`, 'error');
                marketState.entryPrice = price;
                marketState.highestPriceSinceEntry = price;
                marketState.lowestPriceSinceEntry = price;
                if (!marketState.entryTime) marketState.entryTime = Date.now();
            }
            if (marketState.aiStopLoss == null) {
                marketState.aiStopLoss = 1.5;
                aiBrain.think(`[${symbol}] Emergency SL assigned: 1.5% (position had no stop loss)`, 'safety');
            }
            if (marketState.aiTakeProfit == null) {
                marketState.aiTakeProfit = 1.5;
                aiBrain.think(`[${symbol}] Emergency TP assigned: 1.5% (position had no take profit)`, 'safety');
            }
            if (marketState.aiMaxHoldMinutes == null) {
                marketState.aiMaxHoldMinutes = 120;
            }
            const priceMovePct = pos === 'LONG'
                ? ((price - marketState.entryPrice) / marketState.entryPrice * 100)
                : ((marketState.entryPrice - price) / marketState.entryPrice * 100);
            let pnl = priceMovePct * CONFIG.LEVERAGE;
            if (Math.abs(pnl) > 1000) {
                aiBrain.think(`[${symbol}] P&L looks wrong (${pnl.toFixed(0)}%) - entry price may be stale, resetting`, 'error');
                marketState.entryPrice = price;
                marketState.highestPriceSinceEntry = price;
                marketState.lowestPriceSinceEntry = price;
                pnl = 0;
            }
            const holdMin = marketState.entryTime ? ((Date.now() - marketState.entryTime) / 60000).toFixed(0) : '?';
            aiBrain.think(`[${symbol}] Monitoring ${pos} | P&L: ${pnl.toFixed(1)}% | Hold: ${holdMin}min | SL: ${marketState.aiStopLoss}% | TP: ${marketState.aiTakeProfit}%`, 'monitor');

            if (checkStopLoss(price, marketState, symbol)) {
                await closePosition('stop_loss', marketState, marketConfig, symbol);
                return;
            }
            if (checkTakeProfit(price, marketState, symbol)) {
                await closePosition('trailing_tp', marketState, marketConfig, symbol);
                return;
            }
            if (checkMaxHoldTime(marketState, symbol)) {
                await closePosition('max_hold_time', marketState, marketConfig, symbol);
                return;
            }
        } else {
            const now = Date.now();

            if (now - marketState.lastOrderTime < CONFIG.COOLDOWN_MS) {
                return;
            }

            if (now - marketState.lastAiCall < CONFIG.AI_INTERVAL_MS) {
                return;
            }

            if (marketState.prices.length < 5) {
                log(`[${symbol}] Building price history... ${marketState.prices.length}/5`);
                return;
            }

            const safetyCheck = safety.canTrade();
            if (!safetyCheck.allowed) {
                aiBrain.think(`[${symbol}] SAFETY BLOCK: ${safetyCheck.reason} - no new trades`, 'safety');
                return;
            }

            marketState.lastAiCall = now;

            const recentChange = marketState.prices.length >= 2
                ? ((price - marketState.prices[marketState.prices.length - 10] || price) / (marketState.prices[marketState.prices.length - 10] || price)) * 100
                : 0;

            const marketData = {
                symbol,
                price,
                trend: marketState.trend,
                imbalance,
                volatility: marketState.volatility,
                recentChange,
                priceHistory: marketState.prices.slice(-20),
                indicators1m: marketState.indicators1m,
                indicators5m: marketState.indicators5m,
                indicators15m: marketState.indicators15m
            };

            const decision = await aiBrain.askBrain(marketData, tradeMemory.trades);

            if (decision.action === 'WAIT') {
                aiBrain.think(`[${symbol}] AI says WAIT: ${decision.reason}`, 'scan');
                return;
            }

            if (decision.confidence < CONFIG.MIN_CONFIDENCE) {
                aiBrain.think(`[${symbol}] AI confidence too low (${(decision.confidence * 100).toFixed(0)}% < ${(CONFIG.MIN_CONFIDENCE * 100).toFixed(0)}%) - skipping`, 'skip');
                return;
            }

            marketState.aiStopLoss = decision.stopLoss;
            marketState.aiTakeProfit = decision.takeProfit;
            marketState.aiMaxHoldMinutes = decision.maxHoldMinutes;
            marketState.aiReason = decision.reason;

            aiBrain.think(`[${symbol}] EXECUTING ${decision.action} | SL: ${decision.stopLoss}% | TP: ${decision.takeProfit}% | Conf: ${(decision.confidence * 100).toFixed(0)}% | Hold: ${decision.maxHoldMinutes}min`, 'entry');
            await openPosition(decision.action, marketState, marketConfig, symbol);
        }
    } catch (error) {
        log(`[${symbol}] Error: ${error.message}`);
    }
}

async function tradingLoop() {
    lastHeartbeat = Date.now();
    botStatus.lastUpdate = new Date().toISOString();

    try {
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
    const recentTrades = tradeMemory.trades.slice(-25).reverse();
    const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100).toFixed(1) : '0.0';
    const uptime = formatUptime(Date.now() - botStartTime);
    const heartbeatAgo = Math.round((Date.now() - lastHeartbeat) / 1000);
    const safetyStatus = safety.getStatus();
    const brainLog = aiBrain.getThinkingLog();

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
    <title>AI Trading Bot - GLM-4.7 Flash</title>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="5">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0d1117; color: #e6edf3; padding: 15px; font-size: 14px; }
        .container { max-width: 1600px; margin: 0 auto; }
        h1 { color: #58a6ff; margin-bottom: 15px; font-size: 1.4em; }
        .subtitle { color: #8b949e; font-size: 0.85em; margin-bottom: 15px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; margin-bottom: 15px; }
        .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 15px; }
        .card h2 { color: #58a6ff; font-size: 1em; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
        .stat-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #21262d; }
        .stat-label { color: #8b949e; font-size: 0.9em; }
        .stat-value { font-weight: bold; }
        .positive { color: #3fb950; }
        .negative { color: #f85149; }
        .neutral { color: #d29922; }
        .sim-mode { background: #1f6feb; color: white; padding: 3px 12px; border-radius: 12px; display: inline-block; font-size: 0.85em; }
        .live-mode { background: #238636; color: white; padding: 3px 12px; border-radius: 12px; display: inline-block; font-size: 0.85em; }
        .paused-badge { background: #da3633; color: white; padding: 3px 12px; border-radius: 12px; display: inline-block; font-size: 0.85em; }
        table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
        th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #21262d; }
        th { color: #58a6ff; font-weight: 600; }
        .health-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
        .health-green { background: #3fb950; }
        .health-red { background: #f85149; }
        .full-width { grid-column: 1 / -1; }
        .thinking-entry { padding: 6px 10px; margin: 3px 0; border-radius: 4px; font-size: 0.82em; border-left: 3px solid #30363d; background: #0d1117; word-break: break-word; }
        .thinking-time { color: #484f58; font-size: 0.8em; margin-right: 8px; }
        .best-worst { display: flex; gap: 15px; }
        .best-worst > div { flex: 1; padding: 10px; border-radius: 6px; background: #0d1117; }
    </style>
</head>
<body>
    <div class="container">
        <h1>AI Trading Bot - GLM-4.7 Flash</h1>
        <div class="subtitle">Drift Protocol | ${CONFIG.LEVERAGE}x Leverage | AI-Driven Entries & Exits</div>
        
        <div class="grid">
            <div class="card">
                <h2>System Health</h2>
                <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${uptime}</span></div>
                <div class="stat-row"><span class="stat-label">Heartbeat</span><span class="stat-value ${heartbeatAgo > 60 ? 'negative' : 'positive'}">${heartbeatAgo}s ago</span></div>
                <div class="stat-row"><span class="stat-label"><span class="health-dot ${anyRpcConnected ? 'health-green' : 'health-red'}"></span>RPC</span><span class="stat-value">${anyRpcConnected ? 'OK' : 'DOWN'}</span></div>
                <div class="stat-row"><span class="stat-label"><span class="health-dot ${botStatus.driftConnected ? 'health-green' : 'health-red'}"></span>Drift</span><span class="stat-value">${botStatus.driftConnected ? 'OK' : 'DOWN'}</span></div>
                <div class="stat-row"><span class="stat-label"><span class="health-dot ${anyDlobConnected ? 'health-green' : 'health-red'}"></span>DLOB</span><span class="stat-value">${anyDlobConnected ? 'OK' : 'DOWN'}</span></div>
                <div class="stat-row"><span class="stat-label">Mode</span><span>${CONFIG.SIMULATION_MODE ? '<span class="sim-mode">SIMULATION</span>' : '<span class="live-mode">LIVE</span>'} ${safetyStatus.paused ? '<span class="paused-badge">PAUSED</span>' : ''}</span></div>
                <div class="stat-row"><span class="stat-label">AI Model</span><span class="stat-value" style="color: #ff00ff;">GLM-4.7-Flash</span></div>
                <div class="stat-row"><span class="stat-label">AI Interval</span><span class="stat-value">${CONFIG.AI_INTERVAL_MS / 1000}s</span></div>
                <div class="stat-row"><span class="stat-label">Min Confidence</span><span class="stat-value">${(CONFIG.MIN_CONFIDENCE * 100).toFixed(0)}%</span></div>
            </div>
            
            <div class="card" style="grid-column: span 2;">
                <h2>Markets Overview</h2>
                <table>
                    <thead><tr><th>Market</th><th>Price</th><th>Trend</th><th>Imbalance</th><th>Vol</th><th>Position</th><th>Entry</th><th>P&L</th><th>AI SL/TP</th><th>Hold</th></tr></thead>
                    <tbody>
                        ${ACTIVE_MARKETS.map(symbol => {
                            const m = botStatus.markets[symbol] || {};
                            const ms = marketStates[symbol] || {};
                            const pos = m.position;
                            const volClass = (m.volatility || 0) < 0.2 ? 'positive' : (m.volatility || 0) < 0.4 ? 'neutral' : 'negative';
                            let pnlVal = 0;
                            if (pos && ms.entryPrice > 0 && m.price > 0) {
                                const pm = pos === 'LONG' 
                                    ? ((m.price - ms.entryPrice) / ms.entryPrice * 100)
                                    : ((ms.entryPrice - m.price) / ms.entryPrice * 100);
                                pnlVal = pm * CONFIG.LEVERAGE;
                                if (Math.abs(pnlVal) > 1000) pnlVal = 0;
                            }
                            const holdMin = pos && ms.entryTime ? ((Date.now() - ms.entryTime) / 60000).toFixed(0) + 'm' : '-';
                            return `<tr>
                                <td><strong>${symbol}</strong></td>
                                <td>$${(m.price || 0).toFixed(2)}</td>
                                <td class="${m.trend === 'UPTREND' ? 'positive' : m.trend === 'DOWNTREND' ? 'negative' : 'neutral'}">${m.trend || 'BUILDING'}</td>
                                <td class="${(m.imbalance || 0) > 0 ? 'positive' : 'negative'}">${((m.imbalance || 0) * 100).toFixed(1)}%</td>
                                <td class="${volClass}">${(m.volatility || 0).toFixed(2)}%</td>
                                <td class="${pos === 'LONG' ? 'positive' : pos === 'SHORT' ? 'negative' : ''}">${pos || 'NONE'}</td>
                                <td>${pos ? '$' + ms.entryPrice.toFixed(2) : '-'}</td>
                                <td class="${pnlVal >= 0 ? 'positive' : 'negative'}">${pos ? pnlVal.toFixed(2) + '%' : '-'}</td>
                                <td>${pos && ms.aiStopLoss != null ? ms.aiStopLoss.toFixed(1) + '/' + (ms.aiTakeProfit != null ? ms.aiTakeProfit.toFixed(1) : '?') : (pos ? 'synced' : '-')}</td>
                                <td>${holdMin}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Technical Indicators (What AI Sees)</h2>
                <table>
                    <thead><tr><th>Market</th><th>TF</th><th>RSI</th><th>EMA 9/21</th><th>MACD</th><th>BB Position</th><th>ATR</th><th>StochRSI</th><th>ADX</th><th>Data</th></tr></thead>
                    <tbody>
                        ${ACTIVE_MARKETS.map(symbol => {
                            const ms = marketStates[symbol] || {};
                            return ['1m', '5m', '15m'].map(tf => {
                                const ind = tf === '1m' ? ms.indicators1m : tf === '5m' ? ms.indicators5m : ms.indicators15m;
                                if (!ind || !ind.ready) return '<tr><td>' + symbol + '</td><td>' + tf + '</td><td colspan="8" style="color:#484f58;">Building data...</td></tr>';
                                const rsiVal = ind.rsi !== null ? ind.rsi.toFixed(1) : '-';
                                const rsiClass = ind.rsi > 70 ? 'negative' : ind.rsi < 30 ? 'positive' : '';
                                const rsiLabel = ind.rsi > 70 ? ' OB' : ind.rsi < 30 ? ' OS' : '';
                                const emaText = ind.ema9 !== null && ind.ema21 !== null ? (ind.ema9 > ind.ema21 ? 'BULL' : 'BEAR') : '-';
                                const emaClass = emaText === 'BULL' ? 'positive' : emaText === 'BEAR' ? 'negative' : '';
                                const macdText = ind.macd ? (ind.macd.histogram > 0 ? '+' + ind.macd.histogram.toFixed(4) : ind.macd.histogram.toFixed(4)) : '-';
                                const macdClass = ind.macd ? (ind.macd.histogram > 0 ? 'positive' : 'negative') : '';
                                const bbText = ind.bollinger ? ((ind.ema9 || ind.bollinger.middle) > ind.bollinger.lower ? (((ind.ema9 || ind.bollinger.middle) - ind.bollinger.lower) / (ind.bollinger.upper - ind.bollinger.lower) * 100).toFixed(0) + '%' : '-') : '-';
                                const atrText = ind.atr !== null ? ind.atr.toFixed(4) : '-';
                                const stochText = ind.stochRSI ? 'K:' + ind.stochRSI.k.toFixed(0) + ' D:' + ind.stochRSI.d.toFixed(0) : '-';
                                const stochClass = ind.stochRSI ? (ind.stochRSI.k > 80 ? 'negative' : ind.stochRSI.k < 20 ? 'positive' : '') : '';
                                const adxText = ind.adx ? ind.adx.adx.toFixed(1) + (ind.adx.plusDI > ind.adx.minusDI ? ' +' : ' -') : '-';
                                const adxClass = ind.adx ? (ind.adx.adx > 25 ? 'positive' : ind.adx.adx < 20 ? 'negative' : 'neutral') : '';
                                return '<tr><td>' + (tf === '1m' ? '<strong>' + symbol + '</strong>' : '') + '</td><td>' + tf + '</td>' +
                                    '<td class="' + rsiClass + '">' + rsiVal + rsiLabel + '</td>' +
                                    '<td class="' + emaClass + '">' + emaText + '</td>' +
                                    '<td class="' + macdClass + '">' + macdText + '</td>' +
                                    '<td>' + bbText + '</td>' +
                                    '<td>' + atrText + '</td>' +
                                    '<td class="' + stochClass + '">' + stochText + '</td>' +
                                    '<td class="' + adxClass + '">' + adxText + '</td>' +
                                    '<td style="color:#484f58;">' + (ind.indicatorsAvailable || 0) + '/' + (ind.indicatorsTotal || 9) + '</td></tr>';
                            }).join('');
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <h2>Session Stats</h2>
                <div class="stat-row"><span class="stat-label">Total Trades</span><span class="stat-value">${stats.totalTrades}</span></div>
                <div class="stat-row"><span class="stat-label">Wins / Losses</span><span class="stat-value"><span class="positive">${stats.wins}</span> / <span class="negative">${stats.losses}</span></span></div>
                <div class="stat-row"><span class="stat-label">Win Rate</span><span class="stat-value ${parseFloat(winRate) >= 50 ? 'positive' : 'negative'}">${winRate}%</span></div>
                <div class="stat-row"><span class="stat-label">Total P&L</span><span class="stat-value ${stats.totalProfitPercent >= 0 ? 'positive' : 'negative'}">${stats.totalProfitPercent.toFixed(2)}%</span></div>
            </div>

            <div class="card">
                <h2>Daily Safety</h2>
                <div class="stat-row"><span class="stat-label">Daily P&L</span><span class="stat-value ${safetyStatus.dailyPnl >= 0 ? 'positive' : 'negative'}">${safetyStatus.dailyPnl.toFixed(2)}%</span></div>
                <div class="stat-row"><span class="stat-label">Daily Loss Limit</span><span class="stat-value">-${safetyStatus.dailyLossLimit}%</span></div>
                <div class="stat-row"><span class="stat-label">Daily Trades</span><span class="stat-value">${safetyStatus.dailyTrades}</span></div>
                <div class="stat-row"><span class="stat-label">Daily Win Rate</span><span class="stat-value">${safetyStatus.dailyWinRate}%</span></div>
                <div class="stat-row"><span class="stat-label">Consec. Losses</span><span class="stat-value ${safetyStatus.consecutiveLosses >= 5 ? 'negative' : ''}">${safetyStatus.consecutiveLosses} / ${safetyStatus.maxConsecutiveLosses}</span></div>
                <div class="stat-row"><span class="stat-label">Status</span><span class="${safetyStatus.paused ? 'negative' : 'positive'}">${safetyStatus.paused ? 'PAUSED: ' + safetyStatus.pauseReason : 'ACTIVE'}</span></div>
            </div>

            <div class="card">
                <h2>Best / Worst Trade</h2>
                <div class="best-worst">
                    <div>
                        <div style="color: #3fb950; font-weight: bold; margin-bottom: 5px;">Best</div>
                        ${bestTrade ? `<div style="font-size: 1.3em; color: #3fb950;">+${(bestTrade.profitPercent || 0).toFixed(2)}%</div><div style="font-size: 0.8em; color: #8b949e;">${bestTrade.direction} | ${bestTrade.symbol || ''}</div>` : '<div style="color: #484f58;">No trades yet</div>'}
                    </div>
                    <div>
                        <div style="color: #f85149; font-weight: bold; margin-bottom: 5px;">Worst</div>
                        ${worstTrade ? `<div style="font-size: 1.3em; color: #f85149;">${(worstTrade.profitPercent || 0).toFixed(2)}%</div><div style="font-size: 0.8em; color: #8b949e;">${worstTrade.direction} | ${worstTrade.symbol || ''}</div>` : '<div style="color: #484f58;">No trades yet</div>'}
                    </div>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>AI Brain - Live Decisions</h2>
                <div style="max-height: 400px; overflow-y: auto;">
                    ${brainLog.slice(0, 50).map(t => {
                        const color = categoryColors[t.category] || '#888';
                        return `<div class="thinking-entry" style="border-left-color: ${color};">
                            <span class="thinking-time">${new Date(t.time).toLocaleTimeString()}</span>
                            <span style="color: ${color}; font-weight: 600; text-transform: uppercase; font-size: 0.75em;">[${t.category}]</span>
                            ${t.message}
                        </div>`;
                    }).join('') || '<div style="color: #484f58; padding: 20px; text-align: center;">Waiting for AI decisions...</div>'}
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card full-width">
                <h2>Recent Trades</h2>
                <table>
                    <tr><th>Time</th><th>Market</th><th>Direction</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Exit Reason</th><th>Hold</th><th>AI SL/TP</th><th>AI Reasoning</th></tr>
                    ${recentTrades.map(t => `<tr>
                        <td style="font-size:0.8em;">${new Date(t.timestamp).toLocaleTimeString()}</td>
                        <td>${t.symbol}</td>
                        <td class="${t.direction === 'LONG' ? 'positive' : 'negative'}">${t.direction}</td>
                        <td>$${(t.entryPrice || 0).toFixed(2)}</td>
                        <td>$${(t.exitPrice || 0).toFixed(2)}</td>
                        <td class="${t.profitPercent >= 0 ? 'positive' : 'negative'}">${t.profitPercent >= 0 ? '+' : ''}${t.profitPercent.toFixed(2)}%</td>
                        <td>${t.exitReason}</td>
                        <td>${t.holdTimeMin || '?'}m</td>
                        <td>${t.aiStopLoss ? t.aiStopLoss.toFixed(1) + '/' + t.aiTakeProfit.toFixed(1) : '-'}</td>
                        <td style="font-size:0.75em; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${(t.aiReason || '').replace(/"/g, '&quot;')}">${t.aiReason || '-'}</td>
                    </tr>`).join('') || '<tr><td colspan="10" style="color: #484f58; text-align: center; padding: 20px;">No trades yet - AI is analyzing markets...</td></tr>'}
                </table>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function startDashboard() {
    const server = http.createServer((req, res) => {
        if (req.url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify({ status: botStatus, safety: safety.getStatus(), stats: tradeMemory.sessionStats }));
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
    log('   AI TRADING BOT - GLM-4.7 Flash');
    log(`   Drift Protocol | ${CONFIG.LEVERAGE}x Leverage | AI-Driven`);
    log('═══════════════════════════════════════════════════════════');
    log(`Mode: ${CONFIG.SIMULATION_MODE ? 'SIMULATION (Paper Trading)' : 'LIVE TRADING'}`);
    log(`Leverage: ${CONFIG.LEVERAGE}x`);
    log(`Active Markets: ${ACTIVE_MARKETS.join(', ')}`);
    log(`Trade Size: ${CONFIG.TRADE_AMOUNT_USDC} USDC per market`);
    log(`AI Check Interval: ${CONFIG.AI_INTERVAL_MS / 1000}s`);
    log(`Position Check Interval: ${CONFIG.CHECK_INTERVAL_MS / 1000}s`);
    log(`Min Confidence: ${(CONFIG.MIN_CONFIDENCE * 100).toFixed(0)}%`);
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
    startDashboard();

    aiBrain.think('Bot starting up - AI brain online with technical indicators (RSI, EMA, MACD, BB, ATR, StochRSI, ADX)', 'ai_brain');

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

        log('Starting AI trading loop...');
        setInterval(tradingLoop, CONFIG.CHECK_INTERVAL_MS);

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
