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
    BASE_PRECISION,
    QUOTE_PRECISION,
    getMarketsAndOraclesForSubscription,
    PerpMarkets,
} = require('@drift-labs/sdk');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const dotenv = require('dotenv');

dotenv.config();

const CONFIG = {
    RPC_URL: process.env.SOLANA_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    LEVERAGE: parseInt(process.env.LEVERAGE) || 50,
    SYMBOL: process.env.SYMBOL || 'SOL-PERP',
    TRADE_AMOUNT_USDC: parseFloat(process.env.TRADE_AMOUNT_USDC) || 10,
    
    IMBALANCE_THRESHOLD: parseFloat(process.env.IMBALANCE_THRESHOLD) || 0.25,
    CVD_LOOKBACK: parseInt(process.env.CVD_LOOKBACK) || 5,
    VWAP_PERIOD: parseInt(process.env.VWAP_PERIOD) || 50,
    
    STOP_LOSS_PERCENT: parseFloat(process.env.STOP_LOSS_PERCENT) || 0.5,
    TAKE_PROFIT_ACTIVATION: parseFloat(process.env.TAKE_PROFIT_ACTIVATION) || 0.4,
    TRAILING_NORMAL: parseFloat(process.env.TRAILING_NORMAL) || 0.15,
    TRAILING_DANGER: parseFloat(process.env.TRAILING_DANGER) || 0.05,
    
    ORDER_COOLDOWN_MS: (parseInt(process.env.COOLDOWN_SECONDS) || 120) * 1000,
    CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS) || 5000,
    DLOB_URL: 'https://dlob.drift.trade',
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

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

async function fetchOrderBook() {
    try {
        const response = await fetch(
            `${CONFIG.DLOB_URL}/l2?marketName=${CONFIG.SYMBOL}&depth=10`
        );
        
        if (!response.ok) {
            log(`DLOB API error: ${response.status}`);
            return null;
        }
        
        const data = await response.json();
        
        if (!data || !data.bids || !data.asks || !Array.isArray(data.bids) || !Array.isArray(data.asks)) {
            log('Invalid order book format');
            return null;
        }
        
        return data;
    } catch (error) {
        log(`Error fetching order book: ${error.message}`);
        return null;
    }
}

function calculateImbalance(orderBook) {
    if (!orderBook || !orderBook.bids || !orderBook.asks) {
        return 0;
    }
    
    let totalBids = 0;
    let totalAsks = 0;
    
    for (const bid of orderBook.bids.slice(0, 10)) {
        const size = Array.isArray(bid) ? parseFloat(bid[1]) : parseFloat(bid.size || 0);
        if (!isNaN(size)) totalBids += size;
    }
    
    for (const ask of orderBook.asks.slice(0, 10)) {
        const size = Array.isArray(ask) ? parseFloat(ask[1]) : parseFloat(ask.size || 0);
        if (!isNaN(size)) totalAsks += size;
    }
    
    if (totalBids + totalAsks === 0) return 0;
    
    const imbalance = (totalBids - totalAsks) / (totalBids + totalAsks);
    return imbalance;
}

function getImbalanceTrend() {
    if (imbalanceHistory.length < CONFIG.CVD_LOOKBACK) return 'FLAT';
    
    const recent = imbalanceHistory.slice(-CONFIG.CVD_LOOKBACK);
    let bullishCount = 0;
    let bearishCount = 0;
    
    for (const imb of recent) {
        if (imb > 0.1) bullishCount++;
        else if (imb < -0.1) bearishCount++;
    }
    
    if (bullishCount >= CONFIG.CVD_LOOKBACK - 1) return 'RISING';
    if (bearishCount >= CONFIG.CVD_LOOKBACK - 1) return 'FALLING';
    return 'FLAT';
}

function calculateVWAP() {
    if (priceHistory.length < 2) {
        return priceHistory.length > 0 ? priceHistory[priceHistory.length - 1] : 0;
    }
    
    const period = Math.min(CONFIG.VWAP_PERIOD, priceHistory.length);
    const prices = priceHistory.slice(-period);
    
    let sum = 0;
    for (const p of prices) {
        sum += p;
    }
    
    return sum / prices.length;
}

function shouldOpenLong(imbalance, imbalanceTrend, price, avgPrice) {
    const now = Date.now();
    if (now - lastOrderTime < CONFIG.ORDER_COOLDOWN_MS) {
        return false;
    }
    
    if (imbalanceHistory.length < CONFIG.CVD_LOOKBACK) {
        return false;
    }
    
    const imbalanceBullish = imbalance >= CONFIG.IMBALANCE_THRESHOLD;
    const trendBullish = imbalanceTrend === 'RISING';
    const priceAtOrBelowAvg = price <= avgPrice * 1.002;
    
    if (imbalanceBullish && trendBullish && priceAtOrBelowAvg) {
        log(`✓ LONG SIGNAL: Imbalance=${(imbalance * 100).toFixed(1)}% | Trend=${imbalanceTrend} | Price=$${price.toFixed(4)} <= Avg=$${avgPrice.toFixed(4)}`);
        return true;
    }
    
    return false;
}

