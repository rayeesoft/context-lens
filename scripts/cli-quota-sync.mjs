import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OFFICIAL_CACHE_FILENAME = 'official-quota-cache.json';
const LOCK_FILENAME = 'cli-sync.lock';

const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_ESC_RE = /\x1b[@-Z\\-_]/g;

const PTY_RUNNER_PY = `
import os, sys, pty, select, time, json, signal, fcntl, termios, struct, re

cfg = json.loads(os.environ["CL_SYNC_CFG"])
agy_bin = cfg["agyBin"]
settings_json = cfg["settingsJson"]
log_path = cfg["logPath"]
status_file = cfg["statusFile"]
timeout_sec = float(cfg.get("timeoutSeconds", 14))

master_fd = None
child_pid = None

def read_status_lines():
    if not os.path.exists(status_file):
        return []
    out = []
    try:
        with open(status_file, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                s = line.strip()
                if not s:
                    continue
                try:
                    out.append(json.loads(s))
                except Exception:
                    pass
    except Exception:
        pass
    return out

def read_log_text():
    if not log_path or not os.path.exists(log_path):
        return ""
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""

pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(agy_bin, [agy_bin, "--log-file", log_path, "--settings", settings_json])
    except Exception as e:
        sys.stderr.write(f"EXEC_ERROR:{e}\\n")
        os._exit(127)

master_fd = fd
child_pid = pid
try:
    winsize = struct.pack("HHHH", 36, 120, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
except Exception:
    pass

buf = bytearray()
start = time.time()
deadline = start + timeout_sec
idle_at = None
sent_usage = False
sent_usage_at = None
retried_enter = False
lines_at_usage = 0
had_quota_before_usage = False
abort_reason = None
exit_code = None

def child_exited():
    global exit_code
    try:
        wpid, st = os.waitpid(child_pid, os.WNOHANG)
        if wpid == child_pid:
            if os.WIFEXITED(st):
                exit_code = os.WEXITSTATUS(st)
            else:
                exit_code = -1
            return True
    except ChildProcessError:
        return True
    return False

while time.time() < deadline:
    r, _, _ = select.select([master_fd], [], [], 0.15)
    if r:
        try:
            chunk = os.read(master_fd, 16384)
            if chunk:
                buf.extend(chunk)
        except OSError:
            pass

    log_text = read_log_text()
    if "secret keyring is locked" in log_text:
        abort_reason = "keyring_locked"
        break
    if "Starting OAuth authentication flow" in log_text or "consumerOAuth: starting OAuth flow" in log_text:
        abort_reason = "auth_required"
        break
    if "proxyconnect tcp" in log_text or "socks connect" in log_text:
        abort_reason = "proxy_error"
        break

    lines = read_status_lines()
    last = lines[-1] if lines else None
    has_quota_now = bool(last and isinstance(last.get("quota"), dict))
    is_idle = bool(last and last.get("agent_state") == "idle")

    if is_idle and idle_at is None:
        idle_at = time.time()

    if not sent_usage and (has_quota_now or (is_idle and (time.time() - idle_at) >= 0.35)):
        had_quota_before_usage = has_quota_now
        lines_at_usage = len(lines)
        try:
            os.write(master_fd, b"/usage")
            time.sleep(0.10)
            os.write(master_fd, b"\\r")
            sent_usage = True
            sent_usage_at = time.time()
        except OSError:
            break

    if sent_usage:
        post_lines = lines[lines_at_usage:]
        has_post_quota = any(isinstance(x.get("quota"), dict) for x in post_lines)
        elapsed_usage = time.time() - sent_usage_at
        if not has_post_quota and not retried_enter and elapsed_usage >= 1.8:
            try:
                os.write(master_fd, b"\\r")
                retried_enter = True
            except OSError:
                break
        if has_post_quota and elapsed_usage >= 0.35:
            break
        if had_quota_before_usage and elapsed_usage >= 2.2:
            break
        if not had_quota_before_usage and elapsed_usage >= 5.0:
            break

    if child_exited():
        # Give tiny window for trailing statusLine hook writes
        time.sleep(0.1)
        break

if sent_usage and abort_reason is None:
    try:
        os.write(master_fd, b"\\x1b")
        time.sleep(0.12)
        os.write(master_fd, b"/exit\\r")
    except OSError:
        pass
    grace_end = time.time() + 0.65
    while time.time() < grace_end:
        if child_exited():
            break
        r, _, _ = select.select([master_fd], [], [], 0.08)
        if r:
            try:
                chunk = os.read(master_fd, 8192)
                if not chunk:
                    break
                buf.extend(chunk)
            except OSError:
                break

if exit_code is None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child_pid, sig)
        except Exception:
            try:
                os.kill(child_pid, sig)
            except Exception:
                pass
        end_w = time.time() + 0.35
        reaped = False
        while time.time() < end_w:
            if child_exited():
                reaped = True
                break
            time.sleep(0.05)
        if reaped:
            break

try:
    os.close(master_fd)
except Exception:
    pass

screen_text = buf.decode("utf-8", "replace")
result = {
    "abortReason": abort_reason,
    "sentUsage": sent_usage,
    "exitCode": exit_code,
    "statusLines": read_status_lines(),
    "screenText": screen_text[-16000:],
    "logText": read_log_text()[-12000:],
}
sys.stdout.write(json.dumps(result))
`;

