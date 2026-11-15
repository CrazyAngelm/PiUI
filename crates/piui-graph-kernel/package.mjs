// Reproducible source and native artifacts for the private .NET graph driver.
// `node crates/piui-graph-kernel/package.mjs source` does no compilation/network.
// `... build` additionally builds and probes that source for the Rust host
// target, which it names to Cargo explicitly and records.
// `--out <directory>` writes both into an existing directory outside the
// repository instead of `artifacts/graph-kernel/`, staging inside it.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CRATES = ['piui-contracts', 'piui-orchestration', 'piui-graph-kernel'];
// Every file a packaged crate's tests include at compile time is listed, so
// that the source artifact's tests build (package.test.mjs checks this). The
// TypeScript contracts are listed with every contract they import.
export const CONTRACT_FILES = [
  'contracts/harness-identity-v3.ts', 'contracts/orchestration-v6.ts',
  'contracts/nano-graph-kernel-v1.ts', 'contracts/fixtures/nano-graph-kernel-v1.json',
  'contracts/nano-graph-kernel-v2.ts', 'contracts/fixtures/unified-shell/graph/compile-vectors-v1.json',
  'contracts/work-location-v1.ts',
  'contracts/fixtures/unified-shell/graph/kernel-v2/create-cloud.json',
  'contracts/fixtures/unified-shell/graph/kernel-v2/create-local.json',
  'contracts/fixtures/unified-shell/graph/kernel-v2/refusal-cloud.json',
  'docs/NANO_GRAPH_KERNEL.md', 'LICENSE', 'rust-toolchain.toml',
];
/** The executable speaks protocol 2 only when its host starts it with this argument. */
export const PROTOCOL_2_ARGUMENT = '--with-protocol-2';
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

/**
 * An existing plain directory outside the repository, named by an absolute
 * path without links. Nothing is created here: the caller owns its location.
 */
export function outputDirectory(path, root = ROOT) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('The output directory must be an absolute path.');
  const absolute = resolve(path);
  const info = lstatSync(absolute, { throwIfNoEntry: false });
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error('The output directory must be an existing plain directory.');
  const real = realpathSync(absolute);
  // Windows paths compare case-insensitively; elsewhere the spelling is exact.
  const same = process.platform === 'win32' ? real.toLowerCase() === absolute.toLowerCase() : real === absolute;
  if (!same) throw new Error('The output directory resolves through a link.');
  const repository = realpathSync(root);
  if (inside(repository, real) || inside(real, repository)) throw new Error('The output directory must be outside the repository.');
  return real;
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

/** Where artifacts go: the repository's own folder, or an explicit outside one. */
function artifactArea(root, output) {
  if (output === undefined) {
    const artifacts = join(root, 'artifacts', 'graph-kernel');
    const temporaryArea = join(root, 'target', 'graph-kernel-package');
    plainDirectory(root, artifacts);
    plainDirectory(root, temporaryArea);
    return { base: root, artifacts, temporaryArea, staging: randomUUID() };
  }
  const artifacts = outputDirectory(output, root);
  return { base: artifacts, artifacts, temporaryArea: artifacts, staging: `staging-${randomUUID()}` };
}

/** Packaged files whose content is not the committed `sourceRevision` (provenance only). */
function uncommittedFiles(root, paths) {
  const entries = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths], { cwd: root })
    .split('\0');
  const changed = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    if (!entries[index]) continue;
    changed.add(entries[index].slice(3));
    // A rename or copy is followed by its original path.
    if ('RC'.includes(entries[index][0])) index += 1;
  }
  return [...changed].sort();
}

export function packageSource(root = ROOT, output = undefined) {
  root = realpathSync(root);
  const area = artifactArea(root, output);
  const temporary = join(area.temporaryArea, area.staging);
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
    const changed = uncommittedFiles(root, [...paths, 'Cargo.toml', 'Cargo.lock']);
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
    // `protocol` stays the protocol every host speaks by default (importers
    // pin it); `protocols` adds what the executable also offers on request.
    const manifest = {
      formatVersion: 1, artifactKind: 'nano-graph-kernel-source', protocol: 1, protocols: [1, 2],
      orchestrationSchemaVersion: 6, sourceFingerprint, sourceRevision,
      ...(changed.length ? { uncommittedFiles: changed } : {}),
      sourceEncoding: 'UTF-8 with LF', files,
    };
    writeFileSync(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(temporary, 'SHA256SUMS.txt'), files.map((file) => `${file.sha256}  ${file.path}\n`).join(''));
    const destination = join(area.artifacts, `source-${sourceFingerprint}`);
    if (existsSync(destination)) {
      plainDirectory(area.base, destination);
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
      if (!inside(realpathSync(area.temporaryArea), realpathSync(temporary)) || lstatSync(temporary).isSymbolicLink()) {
        throw new Error('Refusing cleanup outside the owned source staging directory.');
      }
      rmSync(temporary, { recursive: true });
    }
  }
}

