import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredVersions, versionProblems } from './check-version.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function fixture(version = '1.4.0') {
  const root = mkdtempSync(join(tmpdir(), 'piui-version-check-'));
  const files = {
    'package.json': JSON.stringify({ name: 'piui', version }),
    'apps/desktop/package.json': JSON.stringify({ name: '@piui/desktop', version }),
    'apps/desktop/src-tauri/tauri.conf.json': JSON.stringify({ productName: 'PiUI', version }),
    'Cargo.toml': `[workspace]\nmembers = [\n  "apps/desktop/src-tauri",\n  "crates/core",\n]\n\n[workspace.package]\nversion = "${version}"\nedition = "2024"\n`,
    'apps/desktop/src-tauri/Cargo.toml': '[package]\nname = "piui-desktop"\nversion.workspace = true\n',
    'crates/core/Cargo.toml': '[package]\nname = "piui-core"\nversion.workspace = true\n\n[dependencies]\nserde = { version = "1.0.0" }\n',
    'Cargo.lock': `# generated\nversion = 4\n\n[[package]]\nname = "piui-core"\nversion = "${version}"\n\n[[package]]\nname = "piui-desktop"\nversion = "${version}"\ndependencies = [\n "piui-core",\n]\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
    'crates/piui-runtime/bridge/codex.mjs': `const init = { clientInfo: { name: "piui", title: "PiUI", version: "${version}" } };\n`,
    'crates/piui-runtime/bridge/hermes.mjs': `const init = { clientInfo: { name: 'piui', version: '${version}' } };\n`,
    'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-09-27\n\n- Notes.\n`,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function edit(root, path, from, to) {
  const file = join(root, path);
  writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
}

test('the repository declares one release version everywhere', () => {
  const { version, problems } = versionProblems(repositoryRoot);
  assert.deepEqual(problems, []);
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('a consistent tree passes, including a matching release tag', () => {
  const root = fixture();
  try {
    assert.deepEqual(versionProblems(root, { tag: 'v1.4.0' }), { version: '1.4.0', problems: [] });
    const sources = declaredVersions(root).map((entry) => entry.source);
    assert.ok(sources.includes('Cargo.lock piui-core'));
    assert.ok(sources.includes('crates/piui-runtime/bridge/hermes.mjs'));
    // Registry crates are never mistaken for workspace members.
    assert.ok(!sources.some((source) => source.includes('serde')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every drifting declaration is named', () => {
  const root = fixture();
  try {
    edit(root, 'apps/desktop/package.json', '1.4.0', '1.3.9');
    edit(root, 'Cargo.lock', 'name = "piui-core"\nversion = "1.4.0"', 'name = "piui-core"\nversion = "1.3.0"');
    edit(root, 'crates/piui-runtime/bridge/codex.mjs', '1.4.0', '1.0.0');
    writeFileSync(join(root, 'apps/desktop/src-tauri/tauri.linux.conf.json'), JSON.stringify({ version: '2.0.0' }));
    const { problems } = versionProblems(root);
    assert.deepEqual(problems, [
      'apps/desktop/package.json: 1.3.9 (expected 1.4.0)',
      'apps/desktop/src-tauri/tauri.linux.conf.json: 2.0.0 (expected 1.4.0)',
      'Cargo.lock piui-core: 1.3.0 (expected 1.4.0)',
      'crates/piui-runtime/bridge/codex.mjs: 1.0.0 (expected 1.4.0)',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit crate version, a missing changelog entry and a wrong tag fail', () => {
  const root = fixture();
  try {
    edit(root, 'crates/core/Cargo.toml', 'version.workspace = true', 'version = "0.9.0"');
    edit(root, 'CHANGELOG.md', '## [1.4.0] - 2026-09-27', '## [1.3.0] - 2026-09-01');
    const { problems } = versionProblems(root, { tag: 'v1.4.1' });
    assert.deepEqual(problems, [
      'crates/core/Cargo.toml: 0.9.0 (expected 1.4.0)',
      'CHANGELOG.md: no "## [1.4.0]" section',
      'tag v1.4.1 does not match version 1.4.0 (expected v1.4.0)',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a version that is not MAJOR.MINOR.PATCH is refused', () => {
  const root = fixture('1.4');
  try {
    assert.ok(versionProblems(root).problems.includes('package.json: "1.4" is not MAJOR.MINOR.PATCH'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
