// Keeps Cargo's output folder (target/) a bounded build cache.
//
//   node scripts/build-cache.mjs          sizes, the budget and free space
//   node scripts/build-cache.mjs prune    drop leftovers; drop whole trees only while over the limits
//   node scripts/build-cache.mjs clean    remove everything except kept evidence
//
// target/ holds the compiled dependencies. Keeping it makes the next build
// incremental; Cargo never collects it, so `prune` does (it also runs at the
// end of scripts/release-build.mjs). Leftovers that no build reuses go first.
// Whole trees go only while the folder is over PIUI_BUILD_CACHE_BUDGET_GB
// (default 12) or the drive has less than PIUI_BUILD_CACHE_MIN_FREE_GB
// (default 20) free: other profiles before release, largest first.
//
// The folder is fixed under the repository and is never reached through a
// link. A tree that another process still uses is left alone. artifacts/ and
// evidence/ are out of reach; target/piui-evidence is always kept.
import { existsSync, lstatSync, opendirSync, readdirSync, renameSync, rmSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GIB = 1024 ** 3;
export const DEFAULT_BUDGET_GB = 12;
export const DEFAULT_MIN_FREE_GB = 20;

/** Never reused by a later build. */
const LEFTOVER_NAMES = new Set(['release-config', 'cargo-timings', 'tmp', 'doc', 'package']);
/** Reports and screenshots a person may still need (AGENTS.md storage rules). */
const EVIDENCE_NAME = 'piui-evidence';
/** Fixtures of E2E runs; the harness removes its own, so `prune` leaves them. */
const FIXTURE_NAME = 'piui-e2e';
const DOOMED_SUFFIX = '.pruning';

/** 'leftover' | 'tree' | 'kept' | 'fixture' for a directory directly under target/. */
export function classify(name) {
  if (name === EVIDENCE_NAME) return 'kept';
  if (name === FIXTURE_NAME) return 'fixture';
  if (LEFTOVER_NAMES.has(name) || name.endsWith(DOOMED_SUFFIX)) return 'leftover';
  return 'tree';
}

/** Trees to remove, in order, until the folder fits the budget and the drive has room. */
export function treesOverLimits(trees, { budgetBytes, freeBytes, minFreeBytes }) {
  let used = trees.reduce((sum, tree) => sum + tree.bytes, 0);
  let free = freeBytes;
  const order = [...trees].sort(
    (a, b) => Number(a.name === 'release') - Number(b.name === 'release') || b.bytes - a.bytes || a.name.localeCompare(b.name),
  );
  const removals = [];
  for (const tree of order) {
    const overBudget = used > budgetBytes;
    if (!overBudget && free >= minFreeBytes) break;
    removals.push({ ...tree, reason: overBudget ? 'over the budget' : 'low disk space' });
    used -= tree.bytes;
    free += tree.bytes;
  }
  return removals;
}

/** Bytes under a directory. Links count as entries and are never followed. */
export function treeBytes(path) {
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    let directory;
    try {
      directory = opendirSync(current);
    } catch {
      continue;
    }
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        const child = join(current, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile()) total += lstatSync(child, { throwIfNoEntry: false })?.size ?? 0;
      }
    } finally {
      directory.closeSync();
    }
  }
  return total;
}

function isPlainDirectory(path) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info !== undefined && info.isDirectory() && !info.isSymbolicLink();
}

/** Directories directly under target/ with their kind; links are reported as 'link'. */
function topLevel(target) {
  return readdirSync(target, { withFileTypes: true })
    .filter((entry) => !entry.isFile())
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? classify(entry.name) : 'link' }));
}

/** Installer staging inside a build tree: `<tree>/bundle` and `<tree>/<profile>/bundle`. */
function bundleLeftovers(target, tree) {
  const found = [];
  for (const candidate of [join(tree, 'bundle'), join(tree, 'release', 'bundle'), join(tree, 'debug', 'bundle')]) {
    if (isPlainDirectory(join(target, candidate))) found.push(candidate);
  }
  return found;
}

/**
 * Removes one directory under target/. It is first moved aside, which fails
 * while another process holds a file in it; such a tree stays as it is.
 * Returns the freed bytes, or a reason string when nothing was removed.
 */
