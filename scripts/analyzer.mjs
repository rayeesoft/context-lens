import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ID_RE = /^[0-9a-f-]{8,}$/i;
const MODEL_CHANGE_RE = /changed setting `Model Selection` from [^\n]+? to (.+?)(?=\.(?:\s|$|<)|<|\n|$)/i;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g;

export const PRICING_RULES = {
  'gemini-4-argon': {
    familyKey: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    inputPerM: 2.0,
    cacheReadPerM: 0.1,
    outputPerM: 10.0,
    priced: true,
  },
  'gemini-4-carbon': {
    familyKey: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon / Orchestrator',
    inputPerM: 2.5,
    cacheReadPerM: 0.25,
    outputPerM: 15.0,
    above200k: {
      inputPerM: 5.0,
      cacheReadPerM: 0.5,
      outputPerM: 22.5,
    },
    priced: true,
  },
  'gemini-4-hydrogen': {
    familyKey: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    inputPerM: 0.75,
    cacheReadPerM: 0.075,
    outputPerM: 3.75,
    priced: true,
  },
  'gemini-3.8-flash': {
    familyKey: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    inputPerM: 0.75,
    cacheReadPerM: 0.075,
    outputPerM: 3.75,
    priced: true,
  },
  'gemini-3.5-flash-lite': {
    familyKey: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    inputPerM: 0.3,
    cacheReadPerM: 0.03,
    outputPerM: 2.5,
    priced: true,
  },
  'gemini-3-pro': {
    familyKey: 'gemini-3-pro',
    label: 'Gemini 3 / 3.1 Pro',
    inputPerM: 2.0,
    cacheReadPerM: 0.2,
    outputPerM: 12.0,
    above200k: {
      inputPerM: 4.0,
      cacheReadPerM: 0.4,
      outputPerM: 18.0,
    },
    priced: true,
  },
  'gemini-2.5-pro': {
    familyKey: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    inputPerM: 1.25,
    cacheReadPerM: 0.125,
    outputPerM: 10.0,
    priced: true,
  },
  'claude-opus-5': {
    familyKey: 'claude-opus-5',
    label: 'Claude Opus 5',
    inputPerM: 15.0,
    cacheReadPerM: 1.5,
    outputPerM: 75.0,
    priced: true,
  },
  'claude-sonnet': {
    familyKey: 'claude-sonnet',
    label: 'Claude Sonnet',
    inputPerM: 3.0,
    cacheReadPerM: 0.3,
    outputPerM: 15.0,
    priced: true,
  },
  'gpt-oss': {
    familyKey: 'gpt-oss',
    label: 'GPT-OSS',
    inputPerM: 1.5,
    cacheReadPerM: 0.15,
    outputPerM: 6.0,
    priced: true,
  },
};

const compactCache = new Map();
const fullSessionCache = new Map();
const summaryDbCache = new Map();

export function clearAnalyzerCaches() {
  compactCache.clear();
  fullSessionCache.clear();
  summaryDbCache.clear();
}

export function normalizeModelFamily(rawModel) {
  const raw = String(rawModel ?? '').trim();
  if (!raw) return 'unpriced';
  const lower = raw.toLowerCase();
  if (lower === 'auto' || lower === 'none' || lower === 'default') return 'unpriced';
  if (lower.includes('argon')) return 'gemini-4-argon';
  if (lower.includes('carbon') || lower.includes('orchestrator')) return 'gemini-4-carbon';
  if (lower.includes('hydrogen')) return 'gemini-4-hydrogen';
  if (lower.includes('flash-lite') || lower.includes('flash lite')) return 'gemini-3.5-flash-lite';
  if (lower.includes('3.8-flash') || lower.includes('3.8 flash') || lower.includes('flash')) return 'gemini-3.8-flash';
  if (lower.includes('3.1-pro') || lower.includes('3.1 pro') || lower.includes('gemini 3') || lower.includes('3-pro')) {
    return 'gemini-3-pro';
  }
  if (lower.includes('2.5-pro') || lower.includes('2.5 pro')) return 'gemini-2.5-pro';
  if (lower.includes('opus')) return 'claude-opus-5';
  if (lower.includes('sonnet')) return 'claude-sonnet';
  if (lower.includes('gpt')) return 'gpt-oss';
  return 'unpriced';
}

export function getModelLabel(familyKey, rawFallback = '') {
  if (familyKey && PRICING_RULES[familyKey]) return PRICING_RULES[familyKey].label;
  const clean = String(rawFallback || '').trim();
  return clean || 'Unattributed / Auto';
}

