import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertLockedSubset, CONTRACT_FILES, hostTarget, minimalWorkspace, outputDirectory, PROTOCOL_2_ARGUMENT,
  writableArtifactFile, writeNativeArtifact,
} from './package.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('source workspace retains authoritative package, dependency and profile settings', () => {
  const settings = '[workspace.package]\nversion = "0.3.0"\n[workspace.dependencies]\nserde = "1.0"\n[profile.release]\nlto = "thin"\n';
  const output = minimalWorkspace(`[workspace]\nmembers = ["apps/desktop"]\nresolver = "2"\n\n${settings}`);
  assert.ok(output.endsWith(settings));
  assert.ok(output.includes('"crates/piui-orchestration"'));
  assert.ok(output.includes('"crates/piui-contracts"'));
  assert.ok(output.includes('"crates/piui-graph-kernel"'));
  assert.ok(!output.includes('apps/desktop'));
  assert.throws(() => minimalWorkspace('[workspace]\n'), /package section/);
});

test('source lock may remove unused packages but cannot change their origin or checksum', () => {
  const packageRecord = (version, checksum) => `[[package]]\nname = "serde"\nversion = "${version}"\nsource = "registry+fixture"\nchecksum = "${checksum}"\n`;
  const local = '[[package]]\nname = "piui-graph-kernel"\nversion = "0.3.0"\n';
  const unused = '[[package]]\nname = "unused"\nversion = "1.0.0"\n';
  const original = `version = 4\n\n${packageRecord('1.0.229', 'abc')}\n${local}\n${unused}`;
  assertLockedSubset(original, `${packageRecord('1.0.229', 'abc')}\n${local}`);
  assert.throws(() => assertLockedSubset(original, packageRecord('1.0.230', 'abc')), /changed a pinned dependency/);
  assert.throws(() => assertLockedSubset(original, packageRecord('1.0.229', 'changed')), /changed a pinned dependency/);
  assert.throws(() => assertLockedSubset(original, packageRecord('1.0.229', 'abc').replace('registry+fixture', 'registry+other')), /changed a pinned dependency/);
  assert.throws(() => assertLockedSubset(original, ''), /no package records/);
});

test('every file a packaged crate includes at compile time is packaged', () => {
  const members = [...minimalWorkspace(readFileSync(join(ROOT, 'Cargo.toml'), 'utf8')).matchAll(/"(crates\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(members.length > 0);
  const included = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.rs')) {
        for (const match of readFileSync(path, 'utf8').matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"/g)) {
          included.push(relative(ROOT, resolve(dirname(path), match[1])).replaceAll('\\', '/'));
        }
      }
    }
  };
  for (const member of members) {
    for (const folder of ['src', 'tests']) if (existsSync(join(ROOT, member, folder))) visit(join(ROOT, member, folder));
  }
  assert.ok(included.includes('contracts/fixtures/unified-shell/graph/compile-vectors-v1.json'));
  assert.ok(included.includes('contracts/fixtures/unified-shell/graph/kernel-v2/refusal-cloud.json'));
  for (const path of included) {
    // A crate's src/ and tests/ folders are packaged with the crate.
    if (members.some((member) => path.startsWith(`${member}/src/`) || path.startsWith(`${member}/tests/`))) continue;
    assert.ok(CONTRACT_FILES.includes(path), `${path} is included at compile time but not packaged`);
    assert.ok(existsSync(join(ROOT, path)), `${path} does not exist`);
  }
});

test('packaged TypeScript contracts import only packaged contracts', () => {
  for (const path of CONTRACT_FILES.filter((file) => file.endsWith('.ts'))) {
    for (const match of readFileSync(join(ROOT, path), 'utf8').matchAll(/from '(\.\/[^']+)'/g)) {
      const imported = `contracts/${match[1].slice(2)}.ts`;
      assert.ok(CONTRACT_FILES.includes(imported), `${path} imports ${imported}, which is not packaged`);
    }
  }
});

test('the probe starts protocol 2 with the argument the executable accepts', () => {
  const main = readFileSync(join(ROOT, 'crates/piui-graph-kernel/src/main.rs'), 'utf8');
  assert.ok(main.includes(`flag == "${PROTOCOL_2_ARGUMENT}"`));
});

test('an explicit output directory is an existing plain directory outside the repository', () => {
  assert.throws(() => outputDirectory('relative/output'), /absolute path/);
  assert.throws(() => outputDirectory(join(dirname(ROOT), `missing-${process.pid}-${Date.now()}`)), /existing plain directory/);
  assert.throws(() => outputDirectory(ROOT), /outside the repository/);
  assert.throws(() => outputDirectory(join(ROOT, 'crates')), /outside the repository/);
  assert.throws(() => outputDirectory(dirname(ROOT)), /outside the repository/);
});

