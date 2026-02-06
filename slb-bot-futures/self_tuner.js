const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'bot_config.json');
const TUNING_LOG_FILE = path.join(__dirname, 'tuning_log.json');

const DEFAULT_CONFIG = {
    version: 1,
    lastUpdated: null,
    lastTuningRun: null,
    tuningInterval: 20,

    markets: {
        'SOL-PERP': {
            stopLoss: 1.5,
            takeProfit: 2.5,
            trailingNormal: 0.4,
            trailingDanger: 0.2,
            positionMultiplier: 1.0,
            enabled: true,
            pausedUntil: null,
            confidenceMultiplier: 1.0
        },
        'BTC-PERP': {
            stopLoss: 1.0,
            takeProfit: 1.8,
            trailingNormal: 0.3,
            trailingDanger: 0.15,
            positionMultiplier: 1.2,
            enabled: true,
            pausedUntil: null,
            confidenceMultiplier: 1.0
        },
        'ETH-PERP': {
            stopLoss: 1.2,
            takeProfit: 2.0,
            trailingNormal: 0.35,
            trailingDanger: 0.18,
            positionMultiplier: 1.0,
            enabled: true,
            pausedUntil: null,
            confidenceMultiplier: 1.0
        }
    },

    patterns: {
        disabledPatterns: [],
        disabledUntil: {},
        patternDirectionOverride: {},
        minWinRateToTrade: 0.45,
        minTradesForConfidence: 5
    },

    timing: {
        blockedHours: [],
        hourlyPerformance: {},
        lastHourlyReview: null
    },

    streaks: {
        maxConsecutiveLossesBeforePause: 3,
        pauseDurationAfterStreakMs: 1800000,
        postLossCooldownMultiplier: 2.0,
        postWinCooldownMultiplier: 0.5,
        dailyLossLimitPercent: 3.0,
        dailyLossToday: 0,
        dailyLossDate: null,
        cautionMode: false,
        cautionModeMinWinRate: 0.70
    },

    positioning: {
        highConfidenceMultiplier: 1.5,
        mediumConfidenceMultiplier: 1.0,
        lowConfidenceMultiplier: 0.5,
        maxRiskPerTradePercent: 3.0,
        postLossSizeReduction: 0.7,
        lossReductionActive: false
    },

    volatility: {
        extremeVolatilityThreshold: 2.0,
        highVolStopMultiplier: 1.5,
        lowVolStopMultiplier: 0.8,
        postSpikeWaitMs: 300000,
        lastSpikeTime: null
    },

    cooldown: {
        baseCooldownMs: 120000,
        currentCooldownMs: 120000,
        minCooldownMs: 30000,
        maxCooldownMs: 600000
    },

    sameDirectionLimit: {
        maxSameDirectionAcrossMarkets: 2
    }
};

let botConfig = null;
let thinkingLog = [];
let tuningLog = [];

function think(message, category = 'general') {
    const entry = {
        time: Date.now(),
        timestamp: new Date().toISOString(),
        message,
        category
    };
    thinkingLog.unshift(entry);
    if (thinkingLog.length > 100) thinkingLog = thinkingLog.slice(0, 100);
    return entry;
}

function logTuning(action, before, after, reason) {
    const entry = {
        timestamp: new Date().toISOString(),
        action,
        before,
        after,
        reason
    };
    tuningLog.unshift(entry);
    if (tuningLog.length > 200) tuningLog = tuningLog.slice(0, 200);
    saveTuningLog();
    return entry;
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            const loaded = JSON.parse(data);
            botConfig = mergeDeep(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), loaded);
            think('Loaded self-tuning config from file', 'system');
        } else {
            botConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
            saveConfig();
            think('Created new self-tuning config with defaults', 'system');
        }
    } catch (error) {
        botConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        think(`Error loading config: ${error.message}, using defaults`, 'system');
    }
    loadTuningLog();
    return botConfig;
}

function saveConfig() {
    try {
        botConfig.lastUpdated = new Date().toISOString();
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2));
    } catch (error) {
        think(`Error saving config: ${error.message}`, 'error');
    }
}

function saveTuningLog() {
    try {
        fs.writeFileSync(TUNING_LOG_FILE, JSON.stringify(tuningLog.slice(0, 100), null, 2));
    } catch (error) {}
}

