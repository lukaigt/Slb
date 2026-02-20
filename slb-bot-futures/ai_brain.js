const axios = require('axios');
const dotenv = require('dotenv');
const { formatIndicatorsForAI, formatSRForAI, formatCandlePatternsForAI } = require('./indicators');
dotenv.config();

const AI_MODEL = process.env.AI_MODEL || 'z-ai/glm-4.7-flash';
const AI_FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1';

let thinkingLog = [];
let tradeHistory = [];
let consecutiveFailures = 0;

const SYSTEM_PROMPT = `You are an expert perpetual futures trader on Drift Protocol (Solana). You analyze real-time data with 9 technical indicators across 3 timeframes, support/resistance levels, candle patterns, and portfolio context.

CRITICAL FACTS:
- 20x leverage. 1% price move = 20% P&L.
- Fees ~0.1% round trip (= ~2% P&L at 20x). You need minimum 0.15% price move just to break even.
- Markets: SOL-PERP, BTC-PERP, ETH-PERP perpetual futures.
- Your stopLoss/takeProfit are PRICE MOVE %, not P&L %. System multiplies by leverage.
- You can trade all 3 markets simultaneously. Each decision is independent.

TRADING STYLE:
- Short-term: 10 min to 4 hours max.
- Cut losses fast, let winners run. Small profit > big loss.
- If unsure, WAIT. Missing a trade costs nothing. A bad trade costs 10-20%.
- Quality over quantity. 2-3 good trades per day beats 10 mediocre ones.

TECHNICAL INDICATORS (1-min, 5-min, 15-min timeframes):

RSI (14): >70 OVERBOUGHT (avoid LONGs), <30 OVERSOLD (avoid SHORTs). Watch for divergence: price makes new high but RSI doesn't = weakening trend.

EMA (9, 21, 50): EMA9 > EMA21 = bullish. Price vs EMA50 = major trend direction. MANDATORY: Only LONG if price > EMA50 on 15m. Only SHORT if price < EMA50 on 15m.

MACD: Histogram > 0 = bullish momentum. Growing histogram = strengthening. Shrinking histogram = EXHAUSTION WARNING - trend may reverse soon.

Bollinger Bands: Price near upper band + overbought RSI = reversal risk. Price near lower band + oversold RSI = bounce likely. Tight bandwidth = breakout incoming.

ADX: <20 = CHOPPY/NO TREND - strongly prefer WAIT. >25 = trending, good for entries. >40 = very strong trend.

ATR: Measures volatility. Use for SL/TP sizing. High ATR = wider stops needed. Low ATR = tighter stops OK.

StochRSI: >80 = overbought momentum, <20 = oversold momentum. K crossing above D = bullish signal. K crossing below D = bearish signal.

MULTI-TIMEFRAME ALIGNMENT:
- 15m sets the TREND direction. This is your primary filter.
- 5m sets the MOMENTUM. Must agree with 15m.
- 1m sets the ENTRY timing.
- DO NOT trade if 15m and 5m disagree on direction.

SUPPORT & RESISTANCE (you receive calculated S/R levels):
- Support = price level where buyers repeatedly defend (price bounces up).
- Resistance = price level where sellers repeatedly push back (price bounces down).
- More touches = stronger level. STRONG (3+ touches) levels rarely break.
- DO NOT LONG when price is close to STRONG resistance (within 0.3%). Wait for clear breakout.
- DO NOT SHORT when price is close to STRONG support (within 0.3%). Wait for clear breakdown.
- Place SL BELOW support for LONGs (give 0.1-0.2% extra room below the level).
- Place SL ABOVE resistance for SHORTs (give 0.1-0.2% extra room above the level).
- Target TP near the NEXT key level (next resistance for LONGs, next support for SHORTs).

TRAP DETECTION (CRITICAL):
- BULL TRAP: Price briefly breaks above resistance then drops back below. If recent candles show upper wick rejection near resistance, DO NOT LONG. This is a fake breakout designed to trap buyers.
- BEAR TRAP: Price briefly breaks below support then bounces back above. If recent candles show lower wick defense near support, DO NOT SHORT. This is a fake breakdown designed to trap sellers.
- STOP HUNT: Sudden wick below support or above resistance followed by quick reversal. Market makers hunting stop losses. If you see a long wick at S/R level, wait for confirmation before entering.
- If price just broke through a level in the last 1-2 candles, WAIT for confirmation (2-3 candles closing beyond the level) before trading the breakout.

CANDLE PATTERN AWARENESS (you receive pattern analysis):
- DOJI = indecision, market unsure. Not a good entry signal alone.
- SHOOTING STAR (long upper wick) = bearish reversal signal, especially near resistance.
- HAMMER (long lower wick) = bullish reversal signal, especially near support.
- BULLISH ENGULFING = strong bullish reversal, previous downmove may be over.
- BEARISH ENGULFING = strong bearish reversal, previous upmove may be over.
- Patterns are more reliable when they occur AT support/resistance levels.

MOMENTUM EXHAUSTION:
- If MACD histogram is shrinking while price is still advancing = momentum dying, trend about to reverse.
- If RSI is diverging from price (price higher but RSI lower) = weakening, avoid new entries in that direction.
- If ADX is falling from high values (was 40, now 25) = trend losing strength.

VOLATILITY AWARENESS:
- High ATR (volatile market): Use wider SL (0.7-1.0%), wider TP. More room for noise.
- Low ATR (quiet market): Use tighter SL (0.4-0.6%), tighter TP. Precision entries.
- Sudden ATR spike: Something happened. WAIT until volatility stabilizes.

CORRELATION AWARENESS:
- BTC often leads SOL and ETH. If BTC is dumping hard, be very cautious LONGing SOL/ETH.
- If you receive BTC trend info while analyzing SOL/ETH, factor it in.
- If all 3 markets show same direction with strong ADX, that's a high-conviction macro move.

DYNAMIC SL/TP RULES:
- Size SL using ATR: typically 1.5x to 2x ATR as price move %.
- Anchor SL to nearest S/R level: for LONG, place SL just below support. For SHORT, just above resistance.
- SL range: 0.3% to 1.0% price move (system caps at 1.0% = 20% P&L max loss).
- TP must be minimum 2x your SL (2:1 reward-to-risk).
- Anchor TP to next S/R level when possible.
- TP range: 0.5% to 2.5% price move (= 10% to 50% P&L at 20x).
- If no clear TP target exists, use 2x SL as default.

PORTFOLIO CONTEXT:
- You may receive info about positions open on OTHER markets.
- If daily P&L is already negative, be MORE selective (raise your bar for confidence).
- If you've had multiple losses today, strongly prefer WAIT unless setup is exceptional.

RESPOND IN THIS EXACT JSON FORMAT:
{
  "action": "LONG" or "SHORT" or "WAIT",
  "stopLoss": number (PRICE MOVE %, e.g. 0.8 = 0.8% price move),
  "takeProfit": number (PRICE MOVE %, e.g. 1.6 = 1.6% price move),
  "confidence": number (0.0 to 1.0),
  "reason": "brief explanation referencing specific indicators, S/R levels, and patterns",
  "maxHoldMinutes": number (10-240)
}

IMPORTANT: Only output valid JSON. No markdown, no code blocks, no extra text.`;

