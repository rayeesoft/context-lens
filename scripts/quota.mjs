import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateCostUsd,
  discoverSurfaceDirs,
  getModelLabel,
  loadConversationSummaries,
  loadHookSessionModels,
  normalizeModelFamily,
  toLocalDateKey,
} from './analyzer.mjs';
import {
  loadOfficialQuotaCache,
  normalizeProxyUrl,
  syncQuotaViaCli,
} from './cli-quota-sync.mjs';

const ID_RE = /^[0-9a-f-]{8,}$/i;
const MODEL_CHANGE_RE = /changed setting `Model Selection` from [^\n]+? to (.+?)(?=\.(?:\s|$|<)|<|\n|$)/i;
const QUOTA_ERROR_RE = /quota|exhausted.*capacity|resource_exhausted|\b429\b|rate.?limit|too many requests/i;

export const FIVE_HOURS_MS = 5 * 3600_000;
export const ONE_DAY_MS = 86400_000;
export const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
export const SCAN_RETENTION_MS = 15 * ONE_DAY_MS;

export const ALLOWED_STATUS_MODES = ['dual_pct', 'pct7d_timer', 'pct_timer', 'pct_cost', 'pct_only'];

export const POOL_ORDER = ['gemini', 'claude'];

export const POOL_META = {
  gemini: {
    key: 'gemini',
    label: 'Gemini Models',
    subtitle: 'Carbon / Argon / Hydrogen / Pro / Flash',
    shortLabel: 'Gemini',
  },
  claude: {
    key: 'claude',
    label: 'Claude & GPT',
    subtitle: 'Claude Opus / Sonnet · GPT-OSS',
    shortLabel: 'Claude',
  },
};

export const PLAN_PRESETS = {
  ultra_20x: {
    tierKey: 'ultra_20x',
    label: 'Google AI Ultra',
    monthlyPriceUsd: 249.99,
    pools: {
      gemini: { budget5hUsd: 580, budget7dUsd: 2500 },
      claude: { budget5hUsd: 100, budget7dUsd: 180 },
    },
  },
  ultra: {
    tierKey: 'ultra',
    label: 'Google AI Ultra (Standard)',
    monthlyPriceUsd: 199.99,
    pools: {
      gemini: { budget5hUsd: 300, budget7dUsd: 1400 },
      claude: { budget5hUsd: 70, budget7dUsd: 130 },
    },
  },
  pro: {
    tierKey: 'pro',
    label: 'Google AI Pro',
    monthlyPriceUsd: 19.99,
    pools: {
      gemini: { budget5hUsd: 30, budget7dUsd: 160 },
      claude: { budget5hUsd: 12, budget7dUsd: 45 },
    },
  },
  plus: {
    tierKey: 'plus',
    label: 'Google AI Plus',
    monthlyPriceUsd: 4.99,
    pools: {
      gemini: { budget5hUsd: 10, budget7dUsd: 50 },
      claude: { budget5hUsd: 4, budget7dUsd: 15 },
    },
  },
  free: {
    tierKey: 'free',
    label: 'Free',
    monthlyPriceUsd: 0,
    pools: {
      gemini: { budget5hUsd: 3, budget7dUsd: 15 },
      claude: { budget5hUsd: 1, budget7dUsd: 5 },
    },
  },
};

export function mapFamilyToPool(familyKey) {
  if (familyKey === 'claude-opus-5' || familyKey === 'claude-sonnet' || familyKey === 'gpt-oss') {
    return 'claude';
  }
  return 'gemini';
}

export function formatCompactDuration(seconds) {
  const secs = Math.max(0, Number(seconds || 0));
  const totalMins = Math.max(1, Math.round(secs / 60));
  if (totalMins < 60) {
    return `${totalMins}m`;
  }
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours < 24) {
    return `${hours}h${String(mins).padStart(2, '0')}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d${String(remHours).padStart(2, '0')}h`;
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

export function resolvePluginDataDir(options = {}) {
  if (options.pluginDataDir) return options.pluginDataDir;
  if (process.env.CL_PLUGIN_DATA) return process.env.CL_PLUGIN_DATA;
  const geminiRoot = options.geminiRoot || process.env.CL_GEMINI_ROOT || path.join(os.homedir(), '.gemini');
  return path.join(geminiRoot, 'antigravity', 'plugin_data', 'context-lens');
}

export function createDefaultConfig(tierKey = 'ultra_20x') {
  const preset = PLAN_PRESETS[tierKey] || PLAN_PRESETS.ultra_20x;
  const pools = {};
  for (const key of POOL_ORDER) {
    pools[key] = {
      budget5hUsd: preset.pools[key].budget5hUsd,
      autoScalePeak: true,
      lastResetAtMs: null,
      calibration: null,
      budget7dUsd: preset.pools[key].budget7dUsd,
      autoScalePeak7d: true,
      lastReset7dAtMs: null,
      calibration7d: null,
    };
  }
  return {
    version: 1,
    planTier: preset.tierKey,
    statusBarMode: 'dual_pct',
    primaryPool: 'auto',
    proxyUrl: null,
    pools,
    credits: {
      available: null,
      monthly: null,
      updatedAt: null,
    },
  };
}

function normalizeCalibration(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const calibratedAtMs = Number(raw.calibratedAtMs);
  if (!Number.isFinite(calibratedAtMs) || calibratedAtMs <= 0) return null;
  const resetAtMs = raw.resetAtMs !== null && raw.resetAtMs !== undefined && Number.isFinite(Number(raw.resetAtMs))
    ? Number(raw.resetAtMs)
    : null;
  return {
    remainingPct: clampPct(raw.remainingPct),
    calibratedAtMs,
    resetAtMs,
    windowCostAtCalibrationUsd: Math.max(0, Number(raw.windowCostAtCalibrationUsd || 0)),
  };
}

export function loadQuotaConfig(options = {}) {
  const dir = resolvePluginDataDir(options);
  const filePath = path.join(dir, 'quota-config.json');
  const defaults = createDefaultConfig('ultra_20x');

  try {
    if (!fs.existsSync(filePath)) return defaults;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return defaults;

    const tierKey = PLAN_PRESETS[raw.planTier] ? raw.planTier : 'ultra_20x';
    const base = createDefaultConfig(tierKey);

    base.statusBarMode = ALLOWED_STATUS_MODES.includes(raw.statusBarMode)
      ? raw.statusBarMode
      : 'dual_pct';
    base.primaryPool = ['auto', ...POOL_ORDER].includes(raw.primaryPool)
      ? raw.primaryPool
      : 'auto';
    if (raw.proxyUrl !== undefined) {
      try {
        base.proxyUrl = normalizeProxyUrl(raw.proxyUrl);
      } catch {
        base.proxyUrl = null;
      }
    }

    if (raw.pools && typeof raw.pools === 'object') {
      for (const key of POOL_ORDER) {
        const rp = raw.pools[key];
        if (!rp || typeof rp !== 'object') continue;
        const b5 = Number(rp.budget5hUsd);
        if (Number.isFinite(b5) && b5 > 0) {
          base.pools[key].budget5hUsd = b5;
        }
        if (typeof rp.autoScalePeak === 'boolean') {
          base.pools[key].autoScalePeak = rp.autoScalePeak;
        }
        const lr5 = Number(rp.lastResetAtMs);
        base.pools[key].lastResetAtMs = Number.isFinite(lr5) && lr5 > 0 ? lr5 : null;
        base.pools[key].calibration = normalizeCalibration(rp.calibration);

        const b7 = Number(rp.budget7dUsd);
        if (Number.isFinite(b7) && b7 > 0) {
          base.pools[key].budget7dUsd = b7;
        }
        if (typeof rp.autoScalePeak7d === 'boolean') {
          base.pools[key].autoScalePeak7d = rp.autoScalePeak7d;
        }
        const lr7 = Number(rp.lastReset7dAtMs);
        base.pools[key].lastReset7dAtMs = Number.isFinite(lr7) && lr7 > 0 ? lr7 : null;
        base.pools[key].calibration7d = normalizeCalibration(rp.calibration7d);
      }
    }

    if (raw.credits && typeof raw.credits === 'object') {
      const avail = raw.credits.available;
      const monthly = raw.credits.monthly;
      base.credits = {
        available: avail !== null && avail !== undefined && Number.isFinite(Number(avail)) ? Math.max(0, Number(avail)) : null,
        monthly: monthly !== null && monthly !== undefined && Number.isFinite(Number(monthly)) ? Math.max(0, Number(monthly)) : null,
        updatedAt: typeof raw.credits.updatedAt === 'string' ? raw.credits.updatedAt : null,
      };
    }

    return base;
  } catch {
    return defaults;
  }
}

export function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function saveQuotaConfig(config, options = {}) {
  const dir = resolvePluginDataDir(options);
  const filePath = path.join(dir, 'quota-config.json');
  writeJsonAtomic(filePath, config);
  return filePath;
}

function loadScanCache(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) return { version: 2, entries: {} };
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === 2 &&
      parsed.entries &&
      typeof parsed.entries === 'object'
    ) {
      return { version: 2, entries: parsed.entries };
    }
  } catch {}
  return { version: 2, entries: {} };
}