function loadTuningLog() {
    try {
        if (fs.existsSync(TUNING_LOG_FILE)) {
            tuningLog = JSON.parse(fs.readFileSync(TUNING_LOG_FILE, 'utf8'));
        }
    } catch (error) {
        tuningLog = [];
    }
}

function mergeDeep(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            if (!target[key]) target[key] = {};
            mergeDeep(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
    return target;
}

function getMarketConfig(symbol) {
    if (!botConfig) loadConfig();
    return botConfig.markets[symbol] || null;
}

function runFullTuning(trades, shadowTrades, patternStats, marketStates) {
    if (!botConfig) loadConfig();

    const now = Date.now();
    let changes = 0;

    think('=== STARTING SELF-TUNING CYCLE ===', 'tuning');

    changes += tuneStopLosses(trades, shadowTrades);
    changes += tuneTakeProfits(trades);
    changes += tunePatterns(trades, patternStats);
    changes += tuneTimingRules(trades);
    changes += tuneStreakManagement(trades);
    changes += tuneMarketSelection(trades);
    changes += tuneVolatilityResponse(trades, marketStates);
    changes += tunePositionSizing(trades);
    changes += tuneCooldowns(trades);

    botConfig.lastTuningRun = new Date().toISOString();

    if (changes > 0) {
        saveConfig();
        think(`Self-tuning complete: ${changes} adjustments made`, 'tuning');
    } else {
        think('Self-tuning complete: no adjustments needed', 'tuning');
    }

    return changes;
}

function tuneStopLosses(trades, shadowTrades) {
    let changes = 0;
    const markets = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];

    for (const market of markets) {
        const marketTrades = trades.filter(t => t.symbol === market).slice(-30);
        if (marketTrades.length < 10) continue;

        const stopLossTrades = marketTrades.filter(t => t.exitReason === 'stop_loss');
        const stopRate = stopLossTrades.length / marketTrades.length;
        const cfg = botConfig.markets[market];
        if (!cfg) continue;

        if (stopRate > 0.6) {
            const oldSL = cfg.stopLoss;
            cfg.stopLoss = Math.min(4.0, cfg.stopLoss + 0.2);
            if (cfg.stopLoss !== oldSL) {
                think(`[${market}] Stop rate ${(stopRate*100).toFixed(0)}% too high - widening stop ${oldSL}% -> ${cfg.stopLoss}%`, 'stop_loss');
                logTuning('widen_stop_loss', oldSL, cfg.stopLoss, `${(stopRate*100).toFixed(0)}% of trades hitting stop loss`);
                changes++;
            }
        }

        if (stopRate < 0.3 && marketTrades.length >= 15) {
            const oldSL = cfg.stopLoss;
            cfg.stopLoss = Math.max(0.5, cfg.stopLoss - 0.1);
            if (cfg.stopLoss !== oldSL) {
                think(`[${market}] Stop rate ${(stopRate*100).toFixed(0)}% low - tightening stop ${oldSL}% -> ${cfg.stopLoss}%`, 'stop_loss');
                logTuning('tighten_stop_loss', oldSL, cfg.stopLoss, `Only ${(stopRate*100).toFixed(0)}% hitting stop - can tighten`);
                changes++;
            }
        }

        const marketShadows = shadowTrades.filter(t => t.symbol === market && t.resolved).slice(-30);
        if (marketShadows.length >= 10) {
            const shadowWins = marketShadows.filter(t => t.hypotheticalResult === 'WIN').length;
            const shadowWinRate = shadowWins / marketShadows.length;
            const realWins = marketTrades.filter(t => t.result === 'WIN').length;
            const realWinRate = realWins / marketTrades.length;

            if (shadowWinRate > realWinRate + 0.15) {
                const oldSL = cfg.stopLoss;
                cfg.stopLoss = Math.min(4.0, cfg.stopLoss + 0.3);
                if (cfg.stopLoss !== oldSL) {
                    think(`[${market}] Shadow trades win more (${(shadowWinRate*100).toFixed(0)}% vs ${(realWinRate*100).toFixed(0)}%) - wider stops would help`, 'stop_loss');
                    logTuning('shadow_suggests_wider', oldSL, cfg.stopLoss, `Shadows: ${(shadowWinRate*100).toFixed(0)}% vs Real: ${(realWinRate*100).toFixed(0)}%`);
                    changes++;
                }
            }
        }
    }

    return changes;
}

