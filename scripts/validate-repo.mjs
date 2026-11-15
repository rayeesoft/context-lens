import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'release-assets']);
const FORBIDDEN_FILENAMES = new Set([
  'official-quota-cache.json',
  'quota-config.json',
  'quota-scan-cache.json',
  'session-models.json',
]);
const TEXT_EXTENSIONS = new Set([
  '.mjs',
  '.js',
  '.ts',
  '.swift',
  '.sh',
  '.yml',
  '.yaml',
  '.json',
  '.md',
  '.html',
  '.css',
  '.plist',
  '.svg',
]);
const ALLOWED_EMAIL_DOMAINS = ['@example.com', '@users.noreply.github.com'];

const HOME_PATH_RE = /\/Users\/[A-Za-z0-9._-]+/g;
const SECRET_TOKEN_RE = /(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIzaSy[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z._-]{20,})/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function readJson(relPath) {
  const fullPath = path.join(REPO_ROOT, relPath);
  assert.ok(fs.existsSync(fullPath), `Missing required file: ${relPath}`);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function readPlistStringValue(plistText, keyName) {
  const re = new RegExp(`<key>${keyName}</key>\\s*<string>([^<]+)</string>`);
  const m = plistText.match(re);
  return m ? m[1].trim() : null;
}

function validateManifests() {
  const plugin = readJson('plugin.json');
  const pkg = readJson('package.json');
  const hooks = readJson('hooks.json');
  const sidecar = readJson('sidecars/dashboard/sidecar.json');

  const plistRel = 'menubar/Info.plist';
  const plistFull = path.join(REPO_ROOT, plistRel);
  assert.ok(fs.existsSync(plistFull), `Missing required file: ${plistRel}`);
  const plistText = fs.readFileSync(plistFull, 'utf8');

  const plistShort = readPlistStringValue(plistText, 'CFBundleShortVersionString');
  const plistVer = readPlistStringValue(plistText, 'CFBundleVersion');

  assert.ok(plugin.version, 'plugin.json missing version');
  assert.equal(pkg.version, plugin.version, `package.json version (${pkg.version}) != plugin.json version (${plugin.version})`);
  assert.equal(plistShort, plugin.version, `Info.plist CFBundleShortVersionString (${plistShort}) != plugin.json (${plugin.version})`);
  assert.equal(plistVer, plugin.version, `Info.plist CFBundleVersion (${plistVer}) != plugin.json (${plugin.version})`);

  const expectedTag = (process.env.EXPECTED_TAG || '').trim();
  if (expectedTag) {
    assert.equal(
      `v${plugin.version}`,
      expectedTag,
      `EXPECTED_TAG (${expectedTag}) does not match plugin version v${plugin.version}`
    );
  }

  assert.ok(plugin.logo, 'plugin.json missing logo');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, plugin.logo)), `Missing logo file: ${plugin.logo}`);

  const sidecarEntry = sidecar.args?.[0] || 'main.mjs';
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, 'sidecars/dashboard', sidecarEntry)),
    `Missing sidecar entrypoint: sidecars/dashboard/${sidecarEntry}`
  );

  const sessionStartCmd = hooks?.['context-lens-session-recorder']?.SessionStart?.[0]?.command || '';
  const hookMatch = sessionStartCmd.match(/(\S+\.mjs)/);
  assert.ok(hookMatch, 'hooks.json missing .mjs script in SessionStart command');
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, hookMatch[1])),
    `Missing hook script referenced in hooks.json: ${hookMatch[1]}`
  );

  const skillPath = path.join(REPO_ROOT, 'skills/context-lens/SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'Missing skills/context-lens/SKILL.md');
  const skillText = fs.readFileSync(skillPath, 'utf8');
  assert.match(skillText, /^---\s*\nname:\s*context-lens\b[\s\S]*?\ndescription:\s*.+/m, 'SKILL.md missing required YAML frontmatter (name & description)');

  return plugin.version;
}

function walkFiles(dirPath, out = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function scanPrivacyAndHygiene() {
  const files = walkFiles(REPO_ROOT);
  const violations = [];

  for (const full of files) {
    const rel = path.relative(REPO_ROOT, full);
    const base = path.basename(full);

    if (FORBIDDEN_FILENAMES.has(base)) {
      violations.push(`${rel}: forbidden runtime cache/config file present in repository`);
      continue;
    }

    const ext = path.extname(base).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext) || base === 'LICENSE' || base === '.gitignore';
    if (!isText) continue;

    const lines = fs.readFileSync(full, 'utf8').split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const lineNum = idx + 1;

      if (HOME_PATH_RE.test(line)) {
        HOME_PATH_RE.lastIndex = 0;
        violations.push(`${rel}:${lineNum}: hardcoded macOS user home path found (use ~/ or os.homedir())`);
      }

      if (SECRET_TOKEN_RE.test(line)) {
        SECRET_TOKEN_RE.lastIndex = 0;
        violations.push(`${rel}:${lineNum}: potential credential/token pattern detected`);
      }

      const emails = line.match(EMAIL_RE) || [];
      for (const email of emails) {
        const lower = email.toLowerCase();
        if (!ALLOWED_EMAIL_DOMAINS.some((dom) => lower.endsWith(dom))) {
          violations.push(`${rel}:${lineNum}: unexpected email address "${email}"`);
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`Repository hygiene check failed:\n- ${violations.join('\n- ')}`);
  }

  return files.length;
}

function main() {
  const version = validateManifests();
  const fileCount = scanPrivacyAndHygiene();
  console.log(`[validate] OK (v${version}, ${fileCount} files scanned)`);
}

main();
