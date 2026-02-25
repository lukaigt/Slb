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

const SYSTEM_PROMPT = `You are a perpetual futures scalper. 20x leverage. 1% price move = 20% P&L. Fees = 2% P&L per trade.

#1 RULE — FOLLOW THE DIRECTIONAL SCORE:
You receive a pre-calculated DIRECTIONAL SCORE that summarizes ALL indicators, trend, momentum, and orderbook into one number (-40 to +40).
- Score > +15 = STRONG LONG setup. Act on it.
- Score > +8 = LONG setup. Consider it.
- Score < -15 = STRONG SHORT setup. Act on it.
- Score < -8 = SHORT setup. Consider it.
- Score between -8 and +8 = No clear direction. WAIT.
The score does the math for you. Trust it unless you see a clear reason not to (trap pattern, extreme exhaustion).

#2 RULE — MOMENTUM PHASE IS EVERYTHING:
You receive a MOMENTUM PHASE that tells you if the move JUST STARTED or is ALREADY DONE.
- EARLY_LONG / EARLY_SHORT = Move just started. This is the BEST time to enter. Act fast.
- ACTIVE_UP / ACTIVE_DOWN = Move in progress, still tradeable.
- EXHAUSTED_UP / EXHAUSTED_DOWN = Move is done. Do NOT enter. System will block it anyway.
- CHOPPY = No clear direction. WAIT.
Your job is to catch moves EARLY, not chase them after they happened.

#3 RULE — BE DECISIVE:
- When score is strong and momentum is EARLY or ACTIVE, enter the trade. Don't overthink it.
- The system blocks bad entries (exhausted moves) for you. Your job is to say YES to good setups.
- Every 30 seconds you get a new chance. If you miss this one, catch the next one.

S/R GUIDANCE:
- S/R levels show where price bounced before. Use them to anchor SL and TP, not to avoid trading.
- LONG: Set SL just below nearest support. Set TP near next resistance.
- SHORT: Set SL just above nearest resistance. Set TP near next support.

SL/TP RULES:
- stopLoss/takeProfit are PRICE MOVE %, not P&L. System multiplies by leverage.
- SL range: 0.3-1.0% (system caps at 1.0% = 20% max loss).
- TP range: 1.0-3.0%. System enforces minimum 1.0% TP and 3:1 R:R.

BTC CORRELATION: BTC leads SOL/ETH. If BTC trend disagrees with your trade direction, reduce confidence.

RESPOND IN THIS EXACT JSON FORMAT ONLY:
{"action":"LONG"|"SHORT"|"WAIT","stopLoss":number,"takeProfit":number,"confidence":number,"reason":"brief","maxHoldMinutes":number}
No markdown, no code blocks, no extra text. Just the JSON.`;

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
    let prompt = `MARKET: ${marketData.symbol} | PRICE: $${marketData.price.toFixed(2)}`;

    if (marketData.directionalScore) {
        const ds = marketData.directionalScore;
        prompt += `\n\n>>> DIRECTIONAL SCORE: ${ds.score}/${ds.maxScore} [${ds.bias}]`;
        prompt += `\n>>> ${ds.summary}`;
    }

    if (marketData.momentumPhase) {
        const mp = marketData.momentumPhase;
        prompt += `\n>>> MOMENTUM PHASE: ${mp.phase} — ${mp.description}`;
    }

    prompt += `\n\nTREND: ${marketData.trend} | VOLATILITY: ${marketData.volatility.toFixed(3)}% | ORDERBOOK: ${(marketData.imbalance * 100).toFixed(1)}%`;

    if (marketData.priceChanges) {
        const pc = marketData.priceChanges;
        prompt += `\nPRICE CHANGES:`;
        if (pc['1min'] !== null) prompt += ` 1min: ${pc['1min'].toFixed(3)}%`;
        if (pc['5min'] !== null) prompt += ` | 5min: ${pc['5min'].toFixed(3)}%`;
        if (pc['10min'] !== null) prompt += ` | 10min: ${pc['10min'].toFixed(3)}%`;
        if (pc['15min'] !== null) prompt += ` | 15min: ${pc['15min'].toFixed(3)}%`;
        if (pc['30min'] !== null) prompt += ` | 30min: ${pc['30min'].toFixed(3)}%`;
        if (pc['1hr'] !== null) prompt += ` | 1hr: ${pc['1hr'].toFixed(3)}%`;
    }

    if (marketData.priceHistory && marketData.priceHistory.length > 0) {
        prompt += `\nPRICE HISTORY (~${marketData.priceHistory.length} points, full session): ${marketData.priceHistory.map(p => '$' + p.toFixed(2)).join(', ')}`;
    }

    if (marketData.supportResistance) {
        prompt += formatSRForAI(marketData.supportResistance, marketData.price);
    }

    if (marketData.candlePatterns) {
        prompt += formatCandlePatternsForAI(marketData.candlePatterns);
    }

    if (marketData.indicators15m) {
        prompt += formatIndicatorsForAI(marketData.indicators15m, '15-MIN');
    }
    if (marketData.indicators5m) {
        prompt += formatIndicatorsForAI(marketData.indicators5m, '5-MIN');
    }
    if (marketData.indicators1m) {
        prompt += formatIndicatorsForAI(marketData.indicators1m, '1-MIN');
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