function tuneTakeProfits(trades) {
    let changes = 0;
    const markets = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];

    for (const market of markets) {
        const marketTrades = trades.filter(t => t.symbol === market).slice(-30);
        if (marketTrades.length < 10) continue;

        const cfg = botConfig.markets[market];
        if (!cfg) continue;

        const wins = marketTrades.filter(t => t.result === 'WIN');
        if (wins.length < 3) continue;

        const avgWinProfit = wins.reduce((s, t) => s + (t.profitPercent || 0), 0) / wins.length;

        if (avgWinProfit < cfg.takeProfit * 0.5) {
            const oldTP = cfg.takeProfit;
            cfg.takeProfit = Math.max(cfg.stopLoss * 1.5, cfg.takeProfit - 0.2);
            if (cfg.takeProfit !== oldTP) {
                think(`[${market}] Avg win (${avgWinProfit.toFixed(2)}%) well below TP target - lowering TP ${oldTP}% -> ${cfg.takeProfit}%`, 'take_profit');
                logTuning('lower_take_profit', oldTP, cfg.takeProfit, `Avg win ${avgWinProfit.toFixed(2)}% < half of TP ${oldTP}%`);
                changes++;
            }
        }

        const trailingExits = wins.filter(t => t.exitReason === 'trailing_tp');
        if (trailingExits.length >= 3) {
            const avgTrailingProfit = trailingExits.reduce((s, t) => s + (t.profitPercent || 0), 0) / trailingExits.length;
            if (avgTrailingProfit > cfg.takeProfit * 1.5) {
                const oldTP = cfg.takeProfit;
                cfg.takeProfit = Math.min(5.0, cfg.takeProfit + 0.2);
                if (cfg.takeProfit !== oldTP) {
                    think(`[${market}] Trailing profits averaging ${avgTrailingProfit.toFixed(2)}% - can raise TP ${oldTP}% -> ${cfg.takeProfit}%`, 'take_profit');
                    logTuning('raise_take_profit', oldTP, cfg.takeProfit, `Trailing avg ${avgTrailingProfit.toFixed(2)}% suggests room for more`);
                    changes++;
                }
            }
        }

        if (cfg.takeProfit < cfg.stopLoss * 1.5) {
            const oldTP = cfg.takeProfit;
            cfg.takeProfit = cfg.stopLoss * 1.5;
            think(`[${market}] Risk/reward too low - forcing TP to ${cfg.takeProfit.toFixed(2)}% (1.5x stop)`, 'take_profit');
            logTuning('enforce_risk_reward', oldTP, cfg.takeProfit, 'Minimum 1.5:1 risk/reward ratio');
            changes++;
        }
    }

    return changes;
}