function findSimilarMemories(marketData, allTrades, maxResults = 3) {
    if (!allTrades || allTrades.length === 0) return [];

    const tradesWithScore = allTrades
        .filter(t => t.entrySnapshot && t.lesson)
        .map(t => {
            const es = t.entrySnapshot;
            let score = 0;

            if (es.trend === marketData.trend) score += 3;

            const volDiff = Math.abs((es.volatility || 0) - marketData.volatility);
            if (volDiff < 0.05) score += 2;
            else if (volDiff < 0.15) score += 1;

            const imbDiff = Math.abs((es.imbalance || 0) - marketData.imbalance);
            if (imbDiff < 0.05) score += 2;
            else if (imbDiff < 0.15) score += 1;

            if (t.symbol === marketData.symbol) score += 1;

            return { trade: t, score };
        })
        .filter(t => t.score >= 3)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

    return tradesWithScore.map(t => t.trade);
}

function buildMarketPrompt(marketData, recentResults, pastMemories) {
    let prompt = `MARKET: ${marketData.symbol}
CURRENT PRICE: $${marketData.price.toFixed(2)}
TREND: ${marketData.trend}
ORDER BOOK IMBALANCE: ${(marketData.imbalance * 100).toFixed(1)}% (${marketData.imbalance > 0 ? 'bullish' : 'bearish'} pressure)
VOLATILITY: ${marketData.volatility.toFixed(3)}%
5-MINUTE PRICE CHANGE: ${marketData.recentChange.toFixed(3)}%`;

    if (marketData.priceHistory && marketData.priceHistory.length > 0) {
        const prices = marketData.priceHistory.slice(-10);
        prompt += `\nRECENT PRICES (oldest to newest): ${prices.map(p => '$' + p.toFixed(2)).join(', ')}`;
    }

    if (marketData.supportResistance) {
        prompt += formatSRForAI(marketData.supportResistance, marketData.price);
    }

    if (marketData.candlePatterns) {
        prompt += formatCandlePatternsForAI(marketData.candlePatterns);
    }

    if (marketData.indicators1m || marketData.indicators5m || marketData.indicators15m) {
        prompt += `\n`;
        if (marketData.indicators15m) {
            prompt += formatIndicatorsForAI(marketData.indicators15m, '15-MIN');
        }
        if (marketData.indicators5m) {
            prompt += formatIndicatorsForAI(marketData.indicators5m, '5-MIN');
        }
        if (marketData.indicators1m) {
            prompt += formatIndicatorsForAI(marketData.indicators1m, '1-MIN');
        }
    }

    if (marketData.otherPositions && marketData.otherPositions.length > 0) {
        prompt += `\n\nOPEN POSITIONS ON OTHER MARKETS:`;
        for (const op of marketData.otherPositions) {
            prompt += `\n- ${op.symbol}: ${op.direction} | Entry: $${op.entryPrice.toFixed(2)} | P&L: ${op.pnl.toFixed(1)}%`;
        }
    }

    if (marketData.dailyContext) {
        const dc = marketData.dailyContext;
        prompt += `\n\nTODAY'S PERFORMANCE:`;
        prompt += `\n- Daily P&L: ${dc.dailyPnl.toFixed(1)}%`;
        prompt += `\n- Trades: ${dc.dailyTrades} (${dc.dailyWins}W / ${dc.dailyLosses}L)`;
        prompt += `\n- Win Rate: ${dc.dailyWinRate}%`;
        if (dc.consecutiveLosses > 0) {
            prompt += `\n- Consecutive Losses: ${dc.consecutiveLosses} (CAUTION)`;
        }
    }

    if (marketData.btcTrend && marketData.symbol !== 'BTC-PERP') {
        prompt += `\n\nBTC CORRELATION: BTC trend is ${marketData.btcTrend}`;
    }

    if (recentResults.length > 0) {
        prompt += `\n\nYOUR LAST ${recentResults.length} TRADES ON ${marketData.symbol}:`;
        for (const r of recentResults) {
            prompt += `\n- ${r.direction} | Result: ${r.result} | P&L: ${r.profitPercent.toFixed(2)}% | Reason: ${r.exitReason}`;
        }
    }

    if (pastMemories && pastMemories.length > 0) {
        prompt += `\n\nLESSONS FROM SIMILAR PAST TRADES (same market conditions):`;
        for (const mem of pastMemories) {
            prompt += `\n- [${mem.symbol} ${mem.result} ${mem.profitPercent.toFixed(1)}%] ${mem.lesson}`;
        }
        prompt += `\nUse these lessons to avoid repeating mistakes and replicate winning patterns.`;
    }

    prompt += `\n\nWhat is your trading decision? Respond in JSON only.`;
    return prompt;
}

