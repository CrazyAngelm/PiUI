// Collects the Linux or macOS bundles of one release build into artifacts/
// with SHA-256 checksums (Windows uses scripts/prepare-windows-release.ps1).
//
//   node scripts/prepare-release-artifacts.mjs linux   .deb + AppImage (+ update signatures)
//   node scripts/prepare-release-artifacts.mjs macos   universal .dmg (+ .app update archive)
//
// The output folder is fixed under the repository and never follows a link.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** `SHA256SUMS.txt` lines (`<hex>  <name>`), sorted by name. */
export function checksumLines(directory) {
  return readdirSync(directory)
    .filter((name) => name !== 'SHA256SUMS.txt' && lstatSync(join(directory, name)).isFile())
    .sort()
    .map((name) => `${sha256File(join(directory, name))}  ${name}`);
}

function single(directory, pattern, description) {
  const matches = existsSync(directory) ? readdirSync(directory).filter((name) => pattern.test(name)) : [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${description} in ${directory}; found ${matches.length}.`);
  }
  return join(directory, matches[0]);
}

/** Source files and their release names for one platform. */
export function releaseFiles(bundleDirectory, platform, version) {
  const escaped = version.replaceAll('.', '\\.');
  const files = [];
  const withSignature = (source, name = basename(source)) => {
    files.push({ source, name });
    if (existsSync(`${source}.sig`)) files.push({ source: `${source}.sig`, name: `${name}.sig` });
  };
  if (platform === 'linux') {
    withSignature(single(join(bundleDirectory, 'deb'), new RegExp(`_${escaped}_[^_]+\\.deb$`), `.deb for ${version}`));
    withSignature(single(join(bundleDirectory, 'appimage'), new RegExp(`_${escaped}_[^_]+\\.AppImage$`), `AppImage for ${version}`));
  } else if (platform === 'macos') {
    withSignature(single(join(bundleDirectory, 'dmg'), new RegExp(`_${escaped}_[^_]+\\.dmg$`), `.dmg for ${version}`));
    // The update archive exists only when updater artifacts were enabled; it
    // carries no version in its name, so the release name adds one.
    const archive = join(bundleDirectory, 'macos', 'PiUI.app.tar.gz');
    if (existsSync(archive)) withSignature(archive, `PiUI_${version}_universal.app.tar.gz`);
  } else {
    throw new Error(`Unsupported platform "${platform}".`);
  }
  return files;
}

function main(argv) {
  const platform = argv[0];
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const config = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const version = String(config.version ?? '');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('tauri.conf.json does not contain a release version.');
  const targetDirectory = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'target');
  const bundleDirectory =
    platform === 'macos'
      ? join(targetDirectory, 'universal-apple-darwin', 'release', 'bundle')
      : join(targetDirectory, 'release', 'bundle');
  const files = releaseFiles(bundleDirectory, platform, version);

  // Release output is deliberately fixed under the repository; never delete
  // through a link or accept a caller-provided folder.
  const output = join(root, 'artifacts');
  if (existsSync(output)) {
    if (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory()) {
      throw new Error(`${output} is not a plain directory; refusing to replace it.`);
    }
    rmSync(output, { recursive: true, force: true });
  }
  mkdirSync(output);
  for (const file of files) copyFileSync(file.source, join(output, file.name));
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${checksumLines(output).join('\n')}\n`);
  console.log(`Prepared PiUI ${version} ${platform} release artifacts:`);
  for (const name of readdirSync(output).sort()) {
    console.log(`  ${name} (${lstatSync(join(output, name)).size} bytes)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