export function normalizeProxyUrl(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'clear' || lower === 'none' || lower === 'off') return null;

  let candidate = trimmed;
  if (/^:\d+$/.test(candidate)) {
    candidate = `http://127.0.0.1${candidate}`;
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`无效代理地址: ${trimmed}`);
  }

  const proto = parsed.protocol.toLowerCase();
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proto)) {
    throw new Error(`不支持的代理协议 (${proto})，请使用 http:// 或 socks5://`);
  }
  if (!parsed.hostname) {
    throw new Error(`代理地址缺少主机名: ${trimmed}`);
  }

  return candidate.replace(/\/+$/, '');
}

export function detectSystemProxyUrl() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 1500,
    });
    const kv = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
      if (m) kv[m[1]] = m[2];
    }
    if (kv.HTTPSEnable === '1' && kv.HTTPSProxy && kv.HTTPSPort) {
      return `http://${kv.HTTPSProxy}:${kv.HTTPSPort}`;
    }
    if (kv.HTTPEnable === '1' && kv.HTTPProxy && kv.HTTPPort) {
      return `http://${kv.HTTPProxy}:${kv.HTTPPort}`;
    }
    if (kv.SOCKSEnable === '1' && kv.SOCKSProxy && kv.SOCKSPort) {
      return `socks5://${kv.SOCKSProxy}:${kv.SOCKSPort}`;
    }
  } catch {}
  return null;
}

export function resolveEffectiveProxyUrl(configProxyUrl, options = {}) {
  const candidates = [
    options.proxyUrl,
    configProxyUrl,
    process.env.CL_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const norm = normalizeProxyUrl(c);
      if (norm) return norm;
    } catch {}
  }
  if (!options.skipSystemProxy) {
    return detectSystemProxyUrl();
  }
  return null;
}

function isExecutableFile(p) {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

export function resolveAgyBinary(options = {}) {
  const pathDirs = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'agy'));

  const candidates = [
    options.agyBin,
    process.env.CL_AGY_BIN,
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    ...pathDirs,
  ].filter(Boolean);

  for (const c of candidates) {
    if (isExecutableFile(c)) return c;
  }
  return null;
}

export function stripAnsi(str) {
  return String(str || '')
    .replace(ANSI_OSC_RE, ' ')
    .replace(ANSI_CSI_RE, ' ')
    .replace(ANSI_ESC_RE, ' ')
    .replace(/\r/g, '\n');
}

