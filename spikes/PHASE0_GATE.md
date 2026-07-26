# Phase 0 gate — captured decision

**Captured on:** 2026-07-23
**Pi baseline:** `0.81.1` on Windows
**Scope:** local synthetic fixtures and the bounded system-Pi checks recorded below. Results are not cross-platform claims.

## Decision

Phase 0 permits a **contained, read-only foundation slice**. It does **not** clear full product development that writes or concurrently continues real Pi sessions, ships a managed runtime, or claims Windows/Linux release readiness.

The foundation slice may register projects, scan/index Pi session files read-only, render generic history/tree projections, show trust/auth guidance, run deterministic fake-runtime scenarios, and classify system-runtime eligibility without execution. A real system Pi runtime must not be launched from an unverified `PATH` candidate; a future managed runtime requires independently verified provenance before a contained capability probe can exist. No provider request or user-session mutation is permitted.

> **Implementation note (after capture):** PiUI now contains a disabled internal manifest-verification/authorization scaffold. Its empty production keyring means production cannot mint authorization or containment evidence. A crate-private, test-only path can prepare an empty Windows Job only after its gates pass, but no launcher can consume it. PiUI also retains a bytes-only locally authored npm summary whose only disposition is `NonAuthorizing`; its reported isolated `npm audit signatures` outcome is structurally checked locally, not cryptographically authenticated from retained upstream material, and adds no key, launcher, process, session, or execution capability. It closes no evidence item below. See [`../docs/13_FOUNDATION_STATUS.md`](../docs/13_FOUNDATION_STATUS.md).

## Evidence matrix

| Spike | Result | Product decision |
|---|---|---|
| 01 session identity/no ghost files | Pass | Open an existing session with an explicit launch selector. New persistent fixture path is `--fork` + `--session-id` plus official `pi.appendEntry`; never hand-write JSONL or delete a suspected ghost file. |
| 02 shutdown/process tree | Raw Pi EOF fails; Windows host containment passes | On Windows, launch under a Job Object assigned before resume and **always** close it after graceful shutdown. EOF is not descendant cleanup. Unix process-group code exists but needs platform capture before support is claimed. |
| 03 tree navigation | Read-only pass | Render tree read-only. Do not synthesize navigation by changing JSONL parents. |
| 04 provider auth | Inconclusive | No headless login/auth UI. Direct users to authenticate with Pi in their normal terminal, then retry a capability probe. Do not read `auth.json` or expose credentials. |
| 05 extension UI | Standard corpus pass | Support only captured standard Extension UI operations with request IDs, cancellation, native fallback, and generic rendering. Do not claim full TUI/custom/header/footer parity. |
| 06 concurrent writers | Limited custom-entry append pass | Two synchronized `pi.appendEntry()` writers preserved one uniquely tagged entry each in a synthetic session. This does not prove prompt/tool/branch/merge safety; treat external file revision as conflict and never silently merge. |
| 07 managed packaging | Static inventory only | System/runtime candidate inventory is untrusted and non-executing by default. No managed runtime, update, provenance, or rollback claim. |
| 08 WebView baseline | Build/check pass; physical budgets inconclusive | Tauri/Svelte baseline remains viable, but no startup/RSS budget has been proven on the required reference machines. |
| 09 scanner compatibility | Synthetic fixtures pass | Scanner is LF-only and read-only; unknown/partial/corrupt input remains diagnosable. A real multi-version session corpus is still required. |
| 10 capabilities | Pass | Probe runtime commands tolerantly; optional actions are enabled only after successful capability responses, not by version alone. |

## Reproducible checks

```powershell
py -3.13 spikes/rpc/harness.py --codec-self-test
py -3.13 spikes/rpc/harness.py --report spikes/rpc/reports/latest.json
py -3.13 spikes/process-tree/harness.py --self-test
py -3.13 spikes/process-tree/run_tests.py
py -3.13 spikes/process-tree/harness.py --pi pi --report spikes/process-tree/reports/latest.json
py -3.13 spikes/scanner/run_tests.py
py -3.13 -m unittest discover -s spikes/packaging -p "test_*.py" -v
python tools/validate_runtime_evidence.py --check evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1
python -m unittest tools/test_validate_runtime_evidence.py -v
cd spikes/webview-baseline; pnpm check; pnpm build; pnpm cargo:check
```

## Non-negotiable implementation constraints

1. Pi session JSONL remains the source of truth and is never written by PiUI directly.
2. The frontend receives no unrestricted shell, filesystem, auth, or process API.
3. Project-local resources are not loaded before explicit project trust.
4. Runtime diagnostics are sanitized; no prompts, raw paths, credentials, URLs with secrets, or raw stderr are exported by default.
5. A safe-mode/read-only route must remain available even if runtime or extension UI fails.

## Gate to enable real session continuation

Before enabling a write-capable real-session chat flow, capture and review:

- a controlled CLI/PiUI concurrent-writer matrix with conflict semantics;
- real-session start/continue/reopen round trips without ghost sessions;
- Windows and Linux containment reports for the actual production supervisor;
- real scanner corpus compatibility for supported Pi versions; and
- an auth flow that refreshes capabilities without credential exposure.
