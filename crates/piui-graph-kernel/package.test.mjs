import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLockedSubset, minimalWorkspace } from './package.mjs';

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