function extractTitleFromUserContent(content) {
  if (!content) return '';
  const reqMatch = String(content).match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  let text = reqMatch ? reqMatch[1] : String(content);
  text = text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

function extractModelSelection(content) {
  if (!content || typeof content !== 'string') return null;
  const match = content.match(MODEL_CHANGE_RE);
  return match ? match[1].trim() : null;
}

function parseTranscriptForQuota(filePath, stat, fallbackModel, currentMonthKey, retentionStartMs) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let activeModelRaw = fallbackModel || '';
  let lastExplicitModelRaw = activeModelRaw;
  let activeFamily = normalizeModelFamily(activeModelRaw);
  let previewTitle = '';
  let firstTurnTsMs = null;
  const modelChanges = [];

  let latestContextTokens = 0;
  let sessionPromptTokens = 0;
  let sessionCacheTokens = 0;

  let monthCostUsd = 0;
  let monthTokens = 0;
  let monthTurns = 0;

  const recentTurns7d = [];
  let recentQuotaError = null;

  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }

    const parsedTs = step.created_at ? Date.parse(step.created_at) : NaN;
    const tsMs = Number.isFinite(parsedTs) ? parsedTs : stat.mtimeMs;
    if (firstTurnTsMs === null || tsMs < firstTurnTsMs) {
      firstTurnTsMs = tsMs;
    }

    if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
      if (!previewTitle) {
        previewTitle = extractTitleFromUserContent(step.content);
      }
      const nextModel = extractModelSelection(step.content);
      if (nextModel) {
        activeModelRaw = nextModel;
        lastExplicitModelRaw = nextModel;
        activeFamily = normalizeModelFamily(nextModel);
        modelChanges.push([tsMs, nextModel]);
      }
    }

    if (step.type === 'ERROR_MESSAGE' || step.status === 'ERROR' || step.error) {
      const errStr = String(step.error || step.content || '').replace(/\s+/g, ' ').trim();
      if (QUOTA_ERROR_RE.test(errStr)) {
        const kind = /quota|exhausted.*capacity|resource_exhausted/i.test(errStr)
          ? 'quota_exhausted'
          : 'rate_limited';
        const poolKey = mapFamilyToPool(activeFamily);
        recentQuotaError = {
          tsMs,
          poolKey,
          kind,
          message: errStr.length > 140 ? `${errStr.slice(0, 137)}...` : errStr,
        };
      }
    }

    const inTok = Number(step.input_tokens || 0);
    const cacheTok = Number(step.cache_read_tokens || 0);
    const outTok = Number(step.output_tokens || 0);

    if (step.type === 'PLANNER_RESPONSE' && (inTok > 0 || cacheTok > 0)) {
      latestContextTokens = inTok + cacheTok;
    }

    if (inTok > 0 || cacheTok > 0 || outTok > 0) {
      sessionPromptTokens += inTok + cacheTok;
      sessionCacheTokens += cacheTok;

      const totalTok = inTok + cacheTok + outTok;
      const cost = calculateCostUsd(
        { inputTokens: inTok, cacheReadTokens: cacheTok, outputTokens: outTok },
        activeFamily,
        inTok + cacheTok
      );
      const poolKey = mapFamilyToPool(activeFamily);

      const dateKey = toLocalDateKey(tsMs);
      if (dateKey && dateKey.startsWith(currentMonthKey)) {
        monthCostUsd += cost.totalCostUsd;
        monthTokens += totalTok;
        monthTurns += 1;
      }

      if (tsMs >= retentionStartMs) {
        recentTurns7d.push([tsMs, poolKey, totalTok, +cost.totalCostUsd.toFixed(6)]);
      }
    }
  }

  const latestCacheHitRate = sessionPromptTokens > 0
    ? +((sessionCacheTokens / sessionPromptTokens) * 100).toFixed(1)
    : 0;

  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    fallbackModel,
    hookFallbackModel: fallbackModel,
    monthKey: currentMonthKey,
    recentWindowStartMs: retentionStartMs,
    firstTurnTsMs,
    modelChanges,
    activeModelRaw: lastExplicitModelRaw,
    activeFamily,
    previewTitle,
    latestContextTokens,
    latestCacheHitRate,
    monthCostUsd: +monthCostUsd.toFixed(6),
    monthTokens,
    monthTurns,
    recentTurns7d,
    recentQuotaError,
  };
}

function resolveParentModelAt(parentRec, targetTsMs) {
  const changes = parentRec?.parsed?.modelChanges;
  if (Array.isArray(changes) && changes.length > 0 && Number.isFinite(targetTsMs)) {
    let matched = '';
    for (const [tsMs, rawModel] of changes) {
      if (tsMs <= targetTsMs) {
        matched = rawModel;
      } else {
        break;
      }
    }
    if (matched) return matched;
  }
  return parentRec?.parsed?.activeModelRaw || parentRec?.fallbackModel || '';
}

function computePeakWindowCost(turns, windowMs) {
  if (!turns.length) return 0;
  let left = 0;
  let running = 0;
  let peak = 0;
  for (let right = 0; right < turns.length; right++) {
    running += turns[right].costUsd;
    while (turns[right].tsMs - turns[left].tsMs > windowMs) {
      running -= turns[left].costUsd;
      left += 1;
    }
    if (running > peak) peak = running;
  }
  return +peak.toFixed(2);
}

