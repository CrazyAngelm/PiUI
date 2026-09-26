import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';
import { panelHeaders, uiBase } from './src/host-api/pluginFrame';

const host = process.env.TAURI_DEV_HOST;

/**
 * UI Lab only (`pnpm dev`): serves the example plugins' panel folders on
 * `http://piui-plugin.localhost:<port>/<plugin id>/…` with the headers the
 * desktop host's plugin protocol sends (per-plugin CSP with a sandbox), so
 * lab panels load exactly like desktop ones. Never part of a build.
 */
function labPluginFrames(): Plugin {
  const examples = fileURLToPath(new URL('../../examples/plugins/', import.meta.url));
  const panels = new Map<string, { root: string; entry: string }>();
  for (const name of readdirSync(examples)) {
    try {
      const manifest = JSON.parse(readFileSync(join(examples, name, 'piui-plugin.json'), 'utf8')) as { id?: string; ui?: { entry?: string } };
      if (typeof manifest.id === 'string' && typeof manifest.ui?.entry === 'string') panels.set(manifest.id, { root: resolve(examples, name), entry: manifest.ui.entry });
    } catch {
      // Not a plugin folder.
    }
  }
  return {
    name: 'piui-lab-plugin-frames',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const hostHeader = request.headers.host ?? '';
        if (!/^piui-plugin\.localhost(?::\d+)?$/.test(hostHeader)) return next();
        const url = new URL(request.url ?? '/', `http://${hostHeader}`);
        const [, id = '', ...rest] = url.pathname.split('/');
        const path = rest.join('/');
        const plugin = panels.get(id);
        const base = plugin ? uiBase(id, plugin.entry) : '';
        const folder = plugin ? base.slice(id.length + 1) : '';
        const file = plugin ? resolve(plugin.root, path) : '';
        const headers = plugin ? panelHeaders(`http://${hostHeader}`, base, path) : undefined;
        const inside = plugin !== undefined && path.startsWith(folder) && file.startsWith(plugin.root + sep) && !path.split('/').includes('..');
        if (request.method !== 'GET' || !inside || headers === undefined || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.writeHead(200, headers);
        response.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), labPluginFrames()],
  clearScreen: false,
  // Records the initial import graph separately from lazy workspace/history chunks.
  build: { manifest: true },
  server: {
    host: host ?? '127.0.0.1',
    port: 1420,
    strictPort: true,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    setupFiles: ['src/test/setupLocale.ts'],
    // Playwright specs (e2e/) run with `pnpm test:lab`, never under Vitest.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
