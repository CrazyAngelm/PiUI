// Use the application's actual parser and adapter manifests; no parallel CLI schema.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: pnpm system:check <file.piui.json> [...]'); process.exitCode = 1; }
else {
  const server = await createServer({ root: fileURLToPath(new URL('../apps/desktop', import.meta.url)), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { parseSystemFile } = await server.ssrLoadModule('/src/features/orchestration/systemFile.ts');
    for (const file of files) {
      try {
        const definition = parseSystemFile(await readFile(resolve(file), 'utf8'));
        console.log(`${file}: valid (version ${definition.version}, ${definition.agents.length} agents, ${definition.connections.length} connections). Native availability is checked at launch.`);
        // Sub-pipelines (version 5) name saved pipelines of the project the file is imported into.
        const names = [...new Set(definition.agents.flatMap((agent) => agent.executor?.type === 'pipeline' ? [agent.executor.pipeline] : []))];
        if (names.length) console.log(`${file}: sub-pipelines ${names.map((name) => `“${name}”`).join(', ')} are resolved at import against the project's saved pipelines.`);
      } catch (error) { console.error(`${file}: ${error.message}`); process.exitCode = 1; }
    }
  } finally { await server.close(); }
}
