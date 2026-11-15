import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PLAN_PRESETS,
  POOL_ORDER,
  calibratePool,
  clearCalibration,
  collectQuotaSnapshot,
  formatCompactDuration,
  setCreditsMemo,
  setDisplayPreferences,
  setPlanTier,
  setPoolBudget,
} from './quota.mjs';
import { normalizeProxyUrl, parseOfficialCliQuota } from './cli-quota-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUOTA_SCRIPT = path.join(__dirname, 'quota.mjs');

function execQuotaCli(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [QUOTA_SCRIPT, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(JSON.parse(stdout));
    });
  });
}

describe('Context Lens Rolling Quota & Calibration Suite', () => {
  let tmpRoot;
  let geminiRoot;
  let pluginDataDir;
  let baseNowMs;

  const convMainId = '11111111-aaaa-bbbb-cccc-222222222222';
  const convOldId = '33333333-aaaa-bbbb-cccc-444444444444';
  const convSubId = '55555555-aaaa-bbbb-cccc-666666666666';

  before(() => {
    // Anchor on the 15th at 14:00 local time so all 7d offsets stay inside the same month.
    const d = new Date();
    const anchored = new Date(d.getFullYear(), d.getMonth(), Math.min(d.getDate(), 20), 14, 0, 0, 0);
    if (anchored.getDate() < 10) {
      anchored.setDate(10);
    }
    baseNowMs = anchored.getTime();

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'context-lens-quota-test-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    pluginDataDir = path.join(tmpRoot, 'plugin-data');

    const appDir = path.join(geminiRoot, 'antigravity');
    const mainDir = path.join(appDir, 'brain', convMainId, '.system_generated', 'logs');
    const oldDir = path.join(appDir, 'brain', convOldId, '.system_generated', 'logs');
    const subDir = path.join(appDir, 'brain', convSubId, '.system_generated', 'logs');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });

    const dbPath = path.join(appDir, 'conversation_summaries.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT "",
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL,
        workspace_uris TEXT NOT NULL DEFAULT "",
        status TEXT NOT NULL DEFAULT "",
        source TEXT NOT NULL DEFAULT "",
        agent_name TEXT NOT NULL DEFAULT "",
        parent_conversation_id TEXT NOT NULL DEFAULT ""
      );
    `);
    const isoNow = new Date(baseNowMs).toISOString();
    db.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, parent_conversation_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(convMainId, 'Ultra Coding Session', 6, isoNow, '');
    db.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, parent_conversation_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(convOldId, 'Earlier This Week', 2, isoNow, '');
    db.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, parent_conversation_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(convSubId, 'Subagent Claude Helper', 2, isoNow, convMainId);
    db.close();

    const tsOffsetMin = (minsAgo) => new Date(baseNowMs - minsAgo * 60_000).toISOString();

    // Main session:
    // - 240 mins ago: Gemini 4 Carbon turn (within 5h window) -> cost:
    //   input 2M ($2.5/M=$5) + cache 4M ($0.25/M=$1) + out 1M ($15/M=$15) = $21.00 (context <= 200k? use prompt=6M? wait promptHint=6M > 200k -> Carbon above200k!)
    //   Carbon above200k: input $5/M, cache $0.5/M, out $22.5/M -> keep prompt <= 200k for exact math:
    //   Let's set input=100k, cache=100k (prompt=200k), out=100k:
    //   Gemini 4 Carbon <=200k: (100k*2.5 + 100k*0.25 + 100k*15)/1e6 = 0.25 + 0.025 + 1.5 = $1.775
    //   Even simpler for round dollars: repeat 10 turns or choose exact token numbers!
    //   Or Gemini 4 Argon (no above200k tier): input $2/M, cache $0.1/M, out $10/M!
    //   Argon: input=2,000,000 ($4) + cache=0 + out=2,000,000 ($20) = $24.00!
    // - 60 mins ago: Claude Opus 5 turn: input $15/M, cache $1.5/M, out $75/M:
    //   input=1,000,000 ($15) + cache=0 + out=200,000 ($15) = $30.00!
    // - 30 mins ago: Gemini 3.8 Flash turn: input $0.75/M, cache $0.075/M, out $3.75/M:
    //   input=1,000,000 ($0.75) + cache=2,000,000 ($0.15) + out=600,000 ($2.25) = $3.15!
    const mainSteps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: tsOffsetMin(241),
        content:
          '<USER_REQUEST>\nBuild architecture\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from None to Gemini 4 Argon (High).</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: tsOffsetMin(240),
        input_tokens: 2_000_000,
        cache_read_tokens: 0,
        output_tokens: 2_000_000,
        content: 'Argon step',
      },
      {
        step_index: 2,
        type: 'USER_INPUT',
        created_at: tsOffsetMin(61),
        content:
          '<USER_REQUEST>\nSwitch to Claude\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from Gemini 4 Argon (High) to Claude Opus 5.</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: tsOffsetMin(60),
        input_tokens: 1_000_000,
        cache_read_tokens: 0,
        output_tokens: 200_000,
        content: 'Claude step',
      },
      {
        step_index: 4,
        type: 'USER_INPUT',
        created_at: tsOffsetMin(31),
        content:
          '<USER_REQUEST>\nQuick check with Flash\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from Claude Opus 5 to Gemini 3.8 Flash.</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: tsOffsetMin(30),
        input_tokens: 120_000,
        cache_read_tokens: 880_000,
        output_tokens: 600_000,
        content: 'Flash step',
      },
    ];
    fs.writeFileSync(
      path.join(mainDir, 'transcript.jsonl'),
      mainSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8'
    );

    // Subagent inheriting Claude? No, main ended on Flash, wait: test subagent with explicit Argon 2 days ago (peak test)
    const oldSteps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: new Date(baseNowMs - 48 * 3600_000).toISOString(),
        content:
          '<USER_REQUEST>\nHeavy run 2 days ago\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from None to Gemini 4 Argon (High).</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: new Date(baseNowMs - 48 * 3600_000 + 60_000).toISOString(),
        input_tokens: 5_000_000, // $10
        cache_read_tokens: 0,
        output_tokens: 2_000_000, // $20 -> $30 in a 5h window 2 days ago
        content: 'Old Argon burst',
      },
    ];
    fs.writeFileSync(
      path.join(oldDir, 'transcript.jsonl'),
      oldSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8'
    );

    // Subagent without explicit model — inherits lastExplicitModelRaw ('Gemini 3.8 Flash') from parent
    const subSteps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: tsOffsetMin(15),
        content: '<USER_REQUEST>\nSubagent helper\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: tsOffsetMin(10),
        input_tokens: 100_000,
        cache_read_tokens: 900_000,
        output_tokens: 100_000,
        content: 'Subagent done',
      },
    ];
    fs.writeFileSync(
      path.join(subDir, 'transcript.jsonl'),
      subSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8'
    );

    // Ensure mtimes preserve main > sub > old or predictable order
    fs.utimesSync(path.join(oldDir, 'transcript.jsonl'), new Date(baseNowMs - 48 * 3600_000), new Date(baseNowMs - 48 * 3600_000));
    fs.utimesSync(path.join(mainDir, 'transcript.jsonl'), new Date(baseNowMs - 5 * 60_000), new Date(baseNowMs - 5 * 60_000));
    fs.utimesSync(path.join(subDir, 'transcript.jsonl'), new Date(baseNowMs - 10 * 60_000), new Date(baseNowMs - 10 * 60_000));
  });

  after(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('buckets 5h/7d/monthly spend accurately, inherits parent model, and computes recovery countdown', () => {
    const snap = collectQuotaSnapshot({
      geminiRoot,
      pluginDataDir,
      executableDataDir: null,
      nowMs: baseNowMs,
    });

    assert.deepEqual(POOL_ORDER, ['gemini', 'claude']);
    assert.deepEqual(snap.poolOrder, ['gemini', 'claude']);
    assert.equal(snap.preferences.planTier, 'ultra_20x');
    assert.equal(snap.preferences.planLabel, PLAN_PRESETS.ultra_20x.label);
    assert.equal(snap.syncStatus.state, 'never_synced');

    // Gemini unified pool (Argon $24 + Flash $2.406 + Subagent Flash $0.5175 = $26.92) / $580 => 95% remaining; recovery = 1h00m
    assert.equal(snap.pools.gemini.win5hCostUsd, 26.92);
    assert.equal(snap.pools.gemini.win5hTurns, 3);
    assert.equal(snap.pools.gemini.remainingPct, 95);
    assert.equal(snap.pools.gemini.mode, 'estimated');
    assert.equal(snap.pools.gemini.countdownKind, 'recovery');
    assert.equal(snap.pools.gemini.countdownSeconds, 3600);
    assert.equal(snap.pools.gemini.countdownLabel, '↺ 1h00m 回血');

    // Gemini 7d includes the $30 burst from 48h ago -> 56.92 / 2500 = 2.28% used => 98% remaining
    assert.equal(snap.pools.gemini.win7dCostUsd, 56.92);
    assert.equal(snap.pools.gemini.peak5hCost7dUsd, 30);
    assert.equal(snap.pools.gemini.remaining7dPct, 98);
    assert.equal(snap.pools.gemini.mode7d, 'estimated');
    assert.equal(snap.pools.gemini.countdown7dKind, 'recovery');
    assert.equal(snap.pools.gemini.countdown7dLabel, '↺ 5d00h 回血');
    assert.equal(formatCompactDuration(48 * 3600), '2d00h');
    assert.equal(formatCompactDuration(5 * 86400), '5d00h');
    assert.equal(snap.pools.gemini.pacing7d.status, 'ample');
    assert.equal(snap.pools.gemini.pacing7d.dailyBurnUsd, +(56.92 / 7).toFixed(2));
    assert.ok(snap.pools.gemini.pacing7d.estRunwayDays > 100);
    assert.match(snap.pools.gemini.pacing7d.label, /^够用 · 日均 \$8\.1/);

    // Claude & GPT 5h: $30 / $100 = 30% used => 70% remaining
    assert.equal(snap.pools.claude.win5hCostUsd, 30);
    assert.equal(snap.pools.claude.remainingPct, 70);
    assert.equal(snap.pools.claude.countdownSeconds, (300 - 60) * 60);
    assert.equal(snap.pools.claude.countdownLabel, '↺ 4h00m 回血');

    // Latest active pool is gemini (subagent Flash 10m ago now rolls into Gemini Models), default dual_pct shows 5h & 7d
    assert.equal(snap.preferences.statusBarMode, 'dual_pct');
    assert.equal(snap.statusBar.poolKey, 'gemini');
    assert.equal(snap.statusBar.poolShortLabel, 'Ultra');
    assert.equal(snap.statusBar.remaining7dPct, snap.pools.gemini.remaining7dPct);
    assert.match(snap.statusBar.text, /^5h:\d+% · 7d:\d+%$/);
    assert.equal(snap.activeSession.conversationId, convMainId);
    assert.equal(snap.activeSession.title, 'Ultra Coding Session');
    assert.equal(snap.activeSession.contextTokens, 1_000_000);

    // Warm run should hit quota-scan-cache.json without error
    assert.ok(fs.existsSync(path.join(pluginDataDir, 'quota-scan-cache.json')));
    const warmSnap = collectQuotaSnapshot({
      geminiRoot,
      pluginDataDir,
      executableDataDir: null,
      nowMs: baseNowMs + 5000,
    });
    assert.equal(warmSnap.pools.gemini.win5hCostUsd, 26.92);
  });

  it('supports calibration, proportional deduction after new consumption, and automatic reset expiration', () => {
    // Calibrate gemini to 60% remaining (windowCostAtCalibration=$26.92 => impliedCap=$67.30)
    const calSnap = calibratePool('gemini', 60, {
      geminiRoot,
      pluginDataDir,
      executableDataDir: null,
      nowMs: baseNowMs,
    });
    assert.equal(calSnap.pools.gemini.mode, 'calibrated');
    assert.equal(calSnap.pools.gemini.remainingPct, 60);

    // Simulate a subsequent Gemini Argon turn ($12 cost) 2 minutes later
    const mainTranscript = path.join(geminiRoot, 'antigravity', 'brain', convMainId, '.system_generated', 'logs', 'transcript.jsonl');
    const originalContent = fs.readFileSync(mainTranscript, 'utf8');
    try {
      const addedSteps = [
        {
          step_index: 6,
          type: 'USER_INPUT',
          created_at: new Date(baseNowMs + 60_000).toISOString(),
          content:
            '<USER_REQUEST>\nMore Argon\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from Gemini 3.8 Flash to Gemini 4 Argon (High).</USER_SETTINGS_CHANGE>',
        },
        {
          step_index: 7,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(baseNowMs + 120_000).toISOString(),
          input_tokens: 1_000_000, // $2
          cache_read_tokens: 0,
          output_tokens: 1_000_000, // $10 -> $12 extra cost
          content: 'Additional Argon response',
        },
      ];
      fs.writeFileSync(
        mainTranscript,
        originalContent + addedSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf8'
      );

      // deltaCost = $12 against impliedCap = $26.92 / 0.4 = $67.30 => -17.83% => 60% - 17.83% = 42%
      const afterSpend = collectQuotaSnapshot({
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs + 125_000,
      });
      assert.equal(afterSpend.pools.gemini.mode, 'calibrated');
      assert.equal(afterSpend.pools.gemini.remainingPct, 42);

      // Calibrate claude to 25% with explicit reset-minutes=60, then advance past reset
      const calClaude = calibratePool('claude', 25, {
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs + 125_000,
        resetMinutes: 60,
      });
      assert.equal(calClaude.pools.claude.remainingPct, 25);
      assert.equal(calClaude.pools.claude.countdownKind, 'reset');
      assert.equal(calClaude.pools.claude.countdownLabel, '↺ 1h00m 重置');

      // Advance 61 minutes past claude calibration -> calibration clears, lastResetAtMs skips prior spend -> 100%
      const afterReset = collectQuotaSnapshot({
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs + 125_000 + 61 * 60_000,
      });
      assert.equal(afterReset.pools.claude.mode, 'estimated');
      assert.equal(afterReset.pools.claude.remainingPct, 100);
      assert.equal(afterReset.pools.claude.win5hTurns, 0);
    } finally {
      fs.writeFileSync(mainTranscript, originalContent, 'utf8');
      clearCalibration('all', {
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs,
      });
    }
  });

  it('supports 7d weekly calibration, reset countdown, status alert precedence, and pacing7d runway', async () => {
    setDisplayPreferences(
      { mode: 'dual_pct', pool: 'gemini' },
      { geminiRoot, pluginDataDir, executableDataDir: null, nowMs: baseNowMs }
    );

    try {
      // Calibrate gemini 7d to 30% with 3-day reset window (gemini 5h is 80%, so statusBar.level must escalate from ok -> warn due to 7d=30%)
      const cal7dSnap = calibratePool('gemini', 30, {
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs,
        window: '7d',
        resetMinutes: 3 * 1440,
      });

      assert.equal(cal7dSnap.pools.gemini.remainingPct, 95);
      assert.equal(cal7dSnap.pools.gemini.mode, 'estimated');
      assert.equal(cal7dSnap.pools.gemini.mode7d, 'calibrated');
      assert.equal(cal7dSnap.pools.gemini.remaining7dPct, 30);
      assert.equal(cal7dSnap.pools.gemini.countdown7dKind, 'reset');
      assert.equal(cal7dSnap.pools.gemini.countdown7dLabel, '↺ 3d00h 重置');
      assert.equal(cal7dSnap.pools.gemini.pacing7d.daysUntilReset, 3);
      assert.equal(cal7dSnap.statusBar.level, 'warn');
      assert.equal(cal7dSnap.statusBar.text, '5h:95% · 7d:30%');

      // Dropping 7d to 15% triggers critical level even if 5h is 80%
      const critSnap = calibratePool('gemini', 15, {
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs,
        window: '7d',
        resetMinutes: 3 * 1440,
      });
      assert.equal(critSnap.statusBar.level, 'critical');

      // Advancing past 3d reset expires 7d calibration and resets 7d window spend to 100%
      const expiredSnap = collectQuotaSnapshot({
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs + 3 * 1440 * 60_000 + 60_000,
      });
      assert.equal(expiredSnap.pools.gemini.mode7d, 'estimated');
      assert.equal(expiredSnap.pools.gemini.remaining7dPct, 100);

      // Verify CLI --window 7d flags for --calibrate, --set-budget, --clear-calibration, and --set-display modes
      const cliCal7d = await execQuotaCli([
        '--gemini-root',
        geminiRoot,
        '--plugin-data-dir',
        pluginDataDir,
        '--now-ms',
        String(baseNowMs),
        '--calibrate',
        'gemini',
        '--window',
        '7d',
        '--pct',
        '60',
        '--reset-minutes',
        '4320',
      ]);
      assert.equal(cliCal7d.pools.gemini.remaining7dPct, 60);
      assert.equal(cliCal7d.pools.gemini.mode7d, 'calibrated');

      const cliMode7d = await execQuotaCli([
        '--gemini-root',
        geminiRoot,
        '--plugin-data-dir',
        pluginDataDir,
        '--now-ms',
        String(baseNowMs),
        '--set-display',
        '--mode',
        'pct7d_timer',
        '--pool',
        'gemini',
      ]);
      assert.equal(cliMode7d.statusBar.text, '周60% · ↺3d00h');

      const cliBudget7d = await execQuotaCli([
        '--gemini-root',
        geminiRoot,
        '--plugin-data-dir',
        pluginDataDir,
        '--now-ms',
        String(baseNowMs),
        '--set-budget',
        'gemini',
        '--window',
        '7d',
        '--usd',
        '2500',
      ]);
      assert.equal(cliBudget7d.pools.gemini.configuredBudget7dUsd, 2500);
      assert.equal(cliBudget7d.pools.gemini.autoScalePeak7d, false);

      const cliClear7d = await execQuotaCli([
        '--gemini-root',
        geminiRoot,
        '--plugin-data-dir',
        pluginDataDir,
        '--now-ms',
        String(baseNowMs),
        '--clear-calibration',
        'gemini',
        '--window',
        '7d',
      ]);
      assert.equal(cliClear7d.pools.gemini.mode7d, 'estimated');
      assert.equal(cliClear7d.pools.gemini.remaining7dPct, 98);
    } finally {
      setPoolBudget('gemini', 'auto', {
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs,
        window: '7d',
      });
      clearCalibration('all', {
        geminiRoot,
        pluginDataDir,
        executableDataDir: null,
        nowMs: baseNowMs,
        window: 'all',
      });
      setDisplayPreferences(
        { mode: 'dual_pct', pool: 'auto' },
        { geminiRoot, pluginDataDir, executableDataDir: null, nowMs: baseNowMs }
      );
    }
  });

  it('persists plan tier, budget, credits memo, display preferences, and CLI flags cleanly', async () => {
    setPlanTier('pro', { geminiRoot, pluginDataDir, executableDataDir: null, nowMs: baseNowMs });
    setPoolBudget('claude', 150, { geminiRoot, pluginDataDir, executableDataDir: null, nowMs: baseNowMs });
    setCreditsMemo(
      { available: 4200, monthly: 12000 },
      { geminiRoot, pluginDataDir, executableDataDir: null, nowMs: baseNowMs }
    );
    const prefSnap = setDisplayPreferences(
      { mode: 'pct_cost', pool: 'claude' },
      { geminiRoot, pluginDataDir, executableDataDir: null, nowMs: baseNowMs }
    );

    assert.equal(prefSnap.preferences.planTier, 'pro');
    assert.equal(prefSnap.pools.claude.configuredBudget5hUsd, 150);
    assert.equal(prefSnap.pools.claude.autoScalePeak, false);
    assert.equal(prefSnap.credits.available, 4200);
    assert.equal(prefSnap.credits.monthly, 12000);
    assert.equal(prefSnap.statusBar.poolKey, 'claude');
    assert.equal(prefSnap.statusBar.poolShortLabel, 'Claude');
    assert.match(prefSnap.statusBar.text, /^80% · \$30\.0$/);

    // Verify CLI invocations work end-to-end
    const cliResetPlan = await execQuotaCli([
      '--gemini-root',
      geminiRoot,
      '--plugin-data-dir',
      pluginDataDir,
      '--now-ms',
      String(baseNowMs),
      '--set-plan',
      'ultra_20x',
    ]);
    assert.equal(cliResetPlan.preferences.planTier, 'ultra_20x');

    const cliDisplay = await execQuotaCli([
      '--gemini-root',
      geminiRoot,
      '--plugin-data-dir',
      pluginDataDir,
      '--now-ms',
      String(baseNowMs),
      '--set-display',
      '--mode',
      'pct_only',
      '--pool',
      'auto',
    ]);
    assert.equal(cliDisplay.preferences.statusBarMode, 'pct_only');
    assert.equal(cliDisplay.preferences.primaryPool, 'auto');

    const cliClearCredits = await execQuotaCli([
      '--gemini-root',
      geminiRoot,
      '--plugin-data-dir',
      pluginDataDir,
      '--now-ms',
      String(baseNowMs),
      '--set-credits',
      '--available',
      'clear',
      '--monthly',
      'clear',
    ]);
    assert.equal(cliClearCredits.credits.available, null);
    assert.equal(cliClearCredits.credits.monthly, null);
  });

  it('parses official CLI statusLine quota buckets, Go omitempty 0%, unused windows, and /usage screen fallback', () => {
    const t0 = baseNowMs;
    assert.equal(normalizeProxyUrl(':7890'), 'http://127.0.0.1:7890');
    assert.equal(normalizeProxyUrl('127.0.0.1:7897'), 'http://127.0.0.1:7897');
    assert.equal(normalizeProxyUrl('clear'), null);

    const parsed = parseOfficialCliQuota({
      syncedAtMs: t0,
      statusLines: [
        { agent_state: 'authenticating', quota: null },
        {
          agent_state: 'idle',
          plan_tier: 'Ultra',
          quota: {
            'gemini-weekly': {
              remaining_fraction: 0.87,
              reset_time: new Date(t0 + (5 * 24 + 10) * 3600_000).toISOString(),
              reset_in_seconds: (5 * 24 + 10) * 3600,
            },
            'gemini-burst': {
              remaining_fraction: 0.82,
              reset_in_seconds: 3600,
            },
            'claude-gpt-weekly': {
              // Omitted remaining_fraction while reset_in_seconds > 0 => exhausted (0%)
              reset_in_seconds: 4 * 86400,
            },
            'disabled-legacy-bucket': {
              remaining_fraction: 0.1,
              reset_in_seconds: 1200,
              disabled: true,
            },
          },
        },
      ],
    });

    assert.equal(parsed.valid, true);
    assert.equal(parsed.planTierRaw, 'Ultra');
    assert.equal(parsed.pools.gemini['7d'].remainingPct, 87);
    assert.equal(parsed.pools.gemini['5h'].remainingPct, 82);
    assert.equal(parsed.pools.claude['7d'].remainingPct, 0);
    // Absent unused 5h window defaults cleanly to 100%
    assert.equal(parsed.pools.claude['5h'].remainingPct, 100);
    assert.equal(parsed.pools.claude['5h'].bucketId, 'unused_default');

    // Screen text fallback when statusLine omits quota values
    const screenParsed = parseOfficialCliQuota({
      syncedAtMs: t0,
      statusLines: [{ agent_state: 'idle' }],
      screenText: [
        'Gemini Models',
        'Weekly Limit Remaining  87%  refresh in 5 days, 10 hours',
        'Five Hour Limit Remaining  82%  refresh in 1 hour',
        'Claude and GPT models',
        'Weekly Limit Remaining  29%  refresh in 4 days, 11 hours',
        'Five Hour Limit Remaining  79%  refresh in 1 hour, 28 minutes',
      ].join('\n'),
    });

    assert.equal(screenParsed.valid, true);
    assert.equal(screenParsed.pools.gemini['7d'].remainingPct, 87);
    assert.equal(screenParsed.pools.gemini['5h'].remainingPct, 82);
    assert.equal(screenParsed.pools.claude['7d'].remainingPct, 29);
    assert.equal(screenParsed.pools.claude['5h'].remainingPct, 79);

    // Exact agy 1.4.12 statusLine.quota payload with '3p-*' buckets and 'gemini-*' buckets
    const realAgyParsed = parseOfficialCliQuota({
      syncedAtMs: t0,
      statusLines: [
        {
          agent_state: 'idle',
          plan_tier: null,
          quota: {
            '3p-5h': {
              remaining_fraction: 0.7897522,
              reset_time: '2026-11-15T15:26:45Z',
              reset_in_seconds: 701,
            },
            '3p-weekly': {
              remaining_fraction: 0.28846753,
              reset_time: '2026-11-20T01:34:31Z',
              reset_in_seconds: 382767,
            },
            'gemini-5h': {
              remaining_fraction: 0.98921055,
              reset_time: '2026-11-15T19:58:37Z',
              reset_in_seconds: 17013,
            },
            'gemini-weekly': {
              remaining_fraction: 0.8478346,
              reset_time: '2026-11-21T00:27:02Z',
              reset_in_seconds: 465118,
            },
          },
        },
      ],
    });

    assert.equal(realAgyParsed.valid, true);
    assert.equal(realAgyParsed.pools.gemini['5h'].remainingPct, 99);
    assert.equal(realAgyParsed.pools.gemini['5h'].bucketId, 'gemini-5h');
    assert.equal(realAgyParsed.pools.gemini['7d'].remainingPct, 85);
    assert.equal(realAgyParsed.pools.gemini['7d'].bucketId, 'gemini-weekly');
    assert.equal(realAgyParsed.pools.claude['5h'].remainingPct, 79);
    assert.equal(realAgyParsed.pools.claude['5h'].bucketId, '3p-5h');
    assert.equal(realAgyParsed.pools.claude['7d'].remainingPct, 29);
    assert.equal(realAgyParsed.pools.claude['7d'].bucketId, '3p-weekly');

    // Exact agy 1.4.12 /usage TUI progress-bar output (decimal percentages & next-line Refreshes in ...)
    const realTuiParsed = parseOfficialCliQuota({
      syncedAtMs: t0,
      statusLines: [{ agent_state: 'idle' }],
      screenText: [
        'GEMINI MODELS',
        'Models within this group: Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
        'Weekly Limit Remaining',
        '[ ██████████████████████████████████████████ ░░░░░░░░ ] 84.78%',
        'Refreshes in 129h 11m',
        'Five Hour Limit Remaining',
        '[ █████████████████████████████████████████████████ ░ ] 98.92%',
        'Refreshes in 4h 43m',
        'CLAUDE AND GPT MODELS',
        'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
        'Weekly Limit Remaining',
        '[ ██████████████ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ ] 28.85%',
        'Refreshes in 106h 19m',
        'Five Hour Limit Remaining',
        '[ ███████████████████████████████████████ ░░░░░░░░░░░ ] 78.98%',
        'Refreshes in 11m',
      ].join('\n'),
    });

    assert.equal(realTuiParsed.valid, true);
    assert.equal(realTuiParsed.pools.gemini['7d'].remainingPct, 85);
    assert.equal(realTuiParsed.pools.gemini['7d'].resetAtMs, t0 + (129 * 3600 + 11 * 60) * 1000);
    assert.equal(realTuiParsed.pools.gemini['5h'].remainingPct, 99);
    assert.equal(realTuiParsed.pools.gemini['5h'].resetAtMs, t0 + (4 * 3600 + 43 * 60) * 1000);
    assert.equal(realTuiParsed.pools.claude['7d'].remainingPct, 29);
    assert.equal(realTuiParsed.pools.claude['7d'].resetAtMs, t0 + (106 * 3600 + 19 * 60) * 1000);
    assert.equal(realTuiParsed.pools.claude['5h'].remainingPct, 79);
    assert.equal(realTuiParsed.pools.claude['5h'].resetAtMs, t0 + 11 * 60 * 1000);
  });

  it('syncs official quota end-to-end via mock agy CLI, persists proxy safely, and auto-recovers expired windows', async () => {
    const mockAgyPath = path.join(tmpRoot, 'mock-agy.mjs');
    const resetGem5hIso = new Date(baseNowMs + 3600_000).toISOString();
    const resetGem7dIso = new Date(baseNowMs + (5 * 24 + 10) * 3600_000).toISOString();
    const resetClaude5hIso = new Date(baseNowMs + 5280_000).toISOString();
    const resetClaude7dIso = new Date(baseNowMs + (4 * 24 + 11) * 3600_000).toISOString();

    const mockAgyScript = `#!/usr/bin/env node
import { execSync } from 'node:child_process';
import readline from 'node:readline';

const args = process.argv.slice(2);
const idx = args.indexOf('--settings');
const settings = idx >= 0 ? JSON.parse(args[idx + 1]) : {};
const cmd = settings?.statusLine?.command;

// Ensure ANTIGRAVITY_* leakage was scrubbed
if (Object.keys(process.env).some((k) => k.startsWith('ANTIGRAVITY_'))) {
  process.exit(9);
}

function sendStatus(payload) {
  if (!cmd) return;
  execSync(cmd, { input: JSON.stringify(payload), stdio: ['pipe', 'ignore', 'ignore'] });
}

sendStatus({ agent_state: 'idle', plan_tier: 'Ultra', email: 'secret@example.com', quota: null });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const clean = line.replace(/\\x1b/g, '').trim();
  if (clean.includes('/usage')) {
    sendStatus({
      agent_state: 'idle',
      plan_tier: 'Ultra',
      email: 'secret@example.com',
      quota: {
        'gemini-weekly': { remaining_fraction: 0.87, reset_time: ${JSON.stringify(resetGem7dIso)}, reset_in_seconds: 468000 },
        'gemini-5h': { remaining_fraction: 0.82, reset_time: ${JSON.stringify(resetGem5hIso)}, reset_in_seconds: 3600 },
        '3p-weekly': { remaining_fraction: 0.29, reset_time: ${JSON.stringify(resetClaude7dIso)}, reset_in_seconds: 385200 },
        '3p-5h': { remaining_fraction: 0.79, reset_time: ${JSON.stringify(resetClaude5hIso)}, reset_in_seconds: 5280 },
      },
    });
  } else if (clean.includes('/exit')) {
    process.exit(0);
  }
});
`;
    fs.writeFileSync(mockAgyPath, mockAgyScript, { mode: 0o755 });

    const syncedSnap = await execQuotaCli([
      '--gemini-root',
      geminiRoot,
      '--plugin-data-dir',
      pluginDataDir,
      '--now-ms',
      String(baseNowMs),
      '--agy-bin',
      mockAgyPath,
      '--skip-system-proxy',
      '--set-proxy',
      ':7890',
      '--sync-cli',
    ]);

    assert.equal(syncedSnap.syncStatus.state, 'synced');
    assert.equal(syncedSnap.syncStatus.proxyUrl, 'http://127.0.0.1:7890');
    assert.equal(syncedSnap.pools.gemini.mode, 'cloud');
    assert.equal(syncedSnap.pools.gemini.remainingPct, 82);
    assert.equal(syncedSnap.pools.gemini.remaining7dPct, 87);
    assert.equal(syncedSnap.pools.gemini.pacing7d.status, 'ample');

    assert.equal(syncedSnap.pools.claude.mode, 'cloud');
    assert.equal(syncedSnap.pools.claude.remainingPct, 79);
    assert.equal(syncedSnap.pools.claude.remaining7dPct, 29);
    assert.equal(syncedSnap.pools.claude.pacing7d.status, 'tight');

    const cachePath = path.join(pluginDataDir, 'official-quota-cache.json');
    assert.ok(fs.existsSync(cachePath));
    const cacheRaw = fs.readFileSync(cachePath, 'utf8');
    assert.equal(cacheRaw.includes('secret@example.com'), false, 'email must never be saved to cache');

    // Advancing past Gemini 5h reset (+2h) flips Gemini 5h to 100% ('已刷新')
    const afterGem5hReset = collectQuotaSnapshot({
      geminiRoot,
      pluginDataDir,
      executableDataDir: null,
      nowMs: baseNowMs + 2 * 3600_000,
    });
    assert.equal(afterGem5hReset.pools.gemini.remainingPct, 100);
    assert.equal(afterGem5hReset.pools.gemini.countdownLabel, '已刷新');
    assert.equal(afterGem5hReset.pools.claude.remaining7dPct, 29);

    const clearedProxySnap = await execQuotaCli([
      '--gemini-root',
      geminiRoot,
      '--plugin-data-dir',
      pluginDataDir,
      '--now-ms',
      String(baseNowMs),
      '--set-proxy',
      'clear',
    ]);
    assert.equal(clearedProxySnap.syncStatus.proxyUrl, null);
  });
});
