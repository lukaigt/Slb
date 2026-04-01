'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'tp_sl_stats.json');

const TP_OPTIONS = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.75, 1.00];
const SL_OPTIONS = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.75, 1.00, 1.25, 1.50, 2.00];

const MIN_TRADES_FOR_EXPLOIT = 20;
const EXPLORATION_RATE = 0.20;
const MIN_COMBO_TRADES = 3;

let stats = {
    version: 1,
    combos: {},
    totalTrades: 0,
    lastUpdated: null
};

function comboKey(tp, sl) {
    return `${tp.toFixed(2)}_${sl.toFixed(2)}`;
}

function parseComboKey(key) {
    const [tp, sl] = key.split('_').map(Number);
    return { tp, sl };
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function load() {
    ensureDataDir();
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === 'object' && parsed.combos) {
                const combos = parsed.combos || {};
                for (const key of Object.keys(combos)) {
                    const c = combos[key];
                    if (c.bestProfit == null) c.bestProfit = -Infinity;
                    if (c.worstProfit == null) c.worstProfit = Infinity;
                }
                stats = {
                    version: parsed.version || 1,
                    combos,
                    totalTrades: parsed.totalTrades || 0,
                    lastUpdated: parsed.lastUpdated || null
                };
                console.log(`[TP/SL Optimizer] Loaded ${Object.keys(stats.combos).length} combo stats, ${stats.totalTrades} total trades`);
            }
        } else {
            console.log('[TP/SL Optimizer] No stats file found, starting fresh');
        }
    } catch (e) {
        console.log(`[TP/SL Optimizer] Error loading stats: ${e.message}, starting fresh`);
        stats = { version: 1, combos: {}, totalTrades: 0, lastUpdated: null };
    }
}

function save() {
    ensureDataDir();
    try {
        stats.lastUpdated = new Date().toISOString();
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        console.log(`[TP/SL Optimizer] Error saving stats: ${e.message}`);
    }
}

function adjustForATR(baseTP, baseSL, atrPercent) {
    if (atrPercent == null || atrPercent <= 0) return { tp: baseTP, sl: baseSL };

    const normalATR = 0.10;
    const ratio = Math.max(0.5, Math.min(3.0, atrPercent / normalATR));

    let adjustedTP = baseTP * ratio;
    let adjustedSL = baseSL * ratio;

    adjustedTP = Math.max(0.10, Math.min(2.00, adjustedTP));
    adjustedSL = Math.max(0.10, Math.min(3.00, adjustedSL));

    adjustedTP = Math.round(adjustedTP * 100) / 100;
    adjustedSL = Math.round(adjustedSL * 100) / 100;

    return { tp: adjustedTP, sl: adjustedSL };
}

function getComboScore(combo) {
    if (!combo || combo.total < MIN_COMBO_TRADES) return null;
    const winRate = combo.wins / combo.total;
    const avgProfit = combo.totalProfit / combo.total;
    return (winRate * 0.6) + (Math.min(1, Math.max(-1, avgProfit / 10)) * 0.4);
}

