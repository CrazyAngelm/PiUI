import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');
const manifest = JSON.parse(await readFile(resolve(dist, '.vite/manifest.json'), 'utf8'));
const initialFiles = new Set();
const visited = new Set();
function includeStaticGraph(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const chunk = manifest[key];
  if (!chunk || typeof chunk.file !== 'string') throw new Error(`Missing build graph entry: ${key}`);
  initialFiles.add(chunk.file);
  for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) initialFiles.add(file);
  for (const dependency of chunk.imports ?? []) includeStaticGraph(dependency);
  // dynamicImports are loaded only when a user opens workspace editors/history.
}
includeStaticGraph('index.html');
let initialBytes = 0;
for (const file of initialFiles) initialBytes += (await stat(resolve(dist, file))).size;
let totalBytes = 0;
for (const file of await readdir(resolve(dist, 'assets'))) {
  totalBytes += (await stat(resolve(dist, 'assets', file))).size;
}

// Preserve the existing 260 KiB frontend startup smoke ceiling. Before code
// splitting, all emitted assets were the initial route. The build manifest now
// measures that route directly; optional history/editor bytes are reported too,
// not hidden inside an increased ceiling. This is not a measured RSS/startup test.
const budget = 260 * 1024;
if (initialBytes > budget) {
  throw new Error(`Initial frontend asset smoke budget exceeded: ${initialBytes} bytes > ${budget} bytes (all lazy assets: ${totalBytes} bytes).`);
}
console.log(JSON.stringify({
  target: 'default Sessions static import graph',
  initialAssetBytes: initialBytes,
  totalAssetBytes: totalBytes,
  deferredAssetBytes: totalBytes - initialBytes,
  existingInitialBudgetBytes: budget,
  note: 'Asset-size smoke only; startup/RSS/rendering require native measurements.',
}));