function shouldOpenShort(imbalance, imbalanceTrend, price, avgPrice) {
    const now = Date.now();
    if (now - lastOrderTime < CONFIG.ORDER_COOLDOWN_MS) {
        return false;
    }
    
    if (imbalanceHistory.length < CONFIG.CVD_LOOKBACK) {
        return false;
    }
    
    const imbalanceBearish = imbalance <= -CONFIG.IMBALANCE_THRESHOLD;
    const trendBearish = imbalanceTrend === 'FALLING';
    const priceAtOrAboveAvg = price >= avgPrice * 0.998;
    
    if (imbalanceBearish && trendBearish && priceAtOrAboveAvg) {
        log(`✓ SHORT SIGNAL: Imbalance=${(imbalance * 100).toFixed(1)}% | Trend=${imbalanceTrend} | Price=$${price.toFixed(4)} >= Avg=$${avgPrice.toFixed(4)}`);
        return true;
    }
    
    return false;
}

function checkDangerSignals(imbalance, imbalanceTrend) {
    if (!currentPosition) return false;
    
    if (currentPosition === 'LONG') {
        if (imbalance < 0 || imbalanceTrend === 'FALLING') {
            if (!dangerMode) {
                log(`⚠️ DANGER MODE: Reversal signals detected while LONG`);
            }
            return true;
        }
    } else if (currentPosition === 'SHORT') {
        if (imbalance > 0 || imbalanceTrend === 'RISING') {
            if (!dangerMode) {
                log(`⚠️ DANGER MODE: Reversal signals detected while SHORT`);
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

async function openPosition(direction) {
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

        return true;
    } catch (error) {
        log(`Error opening position: ${error.message}`);
        return false;
    }
}

async function closePosition() {
    try {
        log(`Closing ${currentPosition} position...`);

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
            profitPercent = ((exitPrice - entryPrice) / entryPrice) * 100 * CONFIG.LEVERAGE;
        } else {
            profitPercent = ((entryPrice - exitPrice) / entryPrice) * 100 * CONFIG.LEVERAGE;
        }

        log(`Trade result: Entry=$${entryPrice.toFixed(4)}, Exit=$${exitPrice.toFixed(4)}, P&L=${profitPercent.toFixed(2)}% (leveraged)`);

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
        if (priceHistory.length > 200) priceHistory.shift();

        return price;
    } catch (error) {
        log(`Error fetching price: ${error.message}`);
        return null;
    }
}

async function tradingLoop() {
    try {
        const price = await fetchPrice();
        if (!price) return;

        await syncPositionFromChain();
        
        const orderBook = await fetchOrderBook();
        if (!orderBook) {
            log(`Waiting for order book data... Price: $${price.toFixed(4)}`);
            return;
        }
        
        const imbalance = calculateImbalance(orderBook);
        
        imbalanceHistory.push(imbalance);
        if (imbalanceHistory.length > 100) imbalanceHistory.shift();
        
        const imbalanceTrend = getImbalanceTrend();
        const avgPrice = calculateVWAP();

        if (priceHistory.length < CONFIG.VWAP_PERIOD || imbalanceHistory.length < CONFIG.CVD_LOOKBACK) {
            log(`Building history... Prices: ${priceHistory.length}/${CONFIG.VWAP_PERIOD} | Imbalances: ${imbalanceHistory.length}/${CONFIG.CVD_LOOKBACK} | Price: $${price.toFixed(4)}`);
            return;
        }

        const modeStr = currentPosition ? (dangerMode ? '🔴 DANGER' : '🟢 NORMAL') : '⚪ NONE';
        log(`Price: $${price.toFixed(4)} | Avg: $${avgPrice.toFixed(4)} | Imbalance: ${(imbalance * 100).toFixed(1)}% | Trend: ${imbalanceTrend} | Pos: ${currentPosition || 'NONE'} | ${modeStr}`);

        if (currentPosition) {
            dangerMode = checkDangerSignals(imbalance, imbalanceTrend);
            
            if (checkStopLoss(price)) {
                await closePosition();
                return;
            }

            if (checkTrailingTakeProfit(price)) {
                await closePosition();
                return;
            }
        } else {
            if (shouldOpenLong(imbalance, imbalanceTrend, price, avgPrice)) {
                await openPosition('LONG');
            } else if (shouldOpenShort(imbalance, imbalanceTrend, price, avgPrice)) {
                await openPosition('SHORT');
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
    log('   SMART SOLANA FUTURES BOT - DRIFT PROTOCOL');
    log('   Order Book Imbalance + Trend Strategy');
    log('═══════════════════════════════════════════════════════════');
    log(`Leverage: ${CONFIG.LEVERAGE}x`);
    log(`Symbol: ${CONFIG.SYMBOL}`);
    log(`Trade Size: ${CONFIG.TRADE_AMOUNT_USDC} USDC`);
    log(`Imbalance Threshold: ${(CONFIG.IMBALANCE_THRESHOLD * 100).toFixed(0)}%`);
    log(`Stop Loss: ${CONFIG.STOP_LOSS_PERCENT}%`);
    log(`Take Profit Activation: ${CONFIG.TAKE_PROFIT_ACTIVATION}%`);
    log(`Trailing (Normal): ${CONFIG.TRAILING_NORMAL}% | (Danger): ${CONFIG.TRAILING_DANGER}%`);
    log(`Cooldown: ${CONFIG.ORDER_COOLDOWN_MS / 1000}s`);
    log('═══════════════════════════════════════════════════════════');

    if (!CONFIG.RPC_URL || !CONFIG.PRIVATE_KEY) {
        log('ERROR: Missing RPC_URL or PRIVATE_KEY in .env file');
        process.exit(1);
    }

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

        log('Starting smart trading loop...');
        log('Press Ctrl+C to stop the bot safely.');

        setInterval(tradingLoop, CONFIG.CHECK_INTERVAL_MS);

        process.on('SIGINT', async () => {
            log('Shutting down...');
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