function parseRefreshDurationSeconds(text) {
  if (!text) return null;
  let totalSec = 0;
  let matched = false;
  const daysM = text.match(/(\d+)\s*(?:days?|d\b|天)/i);
  const hoursM = text.match(/(\d+)\s*(?:hours?|hrs?|h\b|小时)/i);
  const minsM = text.match(/(\d+)\s*(?:minutes?|mins?|m\b|分钟?)/i);

  if (daysM) {
    totalSec += Number(daysM[1]) * 86400;
    matched = true;
  }
  if (hoursM) {
    totalSec += Number(hoursM[1]) * 3600;
    matched = true;
  }
  if (minsM) {
    totalSec += Number(minsM[1]) * 60;
    matched = true;
  }
  return matched && totalSec > 0 ? totalSec : null;
}

export function parseUsageScreenFallback(screenText, syncedAtMs = Date.now()) {
  const clean = stripAnsi(screenText);
  const lines = clean
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const parsed = { gemini: {}, claude: {} };
  let currentPool = null;
  let pendingWin = null;
  let lastMatchedWin = null;

  for (const line of lines) {
    if (/^models within this group\s*:/i.test(line)) {
      continue;
    }

    if (/^(?:[│└├\s]*)?(?:claude\b.*\bgpt\b|\bclaude\s*(?:and|&)\s*gpt\b)/i.test(line)) {
      currentPool = 'claude';
      pendingWin = null;
      lastMatchedWin = null;
    } else if (/^(?:[│└├\s]*)?gemini\b.*\bmodels?\b/i.test(line)) {
      currentPool = 'gemini';
      pendingWin = null;
      lastMatchedWin = null;
    }

    if (!currentPool) continue;

    const isWeekly = /\bweekly\b|7[\s-]*day|\b7d\b|每周/i.test(line);
    const is5h = /five[\s-]*hour|5[\s-]*hour|\b5h\b|5\s*小时/i.test(line);
    if (isWeekly) {
      pendingWin = '7d';
      lastMatchedWin = null;
    } else if (is5h) {
      pendingWin = '5h';
      lastMatchedWin = null;
    }

    const pctMatch = line.match(/(?<![\d.])(100(?:\.0+)?|\d{1,2}(?:\.\d+)?)\s*%/);
    const winKey = isWeekly ? '7d' : is5h ? '5h' : pendingWin;
    if (winKey && pctMatch) {
      const rawPct = Math.max(0, Math.min(100, Number(pctMatch[1])));
      const pct = Math.round(rawPct);
      const frac = +(rawPct / 100).toFixed(4);
      const resetSec = parseRefreshDurationSeconds(line);
      parsed[currentPool][winKey] = {
        remainingPct: pct,
        remainingFraction: frac,
        resetAtMs: resetSec ? syncedAtMs + resetSec * 1000 : null,
        bucketId: `usage_tui_${currentPool}_${winKey}`,
      };
      lastMatchedWin = winKey;
      pendingWin = null;
    } else if (lastMatchedWin && parsed[currentPool][lastMatchedWin] && !parsed[currentPool][lastMatchedWin].resetAtMs) {
      const resetSec = parseRefreshDurationSeconds(line);
      if (resetSec) {
        parsed[currentPool][lastMatchedWin].resetAtMs = syncedAtMs + resetSec * 1000;
        lastMatchedWin = null;
      }
    }
  }

  return parsed;
}

function classifyBucketPool(bucketId) {
  const id = String(bucketId || '').toLowerCase();
  if (/^(?:3p|third[-_]?party)(?:[-_]|$)|[-_]3p(?:[-_]|$)|claude|opus|sonnet|haiku|gpt|anthropic|openai|external|partner|non[-_]?google/.test(id)) {
    return { poolKey: 'claude', isFlashSpecific: false, known: true };
  }
  if (/^(?:1p|first[-_]?party)(?:[-_]|$)|[-_]1p(?:[-_]|$)|gemini|google|carbon|argon|hydrogen|default/.test(id)) {
    return { poolKey: 'gemini', isFlashSpecific: id.includes('flash') && !id.includes('pro'), known: true };
  }
  return { poolKey: null, isFlashSpecific: id.includes('flash'), known: false };
}

