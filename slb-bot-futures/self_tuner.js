const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'bot_config.json');

const DEFAULT_CONFIG = {
    version: 2,
    lastUpdated: null,
    dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT) || 10,
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || 4,
    maxPositionRiskPercent: 3.0,
    paused: false,
    pauseReason: null,
    pausedUntil: null,
    dailyStats: {
        date: null,
        totalPnl: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        consecutiveLosses: 0
    }
};

let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            const loaded = JSON.parse(data);
            config = { ...DEFAULT_CONFIG, ...loaded, dailyStats: { ...DEFAULT_CONFIG.dailyStats, ...(loaded.dailyStats || {}) } };
            config.dailyLossLimit = DEFAULT_CONFIG.dailyLossLimit;
            config.maxConsecutiveLosses = DEFAULT_CONFIG.maxConsecutiveLosses;
        }
    } catch (e) {
        console.log(`[Safety] Config load error: ${e.message}, using defaults`);
    }
    resetDayIfNeeded();
}

function saveConfig() {
    try {
        config.lastUpdated = new Date().toISOString();
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.log(`[Safety] Config save error: ${e.message}`);
    }
}

function resetDayIfNeeded() {
    const today = new Date().toISOString().split('T')[0];
    if (config.dailyStats.date !== today) {
        config.dailyStats = {
            date: today,
            totalPnl: 0,
            trades: 0,
            wins: 0,
            losses: 0,
            consecutiveLosses: 0
        };
        if (config.paused && config.pauseReason === 'daily_loss_limit') {
            config.paused = false;
            config.pauseReason = null;
        }
        saveConfig();
    }
}

function recordTradeResult(profitPercent, isWin) {
    resetDayIfNeeded();
    config.dailyStats.trades++;
    config.dailyStats.totalPnl += profitPercent;

    if (isWin) {
        config.dailyStats.wins++;
        config.dailyStats.consecutiveLosses = 0;
    } else {
        config.dailyStats.losses++;
        config.dailyStats.consecutiveLosses++;
    }

    if (config.dailyStats.totalPnl <= -config.dailyLossLimit) {
        config.paused = true;
        config.pauseReason = 'daily_loss_limit';
        console.log(`[SAFETY] PAUSED: Daily loss limit reached (${config.dailyStats.totalPnl.toFixed(2)}% / -${config.dailyLossLimit}%)`);
    }

    if (config.dailyStats.consecutiveLosses >= config.maxConsecutiveLosses) {
        config.paused = true;
        config.pauseReason = 'consecutive_losses';
        console.log(`[SAFETY] PAUSED: ${config.dailyStats.consecutiveLosses} consecutive losses`);
    }

    saveConfig();
}

function canTrade() {
    resetDayIfNeeded();

    if (config.paused) {
        return { allowed: false, reason: config.pauseReason || 'paused' };
    }

    return { allowed: true };
}

function unpause() {
    config.paused = false;
    config.pauseReason = null;
    saveConfig();
}

function isPaused() {
    return config.paused;
}

function pause(reason) {
    config.paused = true;
    config.pauseReason = reason;
    saveConfig();
}

function getStats() {
    resetDayIfNeeded();
    return {
        dailyProfitPercent: config.dailyStats.totalPnl
    };
}

function getStatus() {
    resetDayIfNeeded();
    return {
        paused: config.paused,
        pauseReason: config.pauseReason,
        dailyPnl: config.dailyStats.totalPnl,
        dailyLossLimit: config.dailyLossLimit,
        dailyTrades: config.dailyStats.trades,
        dailyWins: config.dailyStats.wins,
        dailyLosses: config.dailyStats.losses,
        consecutiveLosses: config.dailyStats.consecutiveLosses,
        maxConsecutiveLosses: config.maxConsecutiveLosses,
        dailyWinRate: config.dailyStats.trades > 0
            ? ((config.dailyStats.wins / config.dailyStats.trades) * 100).toFixed(1)
            : '0.0'
    };
}

module.exports = {
    loadConfig,
    saveConfig,
    recordTradeResult,
    canTrade,
    unpause,
    isPaused,
    pause,
    getStats,
    getStatus
};
