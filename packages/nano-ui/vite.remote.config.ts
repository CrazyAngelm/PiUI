import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, normalizePath, type Plugin } from 'vite';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repository = resolve(packageRoot, '../..');
const outDir = resolve(packageRoot, 'dist-remote');
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
// Git stores these text sources as LF; a Windows checkout must not change the source fingerprint.
const source = (path: string): string => readFileSync(resolve(repository, path), 'utf8').replace(/\r\n/g, '\n');
const relativePath = (id: string): string => relative(repository, id).replaceAll('\\', '/');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
}

/**
 * The remote bundle compiles the real desktop shell, but `host-api/transport.ts`
 * (Tauri and the UI Lab host) is replaced by `src/remote/transport.ts`. The build
 * fails if anything native or Lab-only still reaches the bundle, and records
 * what was built in `remote-manifest.json`, which Nano Web verifies before it
 * opens the iframe.
 */
function remoteBoundary(): Plugin {
  const desktopTransport = normalizePath(resolve(repository, 'apps/desktop/src/host-api/transport'));
  const remoteTransport = normalizePath(resolve(packageRoot, 'src/remote/transport.ts'));
  let moduleIds: string[] = [];
  return {
    name: 'nano-remote-boundary',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!importer || !id.startsWith('.')) return;
      const requested = normalizePath(resolve(dirname(importer.split('?')[0]), id)).replace(/\.ts$/, '');
      if (requested === desktopTransport) return remoteTransport;
    },
    generateBundle: {
      order: 'post',
      handler() {
        const ids = [...this.getModuleIds()].map((id) => normalizePath(id.split('?')[0]));
        const forbidden = ids.filter((id) => /@tauri-apps(?:\/|\+)/.test(id) || id.includes('/host-api/lab/') || id === `${desktopTransport}.ts`);
        if (forbidden.length > 0) {
          const named = forbidden.map((id) => {
            const importers = (this.getModuleInfo(id)?.importers ?? []).map((importer) => relativePath(normalizePath(importer.split('?')[0])));
            return `${id.includes('node_modules') ? id.slice(id.indexOf('node_modules')) : relativePath(id)}${importers.length ? ` (imported by ${importers.join(', ')})` : ''}`;
          });
          this.error(`Native or Lab transport entered the remote bundle: ${named.join('; ')}`);
        }
        for (const required of ['apps/desktop/src/app/shell/AppShell.svelte', 'packages/nano-ui/src/remote/transport.ts']) {
          if (!ids.some((id) => id.endsWith('/' + required))) this.error(`The remote bundle lacks ${required}.`);
        }
        moduleIds = ids;
      },
    },
    // Artifact hashes cover the exact bytes on disk, after every other plugin has finished with them.
    writeBundle: {
      order: 'post',
      handler() {
        const prefix = normalizePath(repository) + '/';
        const paths = [
          ...new Set([
            ...moduleIds.filter((id) => id.startsWith(prefix) && !id.includes('/node_modules/')).map(relativePath),
            'packages/nano-ui/remote/index.html',
            'packages/nano-ui/vite.remote.config.ts',
            'packages/nano-ui/package.json',
            'contracts/nano-remote-v1.ts',
            'pnpm-lock.yaml',
          ]),
        ].sort();
        const sourceFiles = paths.map((path) => ({ path, sha256: hash(source(path)) }));
        const artifacts = files(outDir)
          .map((file) => ({ path: relative(outDir, file).replaceAll('\\', '/'), sha256: hash(readFileSync(file)) }))
          .filter((artifact) => artifact.path !== 'remote-manifest.json')
          .sort((a, b) => a.path.localeCompare(b.path));
        const manifest = {
          manifestVersion: 1,
          package: '@piui/nano-ui',
          contractVersion: 1,
          entry: 'index.html',
          sourceEncoding: 'utf8-lf',
          sourceTreeSha256: hash(JSON.stringify(sourceFiles)),
          sourceFiles,
          artifacts,
        };
        writeFileSync(join(outDir, 'remote-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      },
    },
  };
}

export default defineConfig({
  root: resolve(packageRoot, 'remote'),
  base: './',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [remoteBoundary(), svelte()],
  build: { outDir, emptyOutDir: true },
});