function classifyBucketWindow(bucketId, entry, syncedAtMs) {
  const id = String(bucketId || '').toLowerCase();
  let resetAtMs = null;
  if (entry?.reset_time) {
    const t = Date.parse(entry.reset_time);
    if (Number.isFinite(t) && t > 0) resetAtMs = t;
  }
  const hasResetSec =
    entry?.reset_in_seconds !== undefined &&
    entry?.reset_in_seconds !== null &&
    Number.isFinite(Number(entry.reset_in_seconds));
  const resetSec = hasResetSec
    ? Math.max(0, Number(entry.reset_in_seconds))
    : resetAtMs
      ? Math.max(0, Math.round((resetAtMs - syncedAtMs) / 1000))
      : null;

  if (resetAtMs === null && resetSec !== null && resetSec > 0) {
    resetAtMs = syncedAtMs + resetSec * 1000;
  }

  let winKey;
  if (/week|7d|7[-_]?day|seven/.test(id)) {
    winKey = '7d';
  } else if (/5h|5[-_]?hour|five[-_]?hour|hourly|5hr|burst|short|rolling/.test(id)) {
    winKey = '5h';
  } else if (resetSec !== null && resetSec > 18300) {
    winKey = '7d';
  } else {
    winKey = '5h';
  }

  return { winKey, resetAtMs, resetSec };
}

function extractBucketRemaining(entry, resetSec, resetAtMs) {
  if (typeof entry?.remaining_fraction === 'number' && Number.isFinite(entry.remaining_fraction)) {
    const frac = Math.max(0, Math.min(1, entry.remaining_fraction));
    return {
      remainingFraction: +frac.toFixed(4),
      remainingPct: Math.max(0, Math.min(100, Math.round(frac * 100))),
    };
  }
  if (
    entry?.remaining_fraction === undefined &&
    entry?.remaining_amount === undefined &&
    ((resetSec !== null && resetSec > 0) || resetAtMs !== null)
  ) {
    // Go JSON omitempty omits float64(0) for exhausted buckets while reset_time is populated
    return { remainingFraction: 0, remainingPct: 0 };
  }
  return { remainingFraction: 1, remainingPct: 100 };
}

