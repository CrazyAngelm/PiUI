import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cacheStatus, classify, cleanTarget, pruneTarget, treeBytes, treesOverLimits } from './build-cache.mjs';

const GB = 1024 ** 3;
const ROOMY = { budgetBytes: 12 * GB, freeBytes: 100 * GB, minFreeBytes: 20 * GB };

function file(root, relative, bytes = 10) {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'piui-build-cache-'));
  const target = join(root, 'target');
  file(target, 'release/deps/app.rlib', 400);
  file(target, 'release/bundle/nsis/setup.exe', 50);
  file(target, 'debug/deps/app.rlib', 900);
  file(target, 'debug/incremental/state.bin', 100);
  file(target, 'e2e-ci/debug/deps/app.rlib', 300);
  file(target, 'cargo-timings/cargo-timing.html');
  file(target, 'release-config/tauri.release.conf.json');
  file(target, 'piui-evidence/run/report.json');
  file(target, 'piui-e2e/run/app.sqlite');
  file(target, '.rustc_info.json');
  return { root, target };
}

test('directories under target/ are leftovers, trees, kept evidence or fixtures', () => {
  assert.equal(classify('release'), 'tree');
  assert.equal(classify('debug'), 'tree');
  assert.equal(classify('x86_64-pc-windows-msvc'), 'tree');
  assert.equal(classify('cargo-timings'), 'leftover');
  assert.equal(classify('release-config'), 'leftover');
  assert.equal(classify('debug-4242.pruning'), 'leftover');
  assert.equal(classify('piui-evidence'), 'kept');
  assert.equal(classify('piui-e2e'), 'fixture');
});

test('trees are dropped only over a limit: other profiles first, release last', () => {
  const trees = [
    { name: 'release', bytes: 5 * GB },
    { name: 'debug', bytes: 6 * GB },
    { name: 'e2e-ci', bytes: 7 * GB },
  ];
  assert.deepEqual(treesOverLimits(trees, { ...ROOMY, budgetBytes: 18 * GB }), []);
  assert.deepEqual(
    treesOverLimits(trees, ROOMY).map((tree) => [tree.name, tree.reason]),
    [['e2e-ci', 'over the budget']],
  );
  assert.deepEqual(
    treesOverLimits(trees, { ...ROOMY, budgetBytes: 4 * GB }).map((tree) => tree.name),
    ['e2e-ci', 'debug', 'release'],
  );
  // A drive short of space takes trees back even when the folder fits its budget.
  assert.deepEqual(
    treesOverLimits(trees, { ...ROOMY, budgetBytes: 18 * GB, freeBytes: 10 * GB }).map((tree) => [tree.name, tree.reason]),
    [
      ['e2e-ci', 'low disk space'],
      ['debug', 'low disk space'],
    ],
  );
});

test('prune removes leftovers and keeps every tree that fits the limits', () => {
  const { root, target } = fixture();
  try {
    const lines = pruneTarget(target, { budgetBytes: GB, minFreeBytes: 0, free: () => GB });
    assert.ok(lines.some((line) => line.includes('removed cargo-timings')), lines.join('\n'));
    for (const gone of ['cargo-timings', 'release-config', 'release/bundle']) assert.ok(!existsSync(join(target, gone)), gone);
    for (const kept of ['release/deps/app.rlib', 'debug/deps/app.rlib', 'debug/incremental/state.bin', 'e2e-ci/debug/deps/app.rlib', 'piui-evidence/run/report.json', 'piui-e2e/run/app.sqlite', '.rustc_info.json']) {
      assert.ok(existsSync(join(target, kept)), kept);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune over the budget drops the other trees before release and never the evidence', () => {
  const { root, target } = fixture();
  try {
    pruneTarget(target, { budgetBytes: 500, minFreeBytes: 0, free: () => GB });
    assert.ok(!existsSync(join(target, 'debug')));
    assert.ok(!existsSync(join(target, 'e2e-ci')));
    assert.ok(existsSync(join(target, 'release/deps/app.rlib')));
    assert.ok(existsSync(join(target, 'piui-evidence/run/report.json')));
    assert.deepEqual(
      cacheStatus(target).map((entry) => entry.name).sort(),
      ['piui-e2e', 'piui-evidence', 'release'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean removes everything except kept evidence', () => {
  const { root, target } = fixture();
  try {
    const lines = cleanTarget(target);
    assert.ok(lines.some((line) => line.includes('kept piui-evidence')), lines.join('\n'));
    assert.deepEqual(cacheStatus(target).map((entry) => entry.name), ['piui-evidence']);
    assert.ok(!existsSync(join(target, '.rustc_info.json')));
    rmSync(join(target, 'piui-evidence'), { recursive: true });
    cleanTarget(target);
    assert.ok(!existsSync(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a link under target/ is never followed, measured or removed', (context) => {
  const { root, target } = fixture();
  try {
    const outside = join(root, 'outside');
    file(outside, 'keep.txt', 700);
    try {
      symlinkSync(outside, join(target, 'linked'), 'junction');
    } catch {
      context.skip('this file system cannot create a directory link');
      return;
    }
    const before = treeBytes(target);
    assert.ok(!cacheStatus(target).some((entry) => entry.name === 'linked'));
    pruneTarget(target, { budgetBytes: 0, minFreeBytes: 0, free: () => GB });
    cleanTarget(target);
    assert.ok(existsSync(join(outside, 'keep.txt')));
    assert.ok(before < 700 + 1800, 'the link destination is not counted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