function tunePatterns(trades, patternStats) {
    let changes = 0;

    for (const [patternKey, stats] of Object.entries(patternStats)) {
        const total = stats.longWins + stats.longLosses + stats.shortWins + stats.shortLosses;
        const wins = stats.longWins + stats.shortWins;
        const winRate = total > 0 ? wins / total : 0;

        if (total >= 15 && winRate < 0.45) {
            if (!botConfig.patterns.disabledPatterns.includes(patternKey)) {
                botConfig.patterns.disabledPatterns.push(patternKey);
                botConfig.patterns.disabledUntil[patternKey] = Date.now() + (24 * 60 * 60 * 1000);
                think(`Disabled pattern "${patternKey}" - win rate ${(winRate*100).toFixed(1)}% over ${total} trades`, 'pattern');
                logTuning('disable_pattern', patternKey, 'disabled', `${(winRate*100).toFixed(1)}% win rate over ${total} trades`);
                changes++;
            }
        }

        if (total >= 15 && winRate >= 0.70) {
            const marketKey = patternKey;
            if (!botConfig.patterns.patternDirectionOverride[marketKey]) {
                botConfig.patterns.patternDirectionOverride[marketKey] = {};
            }
            const longTotal = stats.longWins + stats.longLosses;
            const shortTotal = stats.shortWins + stats.shortLosses;
            const longWinRate = longTotal > 0 ? stats.longWins / longTotal : 0;
            const shortWinRate = shortTotal > 0 ? stats.shortWins / shortTotal : 0;

            if (longWinRate > 0.7 && shortWinRate < 0.4 && longTotal >= 5) {
                botConfig.patterns.patternDirectionOverride[marketKey] = 'LONG_ONLY';
                think(`Pattern "${patternKey}" works LONG (${(longWinRate*100).toFixed(0)}%) but not SHORT (${(shortWinRate*100).toFixed(0)}%) - LONG only`, 'pattern');
                logTuning('direction_override', 'both', 'LONG_ONLY', `Long: ${(longWinRate*100).toFixed(0)}% vs Short: ${(shortWinRate*100).toFixed(0)}%`);
                changes++;
            }
            if (shortWinRate > 0.7 && longWinRate < 0.4 && shortTotal >= 5) {
                botConfig.patterns.patternDirectionOverride[marketKey] = 'SHORT_ONLY';
                think(`Pattern "${patternKey}" works SHORT (${(shortWinRate*100).toFixed(0)}%) but not LONG (${(longWinRate*100).toFixed(0)}%) - SHORT only`, 'pattern');
                logTuning('direction_override', 'both', 'SHORT_ONLY', `Short: ${(shortWinRate*100).toFixed(0)}% vs Long: ${(longWinRate*100).toFixed(0)}%`);
                changes++;
            }
        }
    }

    const now = Date.now();
    const toReEnable = [];
    for (const pattern of botConfig.patterns.disabledPatterns) {
        const until = botConfig.patterns.disabledUntil[pattern] || 0;
        if (now >= until) {
            toReEnable.push(pattern);
        }
    }
    for (const pattern of toReEnable) {
        botConfig.patterns.disabledPatterns = botConfig.patterns.disabledPatterns.filter(p => p !== pattern);
        delete botConfig.patterns.disabledUntil[pattern];
        think(`Re-enabled pattern "${pattern}" for retesting after 24h cooldown`, 'pattern');
        logTuning('reenable_pattern', 'disabled', 'enabled', '24h cooldown expired');
        changes++;
    }

    return changes;
}

function tuneTimingRules(trades) {
    let changes = 0;
    const recentTrades = trades.slice(-100);
    if (recentTrades.length < 20) return 0;

    const hourBlocks = {};
    for (let i = 0; i < 6; i++) {
        hourBlocks[i] = { wins: 0, losses: 0, total: 0 };
    }

    for (const trade of recentTrades) {
        const hour = new Date(trade.timestamp).getUTCHours();
        const block = Math.floor(hour / 4);
        hourBlocks[block].total++;
        if (trade.result === 'WIN') hourBlocks[block].wins++;
        else hourBlocks[block].losses++;
    }

    const newBlockedHours = [];
    for (const [block, stats] of Object.entries(hourBlocks)) {
        if (stats.total >= 5) {
            const winRate = stats.wins / stats.total;
            botConfig.timing.hourlyPerformance[block] = {
                winRate,
                total: stats.total,
                blockLabel: `${block * 4}:00-${(parseInt(block) + 1) * 4}:00 UTC`
            };

            if (winRate < 0.35) {
                const startHour = parseInt(block) * 4;
                for (let h = startHour; h < startHour + 4; h++) {
                    newBlockedHours.push(h);
                }
                think(`Blocking hours ${startHour}:00-${startHour + 4}:00 UTC - win rate only ${(winRate*100).toFixed(0)}% over ${stats.total} trades`, 'timing');
                changes++;
            }
        }
    }

    if (JSON.stringify(newBlockedHours.sort()) !== JSON.stringify(botConfig.timing.blockedHours.sort())) {
        const old = [...botConfig.timing.blockedHours];
        botConfig.timing.blockedHours = newBlockedHours;
        logTuning('update_blocked_hours', old, newBlockedHours, 'Based on hourly win rate analysis');
        changes++;
    }

    botConfig.timing.lastHourlyReview = new Date().toISOString();
    return changes;
}

