const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

let thinkingLog = [];

async function askBrain(marketData) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return { action: 'WAIT', reason: 'Missing OpenRouter API Key' };
    }

    const systemPrompt = `You are an expert Solana Perpetual Futures Trader. 
Your goal is to analyze market data and provide precise trading signals.
You trade with 50x leverage, so risk management is CRITICAL.
Tight stops are necessary, but must be placed intelligently.

STRICTOR RULES:
1. Only trade when there is a clear trend or high-confidence reversal.
2. Return response in strict JSON format.
3. "stopLoss" and "takeProfit" are PERCENTAGES from entry.
4. Be a "futures trader": look for momentum and liquidations.

JSON Format:
{
  "action": "LONG" | "SHORT" | "WAIT",
  "stopLoss": number (e.g. 1.2),
  "takeProfit": number (e.g. 2.5),
  "confidence": number (0 to 1),
  "reason": "short explanation"
}`;

    const userPrompt = `Market: ${marketData.symbol}
Price: $${marketData.price}
Trend: ${marketData.trend}
Imbalance: ${(marketData.imbalance * 100).toFixed(1)}%
Volatility: ${marketData.volatility.toFixed(2)}%
Last 5m Change: ${marketData.recentChange.toFixed(2)}%

What is your move?`;

    try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'z-ai/glm-4.7',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            response_format: { type: 'json_object' }
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        const decision = JSON.parse(response.data.choices[0].message.content);
        think(`AI Brain Decision for ${marketData.symbol}: ${decision.action} | SL: ${decision.stopLoss}% | TP: ${decision.takeProfit}% | Reason: ${decision.reason}`, 'ai_brain');
        return decision;
    } catch (error) {
        console.error('AI Brain Error:', error.message);
        return { action: 'WAIT', reason: 'Brain connection error' };
    }
}

function think(message, category = 'general') {
    thinkingLog.unshift({
        time: Date.now(),
        message,
        category
    });
    if (thinkingLog.length > 100) thinkingLog.pop();
}

function getThinkingLog() {
    return thinkingLog;
}

module.exports = {
    askBrain,
    getThinkingLog
};
