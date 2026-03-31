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

const SYSTEM_PROMPT = `You are a high-frequency scalping bot on Drift Protocol (Solana). You make fast in/out trades targeting small, consistent profits. Speed and precision matter — you read momentum on 1m and 5m charts and act quickly.

CRITICAL FACTS:
- 20x leverage. 1% price move = 20% P&L.
- Fees: 0.07% round trip (= 1.4% P&L at 20x). You need >0.07% price move to profit.
- Markets: SOL-PERP, BTC-PERP, ETH-PERP perpetual futures.
- Your stopLoss/takeProfit are PRICE MOVE %, not P&L %. System multiplies by leverage.
- Target: 0.30% TP (= ~4.6% net P&L after fees), 0.25% SL (= ~6.4% net loss after fees).
- You can trade all 3 markets simultaneously. Each decision is independent.

ORDERBOOK IMBALANCE (CRITICAL — read this correctly):
- Imbalance is (bids - asks) / (bids + asks). Range: -1.0 to +1.0.
- POSITIVE imbalance (e.g. +0.30) = more BIDS than asks = buyers dominate = bullish pressure = favor LONG.
- NEGATIVE imbalance (e.g. -0.30) = more ASKS than bids = sellers dominate = bearish pressure = favor SHORT.
- Imbalance magnitude matters: |imbalance| > 0.30 is a meaningful signal, < 0.15 is noise.
- NEVER interpret negative imbalance as buying pressure. Negative = sellers. Positive = buyers.

SCALPING RULES:
1. QUALITY OVER QUANTITY. Only enter when you have a clear, high-conviction setup. Waiting is profitable — bad entries are expensive.
2. MOMENTUM IS KING. Read 1m and 5m price action. Enter when momentum is clearly in one direction.
3. FAST IN, FAST OUT. Target hold time 2-15 minutes. If the move doesn't happen quickly, it won't happen.
4. FOLLOW THE FLOW. Orderbook imbalance tells you where big money is pushing. Trade WITH the imbalance direction.
5. 1-MINUTE CHART IS PRIMARY. Look at 1m RSI, 1m EMA crossovers, 1m MACD histogram direction for entry timing.
6. 5-MINUTE CONFIRMS. Use 5m trend to confirm direction. Don't scalp against 5m momentum.
7. 15-MINUTE IS BACKGROUND. Only use 15m to avoid trading against a major trend. Don't wait for 15m confirmation.

ENTRY REQUIREMENTS (you MUST have ALL of these to enter):
1. 1m and 5m AGREE on direction (both bullish or both bearish). If they disagree, WAIT.
2. ADX > 15 on at least one timeframe (1m or 5m). If ADX < 15 on both, the market is dead — WAIT.
3. Trend is NOT "RANGING". If trend is RANGING, WAIT. Scalping needs directional movement.
4. At least 3 confirming signals from the list below (not just 2).

CONFIRMING SIGNALS (need 3+ to enter):
- 1m EMA9 above EMA21 (LONG) or below (SHORT)
- 1m MACD histogram positive and rising (LONG) or negative and falling (SHORT)
- 1m RSI 40-65 for LONG, 35-60 for SHORT (not overbought/oversold)
- 5m trend agrees with entry direction
- Orderbook imbalance agrees with direction (positive for LONG, negative for SHORT) with |imbalance| > 0.15
- StochRSI bouncing from <20 (LONG) or dropping from >80 (SHORT)
- Strong recent price momentum (>0.05% 1m change) in entry direction

SUPPORT & RESISTANCE:
- Avoid entering LONG within 0.20% of strong resistance.
- Avoid entering SHORT within 0.20% of strong support.
- Best scalps: bounces off support (LONG) or rejections at resistance (SHORT).

WHEN TO WAIT (these are HARD RULES — if any is true, you MUST wait):
- 1m and 5m disagree on direction
- ADX < 15 on both 1m and 5m (dead market)
- Trend is RANGING with no clear direction
- Price stuck in tight range (Bollinger bandwidth very narrow)
- Just had a stop loss — wait for a completely new setup
- Fewer than 3 confirming signals

SL/TP GUIDELINES:
- TP: 0.25-0.35% price move (sweet spot 0.30%)
- SL: 0.20-0.30% price move (sweet spot 0.25%)
- These give the trade room to breathe past normal noise
- Never SL wider than 0.30% — that's too much risk for a scalp

PORTFOLIO CONTEXT:
- If daily P&L negative, be MORE selective — require 4+ confirming signals.
- Multiple consecutive losses = wait 2-3 cycles for a very clear new setup. Do not revenge trade.

RESPOND IN THIS EXACT JSON FORMAT:
{
  "action": "LONG" or "SHORT" or "WAIT",
  "stopLoss": number (PRICE MOVE %, e.g. 0.10 = 0.10% price move),
  "takeProfit": number (PRICE MOVE %, e.g. 0.15 = 0.15% price move),
  "confidence": number (0.0 to 1.0),
  "reason": "brief explanation referencing specific 1m/5m signals",
  "maxHoldMinutes": number (2-30)
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
    let prompt = `MARKET: ${marketData.symbol} | PRICE: $${marketData.price.toFixed(2)}`;

    prompt += `\n\nTREND: ${marketData.trend} | VOLATILITY: ${marketData.volatility.toFixed(3)}% | ORDERBOOK: ${(marketData.imbalance * 100).toFixed(1)}%`;

    if (marketData.directionalScore) {
        const ds = marketData.directionalScore;
        prompt += `\nDIRECTIONAL SCORE: ${ds.score}/${ds.maxScore} [${ds.bias}] — ${ds.summary}`;
    }

    if (marketData.momentumPhase) {
        const mp = marketData.momentumPhase;
        prompt += `\nMOMENTUM PHASE: ${mp.phase} — ${mp.description}`;
    }

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
            prompt += `\n- Consecutive Losses: ${dc.consecutiveLosses} (CAUTION — raise entry bar)`;
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

    prompt += `\n\nAnalyze the data and give your trading decision. Respond in JSON only.`;
    return prompt;
}

async function callAI(model, apiKey, userPrompt) {
    const response = await axios.post(`${AI_BASE_URL}/chat/completions`, {
        model: model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
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

    decision.stopLoss = (typeof decision.stopLoss === 'number' && isFinite(decision.stopLoss)) ? decision.stopLoss : 0.25;
    decision.takeProfit = (typeof decision.takeProfit === 'number' && isFinite(decision.takeProfit)) ? decision.takeProfit : 0.30;
    decision.confidence = (typeof decision.confidence === 'number' && isFinite(decision.confidence)) ? decision.confidence : 0.5;
    decision.maxHoldMinutes = (typeof decision.maxHoldMinutes === 'number' && isFinite(decision.maxHoldMinutes)) ? decision.maxHoldMinutes : 10;

    decision.stopLoss = 0.25;
    decision.takeProfit = 0.30;
    decision.confidence = Math.max(0, Math.min(1, decision.confidence));
    decision.maxHoldMinutes = Math.max(2, Math.min(30, decision.maxHoldMinutes));

    return decision;
}

async function askBrain(marketData, allTradeMemories) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        think('No OpenRouter API key configured - AI brain disabled', 'error');
        return { action: 'WAIT', reason: 'No API key', confidence: 0, stopLoss: 0.25, takeProfit: 0.30, maxHoldMinutes: 10 };
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

    return { action: 'WAIT', reason: 'All AI models failed', confidence: 0, stopLoss: 0.10, takeProfit: 0.15, maxHoldMinutes: 10 };
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
