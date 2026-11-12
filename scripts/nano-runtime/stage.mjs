import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCES = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SOURCES, '../..');
const NODE_VERSION = '22.23.5';
const NODE_ORIGIN = `https://nodejs.org/dist/v${NODE_VERSION}`;
const NODE_BINARY_SHA256 = '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a';
const NODE_LICENSE_SHA256 = 'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4';
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_ROOT = `node_modules/${PI_PACKAGE}`;
const PI_ENTRY = `${PI_ROOT}/dist/bundle/cli.js`;
const REGISTRY = 'https://registry.npmjs.org/';
// AGENTS.md requires checking with the user before writing a file over 100 MB.
const MAX_RELEASE_FILE_BYTES = 100_000_000;
// SHA-256 digests published with the upstream x64 Windows release assets.
const WINDOWS_TOOLS = [
  {
    release: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0',
    asset: 'ripgrep-15.2.0-x86_64-pc-windows-msvc',
    sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
    entries: {
      'rg.exe': 'rg.exe',
      COPYING: 'rg-COPYING',
      'LICENSE-MIT': 'rg-LICENSE-MIT',
      UNLICENSE: 'rg-UNLICENSE',
    },
  },
  {
    release: 'https://github.com/sharkdp/fd/releases/download/v10.5.0',
    asset: 'fd-v10.5.0-x86_64-pc-windows-msvc',
    sha256: 'a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7',
    entries: {
      'fd.exe': 'fd.exe',
      'LICENSE-APACHE': 'fd-LICENSE-APACHE',
      'LICENSE-MIT': 'fd-LICENSE-MIT',
    },
  },
];
const ARCHIVE_ENTRIES = [
  'node.exe', 'node-license.txt', 'node_modules',
  ...WINDOWS_TOOLS.flatMap(({ entries }) => Object.values(entries)),
];

function run(program, args, options) {
  const result = spawnSync(program, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited with ${result.signal ?? `status ${result.status}`}.`);
}

async function writeBounded(stream, destination) {
  let written = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      callback(written > MAX_RELEASE_FILE_BYTES
        ? new Error('Nano runtime file exceeds the 100 MB workspace limit.')
        : null, chunk);
    },
  });
  await pipeline(stream, limit, createWriteStream(destination, { flags: 'wx' }));
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(url, destination, expectedHash, redirect = 'error') {
  const response = await fetch(url, { redirect });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await writeBounded(Readable.fromWeb(response.body), destination);
  if (hashFile(destination) !== expectedHash) {
    throw new Error(`SHA-256 mismatch: ${url}`);
  }
}

export function fileManifest(root, entries) {
  const files = new Map();
  function collect(path) {
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const name of readdirSync(path).sort()) collect(join(path, name));
      return;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`Unsupported Nano runtime entry: ${path}`);
    }
    const key = relative(root, path).split(sep).join('/');
    files.set(key, { sha256: hashFile(path), size: info.size });
  }
  for (const entry of entries) collect(join(root, entry));
  return Object.fromEntries(files);
}

async function streamTarToFile(args, destination) {
  const tar = spawn(join(process.env.SystemRoot, 'System32', 'tar.exe'), args, {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  const completed = new Promise((resolve, reject) => {
    tar.once('error', reject);
    tar.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with status ${code}.`));
    });
  });
  const writing = writeBounded(tar.stdout, destination).catch((error) => {
    tar.kill();
    throw error;
  });
  const results = await Promise.allSettled([writing, completed]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}

async function stageWindowsTools(stage, payload) {
  for (const tool of WINDOWS_TOOLS) {
    const zip = join(stage, `${tool.asset}.zip`);
    await download(`${tool.release}/${tool.asset}.zip`, zip, tool.sha256, 'follow');
    for (const [source, destination] of Object.entries(tool.entries)) {
      await streamTarToFile(['-xOf', zip, `${tool.asset}/${source}`], join(payload, destination));
    }
  }
}