function expireWindowCalibration(poolCfg, calKey, resetKey, windowMs, nowMs) {
  const cal = poolCfg[calKey];
  if (!cal) return false;
  if (cal.resetAtMs && nowMs >= cal.resetAtMs) {
    poolCfg[resetKey] = Math.max(poolCfg[resetKey] || 0, cal.resetAtMs);
    poolCfg[calKey] = null;
    return true;
  }
  if (!cal.resetAtMs && nowMs >= cal.calibratedAtMs + windowMs) {
    poolCfg[calKey] = null;
    return true;
  }
  return false;
}

function evaluateWindowQuota({
  turnsAll,
  turnsInWindow,
  windowCostUsd,
  windowMs,
  nowMs,
  configuredBudgetUsd,
  autoScalePeak,
  peakCostUsd,
  cal,
  calCostThresholdUsd,
}) {
  const effectiveBudgetUsd =
    autoScalePeak && peakCostUsd > configuredBudgetUsd
      ? +(peakCostUsd * 1.05).toFixed(2)
      : configuredBudgetUsd;

  let impliedCapUsd = effectiveBudgetUsd;
  let remainingPct;
  let mode;

  if (cal) {
    mode = 'calibrated';
    if (cal.remainingPct <= 90 && cal.windowCostAtCalibrationUsd >= calCostThresholdUsd) {
      impliedCapUsd = cal.windowCostAtCalibrationUsd / ((100 - cal.remainingPct) / 100);
    }
    if (!Number.isFinite(impliedCapUsd) || impliedCapUsd <= 0) {
      impliedCapUsd = effectiveBudgetUsd || 1;
    }

    if (cal.resetAtMs) {
      let costSinceCal = 0;
      for (const t of turnsAll) {
        if (t.tsMs > cal.calibratedAtMs && t.tsMs <= nowMs) {
          costSinceCal += t.costUsd;
        }
      }
      remainingPct = clampPct(cal.remainingPct - (costSinceCal / impliedCapUsd) * 100);
    } else {
      const deltaCost = windowCostUsd - cal.windowCostAtCalibrationUsd;
      remainingPct = clampPct(cal.remainingPct - (deltaCost / impliedCapUsd) * 100);
    }
  } else {
    mode = 'estimated';
    remainingPct =
      effectiveBudgetUsd > 0 ? clampPct(100 - (windowCostUsd / effectiveBudgetUsd) * 100) : 100;
  }

  let countdownSeconds = null;
  let countdownKind = null;
  let countdownLabel = null;

  if (cal?.resetAtMs && cal.resetAtMs > nowMs) {
    countdownSeconds = Math.max(60, Math.round((cal.resetAtMs - nowMs) / 1000));
    countdownKind = 'reset';
    countdownLabel = `↺ ${formatCompactDuration(countdownSeconds)} 重置`;
  } else if (turnsInWindow.length > 0) {
    const earliestTsMs = turnsInWindow[0].tsMs;
    countdownSeconds = Math.max(60, Math.round((earliestTsMs + windowMs - nowMs) / 1000));
    countdownKind = 'recovery';
    countdownLabel = `↺ ${formatCompactDuration(countdownSeconds)} 回血`;
  }

  return {
    effectiveBudgetUsd,
    impliedCapUsd,
    remainingPct,
    mode,
    countdownSeconds,
    countdownKind,
    countdownLabel,
    resetAtMs: cal?.resetAtMs && cal.resetAtMs > nowMs ? cal.resetAtMs : null,
  };
}

function evaluateCloudWindowQuota({
  cloudEntry,
  syncedAtMs,
  nowMs,
  configuredBudgetUsd,
  autoScalePeak,
  peakCostUsd,
}) {
  const effectiveBudgetUsd =
    autoScalePeak && peakCostUsd > configuredBudgetUsd
      ? +(peakCostUsd * 1.05).toFixed(2)
      : configuredBudgetUsd;
  const impliedCapUsd = effectiveBudgetUsd;
  const isFresh = Boolean(syncedAtMs && nowMs - syncedAtMs <= 15 * 60_000);
  const mode = isFresh ? 'cloud' : 'cloud_cached';
  const expired = Boolean(cloudEntry.resetAtMs && nowMs >= cloudEntry.resetAtMs);

  let remainingPct;
  let resetAtMs = null;
  let countdownSeconds = null;
  let countdownKind = null;
  let countdownLabel = null;

  if (expired) {
    remainingPct = 100;
    countdownLabel = '已刷新';
  } else {
    remainingPct = clampPct(cloudEntry.remainingPct);
    resetAtMs = cloudEntry.resetAtMs || null;
    if (resetAtMs && resetAtMs > nowMs) {
      countdownSeconds = Math.max(60, Math.round((resetAtMs - nowMs) / 1000));
      countdownKind = 'reset';
      countdownLabel = `↺ ${formatCompactDuration(countdownSeconds)} 刷新`;
    } else if (remainingPct >= 100) {
      countdownLabel = '充裕';
    }
  }

  return {
    effectiveBudgetUsd,
    impliedCapUsd,
    remainingPct,
    mode,
    countdownSeconds,
    countdownKind,
    countdownLabel,
    resetAtMs,
  };
}

function fmtUsdShort(v) {
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1);
}

