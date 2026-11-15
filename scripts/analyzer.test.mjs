import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PRICING_RULES,
  clearAnalyzerCaches,
  collectHistory,
  inspectSession,
  toLocalDateKey,
} from './analyzer.mjs';
import { startServer } from '../sidecars/dashboard/main.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

describe('Context Lens Analyzer & Plugin Suite', () => {
  let tmpRoot;
  let geminiRoot;
  const mainConvId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const subConvId = 'bbbbbbbb-1111-2222-3333-444444444444';

  before(() => {
    clearAnalyzerCaches();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'context-lens-test-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    const appDir = path.join(geminiRoot, 'antigravity');
    const mainLogDir = path.join(appDir, 'brain', mainConvId, '.system_generated', 'logs');
    const subLogDir = path.join(appDir, 'brain', subConvId, '.system_generated', 'logs');
    fs.mkdirSync(mainLogDir, { recursive: true });
    fs.mkdirSync(subLogDir, { recursive: true });

    // SQLite metadata DB with parent-child link
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
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, parent_conversation_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(mainConvId, 'Synthetic Main Session', 6, nowIso, '');
    db.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, parent_conversation_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(subConvId, 'Subagent Worker', 2, nowIso, mainConvId);
    db.close();

    const nowMs = Date.now();
    const ts = (offsetSec) => new Date(nowMs + offsetSec * 1000).toISOString();

    // Main session steps:
    // Turn 1: Gemini 4 Argon (input=10000, cache=0, out=500), context=10000
    // Turn 2: Context grows to 100000 (input=10000, cache=90000, out=1000)
    // Turn 3: Switch model to Gemini 4 Carbon & trigger compaction drop (input=5000, cache=25000, out=400) -> context=30000 (< 100000 * 0.72)
    const mainSteps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: ts(-60),
        content:
          '<USER_REQUEST>\nAnalyze architecture\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from None to Gemini 4 Argon (High).</USER_SETTINGS_CHANGE>',
        media: [{ mime_type: 'image/png', uri: '/tmp/a.png' }],
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: ts(-50),
        input_tokens: 10000,
        cache_read_tokens: 0,
        output_tokens: 500,
        thinking: 'Checking module structure carefully.',
        content: 'Initial findings ready.',
        tool_calls: [{ name: 'read_file', args: { Path: '/tmp/foo.js' } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        created_at: ts(-48),
        content: 'A'.repeat(2000),
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: ts(-38),
        input_tokens: 10000,
        cache_read_tokens: 90000,
        output_tokens: 1000,
        content: 'Second response with large cached prompt.',
      },
      {
        step_index: 4,
        type: 'USER_INPUT',
        created_at: ts(-20),
        content:
          '<USER_REQUEST>\nContinue\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from Gemini 4 Argon (High) to Orchestrator (Carbon).</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: ts(-10),
        input_tokens: 5000,
        cache_read_tokens: 25000,
        output_tokens: 400,
        content: 'Compacted turn completed.',
      },
    ];

    const mainJsonl = mainSteps.map((s) => JSON.stringify(s)).join('\n') + '\n';
    fs.writeFileSync(path.join(mainLogDir, 'transcript.jsonl'), mainJsonl, 'utf8');
    fs.writeFileSync(path.join(mainLogDir, 'transcript_full.jsonl'), mainJsonl, 'utf8');

    // Subagent without explicit Model Selection — should inherit Orchestrator (Carbon) from parent
    const subSteps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: ts(-8),
        content: '<USER_REQUEST>\nSubtask\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: ts(-3),
        input_tokens: 4000,
        cache_read_tokens: 1000,
        output_tokens: 200,
        content: 'Subtask complete.',
      },
    ];
    const subJsonl = subSteps.map((s) => JSON.stringify(s)).join('\n') + '\n';
    fs.writeFileSync(path.join(subLogDir, 'transcript.jsonl'), subJsonl, 'utf8');
  });

  after(() => {
    clearAnalyzerCaches();
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('computes exact context occupancy, model transitions, subagent inheritance, compaction, 6 categories, heatmap, and cost math', () => {
    const session = inspectSession(mainConvId, { geminiRoot, executableDataDir: null });
    assert.equal(session.found, true);
    assert.equal(session.title, 'Synthetic Main Session');
    assert.equal(session.model, 'Orchestrator (Carbon)');
    assert.equal(session.modelLabel, PRICING_RULES['gemini-4-carbon'].label);
    assert.equal(session.summary.contextTokens, 30000); // latest PLANNER_RESPONSE: 5000 + 25000
    assert.equal(session.summary.inputTokens, 25000);
    assert.equal(session.summary.cacheReadTokens, 115000);
    assert.equal(session.summary.outputTokens, 1900);
    assert.equal(session.summary.compactionCount, 1);
    assert.equal(session.categories.length, 6);
    assert.ok(session.turns[2].compacted, 'Turn 3 should be marked as compacted');

    const catSum = session.categories.reduce((acc, c) => acc + c.scaledTokens, 0);
    assert.ok(Math.abs(catSum - 30000) <= 6, `Scaled category sum (${catSum}) should match contextTokens (30000)`);

    const history = collectHistory({ geminiRoot, executableDataDir: null });
    assert.equal(history.totals.sessionCount, 2);
    assert.equal(history.totals.mainSessionCount, 1);
    assert.equal(history.totals.subagentCount, 1);
    assert.equal(history.totals.totalTokens, 29000 + 116000 + 2100);
    assert.equal(history.heatmap.length, 364);

    const todayKey = toLocalDateKey(Date.now());
    const todayCell = history.heatmap.find((d) => d.date === todayKey);
    assert.ok(todayCell, 'Today must exist in 364-day heatmap');
    assert.equal(todayCell.totalTokens, history.totals.totalTokens);
    assert.ok(todayCell.level >= 1);

    // Argon cost: (20k*2 + 90k*0.1 + 1.5k*10)/1e6 = 0.04 + 0.009 + 0.015 = 0.064
    // Carbon cost (main turn 3 + subagent): (9k*2.5 + 26k*0.25 + 0.6k*15)/1e6 = 0.0225 + 0.0065 + 0.009 = 0.038
    assert.equal(history.costSummary.unpricedTokens, 0);
    assert.ok(Math.abs(history.costSummary.allTimeCostUsd - 0.102) < 0.0005);
  });

  it('runs session-start-hook.mjs cleanly via stdin and persists session-models.json', async () => {
    const hookScript = path.join(PLUGIN_ROOT, 'scripts', 'session-start-hook.mjs');
    const pluginDataDir = path.join(tmpRoot, 'plugin_data');
    const payload = JSON.stringify({
      conversationId: 'cccccccc-1111-2222-3333-444444444444',
      modelName: 'Gemini 4 Carbon (High)',
    });

    const result = await new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [hookScript],
        { env: { ...process.env, PLUGIN_DATA: pluginDataDir } },
        (err, stdout, stderr) => {
          if (err) return reject(err);
          resolve({ stdout, stderr });
        }
      );
      child.stdin.write(payload);
      child.stdin.end();
    });

    assert.equal(result.stdout.trim(), '{}');
    const saved = JSON.parse(fs.readFileSync(path.join(pluginDataDir, 'session-models.json'), 'utf8'));
    assert.equal(saved['cccccccc-1111-2222-3333-444444444444'].modelName, 'Gemini 4 Carbon (High)');
  });

  it('serves static assets, /preload.js, /api/session, and /api/history with etag support in standalone HTTP mode', async () => {
    const srv = await startServer({
      standalone: true,
      port: 0,
      analyzerOptions: { geminiRoot, executableDataDir: null },
    });

    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.match(html, /Context Lens/);

      const preloadRes = await fetch(`${base}/preload.js`);
      assert.equal(preloadRes.status, 200);
      assert.match(await preloadRes.text(), /window\.sidecar/);

      const cssRes = await fetch(`${base}/styles.css`);
      assert.equal(cssRes.status, 200);

      const jsRes = await fetch(`${base}/app.js`);
      assert.equal(jsRes.status, 200);

      const sessRes = await fetch(`${base}/api/session?conversationId=${mainConvId}`);
      const sessJson = await sessRes.json();
      assert.equal(sessJson.found, true);
      assert.equal(sessJson.summary.contextTokens, 30000);

      const histRes = await fetch(`${base}/api/history`);
      const histJson = await histRes.json();
      assert.equal(histJson.totals.sessionCount, 2);
      assert.ok(histJson.etag);

      const etagRes = await fetch(`${base}/api/history?etag=${encodeURIComponent(histJson.etag)}`);
      const etagJson = await etagRes.json();
      assert.equal(etagJson.unchanged, true);
    } finally {
      await new Promise((resolve) => srv.server.close(resolve));
    }
  });

  it('integrates with real Antigravity sidecar_sdk loader when installed on host', async () => {
    const registerLoader = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'lib',
      'node_modules',
      'sidecar_sdk',
      'register_loader.js'
    );
    if (!fs.existsSync(registerLoader)) return;

    const freePort = await getFreePort();
    const mainScript = path.join(PLUGIN_ROOT, 'sidecars', 'dashboard', 'main.mjs');

    const child = spawn(process.execPath, ['--import', registerLoader, mainScript], {
      env: {
        ...process.env,
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
        ANTIGRAVITY_CSRF_TOKEN: 'test-csrf',
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(freePort),
        ANTIGRAVITY_CONVERSATION_ID: mainConvId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sidecar startup timeout')), 6000);
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk.toString('utf8');
          if (out.includes('[sidecar] listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Sidecar exited prematurely with code ${code}`));
        });
      });

      const base = `http://127.0.0.1:${freePort}`;
      const [pageRes, histRes, sessRes] = await Promise.all([
        fetch(`${base}/`),
        fetch(`${base}/api/history`),
        fetch(`${base}/api/session`),
      ]);
      assert.equal(pageRes.status, 200);
      assert.equal(histRes.status, 200);
      assert.equal(sessRes.status, 200);

      const histJson = await histRes.json();
      assert.ok(histJson.totals && typeof histJson.totals.totalTokens === 'number');
      const sessJson = await sessRes.json();
      assert.equal(typeof sessJson.found, 'boolean');
    } finally {
      child.kill('SIGTERM');
    }
  });
});
