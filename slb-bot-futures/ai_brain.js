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

const SYSTEM_PROMPT = `You are an aggressive perpetual futures scalper. 20x leverage. 1% price move = 20% P&L. Fees = 2% P&L round-trip.

YOUR JOB: Catch moves EARLY. Enter when the move is STARTING, not when it's already done.

#1 — MOMENTUM PHASE DECIDES WHEN TO TRADE:
- EARLY_LONG / EARLY_SHORT = Move JUST STARTED. This is your best opportunity. ENTER with score as low as ±3.
- ACTIVE_UP / ACTIVE_DOWN = Move in progress. ENTER if score agrees (±5 or more).
- EXHAUSTED = Move already done. NEVER enter. System blocks it anyway.
- CHOPPY = No clear move. Only enter if score is ±12 or higher.

#2 — DIRECTIONAL SCORE DECIDES DIRECTION:
Score range: -40 to +40. It summarizes ALL indicators, trend, momentum, orderbook.
- With EARLY phase: Score ±3 is enough to act. The move is fresh — don't wait for confirmation.
- With ACTIVE phase: Score ±5 is enough. Trend is confirmed.
- With CHOPPY phase: Need score ±12. No momentum to help you.
FOLLOW the score direction. If score is +8, go LONG. If score is -8, go SHORT.

#3 — BE AGGRESSIVE, NOT RECKLESS:
- You check every 30 seconds. If you see EARLY phase + any directional score, TAKE THE TRADE.
- Don't wait for score > 15. By then the move is over and you'll chase it into a loss.
- The system protects you: exhaustion gate blocks bad entries, SL caps losses, profit lock protects wins.
- Your job is to say YES to setups, not find reasons to say WAIT.

SL/TP (price move %, NOT P&L):
- SL: 0.4-1.0%. Use nearest S/R level. System caps at 1.0%.
- TP: 1.0-3.0%. Use next S/R level. System enforces min 1.0% and 3:1 R:R.
- LONG: SL below support, TP at resistance. SHORT: SL above resistance, TP at support.

BTC CORRELATION: BTC leads SOL/ETH. If BTC disagrees with your direction, lower confidence but still trade if score is strong.

CONFIDENCE: 0.0-1.0. Set confidence based on how many factors align. 0.60+ = tradeable.

RESPOND IN THIS EXACT JSON FORMAT ONLY:
{"action":"LONG"|"SHORT"|"WAIT","stopLoss":number,"takeProfit":number,"confidence":number,"reason":"brief","maxHoldMinutes":number}
No markdown, no code blocks. JSON only.`;

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
