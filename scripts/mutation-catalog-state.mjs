import { spawnSync } from 'node:child_process';

// Exercise the host-side freshness state machine independently from the
// index parser gate. These transitions decide whether the UI may call a
// catalog `current` after a bounded reconciliation.
const result = spawnSync(
  'cargo',
  [
    'mutants',
    '--file',
    'apps/desktop/src-tauri/src/state.rs',
    '--re',
    'CatalogRefreshStore',
    '--in-place',
    '--timeout',
    '120',
    '--',
    '--package',
    'piui-desktop',
  ],
  { stdio: 'inherit' },
);

process.exitCode = result.status ?? 1;
