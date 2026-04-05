const WebSocket = require('ws');
const https = require('https');

const KRAKEN_WS_URL = 'wss://ws.kraken.com/v2';
const KRAKEN_REST_URL = 'https://api.kraken.com';

const SYMBOL_MAP = {
    'SOL-PERP': 'SOL/USD',
    'BTC-PERP': 'XBT/USD',
    'ETH-PERP': 'ETH/USD',
    'DOGE-PERP': 'XDG/USD',
    'AVAX-PERP': 'AVAX/USD',
    'LINK-PERP': 'LINK/USD',
    'ADA-PERP': 'ADA/USD',
    'DOT-PERP': 'DOT/USD',
    'ATOM-PERP': 'ATOM/USD',
    'NEAR-PERP': 'NEAR/USD',
    'SUI-PERP': 'SUI/USD',
    'LTC-PERP': 'LTC/USD',
    'XMR-PERP': 'XMR/USD',
    'ALGO-PERP': 'ALGO/USD',
    'HBAR-PERP': 'HBAR/USD',
    'TRX-PERP': 'TRX/USD',
    'RENDER-PERP': 'RENDER/USD',
    'APT-PERP': 'APT/USD',
    'UNI-PERP': 'UNI/USD',
    'ARB-PERP': 'ARB/USD',
    'OP-PERP': 'OP/USD',
    'FIL-PERP': 'FIL/USD',
    'POL-PERP': 'POL/USD'
};

const REST_PAIR_MAP = {
    'SOL-PERP': 'SOLUSD',
    'BTC-PERP': 'XXBTZUSD',
    'ETH-PERP': 'XETHZUSD',
    'DOGE-PERP': 'XDGUSD',
    'AVAX-PERP': 'AVAXUSD',
    'LINK-PERP': 'LINKUSD',
    'ADA-PERP': 'ADAUSD',
    'DOT-PERP': 'DOTUSD',
    'ATOM-PERP': 'ATOMUSD',
    'NEAR-PERP': 'NEARUSD',
    'SUI-PERP': 'SUIUSD',
    'LTC-PERP': 'XLTCZUSD',
    'XMR-PERP': 'XXMRZUSD',
    'ALGO-PERP': 'ALGOUSD',
    'HBAR-PERP': 'HBARUSD',
    'TRX-PERP': 'TRXUSD',
    'RENDER-PERP': 'RENDERUSD',
    'APT-PERP': 'APTUSD',
    'UNI-PERP': 'UNIUSD',
    'ARB-PERP': 'ARBUSD',
    'OP-PERP': 'OPUSD',
    'FIL-PERP': 'FILUSD',
    'POL-PERP': 'POLUSD'
};

class KrakenFeed {
    constructor(symbols) {
        this.symbols = symbols;
        this.krakenSymbols = symbols.map(s => SYMBOL_MAP[s]).filter(Boolean);
        this.ws = null;
        this.connected = false;
        this.prices = {};
        this.orderbooks = {};
        this.reconnectTimer = null;
        this.reconnectDelay = 5000;
        this.maxReconnectDelay = 60000;
        this.pingInterval = null;
        this.lastPriceTime = {};
        this.onPrice = null;

        for (const sym of symbols) {
            this.prices[sym] = null;
            this.orderbooks[sym] = { bids: [], asks: [] };
            this.lastPriceTime[sym] = 0;
        }
    }

    krakenToBot(krakenSym) {
        for (const [bot, kraken] of Object.entries(SYMBOL_MAP)) {
            if (kraken === krakenSym) return bot;
        }
        return null;
    }

