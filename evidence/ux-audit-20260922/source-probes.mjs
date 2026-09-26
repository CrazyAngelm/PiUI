// Read-only, synthetic UX audit probes. No host, harness, provider, or user data calls.
// Run from the repository root: node evidence/ux-audit-20260922/source-probes.mjs
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(resolve('apps/desktop/package.json'));
const ts = require('typescript');
const cache = new Map();
async function moduleUrl(path) {
  path = resolve(path);
  if (cache.has(path)) return cache.get(path);
  let js = ts.transpileModule(await readFile(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const imports = [...js.matchAll(/from\s+['"](\.[^'"]+)['"]/g)];
  for (const match of imports) {
    const url = await moduleUrl(resolve(dirname(path), `${match[1]}.ts`));
    js = js.replace(match[0], `from '${url}'`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
  cache.set(path, url);
  return url;
}
const graph = await import(await moduleUrl('apps/desktop/src/features/orchestration/agentGraph.ts'));
const layout = await import(await moduleUrl('apps/desktop/src/features/orchestration/graphLayout.ts'));
const preflight = await import(await moduleUrl('apps/desktop/src/features/orchestration/graphPreflight.ts'));

const router = graph.newRouterNode(0);
const agent = graph.newGraphNode(1);
const arranged = layout.arrangeResultDependencies([router, agent], []);
const [first, second] = arranged.nodes;
const node = graph.newGraphNode(0);
node.profile.model = 'fixture-model';
node.profile.modelProvider = 'fixture-provider';
const unnamed = { ...graph.emptyGraph(), nodes: [node] };
const catalog = async () => ({
  harness: 'codex', models: [{ id: 'fixture-model', provider: 'fixture-provider' }],
  resources: { items: [], warnings: [] },
});
const result = {
  evidenceType: 'synthetic execution of existing pure source functions; not native UI or provider proof',
  layout: {
    defaultRouterBranchCount: router.router.branches.length,
    reportedRouterHeight: layout.graphNodeHeight(first),
    followingNodeOffset: second.y - first.y,
    overlapAccordingToLayoutGeometry: first.y + layout.graphNodeHeight(first) - second.y,
  },
  checkSystem: {
    scenario: 'agent with a catalog-valid model, but system name is empty',
    nativeCatalogIssues: await preflight.preflightGraph(unnamed, catalog),
    graphValidationErrors: graph.graphErrors(unnamed),
  },
  pattern: {
    scenario: 'the editor replaces its entire edges array with the parallel pattern',
    priorKinds: ['result', 'send', 'observe', 'spawn'],
    resultingEdges: graph.patternEdges([router, agent], 'parallel'),
  },
};
console.log(JSON.stringify(result, null, 2));