function buildPacing7d({
  remaining7dPct,
  impliedCap7dUsd,
  dailyBurnUsd,
  reclaim24hCostUsd,
  countdown7dSeconds,
  cal7d,
  mode7d,
  reset7dAtMs,
  nowMs,
}) {
  const remainingBudgetUsd = +((remaining7dPct / 100) * impliedCap7dUsd).toFixed(2);
  const isCloud = mode7d === 'cloud' || mode7d === 'cloud_cached';
  const effectiveResetAtMs = reset7dAtMs || (cal7d?.resetAtMs && cal7d.resetAtMs > nowMs ? cal7d.resetAtMs : null);
  const daysUntilReset =
    effectiveResetAtMs && effectiveResetAtMs > nowMs
      ? +((effectiveResetAtMs - nowMs) / ONE_DAY_MS).toFixed(1)
      : null;

  if (isCloud) {
    if (remaining7dPct >= 98 && dailyBurnUsd < 0.5) {
      return {
        status: 'idle',
        dailyBurnUsd,
        remainingBudgetUsd,
        estRunwayDays: null,
        daysUntilReset,
        label: '余量充裕 · 本周几乎未消耗',
      };
    }

    if (daysUntilReset !== null) {
      const usedPct = Math.max(0, 100 - remaining7dPct);
      const elapsedDays = Math.max(0.25, 7 - (effectiveResetAtMs - nowMs) / ONE_DAY_MS);
      if (remaining7dPct <= 5) {
        return {
          status: 'critical',
          dailyBurnUsd,
          remainingBudgetUsd,
          estRunwayDays: 0,
          daysUntilReset,
          label: `周限将尽 · 距刷新还有 ${formatCompactDuration(countdown7dSeconds)}`,
        };
      }
      if (usedPct === 0) {
        return {
          status: 'ample',
          dailyBurnUsd,
          remainingBudgetUsd,
          estRunwayDays: null,
          daysUntilReset,
          label: `余量 100% · 距刷新 ${daysUntilReset}d`,
        };
      }
      const dailyPctBurn = +(usedPct / elapsedDays).toFixed(1);
      const estRunwayDays = +(remaining7dPct / Math.max(0.1, usedPct / elapsedDays)).toFixed(1);
      const runwayStr = estRunwayDays > 14 ? '>14' : String(estRunwayDays);
      const ratio = estRunwayDays / Math.max(0.1, daysUntilReset);
      let status;
      let label;
      if (ratio >= 1.15) {
        status = 'ample';
        label = `够用 · 日均耗 ${dailyPctBurn}%，可撑 ~${runwayStr}d (距刷新 ${daysUntilReset}d)`;
      } else if (ratio >= 0.85) {
        status = 'steady';
        label = `基本够用 · 日均耗 ${dailyPctBurn}%，可撑 ~${runwayStr}d (距刷新 ${daysUntilReset}d)`;
      } else {
        status = remaining7dPct < 20 ? 'critical' : 'tight';
        label = `偏紧 · 日均耗 ${dailyPctBurn}%，仅够 ~${runwayStr}d (距刷新 ${daysUntilReset}d)`;
      }
      return {
        status,
        dailyBurnUsd,
        remainingBudgetUsd,
        estRunwayDays,
        daysUntilReset,
        label,
      };
    }

    const estRunwayDays = dailyBurnUsd >= 0.5 ? +(remainingBudgetUsd / dailyBurnUsd).toFixed(1) : null;
    const status = remaining7dPct >= 50 ? 'ample' : remaining7dPct >= 25 ? 'steady' : remaining7dPct <= 5 ? 'critical' : 'tight';
    const prefix = status === 'ample' ? '够用' : status === 'steady' ? '基本够用' : status === 'critical' ? '周限将尽' : '偏紧';
    return {
      status,
      dailyBurnUsd,
      remainingBudgetUsd,
      estRunwayDays,
      daysUntilReset: null,
      label: `${prefix} · 当前周余量 ${remaining7dPct}%`,
    };
  }

  const estRunwayDays = dailyBurnUsd >= 0.5 ? +(remainingBudgetUsd / dailyBurnUsd).toFixed(1) : null;
  const runwayStr = estRunwayDays !== null && estRunwayDays > 14 ? '>14' : String(estRunwayDays);

  let status;
  let label;

  if (dailyBurnUsd < 0.5 && remaining7dPct >= 80) {
    status = 'idle';
    label = '余量充裕 · 近 7 天几乎未消耗';
  } else if (daysUntilReset !== null) {
    if (remaining7dPct <= 5) {
      status = 'critical';
      label = `周限将尽 · 距重置还有 ${formatCompactDuration(countdown7dSeconds)}`;
    } else if (estRunwayDays === null) {
      status = remaining7dPct < 25 ? 'tight' : 'ample';
      label = `近 7 天低负载 · 当前周余量 ${remaining7dPct}% (距重置 ${daysUntilReset}d)`;
    } else {
      const ratio = estRunwayDays / Math.max(0.1, daysUntilReset);
      if (ratio >= 1.2) {
        status = 'ample';
        label = `够用 · 日均 $${fmtUsdShort(dailyBurnUsd)}，可撑 ~${runwayStr}d (距重置 ${daysUntilReset}d)`;
      } else if (ratio >= 0.9) {
        status = 'steady';
        label = `基本够用 · 日均 $${fmtUsdShort(dailyBurnUsd)}，可撑 ~${runwayStr}d (距重置 ${daysUntilReset}d)`;
      } else {
        status = remaining7dPct < 20 ? 'critical' : 'tight';
        label = `偏紧 · 按日均 $${fmtUsdShort(dailyBurnUsd)} 仅够 ~${runwayStr}d (距重置 ${daysUntilReset}d)`;
      }
    }
  } else {
    const reclaimSuffix = reclaim24hCostUsd >= 5 ? ` (24h回血 +$${fmtUsdShort(reclaim24hCostUsd)})` : '';
    if (remaining7dPct <= 5) {
      status = 'critical';
      label = `周限告急 · 日均 $${fmtUsdShort(dailyBurnUsd)}，建议控制高耗任务`;
    } else if (estRunwayDays === null) {
      status = remaining7dPct < 25 ? 'tight' : 'ample';
      label = `近 7 天低负载 · 当前周余量 ${remaining7dPct}%`;
    } else if (remaining7dPct >= 50 || estRunwayDays >= 4.5) {
      status = 'ample';
      label = `够用 · 日均 $${fmtUsdShort(dailyBurnUsd)}，按此节奏还够 ~${runwayStr} 天`;
    } else if (remaining7dPct >= 25 && estRunwayDays >= 2.0) {
      status = 'steady';
      label = `适中 · 日均 $${fmtUsdShort(dailyBurnUsd)}，纯余量可撑 ~${runwayStr} 天${reclaimSuffix}`;
    } else {
      status = remaining7dPct < 12 ? 'critical' : 'tight';
      label = `偏紧 · 日均 $${fmtUsdShort(dailyBurnUsd)} 仅够 ~${runwayStr} 天${reclaimSuffix}`;
    }
  }

  return {
    status,
    dailyBurnUsd,
    remainingBudgetUsd,
    estRunwayDays,
    daysUntilReset,
    label,
  };
}

