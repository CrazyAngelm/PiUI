# PiUI Phase 0 RPC spike harness

Portable Python 3.13 harness for SPIKE-01/02/03/04/05/06/10. It creates a fresh temporary `PI_CODING_AGENT_DIR`, session directory, and cwd for every run. It only opens a generated synthetic v3 JSONL session with ordinary UUIDv4 header/entry IDs and never discovers, reads, changes, or reports a real Pi session, prompt, or `auth.json`.

## Run

```bash
python3.13 spikes/rpc/harness.py --codec-self-test
python3.13 spikes/rpc/harness.py --pi pi --report spikes/rpc/reports/latest.json
# CI/G0 gate: exits 2 unless every required RPC spike passes.
python3.13 spikes/rpc/harness.py --pi pi --report spikes/rpc/reports/latest.json --require-g0
```

`--keep-sandbox` retains the generated temporary directory for local debugging; do not use it with real user data. The report is sanitized recursively and value-aware: prompt/content/auth/path fields, access/refresh tokens, passwords, secrets, credentials, path-shaped values, and URLs containing credentials or secret query values are redacted. Safe endpoint URLs retain only useful non-secret semantics. `pi --version` output is parsed as a strict version token, never retained raw. `reports/.gitignore` keeps only the current sanitized `latest.json`; ad-hoc verification reports are intentionally ignored.

## Safety boundary

The child process is launched with `--offline`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `--no-tools`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, and `--no-approve`. Its environment has only executable/system essentials plus temporary Pi directories; provider credential variables are not inherited. The bounded exceptions are SPIKE-01, which explicitly loads `fixtures/persist_session_fixture.ts` and forks a synthetic source tree, SPIKE-05, which explicitly loads `fixtures/rpc_ui_fixture.ts`, SPIKE-06, which explicitly loads `fixtures/concurrent_append_fixture.ts` for session-start custom appends, and SPIKE-02, which sends the documented direct `bash` RPC command to run only `fixtures/child_fixture.py` in the temporary sandbox.

These measures request Pi's offline mode and disable project-discovered resources; no prompt is submitted to a provider. They are **not** an OS firewall, container, or process-tree sandbox, and package-provided behavior can still appear in capability output. The harness does not claim a network-blocking guarantee or cross-platform process cleanup.

## What is measured

- **SPIKE-01:** tests four synthetic paths: explicit existing `--session` launch, expected new persistent `--fork <synthetic source> --session-id <generated id>` creation through the harness-owned `pi.appendEntry()` command, `switch_session` to a second existing file, and forced crash. The new-session path requires exactly one JSONL file with the generated ID and validated synthetic custom entry. Every path snapshots temporary JSONL files and verifies identity; no user session is inspected.
- **SPIKE-02:** closes stdin while idle, then separately dispatches documented direct `bash` against the foreground synthetic child fixture, waits for its ready file, closes stdin, and verifies Pi exit plus child liveness. Any surviving child is forcibly cleaned up. This is a current-platform direct-bash result only, not a cross-platform or model-tool/process-tree guarantee.
- **SPIKE-03:** probes `get_tree`; documents the absence of a documented direct navigation RPC and the unverified narrow bridge option.
- **SPIKE-04:** records headless auth as inconclusive when no documented RPC auth endpoint exists. It never invokes login.
- **SPIKE-05:** captures and compares a sanitized method/event-shape corpus against `fixtures/extension_ui.golden.json`, returns synthetic cancellation for dialogs, and proves completion after cancellation. Timeout behavior is explicitly inconclusive because this fixture has no timeout-bearing request.
- **SPIKE-06:** starts two isolated RPC processes against one synthetic session on a thread barrier. A harness-owned session-start extension appends distinct safe custom entries through `pi.appendEntry()`; each process must acknowledge `get_state`/`get_tree` for the same session, and the final LF JSONL must parse with both tags persisted exactly once. This is bounded custom-entry append evidence only, never multi-turn/tool/branch safety.
- **SPIKE-10:** records a strictly parsed executable version plus `get_state`, `get_tree`, `get_commands`, and `get_available_models` probes. It passes only when every required probe explicitly returns `success: true`; opaque/unknown fields are otherwise preserved by policy.

The LF decoder operates on `os.read()` bytes, splits only `0x0A`, accepts an immediately preceding `0x0D`, rejects invalid UTF-8/JSON and partial EOF frames, and its self-test includes U+2028 inside JSON text. It intentionally does not use `readline`, text-mode stdout, or universal line splitting. On Windows, npm's `pi.cmd` is invoked through `cmd /d /c call` with separate argv elements; this preserves paths containing spaces and Unicode.

## Result interpretation

`pass` means only the named bounded check succeeded on the current machine/version. `fail` means that bounded check did not succeed. `inconclusive` means the safety boundary deliberately prevents a stronger conclusion. `--require-g0` treats every required RPC spike (01/02/03/04/05/06/10) as mandatory and exits nonzero for either result, so successful harness execution is not G0 approval. Reports must not be used to claim Windows/Linux parity; run separately on each platform and retain the resulting report outside source control if it includes local operational metadata.