function tuneStreakManagement(trades) {
    let changes = 0;
    const recentTrades = trades.slice(-50);

    const todayStr = new Date().toISOString().split('T')[0];
    if (botConfig.streaks.dailyLossDate !== todayStr) {
        botConfig.streaks.dailyLossToday = 0;
        botConfig.streaks.dailyLossDate = todayStr;
        botConfig.streaks.cautionMode = false;
    }

    const todayTrades = recentTrades.filter(t => t.timestamp && t.timestamp.startsWith(todayStr));
    const todayPnL = todayTrades.reduce((sum, t) => sum + (t.profitPercent || 0), 0);
    botConfig.streaks.dailyLossToday = todayPnL;

    if (todayPnL < -botConfig.streaks.dailyLossLimitPercent) {
        if (!botConfig.streaks.cautionMode) {
            botConfig.streaks.cautionMode = true;
            think(`CAUTION MODE ON: Daily loss ${todayPnL.toFixed(2)}% exceeds limit of ${botConfig.streaks.dailyLossLimitPercent}%`, 'streak');
            logTuning('enable_caution_mode', false, true, `Daily P&L: ${todayPnL.toFixed(2)}%`);
            changes++;
        }
    }

    if (recentTrades.length >= 30) {
        const last30 = recentTrades.slice(-30);
        const winRate = last30.filter(t => t.result === 'WIN').length / last30.length;
        if (winRate < 0.35 && !botConfig.streaks.cautionMode) {
            botConfig.streaks.cautionMode = true;
            think(`CAUTION MODE ON: Win rate dropped to ${(winRate*100).toFixed(0)}% over last 30 trades`, 'streak');
            logTuning('enable_caution_mode', false, true, `Win rate: ${(winRate*100).toFixed(0)}%`);
            changes++;
        }
        if (winRate >= 0.50 && botConfig.streaks.cautionMode) {
            botConfig.streaks.cautionMode = false;
            think(`CAUTION MODE OFF: Win rate recovered to ${(winRate*100).toFixed(0)}%`, 'streak');
            logTuning('disable_caution_mode', true, false, `Win rate recovered: ${(winRate*100).toFixed(0)}%`);
            changes++;
        }
    }

    const quickReentries = [];
    for (let i = 1; i < recentTrades.length; i++) {
        const gap = new Date(recentTrades[i].timestamp).getTime() - new Date(recentTrades[i-1].timestamp).getTime();
        if (gap < 180000) {
            quickReentries.push({
                afterResult: recentTrades[i-1].result,
                nextResult: recentTrades[i].result
            });
        }
    }

    if (quickReentries.length >= 5) {
        const afterLoss = quickReentries.filter(q => q.afterResult === 'LOSS');
        const afterWin = quickReentries.filter(q => q.afterResult === 'WIN');

        if (afterLoss.length >= 3) {
            const afterLossWinRate = afterLoss.filter(q => q.nextResult === 'WIN').length / afterLoss.length;
            if (afterLossWinRate < 0.35) {
                const oldMult = botConfig.streaks.postLossCooldownMultiplier;
                botConfig.streaks.postLossCooldownMultiplier = Math.min(4.0, oldMult + 0.5);
                if (botConfig.streaks.postLossCooldownMultiplier !== oldMult) {
                    think(`Quick re-entry after loss has ${(afterLossWinRate*100).toFixed(0)}% win rate - increasing post-loss cooldown`, 'streak');
                    logTuning('increase_post_loss_cooldown', oldMult, botConfig.streaks.postLossCooldownMultiplier, `Quick re-entry after loss: ${(afterLossWinRate*100).toFixed(0)}% win rate`);
                    changes++;
                }
            }
        }

        if (afterWin.length >= 3) {
            const afterWinWinRate = afterWin.filter(q => q.nextResult === 'WIN').length / afterWin.length;
            if (afterWinWinRate > 0.60) {
                const oldMult = botConfig.streaks.postWinCooldownMultiplier;
                botConfig.streaks.postWinCooldownMultiplier = Math.max(0.3, oldMult - 0.1);
                if (botConfig.streaks.postWinCooldownMultiplier !== oldMult) {
                    think(`Quick re-entry after win has ${(afterWinWinRate*100).toFixed(0)}% win rate - decreasing post-win cooldown`, 'streak');
                    logTuning('decrease_post_win_cooldown', oldMult, botConfig.streaks.postWinCooldownMultiplier, `Quick re-entry after win: ${(afterWinWinRate*100).toFixed(0)}% win rate`);
                    changes++;
                }
            }
        }
    }

    return changes;
}

