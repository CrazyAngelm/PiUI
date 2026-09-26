// Every place that declares the PiUI release version must agree, and the
// changelog must describe it. Protocol and contract versions are separate and
// never checked here. `--tag vX.Y.Z` also requires a release tag to match.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function jsonVersion(root, path) {
  const value = JSON.parse(read(root, path)).version;
  return typeof value === 'string' ? value : undefined;
}

/** The value of `key = "..."` inside one TOML table (flat tables only). */
function tomlTableValue(text, table, key) {
  let inTable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inTable = line === `[${table}]`;
      continue;
    }
    if (!inTable) continue;
    const match = line.match(new RegExp(`^${key.replace('.', '\\.')}\\s*=\\s*(.+)$`));
    if (match) return match[1].trim();
  }
  return undefined;
}

function unquote(value) {
  return value?.match(/^"([^"]*)"$/)?.[1];
}

function workspaceMembers(root) {
  const text = read(root, 'Cargo.toml');
  const block = text.match(/^members\s*=\s*\[([\s\S]*?)\]/m);
  if (!block) throw new Error('Cargo.toml has no [workspace] members list.');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function lockVersions(root) {
  const versions = new Map();
  for (const entry of read(root, 'Cargo.lock').split(/\r?\n\[\[package\]\]\r?\n/)) {
    const name = entry.match(/^name = "([^"]+)"$/m)?.[1];
    const version = entry.match(/^version = "([^"]+)"$/m)?.[1];
    if (name && version && !entry.match(/^source = /m)) versions.set(name, version);
  }
  return versions;
}

/** Client versions PiUI announces to native harnesses in their handshakes. */
const BRIDGE_CLIENT_VERSIONS = [
  ['crates/piui-runtime/bridge/codex.mjs', /clientInfo:\s*\{\s*name:\s*"piui",\s*title:\s*"PiUI",\s*version:\s*"([^"]+)"/],
  ['crates/piui-runtime/bridge/hermes.mjs', /clientInfo:\s*\{\s*name:\s*'piui',\s*version:\s*'([^']+)'/],
];

/** Every declared release version as `{ source, version }`. */
export function declaredVersions(root) {
  const declared = [
    { source: 'package.json', version: jsonVersion(root, 'package.json') },
    { source: 'apps/desktop/package.json', version: jsonVersion(root, 'apps/desktop/package.json') },
    { source: 'apps/desktop/src-tauri/tauri.conf.json', version: jsonVersion(root, 'apps/desktop/src-tauri/tauri.conf.json') },
  ];
  // Platform files merge over tauri.conf.json; they may not carry another version.
  for (const platform of ['windows', 'linux', 'macos']) {
    const path = `apps/desktop/src-tauri/tauri.${platform}.conf.json`;
    if (existsSync(join(root, path)) && 'version' in JSON.parse(read(root, path))) {
      declared.push({ source: path, version: jsonVersion(root, path) });
    }
  }
  const cargo = read(root, 'Cargo.toml');
  const workspaceVersion = unquote(tomlTableValue(cargo, 'workspace.package', 'version'));
  declared.push({ source: 'Cargo.toml [workspace.package]', version: workspaceVersion });
  const locked = lockVersions(root);
  for (const member of workspaceMembers(root)) {
    const manifest = read(root, `${member}/Cargo.toml`);
    const name = unquote(tomlTableValue(manifest, 'package', 'name'));
    const own = tomlTableValue(manifest, 'package', 'version');
    const inherited = tomlTableValue(manifest, 'package', 'version.workspace') === 'true';
    declared.push({ source: `${member}/Cargo.toml`, version: inherited ? workspaceVersion : unquote(own) });
    declared.push({ source: `Cargo.lock ${name ?? member}`, version: name ? locked.get(name) : undefined });
  }
  for (const [path, pattern] of BRIDGE_CLIENT_VERSIONS) {
    declared.push({ source: path, version: read(root, path).match(pattern)?.[1] });
  }
  return declared;
}

/** Problems as readable lines; empty when every declaration agrees. */
export function versionProblems(root, { tag } = {}) {
  const declared = declaredVersions(root);
  const problems = [];
  const expected = declared[0].version;
  for (const { source, version } of declared) {
    if (version === undefined) problems.push(`${source}: no version found`);
    else if (!SEMVER.test(version)) problems.push(`${source}: "${version}" is not MAJOR.MINOR.PATCH`);
    else if (version !== expected) problems.push(`${source}: ${version} (expected ${expected})`);
  }
  if (expected !== undefined) {
    const heading = new RegExp(`^## \\[${expected.replaceAll('.', '\\.')}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\s*$`, 'm');
    if (!heading.test(read(root, 'CHANGELOG.md'))) problems.push(`CHANGELOG.md: no "## [${expected}]" section`);
    if (tag !== undefined && tag !== `v${expected}`) problems.push(`tag ${tag} does not match version ${expected} (expected v${expected})`);
  }
  return { version: expected, problems };
}

function main(argv) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const tagIndex = argv.indexOf('--tag');
  const tag = tagIndex === -1 ? undefined : argv[tagIndex + 1];
  if (tagIndex !== -1 && !tag) throw new Error('--tag needs a value such as v0.2.0.');
  const { version, problems } = versionProblems(root, { tag });
  if (problems.length > 0) {
    console.error('PiUI version check failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PiUI version check passed: ${version}${tag ? ` (tag ${tag})` : ''}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