export function calculateCostUsd(tokens = {}, familyKey = 'unpriced', promptTokensHint = null) {
  const rule = PRICING_RULES[familyKey];
  const input = Math.max(0, Number(tokens.inputTokens || 0));
  const cache = Math.max(0, Number(tokens.cacheReadTokens || 0));
  const output = Math.max(0, Number(tokens.outputTokens || 0));

  if (!rule) {
    return {
      priced: false,
      inputCostUsd: 0,
      cacheCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
    };
  }

  const promptTokens = promptTokensHint !== null ? Number(promptTokensHint) : input + cache;
  const rate = rule.above200k && promptTokens > 200000 ? rule.above200k : rule;

  const inputCostUsd = (input * rate.inputPerM) / 1_000_000;
  const cacheCostUsd = (cache * rate.cacheReadPerM) / 1_000_000;
  const outputCostUsd = (output * rate.outputPerM) / 1_000_000;

  return {
    priced: true,
    inputCostUsd,
    cacheCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + cacheCostUsd + outputCostUsd,
  };
}

export function estimateTextTokens(text) {
  if (!text) return 0;
  const str = String(text);
  const cjkMatches = str.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, str.length - cjkCount);
  return Math.round(cjkCount * 0.65 + nonCjkCount * 0.26);
}