function tuneMarketSelection(trades) {
    let changes = 0;
    const markets = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];

    for (const market of markets) {
        const marketTrades = trades.filter(t => t.symbol === market).slice(-50);
        if (marketTrades.length < 10) continue;

        const cfg = botConfig.markets[market];
        if (!cfg) continue;

        const wins = marketTrades.filter(t => t.result === 'WIN').length;
        const winRate = wins / marketTrades.length;

        if (winRate < 0.35 && cfg.enabled) {
            cfg.enabled = false;
            cfg.pausedUntil = Date.now() + (6 * 60 * 60 * 1000);
            think(`PAUSING ${market}: Win rate ${(winRate*100).toFixed(0)}% over ${marketTrades.length} trades - will recheck in 6 hours`, 'market_selection');
            logTuning('pause_market', market, 'paused', `${(winRate*100).toFixed(0)}% win rate`);
            changes++;
        }

        if (!cfg.enabled && cfg.pausedUntil && Date.now() >= cfg.pausedUntil) {
            cfg.enabled = true;
            cfg.pausedUntil = null;
            think(`UNPAUSING ${market}: 6-hour pause expired, retesting`, 'market_selection');
            logTuning('unpause_market', 'paused', market, '6-hour pause expired');
            changes++;
        }

        if (winRate > 0.60 && marketTrades.length >= 15) {
            cfg.confidenceMultiplier = 1.3;
            think(`${market} performing well (${(winRate*100).toFixed(0)}%) - boosting confidence multiplier`, 'market_selection');
        } else if (winRate < 0.45) {
            cfg.confidenceMultiplier = 0.7;
        } else {
            cfg.confidenceMultiplier = 1.0;
        }
    }

    return changes;
}

function tuneVolatilityResponse(trades, marketStates) {
    let changes = 0;
    const recentTrades = trades.slice(-30);
    if (recentTrades.length < 10) return 0;

    const highVolTrades = recentTrades.filter(t => t.pattern && t.pattern.volatility > 0.3);
    const lowVolTrades = recentTrades.filter(t => t.pattern && t.pattern.volatility <= 0.3);

    if (highVolTrades.length >= 5) {
        const hvWinRate = highVolTrades.filter(t => t.result === 'WIN').length / highVolTrades.length;
        if (hvWinRate < 0.35) {
            const old = botConfig.volatility.highVolStopMultiplier;
            botConfig.volatility.highVolStopMultiplier = Math.min(2.0, old + 0.1);
            if (old !== botConfig.volatility.highVolStopMultiplier) {
                think(`High volatility trades losing (${(hvWinRate*100).toFixed(0)}%) - widening high-vol stops`, 'volatility');
                logTuning('widen_high_vol_stops', old, botConfig.volatility.highVolStopMultiplier, `High vol win rate: ${(hvWinRate*100).toFixed(0)}%`);
                changes++;
            }
        }
    }

    for (const [symbol, state] of Object.entries(marketStates)) {
        if (state.volatility > botConfig.volatility.extremeVolatilityThreshold) {
            botConfig.volatility.lastSpikeTime = Date.now();
            think(`[${symbol}] Extreme volatility detected (${state.volatility.toFixed(2)}%) - activating post-spike wait`, 'volatility');
        }
    }

    return changes;
}

function tunePositionSizing(trades) {
    let changes = 0;
    const recentTrades = trades.slice(-20);
    if (recentTrades.length < 10) return 0;

    let consecutiveLosses = 0;
    for (let i = recentTrades.length - 1; i >= 0; i--) {
        if (recentTrades[i].result === 'LOSS') consecutiveLosses++;
        else break;
    }

    if (consecutiveLosses >= 3 && !botConfig.positioning.lossReductionActive) {
        botConfig.positioning.lossReductionActive = true;
        think(`${consecutiveLosses} consecutive losses - reducing position size by 30%`, 'position_size');
        logTuning('reduce_position_size', 1.0, botConfig.positioning.postLossSizeReduction, `${consecutiveLosses} consecutive losses`);
        changes++;
    }

    if (consecutiveLosses === 0 && botConfig.positioning.lossReductionActive) {
        botConfig.positioning.lossReductionActive = false;
        think('Win recorded - restoring normal position size', 'position_size');
        logTuning('restore_position_size', botConfig.positioning.postLossSizeReduction, 1.0, 'Win recorded after loss streak');
        changes++;
    }

    return changes;
}

