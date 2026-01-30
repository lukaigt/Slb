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
    BulkAccountLoader,
    getMarketsAndOraclesForSubscription,
    PerpMarkets,
} = require('@drift-labs/sdk');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const dotenv = require('dotenv');
const { RSI, EMA, BollingerBands } = require('technicalindicators');

dotenv.config();

const CONFIG = {
    RPC_URL: process.env.SOLANA_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    LEVERAGE: parseInt(process.env.LEVERAGE) || 50,
    SYMBOL: process.env.SYMBOL || 'SOL-PERP',
    TRADE_AMOUNT_USDC: parseFloat(process.env.TRADE_AMOUNT_USDC) || 10,
    STOP_LOSS_PERCENT: parseFloat(process.env.STOP_LOSS_PERCENT) || 0.8,
    TRAILING_TP_START: parseFloat(process.env.TRAILING_TP_START_PERCENT) || 2.0,
    TRAILING_TP_DISTANCE: parseFloat(process.env.TRAILING_TP_DISTANCE_PERCENT) || 0.5,
    EMA_SHORT: 20,
    EMA_LONG: 50,
    RSI_PERIOD: 14,
    RSI_OVERSOLD: 30,
    RSI_OVERBOUGHT: 70,
    MIN_VOLUME_MULTIPLIER: 1.5,
    CHECK_INTERVAL_MS: 10000,
};

const priceHistory = [];
let currentPosition = null;
let entryPrice = 0;
let highestPriceSinceEntry = 0;
let lowestPriceSinceEntry = Infinity;
let trailingStopActive = false;
let driftClient = null;
let marketIndex = 0;
let lastOrderTime = 0;
const ORDER_COOLDOWN_MS = 30000;

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function calculateIndicators() {
    if (priceHistory.length < CONFIG.EMA_LONG) {
        return null;
    }

    const emaShort = EMA.calculate({ period: CONFIG.EMA_SHORT, values: priceHistory });
    const emaLong = EMA.calculate({ period: CONFIG.EMA_LONG, values: priceHistory });
    const rsiValues = RSI.calculate({ period: CONFIG.RSI_PERIOD, values: priceHistory });
    const bbands = BollingerBands.calculate({ 
        period: 20, 
        values: priceHistory, 
        stdDev: 2 
    });

    if (emaShort.length === 0 || emaLong.length === 0 || rsiValues.length === 0) {
        return null;
    }

    const currentEmaShort = emaShort[emaShort.length - 1];
    const currentEmaLong = emaLong[emaLong.length - 1];
    const currentRsi = rsiValues[rsiValues.length - 1];
    const currentBB = bbands.length > 0 ? bbands[bbands.length - 1] : null;
    const currentPrice = priceHistory[priceHistory.length - 1];

    return {
        emaShort: currentEmaShort,
        emaLong: currentEmaLong,
        rsi: currentRsi,
        bb: currentBB,
        price: currentPrice,
        emaTrend: currentEmaShort > currentEmaLong ? 'BULLISH' : 'BEARISH',
    };
}

function shouldOpenLong(indicators) {
    if (!indicators || !indicators.bb) return false;

    const emaBullish = indicators.emaTrend === 'BULLISH';
    const rsiOversold = indicators.rsi < CONFIG.RSI_OVERSOLD + 10;
    const priceBelowMiddleBB = indicators.price < indicators.bb.middle;

    const signal = emaBullish && rsiOversold && priceBelowMiddleBB;

    if (signal) {
        log(`LONG SIGNAL: EMA=${indicators.emaTrend}, RSI=${indicators.rsi.toFixed(2)}`);
    }

    return signal;
}

function shouldOpenShort(indicators) {
    if (!indicators || !indicators.bb) return false;

    const emaBearish = indicators.emaTrend === 'BEARISH';
    const rsiOverbought = indicators.rsi > CONFIG.RSI_OVERBOUGHT - 10;
    const priceAboveMiddleBB = indicators.price > indicators.bb.middle;

    const signal = emaBearish && rsiOverbought && priceAboveMiddleBB;

    if (signal) {
        log(`SHORT SIGNAL: EMA=${indicators.emaTrend}, RSI=${indicators.rsi.toFixed(2)}`);
    }

    return signal;
}

function checkStopLoss(currentPrice) {
    if (!currentPosition) return false;

    const priceMovePercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    if (currentPosition === 'LONG') {
        if (priceMovePercent <= -CONFIG.STOP_LOSS_PERCENT) {
            log(`STOP LOSS HIT (LONG): Entry=${entryPrice.toFixed(4)}, Current=${currentPrice.toFixed(4)}, Loss=${priceMovePercent.toFixed(2)}%`);
            return true;
        }
    } else if (currentPosition === 'SHORT') {
        if (priceMovePercent >= CONFIG.STOP_LOSS_PERCENT) {
            log(`STOP LOSS HIT (SHORT): Entry=${entryPrice.toFixed(4)}, Current=${currentPrice.toFixed(4)}, Loss=${(-priceMovePercent).toFixed(2)}%`);
            return true;
        }
    }

    return false;
}