function collectConversationsForQuota(options = {}, nowMs, currentMonthKey, retentionStartMs, startOfCurrentMonthMs) {
  const geminiRoot = options.geminiRoot || process.env.CL_GEMINI_ROOT || path.join(os.homedir(), '.gemini');
  const surfaces = discoverSurfaceDirs({
    geminiRoot,
    executableDataDir: options.executableDataDir !== undefined ? options.executableDataDir : process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  });
  const hookModels = loadHookSessionModels({ geminiRoot });
  const cachePath = path.join(resolvePluginDataDir(options), 'quota-scan-cache.json');
  const scanCache = loadScanCache(cachePath);
  const scanCutoffMs = Math.min(startOfCurrentMonthMs, nowMs - SCAN_RETENTION_MS);

  const candidates = [];
  for (const surf of surfaces) {
    const summaries = loadConversationSummaries(surf.appDataDir);
    let entries = [];
    try {
      entries = fs.readdirSync(surf.brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || !ID_RE.test(entry.name)) continue;
      const convId = entry.name;
      const compactPath = path.join(surf.brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      let stat;
      try {
        stat = fs.statSync(compactPath);
      } catch {
        continue;
      }
      const summary = summaries.get(convId) || null;
      const fallbackModel = hookModels[convId]?.modelName || '';
      candidates.push({
        conversationId: convId,
        surface: surf.surface,
        surfaceLabel: surf.label,
        compactPath,
        stat,
        summary,
        fallbackModel,
      });
    }
  }

  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const newestId = candidates[0]?.conversationId || '';
  const activeRecords = [];
  let cacheDirty = false;
  const activeCacheKeys = new Set();

  for (const cand of candidates) {
    if (cand.stat.mtimeMs < scanCutoffMs && cand.conversationId !== newestId) {
      continue;
    }
    activeCacheKeys.add(cand.compactPath);
    const cached = scanCache.entries[cand.compactPath];
    const cacheValid = Boolean(
      cached &&
      cached.mtimeMs === cand.stat.mtimeMs &&
      cached.size === cand.stat.size &&
      (cached.hookFallbackModel ?? cached.fallbackModel) === cand.fallbackModel &&
      cached.monthKey === currentMonthKey &&
      typeof cached.recentWindowStartMs === 'number' &&
      cached.recentWindowStartMs <= retentionStartMs
    );

    let parsed = cacheValid ? cached : null;
    if (!parsed) {
      parsed = parseTranscriptForQuota(
        cand.compactPath,
        cand.stat,
        cand.fallbackModel,
        currentMonthKey,
        retentionStartMs
      );
      if (!parsed) continue;
      scanCache.entries[cand.compactPath] = parsed;
      cacheDirty = true;
    }

    activeRecords.push({ ...cand, parsed });
  }

  // Subagent inheritance for unattributed subagent conversations using parent's model at subagent start time
  const byId = new Map();
  for (const rec of activeRecords) {
    byId.set(rec.conversationId, rec);
  }
  for (const rec of activeRecords) {
    const parentId = rec.summary?.parentConversationId || '';
    if (!rec.parsed.activeModelRaw && parentId && byId.has(parentId)) {
      const parentRec = byId.get(parentId);
      const inheritedModel = resolveParentModelAt(parentRec, rec.parsed.firstTurnTsMs);
      if (inheritedModel && inheritedModel !== rec.parsed.fallbackModel) {
        const reparsed = parseTranscriptForQuota(
          rec.compactPath,
          rec.stat,
          inheritedModel,
          currentMonthKey,
          retentionStartMs
        );
        if (reparsed) {
          reparsed.hookFallbackModel = rec.fallbackModel;
          rec.parsed = reparsed;
          scanCache.entries[rec.compactPath] = reparsed;
          cacheDirty = true;
        }
      }
    }
  }

  // Prune stale cache entries beyond retention window
  for (const key of Object.keys(scanCache.entries)) {
    if (!activeCacheKeys.has(key)) {
      delete scanCache.entries[key];
      cacheDirty = true;
    }
  }

  if (cacheDirty) {
    try {
      writeJsonAtomic(cachePath, scanCache);
    } catch {}
  }

  return activeRecords;
}

function formatLocalHHMM(tsMs) {
  if (!tsMs || !Number.isFinite(tsMs)) return '';
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildSyncStatus(officialCache, config, nowMs) {
  const hasPools = Boolean(officialCache?.pools && typeof officialCache.syncedAtMs === 'number');
  const lastSync = officialCache?.lastSync || null;
  const syncedAtMs = hasPools ? officialCache.syncedAtMs : null;
  const isFresh = Boolean(syncedAtMs && nowMs - syncedAtMs <= 15 * 60_000);
  const hhmm = syncedAtMs ? formatLocalHHMM(syncedAtMs) : '';

  const lastErrorStatus = lastSync && lastSync.ok === false ? (lastSync.status || 'network_timeout') : null;
  const errorDetail = lastSync && lastSync.ok === false ? (lastSync.error || null) : null;

  let state;
  let label;
  if (hasPools && isFresh && !lastErrorStatus) {
    state = 'synced';
    label = `云端已同步 ${hhmm}`;
  } else if (hasPools) {
    state = 'stale';
    if (lastErrorStatus === 'network_timeout') label = '同步超时 · 显示缓存';
    else if (lastErrorStatus === 'proxy_error') label = '代理异常 · 显示缓存';
    else if (lastErrorStatus === 'auth_required') label = '需登录 CLI · 显示缓存';
    else if (lastErrorStatus === 'keyring_locked') label = '钥匙串锁定 · 显示缓存';
    else if (lastErrorStatus === 'cli_missing') label = '缺少 agy CLI';
    else label = `云端缓存 ${hhmm}`;
  } else if (lastErrorStatus) {
    state = lastErrorStatus;
    if (lastErrorStatus === 'network_timeout') label = '同步超时 · 需代理';
    else if (lastErrorStatus === 'proxy_error') label = '代理连接失败';
    else if (lastErrorStatus === 'auth_required') label = '需登录 agy CLI';
    else if (lastErrorStatus === 'keyring_locked') label = '需解锁钥匙串';
    else if (lastErrorStatus === 'cli_missing') label = '未安装 agy CLI';
    else label = '同步失败';
  } else {
    state = 'never_synced';
    label = '尚未同步云端';
  }

  return {
    state,
    lastErrorStatus,
    label,
    syncedAt: syncedAtMs ? new Date(syncedAtMs).toISOString() : null,
    lastAttemptAt: lastSync?.attemptedAt || null,
    errorDetail,
    proxyUrl: config.proxyUrl || null,
  };
}

export function collectQuotaSnapshot(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nowDate = new Date(nowMs);
  const currentMonthKey = toLocalDateKey(nowMs).slice(0, 7);
  const startOfCurrentMonthMs = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
  const win5hStart = nowMs - FIVE_HOURS_MS;
  const win24hStart = nowMs - ONE_DAY_MS;
  const win7dStart = nowMs - SEVEN_DAYS_MS;
  const retentionStartMs = nowMs - SCAN_RETENTION_MS;

  const config = loadQuotaConfig(options);
  const preset = PLAN_PRESETS[config.planTier] || PLAN_PRESETS.ultra_20x;
  const officialCache = loadOfficialQuotaCache(resolvePluginDataDir(options));
  let configDirty = false;

  const records = collectConversationsForQuota(
    options,
    nowMs,
    currentMonthKey,
    retentionStartMs,
    startOfCurrentMonthMs
  );

  const turnsByPool15d = { gemini: [], claude: [] };
  const latestErrorByPool = { gemini: null, claude: null };
  let monthCostUsd = 0;
  let monthTokens = 0;
  let monthTurns = 0;

  for (const rec of records) {
    const p = rec.parsed;
    monthCostUsd += p.monthCostUsd;
    monthTokens += p.monthTokens;
    monthTurns += p.monthTurns;

    if (p.recentQuotaError) {
      const prevErr = latestErrorByPool[p.recentQuotaError.poolKey];
      if (!prevErr || p.recentQuotaError.tsMs > prevErr.tsMs) {
        latestErrorByPool[p.recentQuotaError.poolKey] = p.recentQuotaError;
      }
    }

    for (const tuple of p.recentTurns7d) {
      const [tsMs, poolKey, totalTokens, costUsd] = tuple;
      if (tsMs >= retentionStartMs && tsMs <= nowMs && turnsByPool15d[poolKey]) {
        turnsByPool15d[poolKey].push({ tsMs, totalTokens, costUsd });
      }
    }
  }

  const pools = {};
  let latestActivePoolKey = null;
  let latestActiveTs = -1;
  let latestActive7dPoolKey = null;
  let latestActive7dTs = -1;
  let total7dTurns = 0;
  let total7dTokens = 0;
  let total7dCostUsd = 0;

  for (const poolKey of POOL_ORDER) {
    const poolCfg = config.pools[poolKey];
    const meta = POOL_META[poolKey];
    const turns15d = turnsByPool15d[poolKey].sort((a, b) => a.tsMs - b.tsMs);

    if (expireWindowCalibration(poolCfg, 'calibration', 'lastResetAtMs', FIVE_HOURS_MS, nowMs)) {
      configDirty = true;
    }
    if (expireWindowCalibration(poolCfg, 'calibration7d', 'lastReset7dAtMs', SEVEN_DAYS_MS, nowMs)) {
      configDirty = true;
    }

    const effectiveWin5hStart = Math.max(win5hStart, poolCfg.lastResetAtMs || 0);
    const turns5h = turns15d.filter((t) => t.tsMs >= effectiveWin5hStart && t.tsMs <= nowMs);

    let win5hTurns = 0;
    let win5hTokens = 0;
    let win5hCostUsd = 0;
    for (const t of turns5h) {
      win5hTurns += 1;
      win5hTokens += t.totalTokens;
      win5hCostUsd += t.costUsd;
      if (t.tsMs > latestActiveTs) {
        latestActiveTs = t.tsMs;
        latestActivePoolKey = poolKey;
      }
    }

    const rawTurns7d = turns15d.filter((t) => t.tsMs >= win7dStart && t.tsMs <= nowMs);
    let rawWin7dCostUsd = 0;
    let win24hCostUsd = 0;
    for (const t of rawTurns7d) {
      total7dTurns += 1;
      total7dTokens += t.totalTokens;
      total7dCostUsd += t.costUsd;
      rawWin7dCostUsd += t.costUsd;
      if (t.tsMs >= win24hStart) {
        win24hCostUsd += t.costUsd;
      }
      if (t.tsMs > latestActive7dTs) {
        latestActive7dTs = t.tsMs;
        latestActive7dPoolKey = poolKey;
      }
    }

    const effectiveWin7dStart = Math.max(win7dStart, poolCfg.lastReset7dAtMs || 0);
    const quotaTurns7d = turns15d.filter((t) => t.tsMs >= effectiveWin7dStart && t.tsMs <= nowMs);
    let win7dTurns = 0;
    let win7dTokens = 0;
    let win7dCostUsd = 0;
    for (const t of quotaTurns7d) {
      win7dTurns += 1;
      win7dTokens += t.totalTokens;
      win7dCostUsd += t.costUsd;
    }

    let reclaim24hCostUsd = 0;
    if (effectiveWin7dStart === win7dStart) {
      const reclaimEnd = Math.min(nowMs, win7dStart + ONE_DAY_MS);
      for (const t of quotaTurns7d) {
        if (t.tsMs <= reclaimEnd) {
          reclaim24hCostUsd += t.costUsd;
        }
      }
    }

    const officialPool = officialCache?.pools?.[poolKey] || null;
    const cal = poolCfg.calibration;
    const cal7d = poolCfg.calibration7d;

    const peak5hCost7dUsd = computePeakWindowCost(rawTurns7d, FIVE_HOURS_MS);
    const eval5h =
      !cal && officialPool?.['5h']
        ? evaluateCloudWindowQuota({
            cloudEntry: officialPool['5h'],
            syncedAtMs: officialCache.syncedAtMs,
            nowMs,
            configuredBudgetUsd: poolCfg.budget5hUsd,
            autoScalePeak: poolCfg.autoScalePeak !== false,
            peakCostUsd: peak5hCost7dUsd,
          })
        : evaluateWindowQuota({
            turnsAll: turns15d,
            turnsInWindow: turns5h,
            windowCostUsd: win5hCostUsd,
            windowMs: FIVE_HOURS_MS,
            nowMs,
            configuredBudgetUsd: poolCfg.budget5hUsd,
            autoScalePeak: poolCfg.autoScalePeak !== false,
            peakCostUsd: peak5hCost7dUsd,
            cal,
            calCostThresholdUsd: 0.5,
          });

    const peak7dCost14dUsd = computePeakWindowCost(turns15d, SEVEN_DAYS_MS);
    const eval7d =
      !cal7d && officialPool?.['7d']
        ? evaluateCloudWindowQuota({
            cloudEntry: officialPool['7d'],
            syncedAtMs: officialCache.syncedAtMs,
            nowMs,
            configuredBudgetUsd: poolCfg.budget7dUsd,
            autoScalePeak: poolCfg.autoScalePeak7d !== false,
            peakCostUsd: peak7dCost14dUsd,
          })
        : evaluateWindowQuota({
            turnsAll: turns15d,
            turnsInWindow: quotaTurns7d,
            windowCostUsd: win7dCostUsd,
            windowMs: SEVEN_DAYS_MS,
            nowMs,
            configuredBudgetUsd: poolCfg.budget7dUsd,
            autoScalePeak: poolCfg.autoScalePeak7d !== false,
            peakCostUsd: peak7dCost14dUsd,
            cal: cal7d,
            calCostThresholdUsd: 2,
          });

    let releaseCostUsd = 0;
    if (eval5h.countdownKind === 'recovery' && turns5h.length > 0) {
      const earliestTsMs = turns5h[0].tsMs;
      for (const t of turns5h) {
        if (t.tsMs <= earliestTsMs + 15 * 60_000) {
          releaseCostUsd += t.costUsd;
        }
      }
    }

    const recentErr = latestErrorByPool[poolKey];
    const latestCalMs = Math.max(
      cal?.calibratedAtMs || 0,
      cal7d?.calibratedAtMs || 0,
      officialCache?.syncedAtMs || 0
    );
    const quotaAlert =
      recentErr &&
      recentErr.tsMs >= nowMs - 30 * 60_000 &&
      recentErr.tsMs <= nowMs &&
      recentErr.tsMs > latestCalMs
        ? recentErr
        : null;

    const dailyBurnUsd = +(rawWin7dCostUsd / 7).toFixed(2);
    const pacing7d = buildPacing7d({
      remaining7dPct: eval7d.remainingPct,
      impliedCap7dUsd: eval7d.impliedCapUsd,
      dailyBurnUsd,
      reclaim24hCostUsd: +reclaim24hCostUsd.toFixed(2),
      countdown7dSeconds: eval7d.countdownSeconds,
      cal7d,
      mode7d: eval7d.mode,
      reset7dAtMs: eval7d.resetAtMs,
      nowMs,
    });

    pools[poolKey] = {
      key: poolKey,
      label: meta.label,
      subtitle: meta.subtitle,
      shortLabel: meta.shortLabel,
      remainingPct: eval5h.remainingPct,
      mode: eval5h.mode,
      win5hTurns,
      win5hTokens,
      win5hCostUsd: +win5hCostUsd.toFixed(2),
      win24hCostUsd: +win24hCostUsd.toFixed(2),
      win7dTurns,
      win7dTokens,
      win7dCostUsd: +win7dCostUsd.toFixed(2),
      configuredBudget5hUsd: poolCfg.budget5hUsd,
      autoScalePeak: poolCfg.autoScalePeak !== false,
      peak5hCost7dUsd,
      effectiveBudget5hUsd: eval5h.effectiveBudgetUsd,
      countdownSeconds: eval5h.countdownSeconds,
      countdownKind: eval5h.countdownKind,
      countdownLabel: eval5h.countdownLabel,
      releaseCostUsd: +releaseCostUsd.toFixed(2),
      calibratedAt: cal ? new Date(cal.calibratedAtMs).toISOString() : null,
      resetAt: eval5h.resetAtMs ? new Date(eval5h.resetAtMs).toISOString() : null,
      remaining7dPct: eval7d.remainingPct,
      mode7d: eval7d.mode,
      configuredBudget7dUsd: poolCfg.budget7dUsd,
      autoScalePeak7d: poolCfg.autoScalePeak7d !== false,
      peak7dCost14dUsd,
      effectiveBudget7dUsd: eval7d.effectiveBudgetUsd,
      countdown7dSeconds: eval7d.countdownSeconds,
      countdown7dKind: eval7d.countdown7dKind ?? eval7d.countdownKind,
      countdown7dLabel: eval7d.countdownLabel,
      reclaim24hCostUsd: +reclaim24hCostUsd.toFixed(2),
      calibrated7dAt: cal7d ? new Date(cal7d.calibratedAtMs).toISOString() : null,
      reset7dAt: eval7d.resetAtMs ? new Date(eval7d.resetAtMs).toISOString() : null,
      pacing7d,
      quotaAlert,
    };
  }

  if (configDirty) {
    try {
      saveQuotaConfig(config, options);
    } catch {}
  }

  const primaryPoolKey =
    config.primaryPool !== 'auto'
      ? config.primaryPool
      : latestActivePoolKey || latestActive7dPoolKey || 'gemini';
  const primaryPool = pools[primaryPoolKey] || pools.gemini;

  const poolShortLabel =
    config.primaryPool === 'auto' && config.planTier.startsWith('ultra')
      ? 'Ultra'
      : primaryPool.shortLabel;

  const minPct = Math.min(primaryPool.remainingPct, primaryPool.remaining7dPct);
  let statusLevel = 'ok';
  if (minPct < 20 || primaryPool.quotaAlert) {
    statusLevel = 'critical';
  } else if (minPct < 45) {
    statusLevel = 'warn';
  }

  let statusText;
  if (config.statusBarMode === 'dual_pct') {
    statusText = `5h:${primaryPool.remainingPct}% · 7d:${primaryPool.remaining7dPct}%`;
  } else if (config.statusBarMode === 'pct7d_timer') {
    statusText =
      primaryPool.countdown7dSeconds && primaryPool.remaining7dPct < 100
        ? `周${primaryPool.remaining7dPct}% · ↺${formatCompactDuration(primaryPool.countdown7dSeconds)}`
        : `周${primaryPool.remaining7dPct}%`;
  } else if (config.statusBarMode === 'pct_cost') {
    statusText = `${primaryPool.remainingPct}% · $${primaryPool.win5hCostUsd.toFixed(1)}`;
  } else if (config.statusBarMode === 'pct_only') {
    statusText = `${primaryPool.remainingPct}%`;
  } else {
    statusText =
      primaryPool.countdownSeconds && primaryPool.remainingPct < 100
        ? `${primaryPool.remainingPct}% · ↺${formatCompactDuration(primaryPool.countdownSeconds)}`
        : `${primaryPool.remainingPct}%`;
  }

  // Prefer latest non-subagent conversation with context tokens for activeSession display
  const activeRec =
    records.find((r) => !r.summary?.parentConversationId && r.parsed.latestContextTokens > 0) ||
    records[0] ||
    null;

  const activeSession = activeRec
    ? {
        conversationId: activeRec.conversationId,
        title: activeRec.summary?.title || activeRec.parsed.previewTitle || activeRec.conversationId.slice(0, 8),
        modelLabel: getModelLabel(activeRec.parsed.activeFamily, activeRec.parsed.activeModelRaw),
        contextTokens: activeRec.parsed.latestContextTokens,
        cacheHitRate: activeRec.parsed.latestCacheHitRate,
        updatedAt: new Date(activeRec.stat.mtimeMs).toISOString(),
      }
    : null;

  const roiMultiplier =
    preset.monthlyPriceUsd > 0 ? +(monthCostUsd / preset.monthlyPriceUsd).toFixed(1) : null;

  const syncStatus = buildSyncStatus(officialCache, config, nowMs);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    preferences: {
      planTier: preset.tierKey,
      planLabel: preset.label,
      monthlyPriceUsd: preset.monthlyPriceUsd,
      statusBarMode: config.statusBarMode,
      primaryPool: config.primaryPool,
    },
    syncStatus,
    statusBar: {
      poolKey: primaryPool.key,
      poolShortLabel,
      remainingPct: primaryPool.remainingPct,
      remaining7dPct: primaryPool.remaining7dPct,
      level: statusLevel,
      text: statusText,
    },
    pools,
    poolOrder: POOL_ORDER,
    activeSession,
    totals7d: {
      turns: total7dTurns,
      totalTokens: total7dTokens,
      costUsd: +total7dCostUsd.toFixed(2),
    },
    monthSummary: {
      month: currentMonthKey,
      turns: monthTurns,
      totalTokens: monthTokens,
      costUsd: +monthCostUsd.toFixed(2),
      planPriceUsd: preset.monthlyPriceUsd,
      roiMultiplier,
    },
    credits: config.credits,
  };
}

function normalizeWindowArg(value, defaultWin, allowAll = false) {
  if (value === undefined || value === null || value === '') return defaultWin;
  const v = String(value).toLowerCase();
  if ((allowAll && v === 'all') || v === '5h' || v === '7d') {
    return v;
  }
  throw new Error(`Invalid window: ${value}`);
}

export function calibratePool(poolKey, remainingPct, options = {}) {
  if (!POOL_ORDER.includes(poolKey)) {
    throw new Error(`Invalid pool key: ${poolKey}`);
  }
  const win = normalizeWindowArg(options.window, '5h');
  const nowMs = options.nowMs ?? Date.now();
  const snapshot = collectQuotaSnapshot({ ...options, nowMs });
  const config = loadQuotaConfig(options);
  const currentWinCost =
    win === '7d'
      ? snapshot.pools[poolKey]?.win7dCostUsd || 0
      : snapshot.pools[poolKey]?.win5hCostUsd || 0;

  let resetAtMs = null;
  if (options.resetMinutes !== undefined && options.resetMinutes !== null && options.resetMinutes !== 'auto') {
    const mins = Number(options.resetMinutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      throw new Error(`Invalid reset-minutes: ${options.resetMinutes}`);
    }
    resetAtMs = nowMs + mins * 60_000;
  }

  const calKey = win === '7d' ? 'calibration7d' : 'calibration';
  config.pools[poolKey][calKey] = {
    remainingPct: clampPct(remainingPct),
    calibratedAtMs: nowMs,
    resetAtMs,
    windowCostAtCalibrationUsd: currentWinCost,
  };
  saveQuotaConfig(config, options);
  return collectQuotaSnapshot({ ...options, nowMs });
}

export function clearCalibration(target = 'all', options = {}) {
  const win = normalizeWindowArg(options.window, 'all', true);
  const config = loadQuotaConfig(options);
  const targets = target === 'all' ? POOL_ORDER : [target];
  for (const k of targets) {
    if (!POOL_ORDER.includes(k)) {
      throw new Error(`Invalid pool key: ${k}`);
    }
    if (win === 'all' || win === '5h') {
      config.pools[k].calibration = null;
      config.pools[k].lastResetAtMs = null;
    }
    if (win === 'all' || win === '7d') {
      config.pools[k].calibration7d = null;
      config.pools[k].lastReset7dAtMs = null;
    }
  }
  saveQuotaConfig(config, options);
  return collectQuotaSnapshot(options);
}

export function setPlanTier(tierKey, options = {}) {
  const preset = PLAN_PRESETS[tierKey];
  if (!preset) {
    throw new Error(`Invalid plan tier: ${tierKey}`);
  }
  const config = loadQuotaConfig(options);
  config.planTier = preset.tierKey;
  for (const key of POOL_ORDER) {
    if (config.pools[key].autoScalePeak !== false) {
      config.pools[key].budget5hUsd = preset.pools[key].budget5hUsd;
    }
    if (config.pools[key].autoScalePeak7d !== false) {
      config.pools[key].budget7dUsd = preset.pools[key].budget7dUsd;
    }
  }
  saveQuotaConfig(config, options);
  return collectQuotaSnapshot(options);
}

export function setPoolBudget(poolKey, usdOrAuto, options = {}) {
  if (!POOL_ORDER.includes(poolKey)) {
    throw new Error(`Invalid pool key: ${poolKey}`);
  }
  const win = normalizeWindowArg(options.window, '5h');
  const budgetKey = win === '7d' ? 'budget7dUsd' : 'budget5hUsd';
  const autoKey = win === '7d' ? 'autoScalePeak7d' : 'autoScalePeak';

  const config = loadQuotaConfig(options);
  const preset = PLAN_PRESETS[config.planTier] || PLAN_PRESETS.ultra_20x;
  if (String(usdOrAuto).toLowerCase() === 'auto') {
    config.pools[poolKey][budgetKey] = preset.pools[poolKey][budgetKey];
    config.pools[poolKey][autoKey] = true;
  } else {
    const usd = Number(usdOrAuto);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new Error(`Invalid budget USD value: ${usdOrAuto}`);
    }
    config.pools[poolKey][budgetKey] = usd;
    config.pools[poolKey][autoKey] = false;
  }
  saveQuotaConfig(config, options);
  return collectQuotaSnapshot(options);
}

