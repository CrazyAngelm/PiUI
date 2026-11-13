// Reproducible source and native artifacts for the private .NET graph driver.
// `node crates/piui-graph-kernel/package.mjs source` does no compilation/network.
// `... build` additionally builds and probes that source on the current target.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CRATES = ['piui-contracts', 'piui-orchestration', 'piui-graph-kernel'];
const CONTRACT_FILES = [
  'contracts/harness-identity-v3.ts', 'contracts/orchestration-v6.ts',
  'contracts/nano-graph-kernel-v1.ts', 'contracts/fixtures/nano-graph-kernel-v1.json',
  'docs/NANO_GRAPH_KERNEL.md', 'LICENSE', 'rust-toolchain.toml',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (path) => new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)).replaceAll('\r\n', '\n');

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    // These commands process repository source, never graph/run content.
    throw new Error(`${program} failed (${result.status ?? result.error?.code ?? 'unknown'}).\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}

function inside(root, path) {
  const part = relative(root, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}

/** Refuse links at every segment before creating or writing artifact paths. */
function plainDirectory(root, path) {
  root = realpathSync(root);
  if (!inside(root, path)) throw new Error('Artifact directory escaped the repository.');
  let current = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error('Artifact path is not a plain directory.');
    if (!info) mkdirSync(current);
    if (realpathSync(current) !== current) throw new Error('Artifact path resolves through a link.');
  }
}

/** Replace only workspace membership, retaining the source's package/dependency/profile settings. */
export function minimalWorkspace(manifest) {
  const marker = manifest.indexOf('[workspace.package]');
  if (marker < 0 || !manifest.startsWith('[workspace]')) throw new Error('Workspace manifest has no supported package section.');
  const resolver = manifest.slice(0, marker).match(/^resolver\s*=\s*("[^"]+")\s*$/m)?.[1];
  if (!resolver) throw new Error('Workspace resolver is not explicit.');
  return `[workspace]\nmembers = [${CRATES.map((name) => `"crates/${name}"`).join(', ')}]\nresolver = ${resolver}\n\n${manifest.slice(marker)}`;
}

function lockedPackages(lock) {
  const result = new Map();
  for (const block of lock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (name) => block.match(new RegExp(`^${name} = "([^"\\r\\n]+)"$`, 'm'))?.[1];
    const name = field('name');
    const version = field('version');
    if (!name || !version) throw new Error('Cargo.lock contains an unrecognized package record.');
    const key = JSON.stringify([name, version, field('source') ?? null]);
    if (result.has(key)) throw new Error('Cargo.lock contains duplicate package identities.');
    result.set(key, field('checksum') ?? null);
  }
  if (result.size === 0) throw new Error('Cargo.lock has no package records.');
  return result;
}

/** Pruning unused packages must never resolve a different version or checksum. */
export function assertLockedSubset(original, subset) {
  const source = lockedPackages(original);
  for (const [identity, checksum] of lockedPackages(subset)) {
    if (!source.has(identity) || source.get(identity) !== checksum) {
      throw new Error(`Source packaging changed a pinned dependency: ${identity}.`);
    }
  }
}