test('the native target is the host line of rustc -vV', () => {
  const verbose = 'rustc 1.94.1 (e408947bf 2026-03-25)\nbinary: rustc\nhost: x86_64-unknown-linux-gnu\nrelease: 1.94.1\n';
  assert.equal(hostTarget(verbose), 'x86_64-unknown-linux-gnu');
  assert.equal(hostTarget(verbose.replaceAll('\n', '\r\n')), 'x86_64-unknown-linux-gnu');
  for (const refused of ['release: 1.94.1\n', 'host: \n', 'host: x86_64 linux\n', 'host: ../custom-target.json\n']) {
    assert.throws(() => hostTarget(refused), /could not be identified/);
  }
});

test('cargo is given the target before the build and the manifest records the same one', () => {
  // Static: the source of buildNative, not a build for another target.
  const source = readFileSync(join(ROOT, 'crates/piui-graph-kernel/package.mjs'), 'utf8');
  const build = source.slice(source.indexOf('export function buildNative'));
  const resolved = build.indexOf("const target = hostTarget(run('rustc', ['-vV']");
  const cargo = build.indexOf("run('cargo', [");
  assert.ok(resolved > 0 && resolved < cargo);
  assert.ok(build.indexOf("'--target', target,") > cargo);
  assert.ok(build.includes('inside(realpathSync(join(cargoTarget, target)), realpathSync(artifact.executable))'));
  assert.equal(build.match(/\btarget = /g)?.length, 1);
});

test('a native artifact file is writable only when absent or a plain file of its own', () => {
  // Policy over lstat results; the filesystem test below executes it.
  const info = (kind, nlink = 1) => ({ isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link', nlink });
  assert.equal(writableArtifactFile(undefined), true);
  assert.equal(writableArtifactFile(info('file')), true);
  assert.equal(writableArtifactFile(info('file', 2)), false);
  assert.equal(writableArtifactFile(info('link')), false);
  assert.equal(writableArtifactFile(info('directory')), false);
  assert.equal(writableArtifactFile(info('fifo')), false);
});

test('native artifact files are checked before the first write and never written through a link', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'graph-kernel-native-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const built = join(scratch, 'built');
  writeFileSync(built, 'kernel');
  const manifest = { executable: 'kernel.exe', sha256: createHash('sha256').update('kernel').digest('hex') };
  const names = ['kernel.exe', 'manifest.json', 'SHA256SUMS.txt'];
  const canary = join(scratch, 'canary.txt');
  writeFileSync(canary, 'canary');
  let count = 0;
  const destination = () => {
    const path = join(scratch, `destination-${(count += 1)}`);
    mkdirSync(path);
    return path;
  };
  const refusedUnchanged = (directory, pattern) => {
    const before = readdirSync(directory).sort();
    assert.throws(() => writeNativeArtifact(directory, built, manifest), pattern);
    assert.deepEqual(readdirSync(directory).sort(), before);
  };

  const plain = destination();
  writeNativeArtifact(plain, built, manifest);
  writeNativeArtifact(plain, built, manifest);
  assert.deepEqual(readdirSync(plain).sort(), [...names].sort());
  assert.equal(readFileSync(join(plain, 'SHA256SUMS.txt'), 'utf8'), `${manifest.sha256}  kernel.exe\n`);

  // A hard link to the canary at any file, or a directory: nothing is written.
  for (const name of names) {
    const linked = destination();
    linkSync(canary, join(linked, name));
    refusedUnchanged(linked, /not a plain file/);
    const directory = destination();
    mkdirSync(join(directory, name));
    refusedUnchanged(directory, /not a plain file/);
  }
  assert.equal(readFileSync(canary, 'utf8'), 'canary');

  // A directory link (a junction on Windows) at a file path.
  const linkedDirectory = destination();
  const elsewhere = destination();
  symlinkSync(elsewhere, join(linkedDirectory, 'SHA256SUMS.txt'), 'junction');
  refusedUnchanged(linkedDirectory, /not a plain file/);
  assert.deepEqual(readdirSync(elsewhere), []);

  // File symbolic links, existing and dangling; Windows grants them only to
  // elevated or developer-mode users, so they may not run here.
  for (const [label, target] of [['to the canary', canary], ['dangling', join(scratch, 'missing.txt')]]) {
    await t.test(`a file symbolic link ${label}`, (st) => {
      const linked = destination();
      try {
        symlinkSync(target, join(linked, 'manifest.json'), 'file');
      } catch (error) {
        if (error.code !== 'EPERM') throw error;
        st.skip('this user cannot create file symbolic links');
        return;
      }
      refusedUnchanged(linked, /not a plain file/);
      assert.equal(readFileSync(canary, 'utf8'), 'canary');
      assert.equal(existsSync(join(scratch, 'missing.txt')), false);
    });
  }

  const other = destination();
  writeFileSync(join(other, 'kernel.exe'), 'other');
  refusedUnchanged(other, /different content/);
});