export function setCreditsMemo({ available, monthly }, options = {}) {
  const config = loadQuotaConfig(options);
  if (available !== undefined) {
    if (available === null || String(available).toLowerCase() === 'clear') {
      config.credits.available = null;
    } else {
      const val = Number(available);
      if (!Number.isFinite(val) || val < 0) throw new Error(`Invalid available credits: ${available}`);
      config.credits.available = val;
    }
  }
  if (monthly !== undefined) {
    if (monthly === null || String(monthly).toLowerCase() === 'clear') {
      config.credits.monthly = null;
    } else {
      const val = Number(monthly);
      if (!Number.isFinite(val) || val < 0) throw new Error(`Invalid monthly credits: ${monthly}`);
      config.credits.monthly = val;
    }
  }
  config.credits.updatedAt =
    config.credits.available === null && config.credits.monthly === null
      ? null
      : new Date(options.nowMs ?? Date.now()).toISOString();
  saveQuotaConfig(config, options);
  return collectQuotaSnapshot(options);
}

export function setDisplayPreferences({ mode, pool }, options = {}) {
  const config = loadQuotaConfig(options);
  if (mode !== undefined) {
    if (!ALLOWED_STATUS_MODES.includes(mode)) {
      throw new Error(`Invalid display mode: ${mode}`);
    }
    config.statusBarMode = mode;
  }
  if (pool !== undefined) {
    if (!['auto', ...POOL_ORDER].includes(pool)) {
      throw new Error(`Invalid primary pool: ${pool}`);
    }
    config.primaryPool = pool;
  }
  saveQuotaConfig(config, options);
  return collectQuotaSnapshot(options);
}