function sourcePaths(root) {
  const paths = [...CONTRACT_FILES, 'crates/piui-graph-kernel/package.mjs', 'crates/piui-graph-kernel/package.test.mjs'];
  function visit(folder) {
    const absolute = join(root, folder);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error('Source packaging does not follow links.');
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${folder}/${name}`);
    } else if (info.isFile()) {
      paths.push(folder);
    } else {
      throw new Error('Source packaging requires regular files.');
    }
  }
  for (const name of CRATES) {
    paths.push(`crates/${name}/Cargo.toml`);
    visit(`crates/${name}/src`);
    if (existsSync(join(root, `crates/${name}/tests`))) visit(`crates/${name}/tests`);
  }
  return [...new Set(paths)].sort();
}

function describeFiles(directory, paths) {
  return paths.map((path) => {
    const bytes = readFileSync(join(directory, path));
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

function verifyFiles(directory, files) {
  const expected = new Set([...files.map((file) => file.path), 'manifest.json', 'SHA256SUMS.txt']);
  function inventory(folder, prefix = '') {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error('Source artifacts must not contain links.');
      if (info.isDirectory()) inventory(path, relativePath);
      else if (!info.isFile() || !expected.delete(relativePath)) throw new Error('Source artifact contains an unexpected file.');
    }
  }
  inventory(directory);
  if (expected.size !== 0) throw new Error('Source artifact is missing a recorded file.');
  for (const file of files) {
    const path = resolve(directory, file.path);
    if (!inside(directory, path) || lstatSync(path).isSymbolicLink() || sha256(readFileSync(path)) !== file.sha256) {
      throw new Error('An existing artifact differs from its source manifest.');
    }
  }
}

export function packageSource(root = ROOT) {
  root = realpathSync(root);
  const artifacts = join(root, 'artifacts', 'graph-kernel');
  const temporaryArea = join(root, 'target', 'graph-kernel-package');
  plainDirectory(root, artifacts);
  plainDirectory(root, temporaryArea);
  const temporary = join(temporaryArea, randomUUID());
  mkdirSync(temporary);
  try {
    const paths = sourcePaths(root);
    for (const path of paths) {
      const origin = join(root, path);
      if (!inside(root, realpathSync(origin)) || lstatSync(origin).isSymbolicLink()) {
        throw new Error('Source packaging refuses linked or escaped files.');
      }
      const destination = join(temporary, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, text(origin));
    }
    const originalLock = text(join(root, 'Cargo.lock'));
    writeFileSync(join(temporary, 'Cargo.toml'), minimalWorkspace(text(join(root, 'Cargo.toml'))));
    writeFileSync(join(temporary, 'Cargo.lock'), originalLock);
    // Cargo's own resolver prunes the copied lock; it is offline and may update
    // only workspace packages. The package/checksum proof below forbids drift.
    run('cargo', ['update', '--workspace', '--offline'], { cwd: temporary });
    const locked = text(join(temporary, 'Cargo.lock'));
    assertLockedSubset(originalLock, locked);
    writeFileSync(join(temporary, 'Cargo.lock'), locked);
    paths.push('Cargo.toml', 'Cargo.lock');
    paths.sort();
    const files = describeFiles(temporary, paths);
    const sourceFingerprint = sha256(JSON.stringify(files));
    const sourceRevision = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
    const manifest = {
      formatVersion: 1, artifactKind: 'nano-graph-kernel-source', protocol: 1,
      orchestrationSchemaVersion: 6, sourceFingerprint, sourceRevision,
      sourceEncoding: 'UTF-8 with LF', files,
    };
    writeFileSync(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(temporary, 'SHA256SUMS.txt'), files.map((file) => `${file.sha256}  ${file.path}\n`).join(''));
    const destination = join(artifacts, `source-${sourceFingerprint}`);
    if (existsSync(destination)) {
      plainDirectory(root, destination);
      const existing = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8'));
      if (existing.sourceFingerprint !== sourceFingerprint || JSON.stringify(existing.files) !== JSON.stringify(files)) {
        throw new Error('Source artifact identity already exists with different content.');
      }
      verifyFiles(destination, files);
      return { directory: destination, manifest: existing };
    }
    renameSync(temporary, destination);
    verifyFiles(destination, files);
    return { directory: destination, manifest };
  } finally {
    if (existsSync(temporary)) {
      if (!inside(realpathSync(temporaryArea), realpathSync(temporary)) || lstatSync(temporary).isSymbolicLink()) {
        throw new Error('Refusing cleanup outside the owned source staging directory.');
      }
      rmSync(temporary, { recursive: true });
    }
  }
}

export function buildNative(root = ROOT) {
  root = realpathSync(root);
  const source = packageSource(root);
  const cargoTarget = resolve(process.env.CARGO_TARGET_DIR ?? join(root, 'target'));
  const buildOutput = run('cargo', [
    'build', '--release', '--locked', '--manifest-path', join(source.directory, 'Cargo.toml'),
    '--target-dir', cargoTarget, '--package', 'piui-graph-kernel', '--bin', 'piui-graph-kernel',
    '--message-format=json-render-diagnostics',
  ], { cwd: source.directory });
  const records = buildOutput.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const artifact = records.findLast((record) => record.reason === 'compiler-artifact'
    && record.target?.name === 'piui-graph-kernel' && record.target.kind.includes('bin') && record.executable);
  if (!artifact || !inside(realpathSync(cargoTarget), realpathSync(artifact.executable))) {
    throw new Error('Cargo did not report the expected kernel executable inside its target directory.');
  }
  const request = JSON.parse(readFileSync(join(source.directory, 'contracts/fixtures/nano-graph-kernel-v1.json'), 'utf8'));
  const invalid = { ...request, protocol: 2, requestId: 'fixture-unsupported' };
  const probe = run(artifact.executable, [], { input: `${JSON.stringify(request)}\n${JSON.stringify(invalid)}\n` });
  const responses = probe.trim().split('\n').map((line) => JSON.parse(line));
  if (responses.length !== 2 || responses[0].status !== 'ok' || responses[0].run?.revision !== 0
    || responses[0].requestId !== request.requestId || responses[1].error?.code !== 'unsupportedProtocol') {
    throw new Error('The built kernel failed its private-pipe contract probe.');
  }
  const target = run('rustc', ['-vV'], { cwd: source.directory }).match(/^host: (.+)$/m)?.[1];
  if (!target || !/^[a-zA-Z0-9_-]+$/.test(target)) throw new Error('The native Rust target could not be identified.');
  const bytes = readFileSync(artifact.executable);
  const binarySha256 = sha256(bytes);
  const destination = join(root, 'artifacts', 'graph-kernel', `${target}-${binarySha256}`);
  plainDirectory(root, destination);
  const executable = `piui-graph-kernel${process.platform === 'win32' ? '.exe' : ''}`;
  const output = join(destination, executable);
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || sha256(readFileSync(output)) !== binarySha256)) {
    throw new Error('Native artifact identity already exists with different content.');
  }
  copyFileSync(artifact.executable, output);
  const manifest = { formatVersion: 1, artifactKind: 'nano-graph-kernel-native', protocol: 1,
    sourceFingerprint: source.manifest.sourceFingerprint, target, executable, bytes: bytes.length, sha256: binarySha256,
    probe: { create: 'passed', unsupportedProtocol: 'refused' } };
  writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(destination, 'SHA256SUMS.txt'), `${binarySha256}  ${executable}\n`);
  if (sha256(readFileSync(output)) !== binarySha256) throw new Error('Native artifact copy failed verification.');
  return { directory: destination, manifest, sourceDirectory: source.directory };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length !== 0 || !['source', 'build'].includes(command)) {
    throw new Error('Usage: node crates/piui-graph-kernel/package.mjs source|build');
  }
  const result = command === 'build' ? buildNative() : packageSource();
  process.stdout.write(`${JSON.stringify({ directory: result.directory, sourceFingerprint: result.manifest.sourceFingerprint,
    ...(result.manifest.target ? { target: result.manifest.target, sha256: result.manifest.sha256 } : {}) })}\n`);
}
