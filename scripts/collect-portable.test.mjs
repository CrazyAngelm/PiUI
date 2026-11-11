import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { builtExecutable, clearArtifacts, collectPortable, portableName } from './collect-portable.mjs';

function file(root, relative, content = 'x') {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function repository(config) {
  const root = mkdtempSync(join(tmpdir(), 'piui-collect-portable-'));
  file(root, 'apps/desktop/src-tauri/tauri.conf.json', JSON.stringify(config));
  return root;
}

test('the portable file is named after the product without spaces', () => {
  assert.equal(portableName({ productName: 'PiUI', version: '0.2.11' }), 'PiUI_0.2.11_windows_x86_64.exe');
  assert.equal(portableName({ productName: 'Nano Desktop', version: '0.3.0' }), 'NanoDesktop_0.3.0_windows_x86_64.exe');
  assert.throws(() => portableName({ productName: 'PiUI' }), /release version/);
  assert.throws(() => portableName({ productName: '../x', version: '1.0.0' }), /product name/);
});

test('the newest of the renamed and the cargo executable is collected', () => {
  const root = mkdtempSync(join(tmpdir(), 'piui-collect-portable-'));
  try {
    assert.throws(() => builtExecutable(root, {}), /Release executable is missing/);
    const cargo = file(root, 'piui-desktop.exe');
    assert.equal(builtExecutable(root, {}), cargo);
    const renamed = file(root, 'nano-desktop.exe');
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(cargo, earlier, earlier);
    assert.equal(builtExecutable(root, { mainBinaryName: 'nano-desktop' }), renamed);
    utimesSync(renamed, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    assert.equal(builtExecutable(root, { mainBinaryName: 'nano-desktop' }), cargo);
    // A name that could leave the release folder is ignored.
    assert.equal(builtExecutable(root, { mainBinaryName: '../outside' }), cargo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifacts/ is replaced by the executable and its checksum', () => {
  const root = repository({ productName: 'PiUI', version: '0.2.11' });
  try {
    file(root, 'target/release/piui-desktop.exe', 'new build');
    file(root, 'artifacts/PiUI_0.2.10_x64-setup.exe', 'old installer');
    file(root, 'artifacts/PiUI_0.2.11_windows_x86_64.exe', 'old build');
    const result = collectPortable(root);
    assert.equal(result.name, 'PiUI_0.2.11_windows_x86_64.exe');
    assert.deepEqual(result.aside, []);
    assert.deepEqual(readdirSync(join(root, 'artifacts')).sort(), ['PiUI_0.2.11_windows_x86_64.exe', 'SHA256SUMS.txt']);
    assert.equal(readFileSync(join(root, 'artifacts', result.name), 'utf8'), 'new build');
    const digest = createHash('sha256').update('new build').digest('hex');
    assert.equal(readFileSync(join(root, 'artifacts', 'SHA256SUMS.txt'), 'utf8'), `${digest}  PiUI_0.2.11_windows_x86_64.exe\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file in use is moved aside so the new build can take its name', () => {
  const root = mkdtempSync(join(tmpdir(), 'piui-collect-portable-'));
  try {
    file(root, 'App_1.0.0_windows_x86_64.exe', 'running');
    file(root, 'App_1.0.0_windows_x86_64.exe.old', 'still running from an earlier update');
    file(root, 'SHA256SUMS.txt');
    const busy = (path) => {
      if (path.includes('.exe')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      rmSync(path, { force: true });
    };
    assert.deepEqual(clearArtifacts(root, busy), ['App_1.0.0_windows_x86_64.exe']);
    assert.ok(!existsSync(join(root, 'App_1.0.0_windows_x86_64.exe')));
    assert.equal(readFileSync(join(root, 'App_1.0.0_windows_x86_64.exe.2.old'), 'utf8'), 'running');
    assert.ok(existsSync(join(root, 'App_1.0.0_windows_x86_64.exe.old')));
    assert.ok(!existsSync(join(root, 'SHA256SUMS.txt')));
    assert.throws(
      () => clearArtifacts(root, () => { throw Object.assign(new Error('denied'), { code: 'EIO' }); }),
      /denied/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