async function callAI(model, apiKey, userPrompt) {
    const response = await axios.post(`${AI_BASE_URL}/chat/completions`, {
        model: model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 1500,
        reasoning: { enabled: false }
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 30000
    });

    if (!response.data || !response.data.choices || !response.data.choices[0]) {
        throw new Error('Empty API response');
    }

    const msg = response.data.choices[0].message;
    let raw = (msg.content || '').trim();

    if (!raw && msg.reasoning) {
        think('Model used reasoning mode - extracting from reasoning field', 'ai_brain');
        const reasoningText = typeof msg.reasoning === 'string' ? msg.reasoning : 
            (msg.reasoning_details && msg.reasoning_details[0] ? msg.reasoning_details[0].text : '');
        if (reasoningText && reasoningText.includes('{')) {
            raw = reasoningText;
        }
    }

    if (!raw) {
        throw new Error('Empty content from model (reasoning mode may have consumed all tokens)');
    }

    return raw;
}

function parseAIResponse(raw) {
    let cleaned = raw;
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    if (cleaned.includes('{') && cleaned.includes('}')) {
        cleaned = cleaned.substring(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1);
    }

    const decision = JSON.parse(cleaned);

    if (!decision.action || !['LONG', 'SHORT', 'WAIT'].includes(decision.action)) {
        throw new Error('Invalid action');
    }

    decision.stopLoss = (typeof decision.stopLoss === 'number' && isFinite(decision.stopLoss)) ? decision.stopLoss : 1.5;
    decision.takeProfit = (typeof decision.takeProfit === 'number' && isFinite(decision.takeProfit)) ? decision.takeProfit : 2.5;
    decision.confidence = (typeof decision.confidence === 'number' && isFinite(decision.confidence)) ? decision.confidence : 0.5;
    decision.maxHoldMinutes = (typeof decision.maxHoldMinutes === 'number' && isFinite(decision.maxHoldMinutes)) ? decision.maxHoldMinutes : 60;

    decision.stopLoss = Math.max(0.3, Math.min(1.0, decision.stopLoss));
    decision.takeProfit = Math.max(0.5, Math.min(2.5, decision.takeProfit));
    decision.confidence = Math.max(0, Math.min(1, decision.confidence));
    decision.maxHoldMinutes = Math.max(10, Math.min(240, decision.maxHoldMinutes));

    if (decision.takeProfit < decision.stopLoss * 2.0) {
        decision.takeProfit = decision.stopLoss * 2.0;
    }

    return decision;
}