function checkTrailingTakeProfit(currentPrice) {
    if (!currentPosition) return false;

    let profitPercent = 0;

    if (currentPosition === 'LONG') {
        profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

        if (currentPrice > highestPriceSinceEntry) {
            highestPriceSinceEntry = currentPrice;
        }

        if (profitPercent >= CONFIG.TRAILING_TP_START) {
            trailingStopActive = true;
        }

        if (trailingStopActive) {
            const dropFromHigh = ((highestPriceSinceEntry - currentPrice) / highestPriceSinceEntry) * 100;
            if (dropFromHigh >= CONFIG.TRAILING_TP_DISTANCE) {
                log(`TRAILING TP HIT (LONG): High=${highestPriceSinceEntry.toFixed(4)}, Current=${currentPrice.toFixed(4)}, Profit=${profitPercent.toFixed(2)}%`);
                return true;
            }
        }
    } else if (currentPosition === 'SHORT') {
        profitPercent = ((entryPrice - currentPrice) / entryPrice) * 100;

        if (currentPrice < lowestPriceSinceEntry) {
            lowestPriceSinceEntry = currentPrice;
        }

        if (profitPercent >= CONFIG.TRAILING_TP_START) {
            trailingStopActive = true;
        }

        if (trailingStopActive) {
            const riseFromLow = ((currentPrice - lowestPriceSinceEntry) / lowestPriceSinceEntry) * 100;
            if (riseFromLow >= CONFIG.TRAILING_TP_DISTANCE) {
                log(`TRAILING TP HIT (SHORT): Low=${lowestPriceSinceEntry.toFixed(4)}, Current=${currentPrice.toFixed(4)}, Profit=${profitPercent.toFixed(2)}%`);
                return true;
            }
        }
    }

    return false;
}

async function openPosition(direction) {
    const now = Date.now();
    if (now - lastOrderTime < ORDER_COOLDOWN_MS) {
        log('Order cooldown active, skipping...');
        return false;
    }

    try {
        const currentPrice = priceHistory[priceHistory.length - 1];
        const notionalValue = CONFIG.TRADE_AMOUNT_USDC * CONFIG.LEVERAGE;
        const baseAssetAmountRaw = notionalValue / currentPrice;
        const baseAssetAmount = driftClient.convertToPerpPrecision(baseAssetAmountRaw);

        log(`Opening ${direction}: $${CONFIG.TRADE_AMOUNT_USDC} x ${CONFIG.LEVERAGE}x = $${notionalValue} notional`);
        log(`Base amount: ${baseAssetAmountRaw.toFixed(6)} SOL at $${currentPrice.toFixed(4)}`);

        const orderParams = {
            orderType: OrderType.MARKET,
            marketType: MarketType.PERP,
            marketIndex: marketIndex,
            direction: direction === 'LONG' ? PositionDirection.LONG : PositionDirection.SHORT,
            baseAssetAmount: baseAssetAmount,
        };

        const txSig = await driftClient.placePerpOrder(orderParams);
        log(`Order placed. TX: ${txSig}`);

        lastOrderTime = now;
        currentPosition = direction;
        entryPrice = currentPrice;
        highestPriceSinceEntry = currentPrice;
        lowestPriceSinceEntry = currentPrice;
        trailingStopActive = false;

        return true;
    } catch (error) {
        log(`Error opening position: ${error.message}`);
        return false;
    }
}

async function closePosition() {
    const now = Date.now();
    if (now - lastOrderTime < ORDER_COOLDOWN_MS) {
        log('Order cooldown active, skipping close...');
        return false;
    }

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

        lastOrderTime = now;
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
                
                log(`Synced entry price: $${entryPrice.toFixed(4)}`);
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
            log('Waiting for oracle data...');
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

        const indicators = calculateIndicators();

        if (!indicators) {
            log(`Building history... ${priceHistory.length}/${CONFIG.EMA_LONG} candles`);
            return;
        }

        log(`Price: $${price.toFixed(4)} | EMA: ${indicators.emaTrend} | RSI: ${indicators.rsi.toFixed(2)} | Pos: ${currentPosition || 'NONE'}`);

        if (currentPosition) {
            if (checkStopLoss(price)) {
                await closePosition();
                return;
            }

            if (checkTrailingTakeProfit(price)) {
                await closePosition();
                return;
            }
        } else {
            if (shouldOpenLong(indicators)) {
                await openPosition('LONG');
            } else if (shouldOpenShort(indicators)) {
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
    log('Available markets:');
    perpMarkets.slice(0, 15).forEach(m => {
        const name = Buffer.from(m.name).toString('utf8').trim().replace(/\0/g, '');
        log(`  - ${name} (Index: ${m.marketIndex})`);
    });

    log('Please check your SYMBOL in .env file and try again.');
    process.exit(1);
}

async function main() {
    log('===========================================');
    log('   SOLANA FUTURES BOT - DRIFT PROTOCOL');
    log('===========================================');
    log(`Leverage: ${CONFIG.LEVERAGE}x`);
    log(`Symbol: ${CONFIG.SYMBOL}`);
    log(`Trade Size: ${CONFIG.TRADE_AMOUNT_USDC} USDC`);
    log(`Stop Loss: ${CONFIG.STOP_LOSS_PERCENT}%`);
    log(`Trailing TP Start: ${CONFIG.TRAILING_TP_START}%`);
    log(`Trailing TP Distance: ${CONFIG.TRAILING_TP_DISTANCE}%`);
    log('===========================================');

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
            log('Make sure your PRIVATE_KEY in .env is the base58 key from Phantom (no quotes)');
            process.exit(1);
        }
        
        const keypair = Keypair.fromSecretKey(privateKeyBytes);
        const wallet = new Wallet(keypair);

        log(`Wallet: ${keypair.publicKey.toBase58()}`);

        const sdkConfig = initialize({ env: 'mainnet-beta' });

        const accountLoader = new BulkAccountLoader(connection, 'confirmed', 5000);

        driftClient = new DriftClient({
            connection,
            wallet,
            programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
            accountSubscription: {
                type: 'polling',
                accountLoader: accountLoader,
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

        log('Starting trading loop...');
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