function tuneCooldowns(trades) {
    let changes = 0;
    const recentTrades = trades.slice(-30);
    if (recentTrades.length < 10) return 0;

    const markets = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];
    for (const market of markets) {
        const mTrades = recentTrades.filter(t => t.symbol === market);
        if (mTrades.length < 5) continue;

        const winRate = mTrades.filter(t => t.result === 'WIN').length / mTrades.length;

        if (winRate < 0.35) {
            const old = botConfig.cooldown.currentCooldownMs;
            botConfig.cooldown.currentCooldownMs = Math.min(botConfig.cooldown.maxCooldownMs, old + 30000);
            if (old !== botConfig.cooldown.currentCooldownMs) {
                think(`[${market}] Low win rate (${(winRate*100).toFixed(0)}%) - increasing cooldown to ${botConfig.cooldown.currentCooldownMs/1000}s`, 'cooldown');
                logTuning('increase_cooldown', old/1000 + 's', botConfig.cooldown.currentCooldownMs/1000 + 's', `${market} win rate: ${(winRate*100).toFixed(0)}%`);
                changes++;
            }
        }

        if (winRate > 0.60) {
            const old = botConfig.cooldown.currentCooldownMs;
            botConfig.cooldown.currentCooldownMs = Math.max(botConfig.cooldown.minCooldownMs, old - 15000);
            if (old !== botConfig.cooldown.currentCooldownMs) {
                think(`[${market}] High win rate (${(winRate*100).toFixed(0)}%) - decreasing cooldown to ${botConfig.cooldown.currentCooldownMs/1000}s`, 'cooldown');
                logTuning('decrease_cooldown', old/1000 + 's', botConfig.cooldown.currentCooldownMs/1000 + 's', `${market} win rate: ${(winRate*100).toFixed(0)}%`);
                changes++;
            }
        }
    }

    return changes;
}

function shouldTrade(symbol, direction, patternKey, confidence, marketState) {
    if (!botConfig) loadConfig();
    const reasons = [];
    let allowed = true;
    let sizeMultiplier = 1.0;

    const marketCfg = botConfig.markets[symbol];
    if (!marketCfg) {
        reasons.push('Unknown market');
        return { allowed: false, reasons, sizeMultiplier };
    }

    if (!marketCfg.enabled) {
        reasons.push(`${symbol} is paused until ${new Date(marketCfg.pausedUntil).toLocaleTimeString()}`);
        think(`BLOCKED: ${symbol} is paused by self-tuner`, 'decision');
        return { allowed: false, reasons, sizeMultiplier };
    }

    if (botConfig.patterns.disabledPatterns.includes(patternKey)) {
        reasons.push(`Pattern "${patternKey}" is disabled (low win rate)`);
        think(`BLOCKED: Pattern "${patternKey}" disabled - historically unprofitable`, 'decision');
        return { allowed: false, reasons, sizeMultiplier };
    }

    const dirOverride = botConfig.patterns.patternDirectionOverride[patternKey];
    if (dirOverride === 'LONG_ONLY' && direction === 'SHORT') {
        reasons.push(`Pattern "${patternKey}" only profitable as LONG`);
        think(`BLOCKED: Pattern works LONG only, signal is SHORT`, 'decision');
        return { allowed: false, reasons, sizeMultiplier };
    }
    if (dirOverride === 'SHORT_ONLY' && direction === 'LONG') {
        reasons.push(`Pattern "${patternKey}" only profitable as SHORT`);
        think(`BLOCKED: Pattern works SHORT only, signal is LONG`, 'decision');
        return { allowed: false, reasons, sizeMultiplier };
    }

    const currentHour = new Date().getUTCHours();
    if (botConfig.timing.blockedHours.includes(currentHour)) {
        reasons.push(`Hour ${currentHour}:00 UTC is blocked (poor performance)`);
        think(`BLOCKED: Trading during blocked hour ${currentHour}:00 UTC`, 'decision');
        return { allowed: false, reasons, sizeMultiplier };
    }

    if (botConfig.streaks.cautionMode) {
        if (confidence < botConfig.streaks.cautionModeMinWinRate) {
            reasons.push(`Caution mode active - need ${(botConfig.streaks.cautionModeMinWinRate*100).toFixed(0)}%+ confidence`);
            think(`BLOCKED: Caution mode requires high confidence (have ${(confidence*100).toFixed(0)}%, need ${(botConfig.streaks.cautionModeMinWinRate*100).toFixed(0)}%)`, 'decision');
            return { allowed: false, reasons, sizeMultiplier };
        }
        reasons.push('Caution mode active but confidence is sufficient');
    }

    if (botConfig.volatility.lastSpikeTime) {
        const timeSinceSpike = Date.now() - botConfig.volatility.lastSpikeTime;
        if (timeSinceSpike < botConfig.volatility.postSpikeWaitMs) {
            const waitLeft = Math.round((botConfig.volatility.postSpikeWaitMs - timeSinceSpike) / 1000);
            reasons.push(`Post-volatility spike wait: ${waitLeft}s remaining`);
            think(`BLOCKED: Waiting ${waitLeft}s after volatility spike`, 'decision');
            return { allowed: false, reasons, sizeMultiplier };
        }
    }

    if (confidence >= 0.70) {
        sizeMultiplier = botConfig.positioning.highConfidenceMultiplier * marketCfg.confidenceMultiplier;
        reasons.push(`High confidence (${(confidence*100).toFixed(0)}%) - position x${sizeMultiplier.toFixed(1)}`);
    } else if (confidence >= 0.55) {
        sizeMultiplier = botConfig.positioning.mediumConfidenceMultiplier * marketCfg.confidenceMultiplier;
        reasons.push(`Medium confidence - position x${sizeMultiplier.toFixed(1)}`);
    } else {
        sizeMultiplier = botConfig.positioning.lowConfidenceMultiplier * marketCfg.confidenceMultiplier;
        reasons.push(`Low confidence - position x${sizeMultiplier.toFixed(1)}`);
    }

    if (botConfig.positioning.lossReductionActive) {
        sizeMultiplier *= botConfig.positioning.postLossSizeReduction;
        reasons.push(`Loss streak reduction active - size x${botConfig.positioning.postLossSizeReduction}`);
    }

    if (marketState && marketState.volatility > 0.3) {
        sizeMultiplier *= 0.7;
        reasons.push('High volatility - reducing size by 30%');
    }

    think(`ALLOWED: ${direction} on ${symbol} | Pattern: ${patternKey} | Size: x${sizeMultiplier.toFixed(2)} | ${reasons.join(', ')}`, 'decision');

    return { allowed, reasons, sizeMultiplier };
}

