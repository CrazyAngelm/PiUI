import { spawnSync } from 'node:child_process';

// Keep the mutation gate focused enough for an inner-loop/CI validation while
// covering correctness-critical catalog reconciliation transitions and the
// path-free local preference codec that controls persisted Appearance state.
const result = spawnSync(
  'cargo',
  [
    'mutants',
    '--file',
    'crates/piui-index/src/lib.rs',
    '--re',
    'verify_discovered_sessions_batch|discover_sessions_for_project_incremental|commit_verified_project_discovery_batch|encode_preferences|decode_preferences',
    // Windows developer-mode symlink policy can prevent a copied workspace
    // when node_modules contains links; cargo-mutants restores every mutation
    // itself in this explicit in-place mode.
    '--in-place',
    '--timeout',
    '120',
    '--',
    '--package',
    'piui-index',
  ],
  { stdio: 'inherit' },
);

process.exitCode = result.status ?? 1;
