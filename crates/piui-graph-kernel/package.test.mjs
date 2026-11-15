import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLockedSubset, CONTRACT_FILES, minimalWorkspace } from './package.mjs';

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
  for (const path of included) {
    // A crate's src/ and tests/ folders are packaged with the crate.
    if (members.some((member) => path.startsWith(`${member}/src/`) || path.startsWith(`${member}/tests/`))) continue;
    assert.ok(CONTRACT_FILES.includes(path), `${path} is included at compile time but not packaged`);
    assert.ok(existsSync(join(ROOT, path)), `${path} does not exist`);
  }
});
