import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectHistory, inspectSession } from '../../scripts/analyzer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const STANDALONE_PRELOAD_JS = `
(function () {
  const params = new URLSearchParams(window.location.search);
  const conversationId = params.get('conversationId') || '';
  window.sidecar = {
    conversationId,
    fetch: window.fetch.bind(window),
    getWorkspaceUris: async () => [],
    onWorkspaceChange: () => () => {},
    ui: {}
  };
})();
`.trimStart();

function parseCliArgs(argv) {
  let standalone = false;
  let port = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--standalone') standalone = true;
    else if (a === '--port' && argv[i + 1] !== undefined) {
      const parsed = Number(argv[++i]);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
        port = parsed;
      }
    }
  }
  return { standalone, port };
}

function readAsset(fileName) {
  return readFileSync(join(__dirname, fileName), 'utf8');
}

export async function startServer(options = {}) {
  const cli = parseCliArgs(options.argv ?? process.argv.slice(2));
  const forceStandalone = options.standalone !== undefined ? options.standalone : cli.standalone;
  const analyzerOpts = options.analyzerOptions || {};

  const hasSidecarEnv = Boolean(
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
      process.env.ANTIGRAVITY_LS_ADDRESS &&
      process.env.ANTIGRAVITY_CSRF_TOKEN
  );

  if (!forceStandalone && hasSidecarEnv) {
    const { SidecarApp, Response } = await import('sidecar_sdk');
    const app = new SidecarApp();

    app.page('/', () => readAsset('index.html'));
    for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
      app.api(
        route,
        () => new Response(readAsset(file), { contentType }),
        'GET'
      );
    }

    app.api(
      '/api/session',
      (data) => {
        const convId = data.conversationId || app.config.conversationId || '';
        return inspectSession(convId, {
          ...analyzerOpts,
          etag: data.etag || '',
        });
      },
      'GET'
    );

    app.api(
      '/api/history',
      (data) => {
        return collectHistory({
          ...analyzerOpts,
          surface: data.surface || 'all',
          etag: data.etag || '',
        });
      },
      'GET'
    );

    const server = await app.run();
    const addr = server.address();
    return {
      mode: 'sidecar',
      port: addr && typeof addr === 'object' ? addr.port : Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT),
      server,
      app,
    };
  }

  const listenPort = options.port !== undefined ? options.port : (cli.port ?? 4799);

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readAsset('index.html'));
        return;
      }

      if (url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(STANDALONE_PRELOAD_JS);
        return;
      }

      if (STATIC_ASSETS[url.pathname]) {
        const [file, contentType] = STATIC_ASSETS[url.pathname];
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(readAsset(file));
        return;
      }

      if (url.pathname === '/api/session') {
        const convId = url.searchParams.get('conversationId') || '';
        const etag = url.searchParams.get('etag') || '';
        const payload = inspectSession(convId, { ...analyzerOpts, etag });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (url.pathname === '/api/history') {
        const surface = url.searchParams.get('surface') || 'all';
        const etag = url.searchParams.get('etag') || '';
        const payload = collectHistory({ ...analyzerOpts, surface, etag });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
    }
  });

  await new Promise((resolve) => {
    server.listen(listenPort, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : listenPort;
  return { mode: 'standalone', port: actualPort, server };
}

function isExecutedDirectly() {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  startServer()
    .then(({ mode, port }) => {
      if (mode === 'standalone') {
        console.log(`[context-lens] standalone dashboard running at http://127.0.0.1:${port}/`);
      }
    })
    .catch((err) => {
      console.error('[context-lens] failed to start dashboard:', err);
      process.exit(1);
    });
}
