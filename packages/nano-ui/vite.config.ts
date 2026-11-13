import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, normalizePath, type Plugin } from 'vite';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repository = resolve(packageRoot, '../..');
const scope = '.nano-graph-root';
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
// Git stores these text sources as LF. A Windows checkout's line endings must
// not change the source fingerprint of an otherwise identical package.
const sourceBytes = (path: string): string => readFileSync(resolve(repository, path), 'utf8').replace(/\r\n/g, '\n');

function sharedSurface(): Plugin {
  return {
    name: 'nano-shared-surface',
    enforce: 'pre',
    resolveId(source, importer) {
      // Same translation contract, but embedded surfaces never mutate host language or storage.
      if (importer && source.startsWith('.')) {
        const requested = normalizePath(resolve(dirname(importer.split('?')[0]), source)).replace(/\.ts$/, '');
        if (requested === normalizePath(resolve(repository, 'apps/desktop/src/features/locale/language'))) return normalizePath(resolve(packageRoot, 'src/locale.ts'));
      }
    },
    generateBundle: { order: 'post', handler(_options, bundle) {
      const moduleIds = [...this.getModuleIds()];
      if (moduleIds.some(id => normalizePath(id).split('?')[0] === normalizePath(resolve(repository, 'apps/desktop/src/features/locale/language.ts')))) this.error('The desktop global locale entered the embedded surface.');
      if (moduleIds.some(id => /@tauri-apps(?:[\\/]|\+)/.test(id))) this.error('A Tauri API entered the shared browser surface.');
      const repositoryPrefix = repository.replaceAll('\\', '/') + '/';
      const sources = moduleIds.map(id => id.split('?')[0].replaceAll('\\', '/')).filter(id => id.startsWith(repositoryPrefix) && !id.includes('/node_modules/'));
      const forbidden = sources.filter(id => /[\\/](?:transport|labHost|harnessModels|nanoAccount\.svelte|workspaceStore\.svelte)\.ts$/.test(id));
      if (forbidden.length) this.error(`Native or Lab transport entered the shared surface: ${forbidden.map(id => relative(repository, id)).join(', ')}`);
      if (!sources.some(id => id.endsWith('/pipelines/canvas/FlowCanvas.svelte'))) this.error('The shared graph must contain the desktop canvas.');
      if (!Object.values(bundle).some(item => item.type === 'asset' && item.fileName === 'nano-graph.css')) this.error('The shared graph stylesheet was not emitted.');
      for (const item of Object.values(bundle)) {
        if (item.type !== 'asset' || !item.fileName.endsWith('.css')) continue;
        const css = postcss.parse(String(item.source));
        css.walkRules(rule => {
          if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
          rule.selectors = rule.selectors.map(selector => /:root/.test(selector)
            ? selector.replace(/:root/g, scope)
            : `${scope} ${selector}`);
        });
        item.source = css.toString();
      }
      const schemaPath = 'contracts/system-file-v5.schema.json';
      const schema = sourceBytes(schemaPath);
      this.emitFile({ type: 'asset', fileName: 'system-file-v5.schema.json', source: schema });
      const sourcePaths = [...new Set([...sources.map(id => relative(repository, id).replaceAll('\\', '/')), 'pnpm-lock.yaml', 'packages/nano-ui/package.json', 'packages/nano-ui/vite.config.ts', 'contracts/graph-drafts-v1.ts', schemaPath])].sort();
      const sourceFiles = sourcePaths.map(path => ({ path, sha256: sha256(sourceBytes(path)) }));
      const artifacts = Object.values(bundle).map(item => ({ path: item.fileName, sha256: sha256(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : item.source) }));
      if (!artifacts.some(item => item.path === 'system-file-v5.schema.json')) artifacts.push({ path: 'system-file-v5.schema.json', sha256: sha256(schema) });
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify({
        manifestVersion: 1, package: '@piui/nano-ui', packageVersion: '0.1.0', contractVersion: 1,
        entry: 'nano-graph.js', stylesheet: 'nano-graph.css', sourceEncoding: 'utf8-lf', sourceTreeSha256: sha256(JSON.stringify(sourceFiles)),
        sourceFiles, artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
      }, null, 2) + '\n' });
    } },
  };
}

export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [sharedSurface(), svelte()],
  build: {
    outDir: resolve(packageRoot, 'dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: resolve(packageRoot, 'src/index.ts'), formats: ['es'], fileName: () => 'nano-graph.js', cssFileName: 'nano-graph' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
