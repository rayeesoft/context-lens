(() => {
  'use strict';

  const POLL_MS = 3500;
  const $ = (id) => document.getElementById(id);

  const CAT_COLORS = {
    system: '#6366f1',
    user: '#0ea5e9',
    reply: '#10b981',
    thinking: '#f59e0b',
    tools: '#14b8a6',
    media: '#ec4899',
  };

  const I18N = {
    zh: {
      'header.readOnlyBadge': '只读 · 官方日志',
      'header.live': 'Live',
      'header.refreshTitle': '立即刷新',
      'tabs.session': '当前会话',
      'tabs.history': '历史热力图',
      'tabs.cost': '账单与订阅',
      'session.selectSession': '会话',
      'session.budget': '参考上限',
      'session.emptyTitle': '暂无可读取的会话日志',
      'session.emptySub': '等待会话写入 transcript.jsonl 后将自动展示。',
      'session.occupied': '上下文',
      'session.kpiContext': '当前上下文',
      'session.kpiCache': '缓存命中率',
      'session.kpiSpeed': '生成速度中位数',
      'session.kpiCost': '本会话累计 / 估算',
      'session.diagnostics': '异常诊断记录',
      'session.composition': '上下文构成拆解',
      'session.trajectory': '上下文演进曲线',
      'session.turns': '最近模型调用明细',
      'history.surfAll': '全部',
      'history.palette': '配色',
      'history.totalTokens': '累计总 Token',
      'history.activeStreak': '活跃天数 / 连续',
      'history.sessions': '总会话数',
      'history.peakDay': '单日最高',
      'history.heatmapTitle': '52 周 Token 活跃热力图',
      'history.less': '少',
      'history.more': '多',
      'history.last14': '近 14 天用量',
      'history.monthly': '月度趋势与累计曲线',
      'cost.fxRate': '汇率',
      'cost.plan': '订阅套餐',
      'cost.customPlan': '自定义月费',
      'cost.customAmount': '月费($)',
      'cost.unpricedFallback': '未归属模型按',
      'cost.keepUnpriced': '不计价单列',
      'cost.monthApiEq': '本月 API 等值参考',
      'cost.planCost': '参考订阅成本',
      'cost.allTimeApiEq': '历史累计 API 等值',
      'cost.disclaimer': '注：API 等值金额按公开参考费率与本地落盘 Token 计算，仅用于订阅性价比对比，非实际账单。',
      'cost.modelTable': '分模型 Token 与费用估算',
      'cost.topSessions': '高消耗会话排行',
      'cost.colModel': '模型',
      'cost.colTurns': '调用数',
      'cost.colInput': 'Input',
      'cost.colCache': 'Cache Read',
      'cost.colOutput': 'Output',
      'cost.colCost': '参考金额',
      'cost.colSession': '会话',
      'cost.colPeak': '峰值上下文',
      'cost.colTotalTok': '总 Token',
      catNames: {
        system: '系统提示 / 工具定义',
        user: '用户输入与上下文',
        reply: '模型回复',
        thinking: '思考推理 (Thinking)',
        tools: '工具调用与返回',
        media: '媒体附件',
      },
      currentSessionTag: '[当前会话] ',
      subagentTag: '[子智能体] ',
      compactions: (n) => (n > 0 ? `已触发 ${n} 次压缩` : '未触发压缩'),
      itemsChars: (items, chars) => `${items} 项 · ${chars.toLocaleString()} 字符`,
      stepsCount: (n) => `共 ${n} 轮模型调用`,
      recentTurnsCount: (shown, total) => `显示最近 ${shown} / ${total} 次`,
      streakText: (n) => `当前连续 ${n} 天`,
      daysUnit: (n) => `${n} 天`,
      sessionsSplit: (m, s) => `主会话 ${m} · 子智能体 ${s}`,
      cacheHitSub: (pct) => `全局缓存命中 ${pct}%`,
      unpricedText: '未定价',
      dayInspect: (d, money) =>
        `${d.date} · 总计 ${fmtTokens(d.totalTokens)} (In ${fmtTokens(d.inputTokens)} / Cache ${fmtTokens(d.cacheReadTokens)} / Out ${fmtTokens(d.outputTokens)}) · ${d.sessionCount} 会话 · ${money}`,
      noActivityHint: '点击或悬停任意方格查看当天明细',
      monthNote: (m) => `统计月份 ${m}`,
      unpricedNote: (tok) => (tok > 0 ? `另有 ${fmtTokens(tok)} 未匹配模型单价` : '全部流量已匹配费率'),
      roiFree: '免费版 · 纯参考额度',
      roiMultiple: (x) => `本月用出订阅价的 ${x.toFixed(2)}x`,
      simTag: ' (模拟)',
      compactedTag: '压缩后',
      noData: '暂无数据',
    },
    en: {
      'header.readOnlyBadge': 'Read-Only · Local Logs',
      'header.live': 'Live',
      'header.refreshTitle': 'Refresh now',
      'tabs.session': 'Session',
      'tabs.history': 'History',
      'tabs.cost': 'Cost & Plan',
      'session.selectSession': 'Session',
      'session.budget': 'Budget',
      'session.emptyTitle': 'No readable session transcripts found',
      'session.emptySub': 'Data appears automatically once transcript.jsonl is written.',
      'session.occupied': 'Context',
      'session.kpiContext': 'Current Context',
      'session.kpiCache': 'Cache Hit Rate',
      'session.kpiSpeed': 'Median Speed',
      'session.kpiCost': 'Session Total / Est.',
      'session.diagnostics': 'Diagnostics',
      'session.composition': 'Context Composition',
      'session.trajectory': 'Context Trajectory',
      'session.turns': 'Recent Model Turns',
      'history.surfAll': 'All',
      'history.palette': 'Palette',
      'history.totalTokens': 'Total Tokens',
      'history.activeStreak': 'Active Days / Streak',
      'history.sessions': 'Total Sessions',
      'history.peakDay': 'Peak Day',
      'history.heatmapTitle': '52-Week Token Activity Heatmap',
      'history.less': 'Less',
      'history.more': 'More',
      'history.last14': 'Last 14 Days',
      'history.monthly': 'Monthly & Cumulative',
      'cost.fxRate': 'FX',
      'cost.plan': 'Plan',
      'cost.customPlan': 'Custom',
      'cost.customAmount': 'Monthly($)',
      'cost.unpricedFallback': 'Unpriced as',
      'cost.keepUnpriced': 'Keep unpriced',
      'cost.monthApiEq': 'This Month API Eq.',
      'cost.planCost': 'Plan Reference',
      'cost.allTimeApiEq': 'All-Time API Eq.',
      'cost.disclaimer': 'Note: API equivalent costs use public reference list rates on local logs for comparison only, not official billing.',
      'cost.modelTable': 'Usage & Cost by Model',
      'cost.topSessions': 'Top Sessions by Tokens',
      'cost.colModel': 'Model',
      'cost.colTurns': 'Turns',
      'cost.colInput': 'Input',
      'cost.colCache': 'Cache Read',
      'cost.colOutput': 'Output',
      'cost.colCost': 'Est. Cost',
      'cost.colSession': 'Session',
      'cost.colPeak': 'Peak Context',
      'cost.colTotalTok': 'Total Tokens',
      catNames: {
        system: 'System, Skills & Tool Schemas',
        user: 'User Prompts & Context',
        reply: 'Assistant Replies',
        thinking: 'Model Thinking',
        tools: 'Tool Calls & Results',
        media: 'Attached Media',
      },
      currentSessionTag: '[Current] ',
      subagentTag: '[Subagent] ',
      compactions: (n) => (n > 0 ? `${n} compaction(s)` : 'No compaction'),
      itemsChars: (items, chars) => `${items} items · ${chars.toLocaleString()} chars`,
      stepsCount: (n) => `${n} planner turns`,
      recentTurnsCount: (shown, total) => `Latest ${shown} of ${total}`,
      streakText: (n) => `${n}-day streak`,
      daysUnit: (n) => `${n} d`,
      sessionsSplit: (m, s) => `${m} main · ${s} subagents`,
      cacheHitSub: (pct) => `Global cache hit ${pct}%`,
      unpricedText: 'Unpriced',
      dayInspect: (d, money) =>
        `${d.date} · ${fmtTokens(d.totalTokens)} total (In ${fmtTokens(d.inputTokens)} / Cache ${fmtTokens(d.cacheReadTokens)} / Out ${fmtTokens(d.outputTokens)}) · ${d.sessionCount} sessions · ${money}`,
      noActivityHint: 'Hover or click any square to inspect daily tokens',
      monthNote: (m) => `Month ${m}`,
      unpricedNote: (tok) => (tok > 0 ? `${fmtTokens(tok)} unpriced tokens` : 'All tokens matched to rates'),
      roiFree: 'Free tier reference',
      roiMultiple: (x) => `${x.toFixed(2)}x monthly plan value`,
      simTag: ' (sim)',
      compactedTag: 'compacted',
      noData: 'No data',
    },
  };

  const state = {
    lang: localStorage.getItem('cl-lang') === 'en' ? 'en' : 'zh',
    palette: localStorage.getItem('cl-palette') || 'emerald',
    currency: localStorage.getItem('cl-currency') === 'CNY' ? 'CNY' : 'USD',
    fxRate: Number(localStorage.getItem('cl-fx') || '7.25') || 7.25,
    planValue: localStorage.getItem('cl-plan') || '19.99',
    customPlanUsd: Number(localStorage.getItem('cl-custom-plan') || '20') || 20,
    fallbackModel: localStorage.getItem('cl-fallback-model') || 'none',
    budget: Number(localStorage.getItem('cl-budget') || '1000000') || 1000000,
    surface: 'all',
    selectedConvId: '',
    activeTab: 'session',
    sessionData: null,
    sessionEtag: '',
    historyData: null,
    historyEtag: '',
    selectedHeatmapDate: null,
    pollTimer: null,
  };

  const params = new URLSearchParams(window.location.search);
  const hostConvId = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  function t(key, ...args) {
    const dict = I18N[state.lang] || I18N.zh;
    const val = dict[key];
    if (typeof val === 'function') return val(...args);
    return val ?? key;
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function fmtTokens(n) {
    const v = Number(n || 0);
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function fmtMoney(usd) {
    const n = Number(usd || 0);
    if (state.currency === 'CNY') {
      return `¥${(n * state.fxRate).toFixed(2)}`;
    }
    return `$${n.toFixed(2)}`;
  }

  async function apiGet(path) {
    const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : window.fetch.bind(window);
    const res = await fetcher(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  // ---------- Theme Sync (from host --background CSS var or prefers-color-scheme) ----------
  function syncThemeFromHost() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, transparent)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();

    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3 && !(nums.length >= 4 && nums[3] === 0)) {
      const scale = computed.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
    } else {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    }
  }

  syncThemeFromHost();
  new MutationObserver(syncThemeFromHost).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeFromHost);

  document.documentElement.dataset.palette = state.palette;

  // ---------- Accessible Tabs (selection follows focus + beforematch for hidden="until-found") ----------
  const tabButtons = [...document.querySelectorAll('[role="tab"]')];
  const tabPanels = [...document.querySelectorAll('[role="tabpanel"]')];

  function selectTab(tabName, { focusTab = false } = {}) {
    state.activeTab = tabName;
    for (const btn of tabButtons) {
      const active = btn.dataset.tab === tabName;
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
      if (active) {
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (focusTab) btn.focus();
      }
    }
    for (const panel of tabPanels) {
      const active = panel.id === `panel-${tabName}`;
      if (active) {
        panel.removeAttribute('hidden');
        panel.tabIndex = 0;
      } else {
        panel.setAttribute('hidden', 'until-found');
        panel.removeAttribute('tabindex');
      }
    }
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  }

  const tablistEl = document.querySelector('[role="tablist"]');
  tablistEl.addEventListener('keydown', (e) => {
    const idx = tabButtons.indexOf(document.activeElement);
    if (idx === -1) return;
    let nextIdx = -1;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabButtons.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabButtons.length) % tabButtons.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = tabButtons.length - 1;
    if (nextIdx !== -1) {
      e.preventDefault();
      selectTab(tabButtons[nextIdx].dataset.tab, { focusTab: true });
    }
  });

  for (const panel of tabPanels) {
    panel.addEventListener('beforematch', () => {
      const tabName = panel.id.replace('panel-', '');
      selectTab(tabName);
    });
  }

  // ---------- Localization ----------
  function applyTranslations() {
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      el.title = t(el.dataset.i18nTitle);
    }
    $('lang-toggle').textContent = state.lang === 'zh' ? '简 / EN' : 'EN / 简';

    const modelTbl = $('model-cost-table');
    modelTbl.style.setProperty('--label-2', JSON.stringify(t('cost.colTurns')));
    modelTbl.style.setProperty('--label-3', JSON.stringify(t('cost.colInput')));
    modelTbl.style.setProperty('--label-4', JSON.stringify(t('cost.colCache')));
    modelTbl.style.setProperty('--label-5', JSON.stringify(t('cost.colOutput')));
    modelTbl.style.setProperty('--label-6', JSON.stringify(t('cost.colCost')));

    const sessTbl = $('top-sessions-table');
    sessTbl.style.setProperty('--label-2', JSON.stringify(t('cost.colModel')));
    sessTbl.style.setProperty('--label-3', JSON.stringify(t('cost.colPeak')));
    sessTbl.style.setProperty('--label-4', JSON.stringify(t('cost.colTotalTok')));
    sessTbl.style.setProperty('--label-5', JSON.stringify(t('cost.colCost')));
  }

  // ---------- Session Rendering ----------
  function renderSession(data) {
    if (!data || !data.found || !data.summary) {
      $('session-empty').classList.remove('hidden');
      $('session-body').classList.add('hidden');
      return;
    }

    $('session-empty').classList.add('hidden');
    $('session-body').classList.remove('hidden');

    // Populate session selector
    const sel = $('session-select');
    const currentHost = hostConvId();
    const list = data.recentSessions || [];
    sel.innerHTML = '';
    for (const item of list) {
      const opt = document.createElement('option');
      opt.value = item.conversationId;
      const prefix =
        item.conversationId === currentHost
          ? t('currentSessionTag')
          : item.isSubagent
            ? t('subagentTag')
            : '';
      opt.textContent = `${prefix}${item.title} (${fmtTokens(item.contextTokens)})`;
      if (item.conversationId === data.conversationId) opt.selected = true;
      sel.appendChild(opt);
    }

    const s = data.summary;
    $('session-title').textContent = data.title || data.conversationId;
    $('session-model-badge').textContent = data.modelLabel || 'Auto';
    $('session-subtitle').textContent = `${data.surfaceLabel || data.surface} · ${t('stepsCount', s.turnCount)} · ${data.conversationId.slice(0, 8)}`;

    // Gauge
    const pctRaw = state.budget > 0 ? (s.contextTokens / state.budget) * 100 : 0;
    const pctClamped = Math.min(100, Math.max(0, pctRaw));
    const circumference = 2 * Math.PI * 48; // ~301.59
    const dash = (pctClamped / 100) * circumference;
    const arc = $('gauge-arc');
    arc.setAttribute('stroke-dasharray', `${dash.toFixed(1)} ${circumference.toFixed(1)}`);
    arc.style.stroke =
      pctRaw >= 85 ? 'var(--cl-danger)' : pctRaw >= 65 ? 'var(--cl-warning)' : 'var(--cl-primary)';
    $('gauge-pct').textContent = `${pctRaw.toFixed(1)}%`;

    $('kpi-context').textContent = `${fmtTokens(s.contextTokens)} / ${fmtTokens(state.budget)}`;
    $('kpi-cache').textContent = `${s.cacheHitRate}%`;
    $('kpi-speed').textContent = s.medianTokensPerSec !== null ? `${s.medianTokensPerSec} tok/s` : '—';
    $('kpi-session-cost').textContent = `${fmtTokens(s.totalTokens)} · ${s.priced ? fmtMoney(s.totalCostUsd) : t('unpricedText')}`;

    // Diagnostics
    const diagCard = $('diagnostics-card');
    const diagList = $('diagnostics-list');
    if (Array.isArray(data.diagnostics) && data.diagnostics.length > 0) {
      diagCard.classList.remove('hidden');
      diagList.innerHTML = data.diagnostics
        .slice(-5)
        .reverse()
        .map(
          (d) =>
            `<li class="diag-item"><strong>#${d.stepIndex} ${esc(d.title)}</strong>: ${esc(d.message)}</li>`
        )
        .join('');
    } else {
      diagCard.classList.add('hidden');
      diagList.innerHTML = '';
    }

    // Composition
    $('compaction-badge').textContent = t('compactions', s.compactionCount);
    const barEl = $('composition-bar');
    const compListEl = $('composition-list');
    const catNames = t('catNames');

    barEl.innerHTML = data.categories
      .filter((c) => c.sharePct > 0)
      .map(
        (c) =>
          `<span class="stacked-seg" style="width:${Math.max(1, c.sharePct)}%;background:${CAT_COLORS[c.key] || '#94a3b8'}" title="${esc(catNames[c.key] || c.label)}: ${c.sharePct}%"></span>`
      )
      .join('');

    compListEl.innerHTML = data.categories
      .map(
        (c) => `
      <li class="comp-row">
        <span class="comp-swatch" style="background:${CAT_COLORS[c.key] || '#94a3b8'}"></span>
        <span class="comp-name">${esc(catNames[c.key] || c.label)}</span>
        <span class="comp-meta">${esc(t('itemsChars', c.itemCount, c.charCount))}</span>
        <span class="comp-val">${fmtTokens(c.scaledTokens)} (${c.sharePct}%)</span>
      </li>`
      )
      .join('');

    // Trajectory SVG
    renderTrajectoryChart(data.turns || []);

    // Recent turns
    const turns = data.turns || [];
    const shownTurns = turns.slice(-25).reverse();
    $('turns-count-label').textContent = t('recentTurnsCount', shownTurns.length, turns.length);
    $('turns-list').innerHTML = shownTurns
      .map(
        (turn) => `
      <div class="turn-row">
        <span class="turn-step">#${turn.stepIndex}</span>
        <div class="turn-main">
          <span>${esc(turn.modelLabel)}</span>
          ${turn.compacted ? `<span class="turn-compact">${esc(t('compactedTag'))}</span>` : ''}
          <span class="muted-line">${fmtTokens(turn.contextTokens)} ctx · +${fmtTokens(turn.outputTokens)} out</span>
        </div>
        <span class="turn-right">${turn.outputTokensPerSec ? `${turn.outputTokensPerSec} t/s` : turn.durationSec ? `${turn.durationSec}s` : '—'}</span>
      </div>`
      )
      .join('');
  }

  function renderTrajectoryChart(turns) {
    const box = $('trajectory-chart');
    if (!turns.length) {
      $('trajectory-meta').textContent = '';
      box.innerHTML = `<p class="muted-line">${esc(t('noData'))}</p>`;
      return;
    }

    const peak = Math.max(...turns.map((x) => x.contextTokens), 1);
    const maxY = Math.max(peak, state.budget * 0.25);
    $('trajectory-meta').textContent = `Peak ${fmtTokens(peak)}`;

    const w = 640;
    const h = 132;
    const padL = 44;
    const padR = 12;
    const padT = 12;
    const padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const pts = turns.map((turn, idx) => {
      const x = turns.length === 1 ? padL + plotW / 2 : padL + (idx / (turns.length - 1)) * plotW;
      const y = padT + plotH - (turn.contextTokens / maxY) * plotH;
      return { x, y, turn };
    });

    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

    const budgetLineY = state.budget <= maxY ? padT + plotH - (state.budget / maxY) * plotH : null;

    box.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Context trajectory">
        <defs>
          <linearGradient id="cl-traj-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--cl-primary)" stop-opacity="0.28" />
            <stop offset="100%" stop-color="var(--cl-primary)" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--cl-border)" />
        <line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="var(--cl-border)" />
        <text x="${padL - 5}" y="${padT + 8}" text-anchor="end" font-size="10" fill="var(--cl-fg-muted)">${fmtTokens(maxY)}</text>
        <text x="${padL - 5}" y="${padT + plotH}" text-anchor="end" font-size="10" fill="var(--cl-fg-muted)">0</text>
        ${budgetLineY !== null ? `<line x1="${padL}" y1="${budgetLineY.toFixed(1)}" x2="${w - padR}" y2="${budgetLineY.toFixed(1)}" stroke="var(--cl-warning)" stroke-dasharray="4 3" stroke-width="1" />` : ''}
        <path d="${areaPath}" fill="url(#cl-traj-grad)" />
        <path d="${linePath}" fill="none" stroke="var(--cl-primary)" stroke-width="2" stroke-linejoin="round" />
        ${pts
          .map((p) => {
            const color = p.turn.compacted ? 'var(--cl-warning)' : 'var(--cl-primary)';
            const r = p.turn.compacted ? 4 : 2.5;
            return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${color}"><title>#${p.turn.stepIndex}: ${fmtTokens(p.turn.contextTokens)} ctx</title></circle>`;
          })
          .join('')}
      </svg>`;
  }

  // ---------- History Rendering ----------
  function renderHistory(data) {
    if (!data || !data.totals) return;
    const tot = data.totals;
    $('hist-total-tokens').textContent = fmtTokens(tot.totalTokens);
    $('hist-token-split').textContent = `In ${fmtTokens(tot.inputTokens)} · Cache ${fmtTokens(tot.cacheReadTokens)} · Out ${fmtTokens(tot.outputTokens)}`;
    $('hist-active-days').textContent = t('daysUnit', tot.activeDays);
    $('hist-streak').textContent = t('streakText', tot.currentStreakDays);
    $('hist-sessions').textContent = String(tot.sessionCount);
    $('hist-sessions-split').textContent = t('sessionsSplit', tot.mainSessionCount, tot.subagentCount);
    $('hist-peak-day').textContent = fmtTokens(tot.maxDailyTokens);
    $('hist-cache-rate').textContent = t('cacheHitSub', tot.cacheHitRate);

    renderHeatmap(data.heatmap || []);
    render14DayChart(data.last14Days || []);
    renderMonthlyChart(data.monthlySeries || []);
  }

  function renderHeatmap(days) {
    const grid = $('heatmap-grid');
    const monthsEl = $('heatmap-months');
    const inspector = $('heatmap-inspector');

    grid.innerHTML = '';
    monthsEl.innerHTML = '';
    if (!days.length) return;

    const leadingBlanks = days[0].weekday || 0;
    for (let i = 0; i < leadingBlanks; i++) {
      const spacer = document.createElement('span');
      spacer.className = 'hm-cell';
      spacer.style.visibility = 'hidden';
      spacer.setAttribute('aria-hidden', 'true');
      grid.appendChild(spacer);
    }

    let lastMonth = '';
    const monthLabelsByCol = new Map();
    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    days.forEach((day, idx) => {
      const slotIndex = leadingBlanks + idx;
      const col = Math.floor(slotIndex / 7);
      const monthStr = day.date.slice(0, 7);
      if (monthStr !== lastMonth && day.weekday <= 2) {
        const mNum = Number(day.date.slice(5, 7)) - 1;
        monthLabelsByCol.set(col, MONTH_NAMES[mNum] || monthStr);
        lastMonth = monthStr;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `hm-cell hm-l${day.level}`;
      if (state.selectedHeatmapDate === day.date) btn.classList.add('selected');
      btn.title = `${day.date}: ${fmtTokens(day.totalTokens)}`;
      btn.setAttribute('aria-label', `${day.date}: ${day.totalTokens} tokens`);

      const inspect = () => {
        state.selectedHeatmapDate = day.date;
        for (const el of grid.querySelectorAll('.selected')) el.classList.remove('selected');
        btn.classList.add('selected');
        inspector.textContent = t('dayInspect', day, fmtMoney(day.costUsd));
      };
      btn.addEventListener('mouseenter', inspect);
      btn.addEventListener('click', inspect);
      grid.appendChild(btn);
    });

    const totalCols = Math.ceil((leadingBlanks + days.length) / 7);
    monthsEl.style.gridTemplateColumns = `repeat(${totalCols}, 11px)`;
    for (let c = 0; c < totalCols; c++) {
      const span = document.createElement('span');
      span.className = 'heatmap-month-label';
      span.textContent = monthLabelsByCol.get(c) || '';
      monthsEl.appendChild(span);
    }

    const activeDay =
      (state.selectedHeatmapDate && days.find((d) => d.date === state.selectedHeatmapDate)) ||
      [...days].reverse().find((d) => d.totalTokens > 0);
    if (activeDay) {
      inspector.textContent = t('dayInspect', activeDay, fmtMoney(activeDay.costUsd));
    } else {
      inspector.textContent = t('noActivityHint');
    }
  }

  function render14DayChart(days) {
    const box = $('chart-14d');
    if (!days.length) {
      box.innerHTML = `<p class="muted-line">${esc(t('noData'))}</p>`;
      return;
    }
    const maxTok = Math.max(...days.map((d) => d.totalTokens), 1);
    const w = 360;
    const h = 135;
    const padL = 38;
    const padB = 20;
    const padT = 10;
    const plotW = w - padL - 8;
    const plotH = h - padT - padB;
    const step = plotW / days.length;
    const barW = Math.max(6, step * 0.62);

    const bars = days
      .map((d, idx) => {
        const bh = (d.totalTokens / maxTok) * plotH;
        const x = padL + idx * step + (step - barW) / 2;
        const y = padT + plotH - bh;
        const showLabel = idx === 0 || idx === 6 || idx === days.length - 1;
        return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, bh).toFixed(1)}" rx="2.5" fill="var(--cl-primary)">
          <title>${d.date}: ${fmtTokens(d.totalTokens)} (${fmtMoney(d.costUsd)})</title>
        </rect>
        ${showLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle" font-size="9.5" fill="var(--cl-fg-muted)">${d.date.slice(5)}</text>` : ''}`;
      })
      .join('');

    box.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Last 14 days token usage">
        <line x1="${padL}" y1="${padT + plotH}" x2="${w - 8}" y2="${padT + plotH}" stroke="var(--cl-border)" />
        <text x="${padL - 4}" y="${padT + 8}" text-anchor="end" font-size="9.5" fill="var(--cl-fg-muted)">${fmtTokens(maxTok)}</text>
        <text x="${padL - 4}" y="${padT + plotH}" text-anchor="end" font-size="9.5" fill="var(--cl-fg-muted)">0</text>
        ${bars}
      </svg>`;
  }

  function renderMonthlyChart(months) {
    const box = $('chart-monthly');
    if (!months.length) {
      box.innerHTML = `<p class="muted-line">${esc(t('noData'))}</p>`;
      return;
    }
    const maxTok = Math.max(...months.map((m) => m.totalTokens), 1);
    let cum = 0;
    const cumSeries = months.map((m) => {
      cum += m.totalTokens;
      return cum;
    });
    const maxCum = Math.max(cum, 1);

    const w = 360;
    const h = 135;
    const padL = 38;
    const padR = 10;
    const padB = 20;
    const padT = 10;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const step = plotW / months.length;
    const barW = Math.max(6, step * 0.56);

    const bars = months
      .map((m, idx) => {
        const bh = (m.totalTokens / maxTok) * plotH;
        const x = padL + idx * step + (step - barW) / 2;
        const y = padT + plotH - bh;
        const showLbl = idx === 0 || idx === 5 || idx === months.length - 1;
        return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, bh).toFixed(1)}" rx="2" fill="color-mix(in srgb, var(--cl-primary) 55%, transparent)">
          <title>${m.month}: ${fmtTokens(m.totalTokens)} (${fmtMoney(m.costUsd)})</title>
        </rect>
        ${showLbl ? `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle" font-size="9.5" fill="var(--cl-fg-muted)">${m.month.slice(2)}</text>` : ''}`;
      })
      .join('');

    const cumLine = cumSeries
      .map((val, idx) => {
        const x = padL + idx * step + step / 2;
        const y = padT + plotH - (val / maxCum) * plotH;
        return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    box.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Monthly and cumulative tokens">
        <line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="var(--cl-border)" />
        <text x="${padL - 4}" y="${padT + 8}" text-anchor="end" font-size="9.5" fill="var(--cl-fg-muted)">${fmtTokens(maxTok)}</text>
        ${bars}
        <path d="${cumLine}" fill="none" stroke="var(--cl-success)" stroke-width="2" stroke-linejoin="round" />
      </svg>`;
  }

  // ---------- Cost & Subscription Rendering ----------
  function computeFallbackCostUsd(row, rules, fallbackKey) {
    if (row.priced || fallbackKey === 'none' || !rules?.[fallbackKey]) return row.totalCostUsd;
    const r = rules[fallbackKey];
    return (
      (row.inputTokens * r.inputPerM +
        row.cacheReadTokens * r.cacheReadPerM +
        row.outputTokens * r.outputPerM) /
      1_000_000
    );
  }

  function renderCost(data) {
    if (!data || !data.costSummary) return;
    const cs = data.costSummary;
    const rules = cs.pricingRules || {};

    let extraFallbackAllUsd = 0;
    const models = (data.models || []).map((m) => {
      const simCost = computeFallbackCostUsd(m, rules, state.fallbackModel);
      if (!m.priced && state.fallbackModel !== 'none') {
        extraFallbackAllUsd += simCost;
      }
      return { ...m, displayCostUsd: simCost, isSimulated: !m.priced && state.fallbackModel !== 'none' };
    });

    const planUsd = state.planValue === 'custom' ? state.customPlanUsd : Number(state.planValue || 0);
    const monthApiUsd = cs.currentMonthCostUsd;
    const allApiUsd = cs.allTimeCostUsd + extraFallbackAllUsd;

    $('roi-month-api').textContent = fmtMoney(monthApiUsd);
    $('roi-month-note').textContent = t('monthNote', cs.currentMonth);
    $('roi-plan-cost').textContent = fmtMoney(planUsd);
    $('roi-all-api').textContent = fmtMoney(allApiUsd);
    $('roi-unpriced-note').textContent = t(
      'unpricedNote',
      state.fallbackModel === 'none' ? cs.unpricedTokens : 0
    );

    const badge = $('roi-multiplier');
    const barFill = $('roi-bar-fill');
    if (planUsd <= 0) {
      badge.textContent = t('roiFree');
      barFill.style.width = monthApiUsd > 0 ? '100%' : '0%';
    } else {
      const mult = monthApiUsd / planUsd;
      badge.textContent = t('roiMultiple', mult);
      barFill.style.width = `${Math.min(100, mult * 100).toFixed(1)}%`;
    }

    $('model-cost-tbody').innerHTML = models
      .map(
        (m) => `
      <tr>
        <th scope="row">${esc(m.label)}</th>
        <td class="num">${m.turnCount.toLocaleString()}</td>
        <td class="num">${fmtTokens(m.inputTokens)}</td>
        <td class="num">${fmtTokens(m.cacheReadTokens)}</td>
        <td class="num">${fmtTokens(m.outputTokens)}</td>
        <td class="num">${m.priced || m.isSimulated ? `${fmtMoney(m.displayCostUsd)}${m.isSimulated ? t('simTag') : ''}` : esc(t('unpricedText'))}</td>
      </tr>`
      )
      .join('');

    const canJump = typeof window.sidecar?.ui?.toggleConversation === 'function';
    $('top-sessions-tbody').innerHTML = (data.topSessions || [])
      .map((s) => {
        const titleHtml = canJump
          ? `<button type="button" class="session-jump-btn" data-conv="${esc(s.conversationId)}">${esc(s.title)}</button>`
          : esc(s.title);
        return `
        <tr>
          <th scope="row" title="${esc(s.title)}">${titleHtml}</th>
          <td>${esc(s.modelLabel)}</td>
          <td class="num">${fmtTokens(s.contextPeakTokens)}</td>
          <td class="num">${fmtTokens(s.totalTokens)}</td>
          <td class="num">${fmtMoney(s.costUsd)}</td>
        </tr>`;
      })
      .join('');
  }

  // ---------- Polling & Event Wiring ----------
  async function refreshSession(force = false) {
    const convId = state.selectedConvId || hostConvId() || '';
    const qs = new URLSearchParams();
    if (convId) qs.set('conversationId', convId);
    if (!force && state.sessionEtag) qs.set('etag', state.sessionEtag);

    const data = await apiGet(`/api/session?${qs.toString()}`);
    if (data && data.unchanged) return;
    if (data && data.etag) state.sessionEtag = data.etag;
    state.sessionData = data;
    renderSession(data);
  }

  async function refreshHistory(force = false) {
    const qs = new URLSearchParams();
    qs.set('surface', state.surface);
    if (!force && state.historyEtag) qs.set('etag', state.historyEtag);

    const data = await apiGet(`/api/history?${qs.toString()}`);
    if (data && data.unchanged) return;
    if (data && data.etag) state.historyEtag = data.etag;
    state.historyData = data;
    renderHistory(data);
    renderCost(data);
  }

  async function refreshAll(force = false) {
    try {
      await Promise.all([refreshSession(force), refreshHistory(force)]);
      $('live-status').style.opacity = '1';
    } catch (err) {
      console.error('[context-lens] refresh error:', err);
      $('live-status').style.opacity = '0.6';
    }
  }

  // Controls listeners
  $('lang-toggle').addEventListener('click', () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('cl-lang', state.lang);
    applyTranslations();
    if (state.sessionData) renderSession(state.sessionData);
    if (state.historyData) {
      renderHistory(state.historyData);
      renderCost(state.historyData);
    }
  });

  $('refresh-btn').addEventListener('click', () => refreshAll(true));

  $('session-select').addEventListener('change', (e) => {
    state.selectedConvId = e.target.value;
    state.sessionEtag = '';
    refreshSession(true);
  });

  $('budget-select').value = String(state.budget);
  $('budget-select').addEventListener('change', (e) => {
    state.budget = Number(e.target.value) || 1000000;
    localStorage.setItem('cl-budget', String(state.budget));
    if (state.sessionData) renderSession(state.sessionData);
  });

  for (const btn of document.querySelectorAll('[data-surface]')) {
    btn.addEventListener('click', () => {
      state.surface = btn.dataset.surface;
      state.historyEtag = '';
      for (const b of document.querySelectorAll('[data-surface]')) {
        b.classList.toggle('active', b === btn);
      }
      refreshHistory(true);
    });
  }

  for (const btn of document.querySelectorAll('[data-palette]')) {
    btn.classList.toggle('active', btn.dataset.palette === state.palette);
    btn.addEventListener('click', () => {
      state.palette = btn.dataset.palette;
      localStorage.setItem('cl-palette', state.palette);
      document.documentElement.dataset.palette = state.palette;
      for (const b of document.querySelectorAll('[data-palette]')) {
        b.classList.toggle('active', b === btn);
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-currency]')) {
    btn.classList.toggle('active', btn.dataset.currency === state.currency);
    btn.addEventListener('click', () => {
      state.currency = btn.dataset.currency;
      localStorage.setItem('cl-currency', state.currency);
      for (const b of document.querySelectorAll('[data-currency]')) {
        b.classList.toggle('active', b === btn);
      }
      if (state.sessionData) renderSession(state.sessionData);
      if (state.historyData) {
        renderHistory(state.historyData);
        renderCost(state.historyData);
      }
    });
  }

  $('fx-input').value = String(state.fxRate);
  $('fx-input').addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (val > 0) {
      state.fxRate = val;
      localStorage.setItem('cl-fx', String(val));
      if (state.sessionData) renderSession(state.sessionData);
      if (state.historyData) renderCost(state.historyData);
    }
  });

  $('plan-select').value = state.planValue;
  const syncPlanCustomVis = () => {
    $('custom-price-wrap').classList.toggle('hidden', state.planValue !== 'custom');
  };
  syncPlanCustomVis();
  $('plan-select').addEventListener('change', (e) => {
    state.planValue = e.target.value;
    localStorage.setItem('cl-plan', state.planValue);
    syncPlanCustomVis();
    if (state.historyData) renderCost(state.historyData);
  });

  $('custom-price-input').value = String(state.customPlanUsd);
  $('custom-price-input').addEventListener('input', (e) => {
    const val = Math.max(0, Number(e.target.value) || 0);
    state.customPlanUsd = val;
    localStorage.setItem('cl-custom-plan', String(val));
    if (state.historyData) renderCost(state.historyData);
  });

  $('fallback-model-select').value = state.fallbackModel;
  $('fallback-model-select').addEventListener('change', (e) => {
    state.fallbackModel = e.target.value;
    localStorage.setItem('cl-fallback-model', state.fallbackModel);
    if (state.historyData) renderCost(state.historyData);
  });

  $('top-sessions-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('.session-jump-btn');
    if (btn && btn.dataset.conv && typeof window.sidecar?.ui?.toggleConversation === 'function') {
      window.sidecar.ui.toggleConversation(btn.dataset.conv);
    }
  });

  // Boot
  applyTranslations();
  refreshAll(true);
  state.pollTimer = setInterval(() => {
    if (!document.hidden) refreshAll(false);
  }, POLL_MS);
})();