async function askBrain(marketData, allTradeMemories) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        think('No OpenRouter API key configured - AI brain disabled', 'error');
        return { action: 'WAIT', reason: 'No API key', confidence: 0, stopLoss: 1.5, takeProfit: 2.5, maxHoldMinutes: 60 };
    }

    const recentResults = tradeHistory
        .filter(t => t.symbol === marketData.symbol)
        .slice(-5);

    const memories = findSimilarMemories(marketData, allTradeMemories || []);
    if (memories.length > 0) {
        think(`[${marketData.symbol}] Found ${memories.length} similar past trades to learn from`, 'ai_brain');
    }

    const userPrompt = buildMarketPrompt(marketData, recentResults, memories);

    think(`Asking AI brain about ${marketData.symbol} | Price: $${marketData.price.toFixed(2)} | Trend: ${marketData.trend} | Imbalance: ${(marketData.imbalance * 100).toFixed(1)}%`, 'ai_brain');

    const modelsToTry = consecutiveFailures >= 3
        ? [AI_FALLBACK_MODEL, AI_MODEL]
        : [AI_MODEL, AI_FALLBACK_MODEL];

    for (const model of modelsToTry) {
        try {
            const raw = await callAI(model, apiKey, userPrompt);
            think(`Raw AI response (${model}) for ${marketData.symbol}: ${raw.substring(0, 200)}`, 'ai_brain');

            const decision = parseAIResponse(raw);
            consecutiveFailures = 0;

            const emoji = decision.action === 'LONG' ? '🟢' : decision.action === 'SHORT' ? '🔴' : '⚪';
            think(`${emoji} AI Decision [${marketData.symbol}] via ${model}: ${decision.action} | SL: ${decision.stopLoss}% | TP: ${decision.takeProfit}% | Conf: ${(decision.confidence * 100).toFixed(0)}% | Hold: ${decision.maxHoldMinutes}min | ${decision.reason}`, 'ai_brain');

            return decision;
        } catch (error) {
            think(`Model ${model} failed for ${marketData.symbol}: ${error.message}`, 'error');
            if (model === modelsToTry[modelsToTry.length - 1]) {
                consecutiveFailures++;
                think(`Both models failed (${consecutiveFailures} consecutive failures). Will try fallback first next time if this continues.`, 'error');
            }
        }
    }

    return { action: 'WAIT', reason: 'All AI models failed', confidence: 0, stopLoss: 1.5, takeProfit: 2.5, maxHoldMinutes: 60 };
}

function recordTradeResult(symbol, direction, result, profitPercent, exitReason) {
    tradeHistory.push({
        symbol,
        direction,
        result,
        profitPercent,
        exitReason,
        timestamp: Date.now()
    });
    if (tradeHistory.length > 100) tradeHistory.shift();
}

function think(message, category) {
    thinkingLog.unshift({
        time: Date.now(),
        message,
        category: category || 'general'
    });
    if (thinkingLog.length > 100) thinkingLog.pop();
    console.log(`[AI] ${message}`);
}

function getThinkingLog() {
    return thinkingLog;
}

module.exports = {
    askBrain,
    recordTradeResult,
    think,
    getThinkingLog
};