const lines = (output) => output.trim().split('\n').map((line) => JSON.parse(line));

/**
 * The private-pipe contract probe of a built executable. Without an argument
 * it must still be protocol 1 exactly (a protocol 2 frame is refused); with
 * `--with-protocol-2` it must replay protocol 1 byte for byte and round-trip
 * the committed protocol 2 fixtures through a second invocation.
 */
function probe(executable, sourceDirectory) {
  const fixture = (path) => readFileSync(join(sourceDirectory, path), 'utf8');
  const request = JSON.parse(fixture('contracts/fixtures/nano-graph-kernel-v1.json'));
  const invalid = { ...request, protocol: 2, requestId: 'fixture-unsupported' };
  const legacy = run(executable, [], { input: `${JSON.stringify(request)}\n${JSON.stringify(invalid)}\n` });
  const responses = lines(legacy);
  if (responses.length !== 2 || responses[0].status !== 'ok' || responses[0].run?.revision !== 0
    || responses[0].requestId !== request.requestId || responses[1].error?.code !== 'unsupportedProtocol') {
    throw new Error('The built kernel failed its private-pipe contract probe.');
  }

  const v2 = 'contracts/fixtures/unified-shell/graph/kernel-v2';
  const local = JSON.parse(fixture(`${v2}/create-local.json`));
  const cloud = JSON.parse(fixture(`${v2}/create-cloud.json`));
  const refusal = JSON.parse(fixture(`${v2}/refusal-cloud.json`));
  const protocol3 = { ...request, protocol: 3, requestId: 'fixture-protocol-3' };
  const frames = [request, local, cloud, refusal.request, protocol3];
  const output = run(executable, [PROTOCOL_2_ARGUMENT], { input: frames.map((frame) => `${JSON.stringify(frame)}\n`).join('') });
  const [replayed, created, createdCloud, refused, unsupported, ...rest] = output.split('\n');
  const binding = (response) => JSON.parse(response.state?.binding ?? 'null');
  const parsed = [created, createdCloud, refused, unsupported].map((line) => JSON.parse(line ?? 'null'));
  if (replayed !== legacy.split('\n')[0] || rest.join('') !== ''
    || parsed[0]?.protocol !== 2 || parsed[0].status !== 'ok' || parsed[0].requestId !== local.requestId
    || !isDeepStrictEqual(binding(parsed[0])?.owner, local.command.binding.owner)
    || parsed[1]?.status !== 'ok' || !isDeepStrictEqual(binding(parsed[1])?.owner, cloud.command.binding.owner)
    || !isDeepStrictEqual(parsed[2], refusal.response)
    || parsed[3]?.protocol !== 1 || parsed[3].error?.code !== 'unsupportedProtocol') {
    throw new Error('The built kernel failed its protocol 2 contract probe.');
  }
  // A second process continues from the persisted pair: a lease for the
  // bound owner, and a refusal for any other owner before any effect.
  const state = (owner) => ({ snapshot: parsed[0].state.snapshot, binding: parsed[0].state.binding,
    expectedRunRevision: parsed[0].run.revision, owner });
  const otherOwner = { ...local.command.binding.owner, scopeId: `${local.command.binding.owner.scopeId}-other` };
  const followUp = lines(run(executable, [PROTOCOL_2_ARGUMENT], { input: [
    { protocol: 2, requestId: 'probe-lease', command: { type: 'lease', state: state(local.command.binding.owner), leaseId: 'probe-lease' } },
    { protocol: 2, requestId: 'probe-owner', command: { type: 'lease', state: state(otherOwner), leaseId: 'probe-owner' } },
  ].map((frame) => `${JSON.stringify(frame)}\n`).join('') }));
  if (followUp.length !== 2 || followUp[0].status !== 'ok' || followUp[0].effect?.type !== 'leased'
    || followUp[0].effect.executor !== 'agent' || followUp[0].state?.binding !== parsed[0].state.binding
    || followUp[1].error?.code !== 'ownerMismatch' || 'state' in followUp[1]) {
    throw new Error('The built kernel failed its protocol 2 round-trip probe.');
  }
  return {
    create: 'passed', unsupportedProtocol: 'refused',
    withProtocol2: { protocol1Replay: 'identical', create: 'passed', admissionRefusal: 'matched',
      protocol3: 'refused', lease: 'passed', ownerMismatch: 'refused' },
  };
}