function selectBestCombo() {
    const entries = Object.entries(stats.combos);
    const scored = [];
    for (const [key, combo] of entries) {
        const score = getComboScore(combo);
        if (score !== null) {
            scored.push({ key, score, combo });
        }
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
}

function getRecommendedTPSL(atrPercent, symbol) {
    const isExploiting = stats.totalTrades >= MIN_TRADES_FOR_EXPLOIT;
    const shouldExplore = !isExploiting || Math.random() < EXPLORATION_RATE;

    let baseTP, baseSL, mode;

    if (shouldExplore || !isExploiting) {
        const tpIdx = Math.floor(Math.random() * TP_OPTIONS.length);
        const slIdx = Math.floor(Math.random() * SL_OPTIONS.length);
        baseTP = TP_OPTIONS[tpIdx];
        baseSL = SL_OPTIONS[slIdx];
        mode = isExploiting ? 'TP_SL_EXPLORE' : 'TP_SL_LEARNING';
    } else {
        const best = selectBestCombo();
        if (best) {
            const parsed = parseComboKey(best.key);
            baseTP = parsed.tp;
            baseSL = parsed.sl;
            mode = 'TP_SL_OPTIMIZED';
        } else {
            baseTP = 0.40;
            baseSL = 0.40;
            mode = 'TP_SL_DEFAULT';
        }
    }

    const adjusted = adjustForATR(baseTP, baseSL, atrPercent);

    return {
        tp: adjusted.tp,
        sl: adjusted.sl,
        baseTP,
        baseSL,
        mode,
        atrAdjusted: atrPercent != null && atrPercent > 0,
        atrPercent: atrPercent || 0
    };
}

function recordResult(tp, sl, result, profitPercent, symbol) {
    const key = comboKey(tp, sl);

    if (!stats.combos[key]) {
        stats.combos[key] = {
            tp, sl,
            wins: 0, losses: 0, total: 0,
            totalProfit: 0,
            bestProfit: -Infinity, worstProfit: Infinity,
            byMarket: {}
        };
    }

    const combo = stats.combos[key];
    combo.total++;
    if (result === 'WIN') combo.wins++;
    else combo.losses++;
    combo.totalProfit += profitPercent;
    if (profitPercent > combo.bestProfit) combo.bestProfit = profitPercent;
    if (profitPercent < combo.worstProfit) combo.worstProfit = profitPercent;

    if (symbol) {
        if (!combo.byMarket[symbol]) combo.byMarket[symbol] = { wins: 0, losses: 0, total: 0, totalProfit: 0 };
        combo.byMarket[symbol].total++;
        if (result === 'WIN') combo.byMarket[symbol].wins++;
        else combo.byMarket[symbol].losses++;
        combo.byMarket[symbol].totalProfit += profitPercent;
    }

    stats.totalTrades++;
    save();
}

function getTopCombos(limit) {
    limit = limit || 15;
    const entries = Object.entries(stats.combos);
    const scored = entries.map(([key, combo]) => {
        const score = getComboScore(combo);
        const wr = combo.total > 0 ? (combo.wins / combo.total * 100) : 0;
        const avgP = combo.total > 0 ? (combo.totalProfit / combo.total) : 0;
        return {
            key,
            tp: combo.tp,
            sl: combo.sl,
            wins: combo.wins,
            losses: combo.losses,
            total: combo.total,
            winRate: Math.round(wr * 10) / 10,
            avgProfit: Math.round(avgP * 100) / 100,
            totalProfit: Math.round(combo.totalProfit * 100) / 100,
            bestProfit: isFinite(combo.bestProfit) ? Math.round(combo.bestProfit * 100) / 100 : 0,
            worstProfit: isFinite(combo.worstProfit) ? Math.round(combo.worstProfit * 100) / 100 : 0,
            score: score != null ? Math.round(score * 1000) / 1000 : null,
            byMarket: combo.byMarket || {}
        };
    });
    scored.sort((a, b) => (b.total - a.total));
    return scored.slice(0, limit);
}

function getOptimizerStats() {
    const isExploiting = stats.totalTrades >= MIN_TRADES_FOR_EXPLOIT;
    const best = selectBestCombo();
    const combosWithData = Object.values(stats.combos).filter(c => c.total >= MIN_COMBO_TRADES).length;
    const totalCombos = Object.keys(stats.combos).length;

    return {
        totalTrades: stats.totalTrades,
        totalCombos,
        combosWithData,
        isExploiting,
        explorationRate: isExploiting ? Math.round(EXPLORATION_RATE * 100) : 100,
        learningProgress: Math.min(100, Math.round((stats.totalTrades / MIN_TRADES_FOR_EXPLOIT) * 100)),
        bestCombo: best ? {
            tp: parseComboKey(best.key).tp,
            sl: parseComboKey(best.key).sl,
            score: Math.round(best.score * 1000) / 1000,
            winRate: Math.round((best.combo.wins / best.combo.total) * 100),
            total: best.combo.total,
            avgProfit: Math.round((best.combo.totalProfit / best.combo.total) * 100) / 100
        } : null,
        lastUpdated: stats.lastUpdated
    };
}

module.exports = {
    load,
    save,
    getRecommendedTPSL,
    recordResult,
    getTopCombos,
    getOptimizerStats,
    TP_OPTIONS,
    SL_OPTIONS,
    MIN_TRADES_FOR_EXPLOIT
};
