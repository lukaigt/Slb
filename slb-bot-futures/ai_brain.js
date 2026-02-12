const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const AI_MODEL = process.env.AI_MODEL || 'z-ai/glm-4.7-flash';
const AI_FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1';

let thinkingLog = [];
let tradeHistory = [];
let consecutiveFailures = 0;

const SYSTEM_PROMPT = `You are an expert perpetual futures trader on Drift Protocol (Solana blockchain). You analyze real-time market data and make precise trading decisions.

CRITICAL FACTS ABOUT YOUR ENVIRONMENT:
- You trade with 50x leverage. This means a 1% price move = 50% gain or loss on your position.
- Trading fees are approximately 0.1% round trip (open + close). With 50x leverage this equals ~5% of position value.
- You MUST only take trades where expected profit exceeds fees. Minimum 0.3% price move target.
- You trade SOL-PERP, BTC-PERP, and ETH-PERP perpetual futures.
- You can go LONG (profit when price rises) or SHORT (profit when price falls).

YOUR TRADING STYLE:
- Short-term trader. Hold times: 10 minutes to 4 hours maximum.
- Never hold overnight. If unsure, say WAIT.
- You are NOT a spot trader. You think in terms of leverage, liquidation risk, and funding rates.
- Cut losses fast, let winners run slightly. Better to take small profit than hold for a big loss.

HOW TO READ THE DATA:
- Trend: UPTREND means price has been rising, DOWNTREND means falling, RANGING means sideways.
- Imbalance: Positive = more buyers than sellers (bullish pressure). Negative = more sellers (bearish pressure). Above 15% is significant.
- Volatility: How much price is moving. High volatility (>0.3%) = wider stops needed. Low volatility (<0.1%) = tight setups, smaller moves.
- Recent price changes: Shows momentum direction and strength.

ENTRY RULES:
- LONG when: Strong uptrend + bullish imbalance + low/medium volatility. Or: Reversal signal after extended downtrend with bullish imbalance shift.
- SHORT when: Strong downtrend + bearish imbalance + low/medium volatility. Or: Reversal signal after extended uptrend with bearish imbalance shift.
- WAIT when: Choppy/ranging market with no clear direction, extremely high volatility, conflicting signals, or weak imbalance.

STOP LOSS AND TAKE PROFIT RULES:
- Set stop loss based on current volatility. Higher volatility = wider stop.
- Minimum stop loss: 0.5% (with 50x leverage = 25% position risk)
- Maximum stop loss: 3.0% (with 50x leverage = 150% = near liquidation, avoid this)
- Typical stop loss range: 0.8% to 2.0%
- Take profit should be at least 1.5x your stop loss (risk/reward ratio)
- Consider nearby support/resistance when setting levels.

RISK MANAGEMENT:
- If recent trades show losses, be more conservative (wider stops, lower confidence).
- If you are unsure, ALWAYS choose WAIT. Missing a trade is better than losing money.
- Never chase a move that already happened. Wait for pullbacks.

YOU MUST RESPOND IN THIS EXACT JSON FORMAT:
{
  "action": "LONG" or "SHORT" or "WAIT",
  "stopLoss": number (percentage, e.g. 1.2 means 1.2% from entry),
  "takeProfit": number (percentage, e.g. 2.5 means 2.5% from entry),
  "confidence": number (0.0 to 1.0, where 1.0 = very confident),
  "reason": "brief explanation of why this trade or why waiting",
  "maxHoldMinutes": number (how long to hold before closing, 10-240)
}

IMPORTANT: Only output valid JSON. No markdown, no code blocks, no extra text.`;

function buildMarketPrompt(marketData, recentResults) {
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

    if (recentResults.length > 0) {
        prompt += `\n\nYOUR LAST ${recentResults.length} TRADES ON ${marketData.symbol}:`;
        for (const r of recentResults) {
            prompt += `\n- ${r.direction} | Result: ${r.result} | P&L: ${r.profitPercent.toFixed(2)}% | Reason: ${r.exitReason}`;
        }
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
        max_tokens: 1000,
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

    decision.stopLoss = Math.max(0.5, Math.min(3.0, decision.stopLoss));
    decision.takeProfit = Math.max(0.5, Math.min(5.0, decision.takeProfit));
    decision.confidence = Math.max(0, Math.min(1, decision.confidence));
    decision.maxHoldMinutes = Math.max(10, Math.min(240, decision.maxHoldMinutes));

    return decision;
}

async function askBrain(marketData) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        think('No OpenRouter API key configured - AI brain disabled', 'error');
        return { action: 'WAIT', reason: 'No API key', confidence: 0, stopLoss: 1.5, takeProfit: 2.5, maxHoldMinutes: 60 };
    }

    const recentResults = tradeHistory
        .filter(t => t.symbol === marketData.symbol)
        .slice(-5);

    const userPrompt = buildMarketPrompt(marketData, recentResults);

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
