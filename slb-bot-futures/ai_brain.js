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

const SYSTEM_PROMPT = `You are an expert perpetual futures trader on Drift Protocol (Solana). You analyze real-time data with 9 technical indicators across 3 timeframes, support/resistance levels, candle patterns, multi-window price momentum, and portfolio context.

CRITICAL FACTS:
- 20x leverage. 1% price move = 20% P&L.
- Fees ~0.1% round trip (= ~2% P&L at 20x). You need minimum 0.15% price move just to break even.
- Markets: SOL-PERP, BTC-PERP, ETH-PERP perpetual futures.
- Your stopLoss/takeProfit are PRICE MOVE %, not P&L %. System multiplies by leverage.
- You can trade all 3 markets simultaneously. Each decision is independent.

#1 PRIORITY — SUPPORT & RESISTANCE (USE AS GUIDANCE):
- You receive S/R levels detected from ALL available price data (hours of history), with strength (WEAK/MODERATE/STRONG), touch counts, and time span showing how long the level has been tested.
- STRONG levels (tested over 30+ minutes with multiple touches) are significant. WEAK levels (brief touches) are less reliable.
- Use S/R to PLAN entries, not to avoid trading. There is ALWAYS some support below and resistance above — the question is how far away they are and how strong.
- If support and resistance are far apart (1%+), there is plenty of room to trade between them. LONG near support, SHORT near resistance.
- Be cautious longing right AT a STRONG resistance or shorting right AT a STRONG support — but if the level is 0.5%+ away, it should not prevent your trade.
- Anchor SL to S/R: for LONG, place SL just below nearest STRONG support so the trade has room to breathe through normal pullbacks. For SHORT, place SL just above nearest STRONG resistance.
- Anchor TP to next S/R level (next resistance for LONGs, next support for SHORTs).
- Use the PRICE HISTORY to see the bigger picture — where price has been over hours. Real trends move through WEAK levels. Only STRONG levels with hours of testing are real barriers.

#2 PRIORITY — TRAP & EXHAUSTION DETECTION:
- BULL TRAP: Price breaks above resistance then falls back. Upper wick rejection near resistance = DO NOT LONG.
- BEAR TRAP: Price breaks below support then bounces back. Lower wick defense near support = DO NOT SHORT.
- STOP HUNT: Long wick at S/R followed by reversal = wait for confirmation.
- EXHAUSTED MOVE: You receive price changes over 1min, 5min, 10min, 15min, 30min, 1hr windows. If price already moved 2%+ in one direction over 30min, that move is likely EXHAUSTED. Do NOT chase it. Wait for a pullback or reversal confirmation.
- If 30min change is strongly negative but 5min change is positive, price is bouncing — check if it's bouncing INTO resistance before going long.
- If 30min change is strongly positive but 5min change is negative, price is pulling back — check if it's pulling back INTO support before going short.

#3 PRIORITY — CATCHING EARLY TRENDS:
- Use the multi-window price changes to spot trends EARLY.
- If 5min, 10min, and 15min all show increasing negative change AND price is NOT near support, this is a developing downtrend — consider SHORT.
- If 5min, 10min, and 15min all show increasing positive change AND price is NOT near resistance, this is a developing uptrend — consider LONG.
- Confirm with indicators: ADX rising, MACD histogram growing, RSI trending in direction.
- Enter EARLY in trends, not late. If the move already happened (30min change >2%), you missed it.

TRADING STYLE:
- Short-term: 10 min to 4 hours max.
- Cut losses fast, let winners run. Small profit > big loss.
- If unsure, WAIT. Missing a trade costs nothing. A bad trade costs 10-20%.
- Quality over quantity. 2-3 good trades per day beats 10 mediocre ones.

TECHNICAL INDICATORS (1-min, 5-min, 15-min timeframes):
- RSI(14): >70 overbought (avoid LONGs), <30 oversold (avoid SHORTs). Divergence = weakening.
- EMA(9,21,50): EMA9>EMA21 = bullish. Price vs EMA50 on 15m = major trend filter.
- MACD: Growing histogram = strengthening. Shrinking = EXHAUSTION, trend may reverse.
- Bollinger Bands: Near upper+overbought = reversal risk. Near lower+oversold = bounce likely.
- ADX: <20 = choppy, prefer WAIT. >25 = trending. >40 = strong trend.
- ATR: Volatility measure. High = wider SL/TP. Low = tighter SL/TP.
- StochRSI: >80 overbought, <20 oversold. K crossing D = signal.

MULTI-TIMEFRAME: 15m = trend direction, 5m = momentum, 1m = entry timing. Do NOT trade if 15m and 5m disagree.

CANDLE PATTERNS: DOJI = indecision. SHOOTING STAR near resistance = bearish. HAMMER near support = bullish. ENGULFING = reversal. Patterns at S/R levels are most reliable.

VOLATILITY: High ATR = wider SL (0.7-1.0%). Low ATR = tighter SL (0.4-0.6%). ATR spike = WAIT.

CORRELATION: BTC leads SOL/ETH. If BTC dumping, be cautious longing SOL/ETH. All 3 same direction with strong ADX = high-conviction macro move.

DYNAMIC SL/TP:
- SL: 1.5-2x ATR, anchored to S/R. Range 0.3-1.0% (system caps at 1.0% = 20% max loss).
- TP: Minimum 2x SL (2:1 R:R). Anchored to next S/R level. Range 0.5-2.5%.

PORTFOLIO CONTEXT:
- If daily P&L negative, be MORE selective. Multiple losses today = strongly prefer WAIT unless exceptional setup.

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
VOLATILITY: ${marketData.volatility.toFixed(3)}%`;

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
        prompt += `\nPRICE HISTORY (sampled across full session, oldest to newest, ~${marketData.priceHistory.length} points): ${marketData.priceHistory.map(p => '$' + p.toFixed(2)).join(', ')}`;
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