function getEffectiveCooldown(lastResult) {
    if (!botConfig) loadConfig();
    const base = botConfig.cooldown.currentCooldownMs;
    if (lastResult === 'LOSS') {
        return Math.min(botConfig.cooldown.maxCooldownMs, base * botConfig.streaks.postLossCooldownMultiplier);
    }
    if (lastResult === 'WIN') {
        return Math.max(botConfig.cooldown.minCooldownMs, base * botConfig.streaks.postWinCooldownMultiplier);
    }
    return base;
}

function getEffectiveStopLoss(symbol, volatility) {
    if (!botConfig) loadConfig();
    const cfg = botConfig.markets[symbol];
    if (!cfg) return 1.5;

    let sl = cfg.stopLoss;
    if (volatility > 0.3) {
        sl *= botConfig.volatility.highVolStopMultiplier;
    } else if (volatility < 0.1) {
        sl *= botConfig.volatility.lowVolStopMultiplier;
    }
    return Math.max(0.5, Math.min(4.0, sl));
}

function getEffectiveTakeProfit(symbol) {
    if (!botConfig) loadConfig();
    const cfg = botConfig.markets[symbol];
    if (!cfg) return 2.0;
    return cfg.takeProfit;
}

function getEffectiveTrailing(symbol, dangerMode) {
    if (!botConfig) loadConfig();
    const cfg = botConfig.markets[symbol];
    if (!cfg) return 0.4;
    return dangerMode ? cfg.trailingDanger : cfg.trailingNormal;
}

function getThinkingLog() {
    return thinkingLog;
}

function getTuningLog() {
    return tuningLog;
}

function getConfig() {
    if (!botConfig) loadConfig();
    return botConfig;
}

function isMarketEnabled(symbol) {
    if (!botConfig) loadConfig();
    const cfg = botConfig.markets[symbol];
    if (!cfg) return true;
    if (!cfg.enabled && cfg.pausedUntil && Date.now() >= cfg.pausedUntil) {
        cfg.enabled = true;
        cfg.pausedUntil = null;
        saveConfig();
    }
    return cfg.enabled;
}

module.exports = {
    loadConfig,
    saveConfig,
    getConfig,
    getMarketConfig,
    runFullTuning,
    shouldTrade,
    getEffectiveCooldown,
    getEffectiveStopLoss,
    getEffectiveTakeProfit,
    getEffectiveTrailing,
    isMarketEnabled,
    think,
    getThinkingLog,
    getTuningLog,
    logTuning
};
