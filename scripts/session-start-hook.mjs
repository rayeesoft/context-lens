import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  try {
    const raw = (await readStdin()).trim();
    if (raw) {
      const payload = JSON.parse(raw);
      const convId = String(payload?.conversationId || '').trim();
      const modelName = String(payload?.modelName || '').trim();
      if (convId && modelName && modelName.toLowerCase() !== 'auto') {
        const dataDir =
          process.env.PLUGIN_DATA ||
          path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'context-lens');
        fs.mkdirSync(dataDir, { recursive: true });
        const targetFile = path.join(dataDir, 'session-models.json');
        let existing = {};
        try {
          if (fs.existsSync(targetFile)) {
            const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              existing = parsed;
            }
          }
        } catch {}

        existing[convId] = {
          modelName,
          updatedAt: new Date().toISOString(),
        };

        // Prune very old entries if map grows large so hook stays fast.
        const keys = Object.keys(existing);
        if (keys.length > 500) {
          keys
            .sort((a, b) =>
              String(existing[b]?.updatedAt || '').localeCompare(String(existing[a]?.updatedAt || ''))
            )
            .slice(500)
            .forEach((oldKey) => {
              delete existing[oldKey];
            });
        }

        const tmpFile = path.join(dataDir, `.session-models.${process.pid}.tmp`);
        fs.writeFileSync(tmpFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpFile, targetFile);
      }
    }
  } catch {
    // Hooks must never block or fail the host agent loop.
  }
  process.stdout.write('{}\n');
}

main();