function removeDirectory(target, relative) {
  const path = join(target, relative);
  if (!isPlainDirectory(path)) return 'not a plain directory';
  const bytes = treeBytes(path);
  let doomed = path;
  if (!relative.endsWith(DOOMED_SUFFIX)) {
    doomed = join(target, `${relative.replaceAll(/[\\/]/g, '_')}-${process.pid}${DOOMED_SUFFIX}`);
    try {
      renameSync(path, doomed);
    } catch (error) {
      return `in use (${error.code ?? 'rename failed'})`;
    }
  }
  try {
    rmSync(doomed, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    return `partly removed (${error.code ?? 'remove failed'}); the rest is ${doomed}`;
  }
  return bytes;
}

function freeBytes(path) {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function gib(bytes) {
  return `${(bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1)} GB`;
}

/** Sizes of the trees under target/, largest first. */
export function cacheStatus(target) {
  if (!isPlainDirectory(target)) return [];
  return topLevel(target)
    .filter((entry) => entry.kind !== 'link')
    .map((entry) => ({ ...entry, bytes: treeBytes(join(target, entry.name)) }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Runs `prune` on a target folder; returns the lines to print. */
export function pruneTarget(target, { budgetBytes, minFreeBytes, free = () => freeBytes(target) }) {
  const lines = [];
  if (!isPlainDirectory(target)) return ['target/ does not exist; nothing to prune.'];
  const report = (relative, reason) => {
    const result = removeDirectory(target, relative);
    lines.push(typeof result === 'number' ? `  removed ${relative} (${gib(result)}, ${reason})` : `  kept ${relative}: ${result}`);
  };
  const entries = topLevel(target);
  for (const entry of entries) {
    if (entry.kind === 'leftover') report(entry.name, 'leftover');
    if (entry.kind === 'tree') for (const bundle of bundleLeftovers(target, entry.name)) report(bundle, 'leftover');
  }
  const trees = entries.filter((entry) => entry.kind === 'tree').map((entry) => ({ name: entry.name, bytes: treeBytes(join(target, entry.name)) }));
  for (const tree of treesOverLimits(trees, { budgetBytes, freeBytes: free(), minFreeBytes })) report(tree.name, tree.reason);
  return lines;
}

/** Runs `clean`: everything under target/ except kept evidence. */
export function cleanTarget(target) {
  const lines = [];
  if (!isPlainDirectory(target)) return ['target/ does not exist; nothing to clean.'];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isFile()) {
      rmSync(join(target, entry.name), { force: true });
    } else if (!entry.isDirectory()) {
      lines.push(`  kept ${entry.name}: a link, never followed`);
    } else if (classify(entry.name) === 'kept') {
      lines.push(`  kept ${entry.name}: evidence; move it to evidence/ before deleting it`);
    } else {
      const result = removeDirectory(target, entry.name);
      lines.push(typeof result === 'number' ? `  removed ${entry.name} (${gib(result)})` : `  kept ${entry.name}: ${result}`);
    }
  }
  if (readdirSync(target).length === 0) rmSync(target, { recursive: true, force: true });
  return lines;
}

function limit(env, name, fallback) {
  const text = env[name];
  if (text === undefined || text.trim() === '') return fallback * GIB;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number of gigabytes, zero or more.`);
  return value * GIB;
}

/** The repository's own target/ and nothing else. */
function repositoryTarget() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (!existsSync(join(root, 'Cargo.toml')) || !existsSync(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'))) {
    throw new Error(`${root} is not the repository root; refusing to touch anything.`);
  }
  const target = join(root, 'target');
  const info = lstatSync(target, { throwIfNoEntry: false });
  if (info !== undefined && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error(`${target} is not a plain directory; refusing to touch it.`);
  }
  return { root, target };
}

function main(argv) {
  const command = argv[0] ?? 'status';
  if (!['status', 'prune', 'clean'].includes(command) || argv.length > 1) {
    console.error('Usage: node scripts/build-cache.mjs [status|prune|clean]');
    process.exitCode = 2;
    return;
  }
  const { root, target } = repositoryTarget();
  const budgetBytes = limit(process.env, 'PIUI_BUILD_CACHE_BUDGET_GB', DEFAULT_BUDGET_GB);
  const minFreeBytes = limit(process.env, 'PIUI_BUILD_CACHE_MIN_FREE_GB', DEFAULT_MIN_FREE_GB);
  const before = freeBytes(root);
  if (command === 'prune') for (const line of pruneTarget(target, { budgetBytes, minFreeBytes })) console.log(line);
  if (command === 'clean') for (const line of cleanTarget(target)) console.log(line);
  const status = cacheStatus(target);
  const used = status.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`Build cache: ${gib(used)} of a ${gib(budgetBytes)} budget in ${target}`);
  for (const entry of status) console.log(`  ${entry.name.padEnd(18)} ${gib(entry.bytes)}`);
  const after = freeBytes(root);
  console.log(
    command === 'status'
      ? `Free space: ${gib(after)} (trees are dropped below ${gib(minFreeBytes)})`
      : `Free space: ${gib(before)} before, ${gib(after)} after`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