export function toLocalDateKey(isoOrMs) {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(String(isoOrMs || ''));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function discoverSurfaceDirs(options = {}) {
  const geminiRoot = options.geminiRoot || path.join(os.homedir(), '.gemini');
  const executableDataDir =
    options.executableDataDir !== undefined
      ? options.executableDataDir
      : process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;

  const candidates = [
    { surface: 'app', label: 'Antigravity App', appDataDir: path.join(geminiRoot, 'antigravity') },
    { surface: 'ide', label: 'Antigravity IDE', appDataDir: path.join(geminiRoot, 'antigravity-ide') },
    { surface: 'cli', label: 'Antigravity CLI', appDataDir: path.join(geminiRoot, 'antigravity-cli') },
  ];

  if (executableDataDir) {
    let resolvedAppData = null;
    for (let d = path.resolve(executableDataDir); d !== path.dirname(d); d = path.dirname(d)) {
      if (path.basename(d) === 'sidecar_data') {
        resolvedAppData = path.dirname(d);
        break;
      }
    }
    if (!resolvedAppData && fs.existsSync(path.join(executableDataDir, 'brain'))) {
      resolvedAppData = path.resolve(executableDataDir);
    }
    if (resolvedAppData && fs.existsSync(path.join(resolvedAppData, 'brain'))) {
      const already = candidates.some((c) => path.resolve(c.appDataDir) === path.resolve(resolvedAppData));
      if (!already) {
        candidates.unshift({ surface: 'app', label: 'Active Surface', appDataDir: resolvedAppData });
      }
    }
  }

  return candidates
    .filter((item) => {
      try {
        return fs.existsSync(path.join(item.appDataDir, 'brain'));
      } catch {
        return false;
      }
    })
    .map((item) => ({
      ...item,
      brainDir: path.join(item.appDataDir, 'brain'),
    }));
}

export function loadConversationSummaries(appDataDir) {
  const dbPath = path.join(appDataDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return new Map();

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dbPath).mtimeMs;
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      mtimeMs += fs.statSync(walPath).mtimeMs;
    }
  } catch {
    return new Map();
  }

  const cached = summaryDbCache.get(dbPath);
  const now = Date.now();
  if (cached && cached.mtimeMs === mtimeMs && now - cached.loadedAt < 3000) {
    return cached.map;
  }

  const map = new Map();
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT conversation_id, title, step_count, last_modified_time,
                workspace_uris, status, source, agent_name, parent_conversation_id
         FROM conversation_summaries`
      )
      .all();

    for (const row of rows) {
      map.set(row.conversation_id, {
        conversationId: row.conversation_id,
        title: String(row.title || '').trim(),
        stepCount: Number(row.step_count || 0),
        lastModifiedTime: row.last_modified_time || null,
        workspaceUris: row.workspace_uris || '',
        status: row.status || '',
        source: row.source || '',
        agentName: row.agent_name || '',
        parentConversationId: String(row.parent_conversation_id || '').trim(),
      });
    }
    summaryDbCache.set(dbPath, { mtimeMs, loadedAt: now, map });
  } catch {
    return cached ? cached.map : map;
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
  return map;
}

export function loadHookSessionModels(options = {}) {
  const geminiRoot = options.geminiRoot || path.join(os.homedir(), '.gemini');
  const explicitRootPassed = Boolean(options.geminiRoot);
  const candidates = [
    path.join(geminiRoot, 'antigravity', 'plugin_data', 'context-lens', 'session-models.json'),
  ];
  if (!explicitRootPassed && process.env.PLUGIN_DATA) {
    candidates.unshift(path.join(process.env.PLUGIN_DATA, 'session-models.json'));
  }

  const merged = {};
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [convId, entry] of Object.entries(raw)) {
          if (!merged[convId] && entry && typeof entry === 'object' && entry.modelName) {
            merged[convId] = entry;
          }
        }
      }
    } catch {}
  }
  return merged;
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

function addCostToMap(modelMap, familyKey, rawName, tokens, promptHint) {
  let bucket = modelMap.get(familyKey);
  if (!bucket) {
    bucket = {
      familyKey,
      label: getModelLabel(familyKey, rawName),
      rawNames: new Set(),
      priced: Boolean(PRICING_RULES[familyKey]),
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnCount: 0,
      inputCostUsd: 0,
      cacheCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
    };
    modelMap.set(familyKey, bucket);
  }
  if (rawName) bucket.rawNames.add(rawName);
  const input = Math.max(0, Number(tokens.inputTokens || 0));
  const cache = Math.max(0, Number(tokens.cacheReadTokens || 0));
  const output = Math.max(0, Number(tokens.outputTokens || 0));
  bucket.inputTokens += input;
  bucket.cacheReadTokens += cache;
  bucket.outputTokens += output;
  bucket.totalTokens += input + cache + output;
  bucket.turnCount += 1;

  const cost = calculateCostUsd({ inputTokens: input, cacheReadTokens: cache, outputTokens: output }, familyKey, promptHint);
  bucket.inputCostUsd += cost.inputCostUsd;
  bucket.cacheCostUsd += cost.cacheCostUsd;
  bucket.outputCostUsd += cost.outputCostUsd;
  bucket.totalCostUsd += cost.totalCostUsd;
  return cost;
}

export function scanCompactTranscript(filePath, fallbackModel = '') {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const cached = compactCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.fallbackModel === fallbackModel
  ) {
    return cached.parsed;
  }

  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n');
  let activeModelRaw = fallbackModel || '';
  let activeFamily = normalizeModelFamily(activeModelRaw);
  let lastExplicitModelRaw = activeModelRaw;

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let contextTokens = 0;
  let contextPeakTokens = 0;
  let stepCount = 0;
  let turnCount = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let previewTitle = '';

  const dailyBuckets = new Map();
  const modelBuckets = new Map();

  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    stepCount += 1;
    if (step.created_at) {
      if (!firstTimestamp) firstTimestamp = step.created_at;
      lastTimestamp = step.created_at;
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
      }
    }

    const inTok = Number(step.input_tokens || 0);
    const cacheTok = Number(step.cache_read_tokens || 0);
    const outTok = Number(step.output_tokens || 0);
    const hasTokens = inTok > 0 || cacheTok > 0 || outTok > 0;

    if (step.type === 'PLANNER_RESPONSE' && (inTok > 0 || cacheTok > 0)) {
      const ctx = inTok + cacheTok;
      contextTokens = ctx;
      if (ctx > contextPeakTokens) contextPeakTokens = ctx;
    }

    if (hasTokens) {
      turnCount += 1;
      inputTokens += inTok;
      cacheReadTokens += cacheTok;
      outputTokens += outTok;
      const promptHint = inTok + cacheTok;
      const cost = addCostToMap(
        modelBuckets,
        activeFamily,
        activeModelRaw,
        { inputTokens: inTok, cacheReadTokens: cacheTok, outputTokens: outTok },
        promptHint
      );

      const dateKey = toLocalDateKey(step.created_at) || toLocalDateKey(stat.mtimeMs);
      if (dateKey) {
        let day = dailyBuckets.get(dateKey);
        if (!day) {
          day = {
            date: dateKey,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            stepCount: 0,
            costUsd: 0,
          };
          dailyBuckets.set(dateKey, day);
        }
        day.inputTokens += inTok;
        day.cacheReadTokens += cacheTok;
        day.outputTokens += outTok;
        day.totalTokens += inTok + cacheTok + outTok;
        day.stepCount += 1;
        day.costUsd += cost.totalCostUsd;
      }
    }
  }

  let totalCostUsd = 0;
  for (const b of modelBuckets.values()) totalCostUsd += b.totalCostUsd;

  const parsed = {
    filePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    stepCount,
    turnCount,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
    contextTokens,
    contextPeakTokens,
    totalCostUsd,
    firstTimestamp,
    lastTimestamp,
    previewTitle,
    activeModelRaw: lastExplicitModelRaw,
    activeFamily,
    dailyBuckets,
    modelBuckets,
  };

  compactCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    fallbackModel,
    parsed,
  });

  return parsed;
}

function enumerateConversations(options = {}) {
  const surfaces = discoverSurfaceDirs(options);
  const hookModels = loadHookSessionModels(options);
  const surfaceSummaries = new Map();
  const rawRecords = [];

  for (const surf of surfaces) {
    const summaries = loadConversationSummaries(surf.appDataDir);
    surfaceSummaries.set(surf.appDataDir, summaries);

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
      const fullPath = path.join(surf.brainDir, convId, '.system_generated', 'logs', 'transcript_full.jsonl');
      let stat;
      try {
        stat = fs.statSync(compactPath);
      } catch {
        continue;
      }

      const summary = summaries.get(convId) || null;
      const hookEntry = hookModels[convId] || null;
      const fallbackModel = hookEntry?.modelName || '';
      const scan = scanCompactTranscript(compactPath, fallbackModel);
      if (!scan) continue;

      rawRecords.push({
        conversationId: convId,
        surface: surf.surface,
        surfaceLabel: surf.label,
        appDataDir: surf.appDataDir,
        compactPath,
        fullPath: fs.existsSync(fullPath) ? fullPath : compactPath,
        stat,
        summary,
        hookModel: fallbackModel,
        scan,
      });
    }
  }

  // Build quick lookup to let subagents inherit parent's active model when unattributed.
  const byId = new Map();
  for (const rec of rawRecords) {
    byId.set(rec.conversationId, rec);
  }

  for (const rec of rawRecords) {
    const parentId = rec.summary?.parentConversationId || '';
    if (!rec.scan.activeModelRaw && parentId && byId.has(parentId)) {
      const parentRec = byId.get(parentId);
      const inheritedModel = parentRec.scan.activeModelRaw || parentRec.hookModel || '';
      if (inheritedModel) {
        rec.scan = scanCompactTranscript(rec.compactPath, inheritedModel) || rec.scan;
      }
    }
  }

  return rawRecords;
}

function classifyStepError(step) {
  const errStr = String(step.error || step.content || '');
  const lower = errStr.toLowerCase();
  if (/quota|exhausted.*capacity|resource_exhausted.*quota/i.test(lower)) {
    return { kind: 'quota_exhausted', title: 'Quota Exhausted' };
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(lower)) {
    return { kind: 'rate_limited', title: 'Rate Limited (429)' };
  }
  if (/context.*(?:exceed|too long|limit)|maximum context length|max_tokens exceeded/i.test(lower)) {
    return { kind: 'context_overflow', title: 'Context Overflow' };
  }
  return { kind: 'tool_or_runtime_error', title: 'Step Error' };
}

function stripUserTurnEnvelope(content) {
  const raw = String(content || '');
  const metaBlocks = [];
  const metaRe = /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/gi;
  let match;
  while ((match = metaRe.exec(raw)) !== null) {
    metaBlocks.push(match[0]);
  }
  const promptOnly = raw
    .replace(metaRe, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .trim();
  return {
    promptText: promptOnly,
    metadataText: metaBlocks.join('\n'),
  };
}

function readTranscriptFullCached(filePath) {
  const stat = fs.statSync(filePath);
  const cached = fullSessionCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  const rawText = fs.readFileSync(filePath, 'utf8');
  const steps = [];
  for (const line of rawText.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try {
      steps.push(JSON.parse(line));
    } catch {}
  }
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, steps };
  fullSessionCache.set(filePath, entry);
  return entry;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function inspectSession(conversationId, options = {}) {
  const records = enumerateConversations(options);
  const sorted = [...records].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const recentSessions = sorted.slice(0, 30).map((r) => {
    const title = r.summary?.title || r.scan.previewTitle || r.conversationId.slice(0, 8);
    return {
      conversationId: r.conversationId,
      title,
      surface: r.surface,
      model: r.scan.activeModelRaw || '',
      modelLabel: getModelLabel(r.scan.activeFamily, r.scan.activeModelRaw),
      contextTokens: r.scan.contextTokens,
      totalTokens: r.scan.totalTokens,
      stepCount: r.scan.stepCount,
      updatedAt: new Date(r.stat.mtimeMs).toISOString(),
      isSubagent: Boolean(r.summary?.parentConversationId),
    };
  });

  const requestedId = String(conversationId || '').trim();
  let target = null;
  let autoSelected = false;

  if (requestedId && ID_RE.test(requestedId)) {
    target = sorted.find((r) => r.conversationId === requestedId) || null;
  }
  if (!target && sorted.length > 0) {
    target = sorted[0];
    autoSelected = true;
  }

  if (!target) {
    return {
      found: false,
      conversationId: requestedId || null,
      autoSelected: false,
      recentSessions,
      summary: null,
      categories: [],
      turns: [],
      diagnostics: [],
    };
  }

  const targetStat = fs.statSync(target.fullPath);
  const etag = `${target.conversationId}:${targetStat.mtimeMs}:${targetStat.size}`;
  if (options.etag && options.etag === etag) {
    return {
      unchanged: true,
      etag,
      conversationId: target.conversationId,
      recentSessions,
    };
  }

  const { steps } = readTranscriptFullCached(target.fullPath);

  // Determine parent fallback model if needed.
  let activeModelRaw = target.hookModel || '';
  if (!activeModelRaw && target.summary?.parentConversationId) {
    const parentRec = sorted.find((r) => r.conversationId === target.summary.parentConversationId);
    if (parentRec) activeModelRaw = parentRec.scan.activeModelRaw || parentRec.hookModel || '';
  }
  let activeFamily = normalizeModelFamily(activeModelRaw);

  let latestContextTokens = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalInputCost = 0;
  let totalCacheCost = 0;
  let totalOutputCost = 0;
  let totalCostUsd = 0;
  let anyPriced = false;
  let compactionCount = 0;
  let prevPlannerContext = 0;
  let lastCheckpointIdx = -1;

  let firstPlannerIdx = -1;
  let estimatedBeforeFirstPlanner = 0;
  let systemOverheadTokens = 0;

  const turns = [];
  const diagnostics = [];
  const speedSamples = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
      const nextModel = extractModelSelection(step.content);
      if (nextModel) {
        activeModelRaw = nextModel;
        activeFamily = normalizeModelFamily(nextModel);
      }
    }

    if (step.type === 'CHECKPOINT') {
      lastCheckpointIdx = i;
      compactionCount += 1;
    }

    if (step.type === 'ERROR_MESSAGE' || step.status === 'ERROR' || step.error) {
      const info = classifyStepError(step);
      const rawMsg = String(step.error || step.content || 'Unknown error').replace(/\s+/g, ' ').trim();
      diagnostics.push({
        stepIndex: step.step_index ?? i,
        createdAt: step.created_at || null,
        kind: info.kind,
        title: info.title,
        message: rawMsg.length > 180 ? `${rawMsg.slice(0, 177)}...` : rawMsg,
      });
    }

    const inTok = Number(step.input_tokens || 0);
    const cacheTok = Number(step.cache_read_tokens || 0);
    const outTok = Number(step.output_tokens || 0);

    if (inTok > 0 || cacheTok > 0 || outTok > 0) {
      totalInputTokens += inTok;
      totalCacheReadTokens += cacheTok;
      totalOutputTokens += outTok;
      const cost = calculateCostUsd(
        { inputTokens: inTok, cacheReadTokens: cacheTok, outputTokens: outTok },
        activeFamily,
        inTok + cacheTok
      );
      if (cost.priced) anyPriced = true;
      totalInputCost += cost.inputCostUsd;
      totalCacheCost += cost.cacheCostUsd;
      totalOutputCost += cost.outputCostUsd;
      totalCostUsd += cost.totalCostUsd;

      if (step.type === 'PLANNER_RESPONSE') {
        const ctxTok = inTok + cacheTok;
        if (firstPlannerIdx === -1) {
          firstPlannerIdx = i;
          systemOverheadTokens = Math.max(0, ctxTok - estimatedBeforeFirstPlanner);
        }
        const compacted = prevPlannerContext > 40000 && ctxTok < prevPlannerContext * 0.72;
        if (compacted && lastCheckpointIdx < i - 3) {
          compactionCount += 1;
        }
        prevPlannerContext = ctxTok;
        latestContextTokens = ctxTok;

        let durationSec = null;
        let outputTokensPerSec = null;
        if (i > 0 && steps[i - 1]?.created_at && step.created_at) {
          const prevMs = Date.parse(steps[i - 1].created_at);
          const curMs = Date.parse(step.created_at);
          if (Number.isFinite(prevMs) && Number.isFinite(curMs)) {
            const diff = (curMs - prevMs) / 1000;
            if (diff >= 0.2 && diff <= 600) {
              durationSec = +diff.toFixed(1);
              if (diff >= 0.4 && outTok > 0) {
                outputTokensPerSec = +(outTok / diff).toFixed(1);
                speedSamples.push(outputTokensPerSec);
              }
            }
          }
        }

        turns.push({
          stepIndex: step.step_index ?? i,
          createdAt: step.created_at || null,
          model: activeModelRaw || '',
          modelLabel: getModelLabel(activeFamily, activeModelRaw),
          inputTokens: inTok,
          cacheReadTokens: cacheTok,
          outputTokens: outTok,
          contextTokens: ctxTok,
          durationSec,
          outputTokensPerSec,
          compacted,
          costUsd: cost.totalCostUsd,
        });
      }
    }

    if (firstPlannerIdx === -1) {
      if (step.type === 'USER_INPUT') {
        estimatedBeforeFirstPlanner += estimateTextTokens(step.content);
      } else if (step.type === 'SYSTEM_MESSAGE') {
        estimatedBeforeFirstPlanner += estimateTextTokens(step.content);
      }
      if (Array.isArray(step.media)) {
        estimatedBeforeFirstPlanner += step.media.length * 750;
      }
    }
  }

  // Compute 6-category context breakdown over the active trajectory (after latest checkpoint).
  const activeStartIdx = lastCheckpointIdx >= 0 ? lastCheckpointIdx : 0;
  const catStats = {
    system: { key: 'system', label: 'System, Skills & Tool Schemas', rawTokens: systemOverheadTokens, charCount: 0, itemCount: systemOverheadTokens > 0 ? 1 : 0 },
    user: { key: 'user', label: 'User Prompts & Turn Context', rawTokens: 0, charCount: 0, itemCount: 0 },
    reply: { key: 'reply', label: 'Assistant Replies', rawTokens: 0, charCount: 0, itemCount: 0 },
    thinking: { key: 'thinking', label: 'Model Thinking', rawTokens: 0, charCount: 0, itemCount: 0 },
    tools: { key: 'tools', label: 'Tool Calls & Results', rawTokens: 0, charCount: 0, itemCount: 0 },
    media: { key: 'media', label: 'Attached Media', rawTokens: 0, charCount: 0, itemCount: 0 },
  };

  for (let i = activeStartIdx; i < steps.length; i++) {
    const step = steps[i];
    if (Array.isArray(step.media) && step.media.length > 0) {
      for (const m of step.media) {
        const isImg = String(m?.mime_type || '').startsWith('image/');
        catStats.media.rawTokens += isImg ? 750 : 500;
        catStats.media.itemCount += 1;
      }
    }

    if (step.type === 'CHECKPOINT' || step.type === 'SYSTEM_MESSAGE' || step.type === 'CONVERSATION_HISTORY') {
      const txt = String(step.content || '');
      catStats.system.rawTokens += estimateTextTokens(txt);
      catStats.system.charCount += txt.length;
      catStats.system.itemCount += 1;
      continue;
    }

    if (step.type === 'USER_INPUT') {
      const { promptText, metadataText } = stripUserTurnEnvelope(step.content);
      const userTok = estimateTextTokens(promptText);
      const metaTok = estimateTextTokens(metadataText);
      catStats.user.rawTokens += userTok + metaTok;
      catStats.user.charCount += promptText.length + metadataText.length;
      catStats.user.itemCount += 1;
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      const contentStr = String(step.content || '');
      const thinkingStr = String(step.thinking || '');
      if (contentStr) {
        catStats.reply.rawTokens += estimateTextTokens(contentStr);
        catStats.reply.charCount += contentStr.length;
        catStats.reply.itemCount += 1;
      }
      if (thinkingStr) {
        catStats.thinking.rawTokens += estimateTextTokens(thinkingStr);
        catStats.thinking.charCount += thinkingStr.length;
        catStats.thinking.itemCount += 1;
      }
      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        const serialized = JSON.stringify(step.tool_calls);
        catStats.tools.rawTokens += estimateTextTokens(serialized);
        catStats.tools.charCount += serialized.length;
        catStats.tools.itemCount += step.tool_calls.length;
      }
      continue;
    }

    // GENERIC / VIEW_FILE / RUN_COMMAND / GREP_SEARCH / CODE_ACTION / etc. (tool outputs)
    const toolContent = String(step.content || step.error || '');
    if (toolContent) {
      catStats.tools.rawTokens += estimateTextTokens(toolContent);
      catStats.tools.charCount += toolContent.length;
      catStats.tools.itemCount += 1;
    }
  }

  const rawCategorySum = Object.values(catStats).reduce((acc, c) => acc + c.rawTokens, 0);
  const scaleDenominator = latestContextTokens > 0 && rawCategorySum > 0 ? latestContextTokens : rawCategorySum;
  const scaleFactor = latestContextTokens > 0 && rawCategorySum > 0 ? latestContextTokens / rawCategorySum : 1;

  const categories = Object.values(catStats).map((c) => {
    const scaledTokens = Math.round(c.rawTokens * scaleFactor);
    const sharePct = scaleDenominator > 0 ? +((scaledTokens / scaleDenominator) * 100).toFixed(1) : 0;
    return {
      key: c.key,
      label: c.label,
      rawEstimatedTokens: c.rawTokens,
      scaledTokens,
      sharePct,
      charCount: c.charCount,
      itemCount: c.itemCount,
    };
  });

  const promptTotal = totalInputTokens + totalCacheReadTokens;
  const cacheHitRate = promptTotal > 0 ? +((totalCacheReadTokens / promptTotal) * 100).toFixed(1) : 0;
  const medSpeed = median(speedSamples);
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const title = target.summary?.title || target.scan.previewTitle || target.conversationId.slice(0, 8);

  return {
    found: true,
    etag,
    conversationId: target.conversationId,
    autoSelected,
    title,
    surface: target.surface,
    surfaceLabel: target.surfaceLabel,
    model: activeModelRaw || '',
    modelLabel: getModelLabel(activeFamily, activeModelRaw),
    isSubagent: Boolean(target.summary?.parentConversationId),
    parentConversationId: target.summary?.parentConversationId || null,
    updatedAt: new Date(targetStat.mtimeMs).toISOString(),
    recentSessions,
    summary: {
      contextTokens: latestContextTokens,
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
      cacheHitRate,
      medianTokensPerSec: medSpeed !== null ? +medSpeed.toFixed(1) : null,
      latestTokensPerSec: lastTurn?.outputTokensPerSec ?? null,
      turnCount: turns.length,
      stepCount: steps.length,
      compactionCount,
      systemOverheadTokens,
      priced: anyPriced,
      inputCostUsd: +totalInputCost.toFixed(4),
      cacheCostUsd: +totalCacheCost.toFixed(4),
      outputCostUsd: +totalOutputCost.toFixed(4),
      totalCostUsd: +totalCostUsd.toFixed(4),
    },
    categories,
    turns,
    diagnostics: diagnostics.slice(-20),
  };
}

function buildQuantileThresholds(nonZeroValues) {
  if (!nonZeroValues.length) return [0, 0, 0, 0];
  const sorted = [...nonZeroValues].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
  return [pick(0.25), pick(0.5), pick(0.75), sorted[sorted.length - 1]];
}

function classifyHeatmapLevel(value, thresholds) {
  if (!value || value <= 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

export function collectHistory(options = {}) {
  const surfaceFilter = options.surface || 'all';
  const allRecords = enumerateConversations(options);
  const records =
    surfaceFilter === 'all' ? allRecords : allRecords.filter((r) => r.surface === surfaceFilter);

  let maxMtimeMs = 0;
  let sizeSum = 0;
  for (const r of records) {
    if (r.stat.mtimeMs > maxMtimeMs) maxMtimeMs = r.stat.mtimeMs;
    sizeSum += r.stat.size;
  }
  const etag = `${surfaceFilter}:${records.length}:${maxMtimeMs}:${sizeSum}`;
  if (options.etag && options.etag === etag) {
    return { unchanged: true, etag };
  }

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let mainSessionCount = 0;
  let subagentCount = 0;

  const dailyMap = new Map();
  const modelMap = new Map();
  const topSessionsList = [];

  const now = options.now instanceof Date ? options.now : new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let currentMonthCostUsd = 0;
  let allTimeCostUsd = 0;
  let unpricedTokens = 0;

  for (const rec of records) {
    const { scan } = rec;
    inputTokens += scan.inputTokens;
    cacheReadTokens += scan.cacheReadTokens;
    outputTokens += scan.outputTokens;
    const isSub = Boolean(rec.summary?.parentConversationId);
    if (isSub) subagentCount += 1;
    else mainSessionCount += 1;

    for (const [dateKey, bucket] of scan.dailyBuckets.entries()) {
      let agg = dailyMap.get(dateKey);
      if (!agg) {
        agg = {
          date: dateKey,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          stepCount: 0,
          sessionCount: 0,
          costUsd: 0,
        };
        dailyMap.set(dateKey, agg);
      }
      agg.inputTokens += bucket.inputTokens;
      agg.cacheReadTokens += bucket.cacheReadTokens;
      agg.outputTokens += bucket.outputTokens;
      agg.totalTokens += bucket.totalTokens;
      agg.stepCount += bucket.stepCount;
      agg.sessionCount += 1;
      agg.costUsd += bucket.costUsd;

      allTimeCostUsd += bucket.costUsd;
      if (dateKey.startsWith(currentMonthKey)) {
        currentMonthCostUsd += bucket.costUsd;
      }
    }

    for (const [familyKey, mb] of scan.modelBuckets.entries()) {
      let agg = modelMap.get(familyKey);
      if (!agg) {
        agg = {
          familyKey,
          label: mb.label,
          rawNames: new Set(),
          priced: mb.priced,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          turnCount: 0,
          inputCostUsd: 0,
          cacheCostUsd: 0,
          outputCostUsd: 0,
          totalCostUsd: 0,
        };
        modelMap.set(familyKey, agg);
      }
      for (const rn of mb.rawNames) agg.rawNames.add(rn);
      agg.inputTokens += mb.inputTokens;
      agg.cacheReadTokens += mb.cacheReadTokens;
      agg.outputTokens += mb.outputTokens;
      agg.totalTokens += mb.totalTokens;
      agg.turnCount += mb.turnCount;
      agg.inputCostUsd += mb.inputCostUsd;
      agg.cacheCostUsd += mb.cacheCostUsd;
      agg.outputCostUsd += mb.outputCostUsd;
      agg.totalCostUsd += mb.totalCostUsd;
      if (!mb.priced) unpricedTokens += mb.totalTokens;
    }

    const title = rec.summary?.title || scan.previewTitle || rec.conversationId.slice(0, 8);
    topSessionsList.push({
      conversationId: rec.conversationId,
      title,
      surface: rec.surface,
      modelLabel: getModelLabel(scan.activeFamily, scan.activeModelRaw),
      contextPeakTokens: scan.contextPeakTokens,
      totalTokens: scan.totalTokens,
      costUsd: +scan.totalCostUsd.toFixed(4),
      updatedAt: new Date(rec.stat.mtimeMs).toISOString(),
    });
  }

  // Build exact 364-day heatmap ending today in local time.
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rawDays = [];
  const nonZeroTotals = [];
  for (let offset = 363; offset >= 0; offset--) {
    const d = new Date(todayMidnight);
    d.setDate(todayMidnight.getDate() - offset);
    const dateKey = toLocalDateKey(d.getTime());
    const found = dailyMap.get(dateKey);
    const totalTok = found ? found.totalTokens : 0;
    if (totalTok > 0) nonZeroTotals.push(totalTok);
    rawDays.push({
      date: dateKey,
      weekday: (d.getDay() + 6) % 7, // Mon = 0 .. Sun = 6
      inputTokens: found ? found.inputTokens : 0,
      cacheReadTokens: found ? found.cacheReadTokens : 0,
      outputTokens: found ? found.outputTokens : 0,
      totalTokens: totalTok,
      stepCount: found ? found.stepCount : 0,
      sessionCount: found ? found.sessionCount : 0,
      costUsd: found ? +found.costUsd.toFixed(4) : 0,
    });
  }

  const thresholds = buildQuantileThresholds(nonZeroTotals);
  const heatmap = rawDays.map((day) => ({
    ...day,
    level: classifyHeatmapLevel(day.totalTokens, thresholds),
  }));

  // Compute active days, current streak, and max daily tokens across all recorded days.
  let maxDailyTokens = 0;
  let activeDays = 0;
  for (const d of dailyMap.values()) {
    if (d.totalTokens > 0) {
      activeDays += 1;
      if (d.totalTokens > maxDailyTokens) maxDailyTokens = d.totalTokens;
    }
  }

  let currentStreakDays = 0;
  for (let offset = 0; offset < 364; offset++) {
    const idx = heatmap.length - 1 - offset;
    if (heatmap[idx].totalTokens > 0) {
      currentStreakDays += 1;
    } else if (offset === 0) {
      // Allow today to have 0 tokens yet without breaking yesterday's active streak.
      continue;
    } else {
      break;
    }
  }

  const last14Days = heatmap.slice(-14);

  // Last 12 months series
  const monthlyMap = new Map();
  for (let mOffset = 11; mOffset >= 0; mOffset--) {
    const md = new Date(now.getFullYear(), now.getMonth() - mOffset, 1);
    const mKey = `${md.getFullYear()}-${String(md.getMonth() + 1).padStart(2, '0')}`;
    monthlyMap.set(mKey, {
      month: mKey,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  }
  for (const [dateKey, d] of dailyMap.entries()) {
    const mKey = dateKey.slice(0, 7);
    const mEntry = monthlyMap.get(mKey);
    if (mEntry) {
      mEntry.inputTokens += d.inputTokens;
      mEntry.cacheReadTokens += d.cacheReadTokens;
      mEntry.outputTokens += d.outputTokens;
      mEntry.totalTokens += d.totalTokens;
      mEntry.costUsd += d.costUsd;
    }
  }
  const monthlySeries = [...monthlyMap.values()].map((m) => ({
    ...m,
    costUsd: +m.costUsd.toFixed(4),
  }));

  // Cumulative series across active sorted dates
  const sortedDates = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  let cumTokens = 0;
  let cumCost = 0;
  const cumulativeSeries = sortedDates.map((d) => {
    cumTokens += d.totalTokens;
    cumCost += d.costUsd;
    return {
      date: d.date,
      cumulativeTokens: cumTokens,
      cumulativeCostUsd: +cumCost.toFixed(4),
    };
  });

  const models = [...modelMap.values()]
    .map((m) => ({
      familyKey: m.familyKey,
      label: m.label,
      rawNames: [...m.rawNames],
      priced: m.priced,
      inputTokens: m.inputTokens,
      cacheReadTokens: m.cacheReadTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.totalTokens,
      turnCount: m.turnCount,
      inputCostUsd: +m.inputCostUsd.toFixed(4),
      cacheCostUsd: +m.cacheCostUsd.toFixed(4),
      outputCostUsd: +m.outputCostUsd.toFixed(4),
      totalCostUsd: +m.totalCostUsd.toFixed(4),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  topSessionsList.sort((a, b) => b.totalTokens - a.totalTokens);
  const topSessions = topSessionsList.slice(0, 20);

  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  const promptTotal = inputTokens + cacheReadTokens;
  const cacheHitRate = promptTotal > 0 ? +((cacheReadTokens / promptTotal) * 100).toFixed(1) : 0;

  return {
    etag,
    surface: surfaceFilter,
    totals: {
      inputTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      cacheHitRate,
      sessionCount: records.length,
      mainSessionCount,
      subagentCount,
      activeDays,
      currentStreakDays,
      maxDailyTokens,
    },
    heatmap,
    last14Days,
    monthlySeries,
    cumulativeSeries,
    models,
    costSummary: {
      currentMonth: currentMonthKey,
      currentMonthCostUsd: +currentMonthCostUsd.toFixed(4),
      allTimeCostUsd: +allTimeCostUsd.toFixed(4),
      unpricedTokens,
      pricingRules: PRICING_RULES,
    },
    topSessions,
  };
}
