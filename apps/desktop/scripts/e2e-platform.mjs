import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');

if (process.platform !== 'win32') {
  console.error(
    'PiUI has no real Linux Tauri/WebKit E2E harness yet. The static source check is available as `pnpm test:smoke`, but it is not E2E evidence.',
  );
  process.exitCode = 1;
} else {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (!pnpmEntrypoint) {
    console.error('Cannot locate the pnpm entrypoint required to launch the Windows Tauri E2E harness.');
    process.exitCode = 1;
  } else {
    // Derived from the harness's 600 s proof-build bound, two 30 s app-start
    // bounds, and its bounded commands/cleanup.
    const result = spawnSync(
      process.execPath,
      [pnpmEntrypoint, 'run', 'test:e2e:tauri:windows'],
      { cwd: desktopRoot, stdio: 'inherit', timeout: 720_000 },
    );
    if (result.error) {
      console.error(`Windows Tauri E2E launcher failed: ${result.error.message}`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
  }
}