export function setProxyConfig(proxyUrlOrClear, options = {}) {
  const config = loadQuotaConfig(options);
  config.proxyUrl = normalizeProxyUrl(proxyUrlOrClear);
  saveQuotaConfig(config, options);
  return collectQuotaSnapshot(options);
}

export async function syncOfficialQuota(options = {}) {
  const pluginDataDir = resolvePluginDataDir(options);
  const config = loadQuotaConfig(options);
  await syncQuotaViaCli({
    pluginDataDir,
    configProxyUrl: config.proxyUrl,
    agyBin: options.agyBin,
    proxyUrl: options.proxyUrl,
    skipSystemProxy: options.skipSystemProxy,
    timeoutSeconds: options.timeoutSeconds,
    nowMs: options.nowMs,
  });
  return collectQuotaSnapshot(options);
}

function parseCliArgs(argv) {
  const parsed = { flags: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      parsed.flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        parsed.flags.set(key, next);
        i += 1;
      } else {
        parsed.bools.add(key);
      }
    }
  }
  return parsed;
}

async function runCli(argv) {
  const { flags, bools } = parseCliArgs(argv);
  const options = {};
  if (flags.has('gemini-root')) options.geminiRoot = flags.get('gemini-root');
  if (flags.has('plugin-data-dir')) options.pluginDataDir = flags.get('plugin-data-dir');
  if (flags.has('now-ms')) options.nowMs = Number(flags.get('now-ms'));
  if (flags.has('agy-bin')) options.agyBin = flags.get('agy-bin');
  if (flags.has('proxy-url')) options.proxyUrl = flags.get('proxy-url');
  if (bools.has('skip-system-proxy')) options.skipSystemProxy = true;
  if (flags.has('timeout-seconds')) options.timeoutSeconds = Number(flags.get('timeout-seconds'));

  let result = null;
  if (flags.has('set-proxy') || bools.has('set-proxy')) {
    result = setProxyConfig(flags.get('set-proxy') ?? 'clear', options);
  }

  if (bools.has('sync-cli')) {
    result = await syncOfficialQuota(options);
  } else if (flags.has('calibrate')) {
    const pool = flags.get('calibrate');
    const pct = flags.get('pct');
    if (pct === undefined) {
      throw new Error('--pct <0..100> is required with --calibrate');
    }
    result = calibratePool(pool, Number(pct), {
      ...options,
      window: flags.get('window'),
      resetMinutes: flags.get('reset-minutes'),
    });
  } else if (flags.has('clear-calibration')) {
    result = clearCalibration(flags.get('clear-calibration'), {
      ...options,
      window: flags.get('window'),
    });
  } else if (flags.has('set-plan')) {
    result = setPlanTier(flags.get('set-plan'), options);
  } else if (flags.has('set-budget')) {
    const pool = flags.get('set-budget');
    const usd = flags.get('usd');
    if (usd === undefined) {
      throw new Error('--usd <number|auto> is required with --set-budget');
    }
    result = setPoolBudget(pool, usd, {
      ...options,
      window: flags.get('window'),
    });
  } else if (bools.has('set-credits')) {
    result = setCreditsMemo(
      {
        available: flags.has('available') ? flags.get('available') : undefined,
        monthly: flags.has('monthly') ? flags.get('monthly') : undefined,
      },
      options
    );
  } else if (bools.has('set-display')) {
    result = setDisplayPreferences(
      {
        mode: flags.get('mode'),
        pool: flags.get('pool'),
      },
      options
    );
  } else if (!result) {
    result = collectQuotaSnapshot(options);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function isExecutedDirectly() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  runCli(process.argv.slice(2)).catch((err) => {
    process.stderr.write(JSON.stringify({ error: err?.message || String(err) }) + '\n');
    process.exit(1);
  });
}
