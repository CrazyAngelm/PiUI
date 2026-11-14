import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, normalizePath, type Plugin } from 'vite';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repository = resolve(packageRoot, '../..');
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const source = (path: string): string => readFileSync(resolve(repository, path), 'utf8').replace(/\r\n/g, '\n');

function conversationBoundary(): Plugin {
  return {
    name: 'nano-conversation-boundary', enforce: 'pre',
    transform(code, id) {
      if (normalizePath(id.split('?')[0]) !== normalizePath(resolve(repository, 'apps/desktop/src/styles/tokens.css'))) return;
      // The same token source serves two independent owner-controlled roots.
      // Transcript layout rules below must not turn the composer into a scroll viewport.
      return code.replace(/:root/g, ':is(.nano-conversation-root, [data-nano-composer="root"])');
    },
    resolveId(id, importer) {
      if (!importer || !id.startsWith('.')) return;
      const path = normalizePath(resolve(dirname(importer.split('?')[0]), id)).replace(/\.ts$/, '');
      if (path === normalizePath(resolve(repository, 'apps/desktop/src/features/locale/language'))) return normalizePath(resolve(packageRoot, 'src/conversationLocale.ts'));
    },
    generateBundle: { order: 'post', handler(_options, bundle) {
      const ids = [...this.getModuleIds()].map(id => normalizePath(id.split('?')[0]));
      const forbidden = ids.filter(id => /@tauri-apps(?:\/|\+)/.test(id) || /\/(?:transport|labHost|workspaceHistory|pluginsClient|pluginRegistry\.svelte|workspaceStore\.svelte|nanoAccount\.svelte)\.ts$/.test(id) || /\/PluginPanelFrame\.svelte$/.test(id) || id === normalizePath(resolve(repository, 'apps/desktop/src/features/locale/language.ts')));
      if (forbidden.length) this.error(`Native/Lab transport entered conversation presentation: ${forbidden.join(', ')}`);
      for (const required of ['shared/conversation/ConversationTranscript.svelte', 'shared/conversation/ApprovalRequest.svelte', 'app/chat/transcript/ToolRow.svelte']) {
        if (!ids.some(id => id.endsWith('/' + required))) this.error(`The existing Desktop presentation is absent: ${required}`);
      }
      for (const item of Object.values(bundle)) {
        if (item.type !== 'asset' || !item.fileName.endsWith('.css')) continue;
        const css = postcss.parse(String(item.source));
        css.walkRules(rule => {
          if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
          rule.selectors = rule.selectors.map(selector => selector.includes('[data-nano-composer') ? selector : selector.includes(':root') ? selector.replace(/:root/g, '.nano-conversation-root') : `.nano-conversation-root ${selector}`);
        });
        item.source = css.toString();
      }
      const prefix = normalizePath(repository) + '/';
      const paths = [...new Set([...ids.filter(id => id.startsWith(prefix) && !id.includes('/node_modules/')).map(id => relative(repository, id).replaceAll('\\', '/')), 'packages/nano-ui/vite.conversation.config.ts', 'packages/nano-ui/package.json', 'contracts/composer-presentation-v1.ts', 'contracts/conversation-presentation-v1.ts', 'contracts/workspace-v15.ts', 'apps/desktop/src/host-api/types.ts', 'pnpm-lock.yaml'])].sort();
      const sourceFiles = paths.map(path => ({ path, sha256: hash(source(path)) }));
      const artifacts = Object.values(bundle).map(item => ({ path: item.fileName, sha256: hash(item.type === 'chunk' ? item.code : item.source) }));
      this.emitFile({ type: 'asset', fileName: 'conversation-manifest.json', source: JSON.stringify({ manifestVersion: 1, package: '@piui/nano-ui', contractVersion: 1, entry: 'nano-conversation.js', stylesheet: 'nano-conversation.css', sourceEncoding: 'utf8-lf', sourceTreeSha256: hash(JSON.stringify(sourceFiles)), sourceFiles, artifacts }, null, 2) + '\n' });
    } },
  };
}

export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [conversationBoundary(), svelte()],
  build: {
    outDir: resolve(packageRoot, 'dist-conversation'), emptyOutDir: true, cssCodeSplit: false,
    lib: { entry: resolve(packageRoot, 'src/conversation.ts'), formats: ['es'], fileName: () => 'nano-conversation.js', cssFileName: 'nano-conversation' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