function verifyPiVersion(stage, payload, version) {
  const output = spawnSync(join(payload, 'node.exe'), [join(payload, PI_ENTRY), '--version'], {
    cwd: stage,
    env: {
      SYSTEMROOT: process.env.SystemRoot,
      PATH: join(process.env.SystemRoot, 'System32'),
      PI_CODING_AGENT_DIR: join(stage, 'smoke-agent'),
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (output.error) throw output.error;
  if (output.status !== 0 || output.stdout.trim() !== version) {
    throw new Error(`The staged Nano Pi CLI failed its version check: ${output.stderr.trim()}`);
  }
}

export function pinnedPiVersion(lock, requestedVersion) {
  const entries = Object.entries(lock.packages ?? {}).filter(([path]) => path !== '');
  if (!/^\d+\.\d+\.\d+$/.test(requestedVersion) || lock.packages?.[PI_ROOT]?.version !== requestedVersion ||
      entries.some(([, pkg]) => !pkg.resolved?.startsWith(REGISTRY) || !pkg.integrity?.startsWith('sha512-'))) {
    throw new Error('Nano runtime lockfile must pin Pi and the integrity of every registry package.');
  }
  return requestedVersion;
}

/** Stage one Windows release. The caller owns cleanup after the build exits. */
export async function stageWindowsNanoRuntime() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The Nano runtime release payload requires a Windows x64 build host.');
  }
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!lstatSync(npm, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Build with a Windows Node.js installation that includes npm. Expected npm CLI at ${npm}.`);
  }
  const packageJson = JSON.parse(readFileSync(join(SOURCES, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(SOURCES, 'package-lock.json'), 'utf8'));
  const version = pinnedPiVersion(lock, packageJson.dependencies[PI_PACKAGE]);
  const target = join(realpathSync(ROOT), 'target');
  mkdirSync(target, { recursive: true });
  if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) {
    throw new Error('Nano runtime staging requires a plain repository target directory.');
  }
  // Retain npm's content-addressed downloads between release builds. The
  // normal target/ budget owns this cache, and npm ci verifies every hash.
  const cache = join(target, 'nano-runtime-npm-cache');
  mkdirSync(cache, { recursive: true });
  if (lstatSync(cache).isSymbolicLink() || realpathSync(cache) !== cache) {
    throw new Error('Nano runtime npm cache must be a plain directory.');
  }
  const stage = mkdtempSync(join(target, 'nano-runtime-'));
  const dispose = () => {
    const info = lstatSync(stage, { throwIfNoEntry: false });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(stage) !== stage || dirname(stage) !== target) {
      throw new Error('Nano runtime staging path changed; refusing to remove it.');
    }
    rmSync(stage, { recursive: true });
  };

  try {
    const payload = join(stage, 'payload');
    mkdirSync(payload);
    const node = join(payload, 'node.exe');
    await download(`${NODE_ORIGIN}/win-x64/node.exe`, node, NODE_BINARY_SHA256);
    await download(
      `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`,
      join(payload, 'node-license.txt'),
      NODE_LICENSE_SHA256,
    );
    await stageWindowsTools(stage, payload);
    for (const name of ['package.json', 'package-lock.json']) {
      copyFileSync(join(SOURCES, name), join(payload, name));
    }
    const userConfig = join(stage, 'user.npmrc');
    const globalConfig = join(stage, 'global.npmrc');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
      const upper = name.toUpperCase();
      return upper !== 'NODE_OPTIONS' && upper !== 'NODE_PATH' && !upper.startsWith('NPM_CONFIG_');
    }));
    run(node, [
      npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund',
      '--prefer-offline', '--no-update-notifier',
      '--registry', REGISTRY, '--cache', cache,
      '--userconfig', userConfig, '--globalconfig', globalConfig,
    ], { cwd: payload, env });
    const installed = JSON.parse(readFileSync(join(payload, PI_ROOT, 'package.json'), 'utf8'));
    if (installed.version !== version) {
      throw new Error('The staged Nano runtime is missing the pinned Pi CLI.');
    }
    verifyPiVersion(stage, payload, version);
    const manifest = fileManifest(payload, ARCHIVE_ENTRIES);
    const archive = join(stage, 'nano-runtime.tar.zst');
    const manifestPath = join(stage, 'nano-runtime-files.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    // Default zstd measured 55.1 MB and would put the complete executable over
    // 100 MB. Level 12 measured 47.5 MB without removing upstream files.
    await streamTarToFile([
      '--zstd', '--options', 'zstd:compression-level=12', '-cf', '-', '-C', payload, ...ARCHIVE_ENTRIES,
    ], archive);
    return {
      dispose,
      files: Object.keys(manifest).length,
      bytes: lstatSync(archive).size,
      env: {
        PIUI_NANO_RUNTIME_ARCHIVE: archive,
        PIUI_NANO_RUNTIME_MANIFEST: manifestPath,
        PIUI_NANO_RUNTIME_VERSION: version,
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

// Developer smoke check for the build input without rebuilding Rust or Tauri.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const staged = await stageWindowsNanoRuntime();
  try {
    console.log(`Nano runtime Pi ${staged.env.PIUI_NANO_RUNTIME_VERSION}: ${staged.files} files, ${staged.bytes} archive bytes.`);
  } finally {
    staged.dispose();
  }
}
