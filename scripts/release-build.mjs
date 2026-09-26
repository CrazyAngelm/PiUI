// Builds the release packages for one platform and collects them in
// artifacts/ with SHA-256 checksums:
//
//   node scripts/release-build.mjs windows   NSIS installer + portable executable
//   node scripts/release-build.mjs linux     .deb + AppImage
//   node scripts/release-build.mjs macos     universal .app (update archive) + .dmg (experimental)
//
// Code signing and signed update artifacts are added only when their
// environment variables are present (see scripts/release-config.mjs and
// docs/RELEASING.md); without them this is the plain unsigned build.
// `--dry-run` prints the plan without building anything.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORMS, ReleaseConfigError, releaseConfig, writeReleaseConfig } from './release-config.mjs';

const BUNDLES = { windows: 'nsis', linux: 'deb,appimage', macos: 'app,dmg' };
const MACOS_TARGET = 'universal-apple-darwin';

/** The commands for one platform; `configPath` is the optional Tauri fragment. */
export function releasePlan(root, platform, { configPath, windowsSigning, tauriCli, node = process.execPath }) {
  const build = [node, tauriCli, 'build', '--ci', '--bundles', BUNDLES[platform]];
  if (platform === 'macos') build.push('--target', MACOS_TARGET);
  if (configPath) build.push('--config', configPath);
  const collect =
    platform === 'windows'
      ? [
          'powershell',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(root, 'scripts', 'prepare-windows-release.ps1'),
          ...(windowsSigning ? ['-RequireSignature'] : []),
        ]
      : [node, join(root, 'scripts', 'prepare-release-artifacts.mjs'), platform];
  return [
    { cwd: join(root, 'apps', 'desktop'), command: build },
    { cwd: root, command: collect },
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
  if (!PLATFORMS.includes(platform)) {
    console.error(`Usage: node scripts/release-build.mjs <${PLATFORMS.join('|')}> [--dry-run]`);
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
  for (const notice of result.notices) console.log(notice);
  const tauriCli = createRequire(join(root, 'apps', 'desktop', 'package.json')).resolve('@tauri-apps/cli/tauri.js');
  const plan = releasePlan(root, platform, {
    configPath: result.config === null ? undefined : result.path,
    windowsSigning: result.windowsSigning !== null,
    tauriCli,
  });
  for (const step of plan) {
    console.log(`> ${step.command.join(' ')}`);
    if (!dryRun) run(step);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
