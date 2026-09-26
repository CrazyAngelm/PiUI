import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

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
  // dynamicImports load only when a user opens a view (chat, pipelines, settings…).
}
includeStaticGraph('index.html');

let initialBytes = 0;
let initialGzipBytes = 0;
for (const file of initialFiles) {
  const path = resolve(dist, file);
  initialBytes += (await stat(path)).size;
  initialGzipBytes += gzipSync(await readFile(path), { level: 9 }).length;
}
let totalBytes = 0;
for (const file of await readdir(resolve(dist, 'assets'))) {
  totalBytes += (await stat(resolve(dist, 'assets', file))).size;
}

// Budget (ADR-027): the first paint ships the shell, sidebar and home composer,
// built on accessible headless primitives. The WebView reads assets from local
// disk, so compressed size is the useful proxy for parse/compile cost; raw
// bytes are still reported so regressions stay visible. This is an asset
// smoke, not a startup/RSS measurement.
const gzipBudget = 160 * 1024;
const rawBudget = 560 * 1024;
if (initialGzipBytes > gzipBudget || initialBytes > rawBudget) {
  throw new Error(
    `Initial frontend asset budget exceeded: ${initialGzipBytes} gzip bytes (budget ${gzipBudget}), ` +
      `${initialBytes} raw bytes (budget ${rawBudget}); all assets: ${totalBytes} bytes.`,
  );
}
console.log(
  JSON.stringify({
    target: 'default shell static import graph',
    initialAssetBytes: initialBytes,
    initialGzipBytes,
    totalAssetBytes: totalBytes,
    deferredAssetBytes: totalBytes - initialBytes,
    gzipBudgetBytes: gzipBudget,
    rawBudgetBytes: rawBudget,
    note: 'Asset-size smoke only; startup/RSS/rendering require native measurements.',
  }),
);
