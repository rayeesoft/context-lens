import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectHistory, inspectSession } from './analyzer.mjs';

function parseArgs(argv) {
  const args = { conversation: '', surface: 'all', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--conversation' && argv[i + 1]) args.conversation = argv[++i];
    else if (a === '--surface' && argv[i + 1]) args.surface = argv[++i];
  }
  return args;
}

function isSidecarEnabled(geminiRoot) {
  try {
    const cfgPath = path.join(geminiRoot, 'config', 'config.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return Boolean(cfg?.sidecars?.['context-lens/dashboard']?.enabled);
  } catch {
    return false;
  }
}

function fmtTokens(n) {
  const num = Number(n || 0);
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

function fmtUsd(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function formatMarkdown(session, history, sidecarEnabled) {
  const lines = [];
  lines.push('# Context Lens 报告');
  lines.push('');

  if (session && session.found && session.summary) {
    const s = session.summary;
    lines.push(`## 当前会话：${session.title}`);
    lines.push(`- **Conversation ID**: \`${session.conversationId}\`${session.autoSelected ? ' (自动匹配最近会话)' : ''}`);
    lines.push(`- **来源 / 模型**: ${session.surfaceLabel} · ${session.modelLabel}`);
    lines.push(`- **当前上下文占用**: **${fmtTokens(s.contextTokens)}** (${s.contextTokens.toLocaleString()} tokens)`);
    lines.push(`- **缓存命中率**: **${s.cacheHitRate}%** · **输出速度中位数**: ${s.medianTokensPerSec !== null ? `${s.medianTokensPerSec} tok/s` : 'N/A'}`);
    lines.push(`- **本会话累计**: Input ${fmtTokens(s.inputTokens)} · Cache Read ${fmtTokens(s.cacheReadTokens)} · Output ${fmtTokens(s.outputTokens)} · 参考费用 ${s.priced ? fmtUsd(s.totalCostUsd) : '未定价'}`);
    lines.push('');
    lines.push('### 上下文构成拆解');
    lines.push('| 类别 | 占比 | 估算 Token | 条目/字符数 |');
    lines.push('| :--- | ---: | ---: | ---: |');
    for (const c of session.categories) {
      lines.push(`| ${c.label} | ${c.sharePct}% | ${fmtTokens(c.scaledTokens)} | ${c.itemCount} 项 / ${c.charCount.toLocaleString()} 字符 |`);
    }
    lines.push('');
  } else {
    lines.push('## 当前会话');
    lines.push('未找到可读取的本地会话日志。');
    lines.push('');
  }

  const t = history.totals;
  const last30Tokens = history.heatmap.slice(-30).reduce((acc, d) => acc + d.totalTokens, 0);
  const last30Cost = history.heatmap.slice(-30).reduce((acc, d) => acc + d.costUsd, 0);

  lines.push('## 历史用量与 API 参考账单');
  lines.push(`- **近 30 天累计**: **${fmtTokens(last30Tokens)}** tokens · API 等值参考 **${fmtUsd(last30Cost)}**`);
  lines.push(`- **全量累计 (${t.sessionCount} 会话 / ${t.activeDays} 活跃天 / 连续 ${t.currentStreakDays} 天)**: **${fmtTokens(t.totalTokens)}** tokens (Cache Hit ${t.cacheHitRate}%)`);
  lines.push(`- **本月 API 等值参考**: **${fmtUsd(history.costSummary.currentMonthCostUsd)}** · **历史累计等值**: **${fmtUsd(history.costSummary.allTimeCostUsd)}**`);
  if (history.costSummary.unpricedTokens > 0) {
    lines.push(`- **未匹配模型单价用量**: ${fmtTokens(history.costSummary.unpricedTokens)} tokens`);
  }
  lines.push('');
  lines.push('### 分模型统计');
  lines.push('| 模型家族 | Turn 数 | 总 Token | API 等值 (USD) |');
  lines.push('| :--- | ---: | ---: | ---: |');
  for (const m of history.models) {
    lines.push(`| ${m.label} | ${m.turnCount} | ${fmtTokens(m.totalTokens)} | ${m.priced ? fmtUsd(m.totalCostUsd) : '未定价'} |`);
  }
  lines.push('');
  lines.push(`- **Sidecar 侧边栏状态**: ${sidecarEnabled ? '已启用 (`context-lens/dashboard`)' : '未启用（可在插件管理页开启 Sidecar）'}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const geminiRoot = path.join(os.homedir(), '.gemini');
  const session = inspectSession(args.conversation);
  const history = collectHistory({ surface: args.surface });
  const sidecarEnabled = isSidecarEnabled(geminiRoot);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          sidecarEnabled,
          session,
          history,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write(formatMarkdown(session, history, sidecarEnabled) + '\n');
  }
}

main();
