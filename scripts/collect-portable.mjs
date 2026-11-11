// Collects the portable Windows executable of a `--portable` build into
// artifacts/ with its SHA-256 checksum: the quick local update, no installer.
//
//   node scripts/release-build.mjs windows --portable
//
// The file is named like in a full release (`<Product>_X.Y.Z_windows_x86_64.exe`,
// from tauri.conf.json), so a shortcut to it keeps working. artifacts/ is
// replaced as a whole, like in a full release. Windows cannot delete an
// executable that is still running but can rename it: such a file is moved
// aside (`*.old`), the app keeps running and the new build takes its name.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The cargo binary; `mainBinaryName` in tauri.conf.json may rename it during `tauri build`. */
const CARGO_BINARY = 'piui-desktop';
const MOVED_ASIDE = '.old';
const IN_USE = new Set(['EBUSY', 'EPERM', 'EACCES']);

export function portableName(config) {
  const version = String(config.version ?? '');
  const product = String(config.productName ?? '').replaceAll(' ', '');
  if (!/^\d+\.\d+\.\d+/.test(version) || !/^[\w.-]+$/.test(product)) {
    throw new Error('tauri.conf.json does not contain a product name and a release version.');
  }
  return `${product}_${version}_windows_x86_64.exe`;
}

/** The executable the build just wrote: the renamed binary or the cargo one, whichever is newer. */
export function builtExecutable(releaseDirectory, config) {
  const names = [...new Set([config.mainBinaryName, CARGO_BINARY])].filter((name) => typeof name === 'string' && /^[\w.-]+$/.test(name));
  const found = names
    .map((name) => join(releaseDirectory, `${name}.exe`))
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (found.length === 0) throw new Error(`Release executable is missing: ${join(releaseDirectory, `${names[0]}.exe`)}`);
  return found[0];
}

/**
 * Empties artifacts/. A file in use is moved aside instead, so its name is
 * free; a copy moved aside earlier that still runs stays. Returns the names
 * moved aside by this call.
 */
export function clearArtifacts(output, remove = (path) => rmSync(path, { recursive: true, force: true })) {
  const aside = [];
  for (const name of readdirSync(output)) {
    const path = join(output, name);
    try {
      remove(path);
    } catch (error) {
      if (!IN_USE.has(error.code)) throw error;
      if (name.endsWith(MOVED_ASIDE)) continue;
      let moved = `${path}${MOVED_ASIDE}`;
      for (let attempt = 2; existsSync(moved); attempt += 1) moved = `${path}.${attempt}${MOVED_ASIDE}`;
      renameSync(path, moved);
      aside.push(name);
    }
  }
  return aside;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Replaces `<root>/artifacts` with the built executable and its checksum. */
export function collectPortable(root, targetDirectory = join(root, 'target')) {
  const config = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const name = portableName(config);
  const source = builtExecutable(join(targetDirectory, 'release'), config);
  // Release output is deliberately fixed under the repository; never delete
  // through a link or accept a caller-provided folder.
  const output = join(root, 'artifacts');
  const info = lstatSync(output, { throwIfNoEntry: false });
  if (info !== undefined && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error(`${output} is not a plain directory; refusing to replace it.`);
  }
  mkdirSync(output, { recursive: true });
  const aside = clearArtifacts(output);
  const destination = join(output, name);
  copyFileSync(source, destination);
  // LF line endings, so `sha256sum --check` works on every platform.
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${sha256File(destination)}  ${name}\n`);
  return { name, source, aside, bytes: statSync(destination).size };
}

function main() {
  if (process.platform !== 'win32') {
    console.error('The portable executable exists only on Windows.');
    process.exitCode = 2;
    return;
  }
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const targetDirectory = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'target');
  const result = collectPortable(root, targetDirectory);
  for (const name of result.aside) {
    console.log(`In use, moved aside: ${name} -> ${name}${MOVED_ASIDE} (the running app keeps working; restart it to use the new build)`);
  }
  console.log(`Prepared the portable executable: artifacts/${result.name} (${result.bytes} bytes)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