export function parseOfficialCliQuota({ statusLines = [], screenText = '', syncedAtMs = Date.now() }) {
  let latestQuotaPayload = null;
  let planTierRaw = null;
  let agentState = null;

  for (let i = statusLines.length - 1; i >= 0; i--) {
    const item = statusLines[i];
    if (!item || typeof item !== 'object') continue;
    if (!agentState && typeof item.agent_state === 'string') {
      agentState = item.agent_state;
    }
    if (!planTierRaw && typeof item.plan_tier === 'string' && item.plan_tier) {
      planTierRaw = item.plan_tier;
    }
    if (!latestQuotaPayload && item.quota && typeof item.quota === 'object' && !Array.isArray(item.quota)) {
      latestQuotaPayload = item;
    }
    if (latestQuotaPayload && planTierRaw && agentState) break;
  }

  const pools = {
    gemini: { '5h': null, '7d': null },
    claude: { '5h': null, '7d': null },
  };
  const flashFallback = { '5h': null, '7d': null };
  const unknownFallback = { '5h': null, '7d': null };
  let hasQuotaPayload = false;

  if (latestQuotaPayload?.quota) {
    hasQuotaPayload = true;
    for (const [bucketId, entry] of Object.entries(latestQuotaPayload.quota)) {
      if (!entry || typeof entry !== 'object' || entry.disabled === true) continue;
      const { poolKey, isFlashSpecific } = classifyBucketPool(bucketId);
      const { winKey, resetAtMs, resetSec } = classifyBucketWindow(bucketId, entry, syncedAtMs);
      const { remainingFraction, remainingPct } = extractBucketRemaining(entry, resetSec, resetAtMs);
      const record = {
        remainingPct,
        remainingFraction,
        resetAtMs,
        bucketId,
      };

      if (!poolKey) {
        if (!unknownFallback[winKey] || remainingPct < unknownFallback[winKey].remainingPct) {
          unknownFallback[winKey] = record;
        }
      } else if (poolKey === 'gemini' && isFlashSpecific) {
        if (!flashFallback[winKey]) flashFallback[winKey] = record;
      } else {
        const existing = pools[poolKey][winKey];
        if (!existing || remainingPct < existing.remainingPct) {
          pools[poolKey][winKey] = record;
        }
      }
    }
    for (const winKey of ['5h', '7d']) {
      if (!pools.gemini[winKey] && flashFallback[winKey]) {
        pools.gemini[winKey] = flashFallback[winKey];
      }
      if (!pools.gemini[winKey] && unknownFallback[winKey]) {
        pools.gemini[winKey] = unknownFallback[winKey];
      }
    }
  }

  // Fill any missing windows from /usage TUI screen text fallback
  const screenParsed = parseUsageScreenFallback(screenText, syncedAtMs);
  let hasScreenParsed = false;
  for (const poolKey of ['gemini', 'claude']) {
    for (const winKey of ['5h', '7d']) {
      if (!pools[poolKey][winKey] && screenParsed[poolKey][winKey]) {
        pools[poolKey][winKey] = screenParsed[poolKey][winKey];
        hasScreenParsed = true;
      }
    }
  }

  // Check plan tier hint from TUI screen text if not in statusLine payload
  if (!planTierRaw && screenText) {
    const clean = stripAnsi(screenText);
    const m = clean.match(/Google AI (Ultra|Pro|Plus)/i);
    if (m) planTierRaw = m[1];
  }

  const valid = hasQuotaPayload || hasScreenParsed;
  if (!valid) {
    return {
      valid: false,
      planTierRaw,
      agentState,
      pools: null,
    };
  }

  // Unpopulated unused window inside an authenticated quota response defaults to 100%
  for (const poolKey of ['gemini', 'claude']) {
    for (const winKey of ['5h', '7d']) {
      if (!pools[poolKey][winKey]) {
        pools[poolKey][winKey] = {
          remainingPct: 100,
          remainingFraction: 1,
          resetAtMs: null,
          bucketId: 'unused_default',
        };
      }
    }
  }

  return {
    valid: true,
    planTierRaw,
    agentState,
    pools,
  };
}

