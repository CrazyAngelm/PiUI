// Builds the release packages for one platform and collects them in
// artifacts/ with SHA-256 checksums:
//
//   node scripts/release-build.mjs windows   NSIS installer + portable executable
//   node scripts/release-build.mjs linux     .deb + AppImage
//   node scripts/release-build.mjs macos     universal .app (update archive) + .dmg (experimental)
//   node scripts/release-build.mjs windows --portable   portable executable only: the quick local update
//
// Code signing and signed update artifacts are added only when their
// environment variables are present (see scripts/release-config.mjs and
// docs/RELEASING.md); without them this is the plain unsigned build.
// `--dry-run` prints the plan without building anything. Every build ends by
// pruning the Cargo cache (scripts/build-cache.mjs): target/ stays, so the next
// build is incremental, but only within its size budget.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORMS, ReleaseConfigError, releaseConfig, writeReleaseConfig } from './release-config.mjs';

const BUNDLES = { windows: 'nsis', linux: 'deb,appimage', macos: 'app,dmg' };
const MACOS_TARGET = 'universal-apple-darwin';

/**
 * The commands for one platform; `configPath` is the optional Tauri fragment.
 * `portable` skips the installer and collects only the Windows executable.
 */
export function releasePlan(root, platform, { configPath, windowsSigning, tauriCli, node = process.execPath, portable = false }) {
  const build = [node, tauriCli, 'build', '--ci', ...(portable ? ['--no-bundle'] : ['--bundles', BUNDLES[platform]])];
  if (platform === 'macos') build.push('--target', MACOS_TARGET);
  if (configPath) build.push('--config', configPath);
  let collect = [node, join(root, 'scripts', 'prepare-release-artifacts.mjs'), platform];
  if (portable) {
    collect = [node, join(root, 'scripts', 'collect-portable.mjs')];
  } else if (platform === 'windows') {
    collect = [
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'scripts', 'prepare-windows-release.ps1'),
      ...(windowsSigning ? ['-RequireSignature'] : []),
    ];
  }
  return [
    { cwd: join(root, 'apps', 'desktop'), command: build },
    { cwd: root, command: collect },
    { cwd: root, command: [node, join(root, 'scripts', 'build-cache.mjs'), 'prune'] },
  ];
}

function run({ cwd, command }) {
  const [program, ...args] = command;
  const result = spawnSync(program, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main(argv) {
  const platform = argv.find((argument) => !argument.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  const portable = argv.includes('--portable');
  if (!PLATFORMS.includes(platform) || (portable && platform !== 'windows')) {
    console.error(`Usage: node scripts/release-build.mjs <${PLATFORMS.join('|')}> [--portable (windows only)] [--dry-run]`);
    process.exitCode = 2;
    return;
  }
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let result;
  try {
    result = dryRun ? { ...releaseConfig(process.env, platform), path: '<target/release-config/tauri.release.conf.json>' } : writeReleaseConfig(root, process.env, platform);
  } catch (error) {
    if (!(error instanceof ReleaseConfigError)) throw error;
    console.error(`Release configuration error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (portable && result.config !== null) {
    console.error('A portable build is unsigned and has no updater. Unset the signing and updater variables, or run the full release.');
    process.exitCode = 1;
    return;
  }
  // In GitHub Actions each line also becomes a run annotation.
  const annotate = process.env.GITHUB_ACTIONS === 'true' ? '::notice::' : '';
  for (const notice of result.notices) console.log(`${annotate}${notice}`);
  const tauriCli = createRequire(join(root, 'apps', 'desktop', 'package.json')).resolve('@tauri-apps/cli/tauri.js');
  const plan = releasePlan(root, platform, {
    configPath: result.config === null ? undefined : result.path,
    windowsSigning: result.windowsSigning !== null,
    tauriCli,
    portable,
  });
  for (const step of plan) {
    console.log(`> ${step.command.join(' ')}`);
    if (!dryRun) run(step);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
