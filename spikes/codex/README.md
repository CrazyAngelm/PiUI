# Codex native app-server spike

This spike pins and probes the native Codex app-server contract for `codex-cli 0.147.0`.
It does not run a model turn or read user Codex auth/config/session files.

## Run

Windows with Python 3.13+, Rust 1.85+, and Codex 0.147.0 on `PATH`:

```powershell
py -3.13 spikes/codex/run_tests.py
```

Or run the live probe directly:

```powershell
py -3.13 spikes/codex/probe.py --report spikes/codex/reports/latest.json
```

The run:

1. resolves the installed native Codex executable and verifies its package manifest/hash;
2. regenerates experimental TypeScript and JSON Schema into a disposable directory;
3. validates the pinned handshake/thread/turn/stream/approval fixture;
4. builds the spike-only launcher that reuses `piui-platform::WindowsJob`;
5. starts app-server with a disposable `CODEX_HOME` and credential-free environment;
6. exercises initialize, zero-turn start/materialize/read/resume/list and local failures;
7. starts a fixed process-tree fixture through native `process/spawn` and proves Job cleanup;
8. deletes disposable generated protocol, home, sessions, and fixture processes.

Raw protocol payloads and stderr are never written to the report. Reports contain only
booleans, counts, version/hash provenance, method names, and classified error codes.

## Files

- `DECISION.md` — source-backed integration contract and remaining gaps.
- `probe.py` — bounded native integration and generated-schema validator.
- `native-bridge/` — Windows-only spike launcher using PiUI's real Job primitive.
- `fixtures/protocol-contract-0.147.0.json` — reviewed generated-contract subset.
- `fixtures/stream-and-approval.synthetic.jsonl` — prompt-free multiplex fixture.
- `reports/verification.json` — checked-in evidence from the captured Windows run.

## Scope limits

- No `turn/start`, auth, MCP, or real approval request is exercised.
- The Codex-specific Linux process-group path is not captured.
- Reconnect/replay, live interrupt ordering, approval timeout/disconnect behavior, and
  authenticated model/catalog behavior remain unproven.
- `process/spawn` is an unsandboxed host API. This probe uses only fixed internal argv;
  it must never be exposed as user-controlled WebView input.