export function loadOfficialQuotaCache(pluginDataDir) {
  if (!pluginDataDir) return null;
  const cachePath = path.join(pluginDataDir, OFFICIAL_CACHE_FILENAME);
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveOfficialQuotaCache(pluginDataDir, cacheObj) {
  fs.mkdirSync(pluginDataDir, { recursive: true });
  const cachePath = path.join(pluginDataDir, OFFICIAL_CACHE_FILENAME);
  const tmpPath = `${cachePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(cacheObj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, cachePath);
  return cachePath;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLockOrWait(lockPath, pluginDataDir) {
  fs.mkdirSync(pluginDataDir, { recursive: true });
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const payload = JSON.stringify({ pid: process.pid, startedAtMs: Date.now() });
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeFileSync(fd, payload, 'utf8');
      fs.closeSync(fd);
      return { acquired: true };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {}
      const stale = !existing || !existing.startedAtMs || Date.now() - existing.startedAtMs >= 20_000 || !isPidAlive(existing.pid);
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      await sleepMs(250);
    }
  }

  return { acquired: false };
}

function buildSanitizedChildEnv(effectiveProxy, cfgObj) {
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('ANTIGRAVITY_') || k.startsWith('AGY_BROWSER_')) {
      delete childEnv[k];
    }
  }

  childEnv.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  childEnv.BROWSER = '/usr/bin/true';
  childEnv.TERM = 'xterm-256color';

  const prefixPath = [
    path.dirname(process.execPath),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].join(path.delimiter);
  childEnv.PATH = `${prefixPath}${path.delimiter}${childEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;

  if (effectiveProxy) {
    childEnv.HTTPS_PROXY = effectiveProxy;
    childEnv.https_proxy = effectiveProxy;
    childEnv.HTTP_PROXY = effectiveProxy;
    childEnv.http_proxy = effectiveProxy;
    childEnv.ALL_PROXY = effectiveProxy;
    childEnv.all_proxy = effectiveProxy;
    childEnv.NO_PROXY = '127.0.0.1,localhost,::1';
    childEnv.no_proxy = '127.0.0.1,localhost,::1';
  }

  childEnv.CL_SYNC_CFG = JSON.stringify(cfgObj);
  return childEnv;
}

function classifyFailureStatus(ptyResult, effectiveProxy) {
  const log = String(ptyResult?.logText || '');
  const screen = stripAnsi(ptyResult?.screenText || '');

  if (
    ptyResult?.abortReason === 'keyring_locked' ||
    /secret keyring is locked/i.test(log) ||
    /secret keyring is locked/i.test(screen)
  ) {
    return {
      status: 'keyring_locked',
      error: 'macOS 钥匙串已锁定，请在终端解锁钥匙串或允许 agy 访问后重试',
    };
  }

  if (
    ptyResult?.abortReason === 'auth_required' ||
    /Starting OAuth authentication flow|consumerOAuth: starting OAuth flow/i.test(log) ||
    /Please sign in|not signed in/i.test(screen)
  ) {
    // Distinguish "loaded token, timed out calling googleapis" vs genuine OAuth required
    if (
      /keyringAuth: loaded token/i.test(log) &&
      (/i\/o timeout|context deadline exceeded|dial tcp/i.test(log) || ptyResult?.abortReason === null)
    ) {
      return {
        status: 'network_timeout',
        error: effectiveProxy
          ? `连接 Google 配额服务超时（当前代理: ${effectiveProxy}），请检查代理节点或网络`
          : '连接 Google 配额服务超时（未检测到系统代理，请开启系统代理或在设置中填入代理地址）',
      };
    }
    return {
      status: 'auth_required',
      error: 'agy CLI 未登录或登录已过期，请在终端执行 agy 完成登录后重试',
    };
  }

  if (
    ptyResult?.abortReason === 'proxy_error' ||
    /proxyconnect tcp|socks connect|dial tcp .* connection refused/i.test(log)
  ) {
    return {
      status: 'proxy_error',
      error: `代理连接失败${effectiveProxy ? ` (${effectiveProxy})` : ''}，请确认代理端口已启动`,
    };
  }

  if (/i\/o timeout|context deadline exceeded|dial tcp/i.test(log) || ptyResult?.statusLines?.some((x) => x.agent_state === 'authenticating')) {
    return {
      status: 'network_timeout',
      error: effectiveProxy
        ? `连接 Google 配额服务超时（当前代理: ${effectiveProxy}）`
        : '连接 Google 配额服务超时（未检测到系统代理，请开启系统代理或在设置中填入代理地址）',
    };
  }

  return {
    status: 'network_timeout',
    error: 'agy CLI 同步未返回有效配额数据，请确认已登录且网络可访问 Google 服务',
  };
}

export async function syncQuotaViaCli({
  pluginDataDir,
  configProxyUrl = null,
  agyBin: explicitAgyBin,
  proxyUrl,
  skipSystemProxy = false,
  timeoutSeconds = 14,
  nowMs,
} = {}) {
  if (!pluginDataDir) {
    throw new Error('pluginDataDir is required for syncQuotaViaCli');
  }

  const lockPath = path.join(pluginDataDir, LOCK_FILENAME);
  const lockState = await acquireLockOrWait(lockPath, pluginDataDir);
  if (!lockState.acquired) {
    return loadOfficialQuotaCache(pluginDataDir) || { version: 1, pools: null, lastSync: { ok: false, status: 'network_timeout', error: '等待并发同步超时' } };
  }

  let tmpDir = null;
  try {
    const attemptNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const attemptIso = new Date(attemptNowMs).toISOString();
    const existing = loadOfficialQuotaCache(pluginDataDir) || { version: 1 };
    const agyBin = resolveAgyBinary({ agyBin: explicitAgyBin });

    if (!agyBin) {
      const updated = {
        ...existing,
        version: 1,
        lastSync: {
          ok: false,
          status: 'cli_missing',
          attemptedAtMs: attemptNowMs,
          attemptedAt: attemptIso,
          error: '未找到 agy CLI（请先安装并确认 ~/.local/bin/agy 可用）',
        },
      };
      saveOfficialQuotaCache(pluginDataDir, updated);
      return updated;
    }

    const effectiveProxy = resolveEffectiveProxyUrl(configProxyUrl, { proxyUrl, skipSystemProxy });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-lens-cli-'));
    const statusFile = path.join(tmpDir, 'statusline.jsonl');
    const logPath = path.join(tmpDir, 'agy-sync.log');
    const hookPath = path.join(tmpDir, 'hook.mjs');

    const hookSource = [
      "import fs from 'node:fs';",
      'try {',
      "  const raw = fs.readFileSync(0, 'utf8').trim();",
      '  if (raw) {',
      '    const obj = JSON.parse(raw);',
      "    if (obj && typeof obj === 'object') delete obj.email;",
      `    fs.appendFileSync(${JSON.stringify(statusFile)}, JSON.stringify(obj) + '\\n', 'utf8');`,
      '  }',
      '} catch {}',
      "process.stdout.write('ok\\n');",
      '',
    ].join('\n');
    fs.writeFileSync(hookPath, hookSource, 'utf8');

    const settingsJson = JSON.stringify({
      statusLine: {
        type: 'command',
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`,
        stack_with_default: true,
      },
    });

    const childEnv = buildSanitizedChildEnv(effectiveProxy, {
      agyBin,
      settingsJson,
      logPath,
      statusFile,
      timeoutSeconds,
    });

    const ptyResult = await new Promise((resolve, reject) => {
      execFile(
        '/usr/bin/python3',
        ['-c', PTY_RUNNER_PY],
        {
          env: childEnv,
          timeout: Math.round((timeoutSeconds + 6) * 1000),
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (stdout) {
            try {
              return resolve(JSON.parse(stdout));
            } catch {}
          }
          reject(err || new Error(stderr || 'Python PTY runner returned invalid output'));
        }
      );
    });

    const finishMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const finishIso = new Date(finishMs).toISOString();
    const parsed = parseOfficialCliQuota({
      statusLines: ptyResult.statusLines || [],
      screenText: ptyResult.screenText || '',
      syncedAtMs: finishMs,
    });

    if (parsed.valid && parsed.pools) {
      const updated = {
        version: 1,
        syncedAtMs: finishMs,
        syncedAt: finishIso,
        planTierRaw: parsed.planTierRaw || existing.planTierRaw || null,
        pools: parsed.pools,
        lastSync: {
          ok: true,
          status: 'ok',
          attemptedAtMs: finishMs,
          attemptedAt: finishIso,
          proxyUsed: effectiveProxy || null,
          error: null,
        },
      };
      saveOfficialQuotaCache(pluginDataDir, updated);
      return updated;
    }

    const failure = classifyFailureStatus(ptyResult, effectiveProxy);
    const updated = {
      ...existing,
      version: 1,
      lastSync: {
        ok: false,
        status: failure.status,
        attemptedAtMs: finishMs,
        attemptedAt: finishIso,
        proxyUsed: effectiveProxy || null,
        error: failure.error,
      },
    };
    saveOfficialQuotaCache(pluginDataDir, updated);
    return updated;
  } catch (err) {
    const finishMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const finishIso = new Date(finishMs).toISOString();
    const existing = loadOfficialQuotaCache(pluginDataDir) || { version: 1 };
    const updated = {
      ...existing,
      version: 1,
      lastSync: {
        ok: false,
        status: 'network_timeout',
        attemptedAtMs: finishMs,
        attemptedAt: finishIso,
        error: `agy CLI 同步执行异常: ${err?.message || String(err)}`,
      },
    };
    try {
      saveOfficialQuotaCache(pluginDataDir, updated);
    } catch {}
    return updated;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}
