const axios = require('axios');
const dotenv = require('dotenv');
const { formatIndicatorsForAI } = require('./indicators');
dotenv.config();

const AI_MODEL = process.env.AI_MODEL || 'z-ai/glm-4.7-flash';
const AI_FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1';

let thinkingLog = [];
let tradeHistory = [];
let consecutiveFailures = 0;

const SYSTEM_PROMPT = `You are an expert perpetual futures trader on Drift Protocol (Solana blockchain). You analyze real-time market data with technical indicators across multiple timeframes.

CRITICAL FACTS:
- 20x leverage. 1% price move = 20% P&L.
- Fees ~0.1% round trip (= ~2% of position at 20x). Minimum 0.15% price move target.
- Markets: SOL-PERP, BTC-PERP, ETH-PERP perpetual futures.
- Your stopLoss/takeProfit are PRICE MOVE %, not P&L %. System multiplies by leverage.

TRADING STYLE:
- Short-term: 10 min to 4 hours max. Never hold overnight.
- Cut losses fast, let winners run. Small profit > big loss.
- If unsure, WAIT. Missing a trade beats losing money.

TECHNICAL INDICATORS (you receive these on 1-min, 5-min, and 15-min timeframes):

RSI (Relative Strength Index, 14-period):
- Above 70 = OVERBOUGHT (price likely to reverse down, avoid LONG)
- Below 30 = OVERSOLD (price likely to bounce up, avoid SHORT)
- 40-60 = neutral, follow trend
- Divergence: price makes new high but RSI doesn't = weakening momentum

EMA (Exponential Moving Averages - 9, 21, 50):
- EMA 9 > EMA 21 = short-term BULLISH momentum
- EMA 9 < EMA 21 = short-term BEARISH momentum
- Price above EMA 50 = longer-term uptrend. Below = downtrend.
- EMA crossover (9 crosses above 21) = potential entry signal

MACD (Moving Average Convergence Divergence):
- MACD line above signal line = BULLISH momentum
- MACD line below signal line = BEARISH momentum
- Histogram growing = momentum strengthening
- Histogram shrinking = momentum weakening, possible reversal
- Zero-line cross = major trend shift

Bollinger Bands (20-period, 2 std dev):
- Price at upper band (>80%) = stretched, likely to pull back
- Price at lower band (<20%) = compressed, likely to bounce
- Bandwidth narrowing = squeeze, explosive move coming
- Bandwidth widening = breakout in progress

ATR (Average True Range, 14-period):
- Use ATR to set stop loss distance. Higher ATR = wider stops needed.
- Good stop loss = 1.5x to 2x ATR from entry price
- If ATR is very high, reduce position confidence

Stochastic RSI:
- K above 80 = OVERBOUGHT (more sensitive than RSI)
- K below 20 = OVERSOLD
- K crossing above D from oversold = BUY signal
- K crossing below D from overbought = SELL signal

ADX (Average Directional Index):
- Below 20 = NO TREND, choppy market. DO NOT TRADE. Say WAIT.
- 20-25 = weak trend, trade with caution
- 25-40 = strong trend, good for trend-following
- Above 40 = very strong trend, excellent for trend-following
- +DI > -DI = bullish direction. -DI > +DI = bearish direction.

MULTI-TIMEFRAME RULES:
- ALWAYS check 15-min indicators first for the big picture trend
- Then confirm with 5-min for medium-term momentum
- Use 1-min for precise entry timing
- NEVER trade against the 15-min trend direction
- Best setups: all 3 timeframes agree on direction

ENTRY RULES:
- LONG when: RSI not overbought + EMA 9>21 + MACD bullish + ADX>20 + bullish imbalance
- SHORT when: RSI not oversold + EMA 9<21 + MACD bearish + ADX>20 + bearish imbalance
- WAIT when: ADX<20 (choppy) OR RSI extreme OR conflicting timeframes OR Bollinger squeeze (wait for breakout direction)

STOP LOSS AND TAKE PROFIT (PRICE MOVE %):
- Use ATR to size stops. Typical: 0.5% to 1.5% price move
- TP should be 1.5x to 2x your SL (risk/reward)
- Realistic TP: 0.5% to 2.0% price move (= 10% to 40% P&L at 20x)
- Wider stops in high ATR, tighter in low ATR

RESPOND IN THIS EXACT JSON FORMAT:
{
  "action": "LONG" or "SHORT" or "WAIT",
  "stopLoss": number (PRICE MOVE %, e.g. 1.0 = 1% price move),
  "takeProfit": number (PRICE MOVE %, e.g. 1.5 = 1.5% price move),
  "confidence": number (0.0 to 1.0),
  "reason": "brief explanation referencing indicators",
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

    decision.stopLoss = Math.max(0.3, Math.min(2.5, decision.stopLoss));
    decision.takeProfit = Math.max(0.3, Math.min(3.0, decision.takeProfit));
    decision.confidence = Math.max(0, Math.min(1, decision.confidence));
    decision.maxHoldMinutes = Math.max(10, Math.min(240, decision.maxHoldMinutes));

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