    async fetchInitialCandles(symbol) {
        const restPair = REST_PAIR_MAP[symbol];
        if (!restPair) return [];

        return new Promise((resolve) => {
            const url = `${KRAKEN_REST_URL}/0/public/OHLC?pair=${restPair}&interval=1`;
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error && parsed.error.length > 0) {
                            console.log(`[KRAKEN] REST error for ${symbol}: ${parsed.error.join(', ')}`);
                            resolve([]);
                            return;
                        }
                        const keys = Object.keys(parsed.result).filter(k => k !== 'last');
                        if (keys.length === 0) { resolve([]); return; }
                        const candles = parsed.result[keys[0]];
                        const result = candles.map(c => ({
                            timestamp: c[0] * 1000,
                            open: parseFloat(c[1]),
                            high: parseFloat(c[2]),
                            low: parseFloat(c[3]),
                            close: parseFloat(c[4]),
                            volume: parseFloat(c[6])
                        }));
                        console.log(`[KRAKEN] Fetched ${result.length} candles for ${symbol}`);
                        resolve(result);
                    } catch (e) {
                        console.log(`[KRAKEN] Parse error for ${symbol}: ${e.message}`);
                        resolve([]);
                    }
                });
            }).on('error', (e) => {
                console.log(`[KRAKEN] REST request failed for ${symbol}: ${e.message}`);
                resolve([]);
            });
        });
    }

    async fetchOrderBookREST(symbol) {
        const restPair = REST_PAIR_MAP[symbol];
        if (!restPair) return null;

        return new Promise((resolve) => {
            const url = `${KRAKEN_REST_URL}/0/public/Depth?pair=${restPair}&count=20`;
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error && parsed.error.length > 0) { resolve(null); return; }
                        const keys = Object.keys(parsed.result);
                        if (keys.length === 0) { resolve(null); return; }
                        const book = parsed.result[keys[0]];
                        resolve({
                            bids: (book.bids || []).map(b => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })),
                            asks: (book.asks || []).map(a => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) }))
                        });
                    } catch (e) {
                        resolve(null);
                    }
                });
            }).on('error', () => resolve(null));
        });
    }

    async bootstrapHistory() {
        const results = {};
        for (let i = 0; i < this.symbols.length; i++) {
            const symbol = this.symbols[i];
            const candles = await this.fetchInitialCandles(symbol);
            if (candles.length > 0) {
                const prices = [];
                const timestamps = [];
                for (const c of candles) {
                    prices.push(c.close);
                    timestamps.push(c.timestamp);
                }
                results[symbol] = { prices, timestamps };
                this.prices[symbol] = candles[candles.length - 1].close;
                this.lastPriceTime[symbol] = Date.now();
                console.log(`[KRAKEN] ${symbol} bootstrapped: ${prices.length} price points, latest: $${this.prices[symbol].toFixed(2)}`);
            }

            const book = await this.fetchOrderBookREST(symbol);
            if (book) {
                this.orderbooks[symbol] = book;
            }

            if (i < this.symbols.length - 1) {
                await new Promise(r => setTimeout(r, 1200));
            }
        }
        return results;
    }

    connect() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }

        console.log('[KRAKEN] Connecting to WebSocket...');
        this.ws = new WebSocket(KRAKEN_WS_URL);

        this.ws.on('open', () => {
            console.log('[KRAKEN] WebSocket connected');
            this.connected = true;
            this.reconnectDelay = 5000;

            this.ws.send(JSON.stringify({
                method: 'subscribe',
                params: {
                    channel: 'ticker',
                    symbol: this.krakenSymbols
                }
            }));

            this.ws.send(JSON.stringify({
                method: 'subscribe',
                params: {
                    channel: 'book',
                    symbol: this.krakenSymbols,
                    depth: 25
                }
            }));

            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ method: 'ping' }));
                }
            }, 30000);
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                this.handleMessage(msg);
            } catch (e) {}
        });

        this.ws.on('close', () => {
            console.log('[KRAKEN] WebSocket disconnected');
            this.connected = false;
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.log(`[KRAKEN] WebSocket error: ${err.message}`);
            this.connected = false;
        });
    }

    handleMessage(msg) {
        if (msg.channel === 'ticker' && msg.type === 'update' && msg.data) {
            for (const tick of msg.data) {
                const botSymbol = this.krakenToBot(tick.symbol);
                if (!botSymbol) continue;

                const price = parseFloat(tick.last);
                if (price > 0) {
                    this.prices[botSymbol] = price;
                    this.lastPriceTime[botSymbol] = Date.now();
                    if (this.onPrice) {
                        this.onPrice(botSymbol, price);
                    }
                }
            }
        }

        if (msg.channel === 'book' && msg.data) {
            for (const bookData of msg.data) {
                const botSymbol = this.krakenToBot(bookData.symbol);
                if (!botSymbol) continue;

                if (msg.type === 'snapshot') {
                    this.orderbooks[botSymbol] = {
                        bids: (bookData.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.qty) })),
                        asks: (bookData.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.qty) }))
                    };
                } else if (msg.type === 'update') {
                    const book = this.orderbooks[botSymbol];
                    if (bookData.bids) {
                        for (const b of bookData.bids) {
                            const price = parseFloat(b.price);
                            const qty = parseFloat(b.qty);
                            book.bids = book.bids.filter(x => x.price !== price);
                            if (qty > 0) book.bids.push({ price, size: qty });
                        }
                        book.bids.sort((a, b) => b.price - a.price);
                        book.bids = book.bids.slice(0, 25);
                    }
                    if (bookData.asks) {
                        for (const a of bookData.asks) {
                            const price = parseFloat(a.price);
                            const qty = parseFloat(a.qty);
                            book.asks = book.asks.filter(x => x.price !== price);
                            if (qty > 0) book.asks.push({ price, size: qty });
                        }
                        book.asks.sort((a, b) => a.price - b.price);
                        book.asks = book.asks.slice(0, 25);
                    }
                }
            }
        }
    }

    scheduleReconnect() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.reconnectTimer) return;
        console.log(`[KRAKEN] Reconnecting in ${this.reconnectDelay / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
    }

    getPrice(symbol) {
        return this.prices[symbol] || null;
    }

    getOrderBook(symbol) {
        const book = this.orderbooks[symbol];
        if (!book || (book.bids.length === 0 && book.asks.length === 0)) return null;
        return book;
    }

    isConnected() {
        return this.connected;
    }

    isPriceStale(symbol, maxAgeMs = 60000) {
        const lastTime = this.lastPriceTime[symbol] || 0;
        return (Date.now() - lastTime) > maxAgeMs;
    }

    stop() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
        this.connected = false;
    }
}

module.exports = { KrakenFeed, SYMBOL_MAP, REST_PAIR_MAP };
