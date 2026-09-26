// Serves the production build (`dist/`) on loopback with the exact
// Content-Security-Policy of the desktop app, read from tauri.conf.json at
// start so the E2E policy cannot drift from the shipped one. The UI Lab host
// runs in this build because no Tauri bridge is present. Test-only; never
// used by the desktop app.
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const dist = join(desktopRoot, 'dist');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function appContentSecurityPolicy() {
  const config = JSON.parse(readFileSync(join(desktopRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const csp = config?.app?.security?.csp;
  if (typeof csp !== 'string' || csp.trim() === '') throw new Error('tauri.conf.json has no app.security.csp string.');
  return csp;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function main() {
  const port = Number(option('--port', '5392'));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('--port must be a TCP port.');
  const csp = appContentSecurityPolicy();
  if (!process.argv.includes('--no-build')) {
    const { build } = await import('vite');
    await build({ root: desktopRoot, logLevel: 'warn' });
  }
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    // Only files inside dist/ are served; no directory listing, no fallback.
    if (file !== dist && !file.startsWith(dist + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { 'Content-Security-Policy': csp }).end();
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`PiUI production build with the app CSP on http://127.0.0.1:${port}/`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await main();