/** The `host:` target of `rustc -vV` output. */
export function hostTarget(verbose) {
  const target = verbose.match(/^host: (\S+)\s*$/m)?.[1];
  if (!target || !/^[a-zA-Z0-9_-]+$/.test(target)) throw new Error('The native Rust target could not be identified.');
  return target;
}

/**
 * Whether a native artifact file may be written, from its `lstat` (a link,
 * even a dangling one, is never followed): only when it is absent or a
 * regular file that is not a second name of another file.
 */
export function writableArtifactFile(info) {
  return info === undefined || (info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
}

/**
 * Writes the executable `built`, `manifest.json` and `SHA256SUMS.txt` into
 * the plain `destination` directory. All three paths are checked before the
 * first write, so a refusal writes nothing and nothing is written through a
 * link, a directory or a hard link.
 */
export function writeNativeArtifact(destination, built, manifest) {
  const [native, manifestPath, sums] = [manifest.executable, 'manifest.json', 'SHA256SUMS.txt']
    .map((name) => join(destination, name));
  const existing = [native, manifestPath, sums].map((path) => lstatSync(path, { throwIfNoEntry: false }));
  if (!existing.every((info) => writableArtifactFile(info))) throw new Error('A native artifact path is not a plain file.');
  if (existing[0] && sha256(readFileSync(native)) !== manifest.sha256) {
    throw new Error('Native artifact identity already exists with different content.');
  }
  copyFileSync(built, native);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(sums, `${manifest.sha256}  ${manifest.executable}\n`);
  if (sha256(readFileSync(native)) !== manifest.sha256) throw new Error('Native artifact copy failed verification.');
}

export function buildNative(root = ROOT, output = undefined) {
  root = realpathSync(root);
  const source = packageSource(root, output);
  const artifacts = output === undefined ? join(root, 'artifacts', 'graph-kernel') : outputDirectory(output, root);
  const area = { base: output === undefined ? root : artifacts, artifacts };
  const cargoTarget = resolve(process.env.CARGO_TARGET_DIR ?? join(root, 'target'));
  // The target is resolved before the build and passed explicitly, so neither
  // `CARGO_BUILD_TARGET` nor a `build.target` setting can build another
  // target than the one the manifest records.
  const target = hostTarget(run('rustc', ['-vV'], { cwd: source.directory }));
  const buildOutput = run('cargo', [
    'build', '--release', '--locked', '--manifest-path', join(source.directory, 'Cargo.toml'),
    '--target-dir', cargoTarget, '--target', target, '--package', 'piui-graph-kernel', '--bin', 'piui-graph-kernel',
    '--message-format=json-render-diagnostics',
  ], { cwd: source.directory });
  const records = buildOutput.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const artifact = records.findLast((record) => record.reason === 'compiler-artifact'
    && record.target?.name === 'piui-graph-kernel' && record.target.kind.includes('bin') && record.executable);
  if (!artifact || !inside(realpathSync(join(cargoTarget, target)), realpathSync(artifact.executable))) {
    throw new Error('Cargo did not report the expected kernel executable for the host target.');
  }
  const probed = probe(artifact.executable, source.directory);
  const bytes = readFileSync(artifact.executable);
  const binarySha256 = sha256(bytes);
  const destination = join(area.artifacts, `${target}-${binarySha256}`);
  plainDirectory(area.base, destination);
  const executable = `piui-graph-kernel${process.platform === 'win32' ? '.exe' : ''}`;
  const manifest = { formatVersion: 1, artifactKind: 'nano-graph-kernel-native', protocol: 1, protocols: [1, 2],
    protocol2Argument: PROTOCOL_2_ARGUMENT,
    sourceFingerprint: source.manifest.sourceFingerprint, target, executable, bytes: bytes.length, sha256: binarySha256,
    probe: probed };
  writeNativeArtifact(destination, artifact.executable, manifest);
  return { directory: destination, manifest, sourceDirectory: source.directory };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...extra] = process.argv.slice(2);
  const output = extra.length === 2 && extra[0] === '--out' ? extra[1] : undefined;
  if (!(extra.length === 0 || output !== undefined) || !['source', 'build'].includes(command)) {
    throw new Error('Usage: node crates/piui-graph-kernel/package.mjs source|build [--out <absolute directory outside the repository>]');
  }
  const result = command === 'build' ? buildNative(ROOT, output) : packageSource(ROOT, output);
  process.stdout.write(`${JSON.stringify({ directory: result.directory, sourceFingerprint: result.manifest.sourceFingerprint,
    ...(result.manifest.target ? { target: result.manifest.target, sha256: result.manifest.sha256 } : {}) })}\n`);
}
