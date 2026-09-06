# Prime Agent 0.8.1 evidence spike

This spike records the smallest reproducible evidence for PiUI’s read-only Prime Agent history and runtime-scoped global extension settings lane, plus the evidence that keeps live control disabled. It is version-pinned to installed package `prime-agent@0.8.1` and fails closed for a different version or protocol shape. The version-specific Pi/Prime extension comparison and runtime boundary are recorded in [`EXTENSIONS.md`](EXTENSIONS.md).

## Safety boundary

`probe.py` is static and non-executing. It requires an explicit installed package root, reads the fixed relative files in `probe.ALLOWLIST`, and recursively reads only literal relative `.js` imports below the manifest entrypoint `dist/bundle/cli.js`. Every file in that launched bundle closure is hashed in the report; a missing or escaping import fails closed.

It does **not**:

- start `prime-agent`, a daemon, a worker, a provider request, or a browser;
- discover or open `~/.prime/agent/sessions/`;
- read `auth.json`, prompts, harness artifacts, session artifacts, logs, or environment values;
- emit absolute package paths or source text into its report;
- write anything outside an optional caller-selected report path.

Any separate dynamic Prime test must also use an explicit non-default daemon
socket. Isolating only `PRIME_AGENT_SESSION_DIR` still connects the process to
the user's global Prime supervisor. The Rust live tests therefore refuse to
run without `PIUI_PRIME_AGENT_DAEMON_SOCKET` (for example,
`\\.\pipe\piui-prime-live-<unique-id>` on Windows or an absolute
`/tmp/piui-prime-live-<unique-id>.sock` path on Unix).

Production Prime live control is therefore fail-closed as `NOT_SUPPORTED`.
The static report hashes `dist/bundle/cli.js` and its complete literal local
import closure and records the shared-daemon markers found there. This binds
the compatibility observation to the installed bytes, but it is still not
signature/provenance or execution evidence. The spike authorizes read-only
discovery and runtime-scoped global extension settings only, not process
launch.

The synthetic JSONL fixture and session-selection tests contain no real user data. The fixture decoder splits only on LF byte `0x0A`; U+2028 remains payload text, CRLF input is accepted, and an unterminated final record is rejected.

## Run

Python 3.13 or newer is required, matching the other Phase 0 spike entrypoints.

```bash
python3.13 spikes/prime-agent/run_tests.py
python3.13 spikes/prime-agent/probe.py \
  --package-root <global-node-modules>/prime-agent \
  --report spikes/prime-agent/reports/latest.json
```

On Windows:

```powershell
py -3.13 spikes/prime-agent/run_tests.py
py -3.13 spikes/prime-agent/probe.py `
  --package-root "$env:APPDATA/npm/node_modules/prime-agent" `
  --report spikes/prime-agent/reports/latest.json
```

The probe exits `0` only when all static checks pass. It exits `2` for a different version, a missing fixed or imported bundle file, an escaping bundle import, or a changed contract anchor.

## What is fixed by evidence

| Check | Evidence boundary | Product implication |
|---|---|---|
| Package and launched bundle identity | `package.json` plus `dist/bundle/cli.js` and every literal local imported chunk | The captured decision applies to the exact reported `0.8.1` bundle closure; it is not a signature or launch authorization. |
| LF JSONL | package RPC JSONL implementation | Use the existing PiUI LF-only codec. Never use a Unicode line reader. |
| RPC resume | CLI parser, session resolver, sessions docs | Existing persisted work is opened with an explicit path/ID selector; bare `--resume` is interactive-only. |
| Flat session root | config, migration, session manager, README | By default, sessions are flat JSONL under `~/.prime/agent/sessions/`; `PRIME_AGENT_SESSION_DIR` and its legacy alias can override the root. Project membership comes from header `cwd`. |
| Prime surface | RPC dispatcher plus AgentSession emit sites | `get_state` includes goal; live session events include goal, RLM-child, and refinement updates. |
| Lifecycle/lease | RPC EOF path, daemon docs, and launched bundle markers | RPC waits for idle on EOF and worker leases exist, but the launched client reaches a shared detached supervisor that PiUI does not own; live control stays disabled. |
| Auth gap | RPC command cases, built-in slash command list, RPC docs | `0.8.1` has no typed RPC login/auth command. PiUI must not inspect `auth.json` or pretend `/login` is a headless API. |
| Extension boundary | config, extension docs, loader aliases, virtual modules, public types | Prime has its own global/project roots and exposes Pi-named source aliases plus Prime-only hooks. This is a partial source-compatibility surface, not proof of a universal Pi extension ABI. |

`fixtures/prime-rpc-events.synthetic.jsonl` freezes safe representative shapes for `goal_update`, `rlm_child_update`, `refine_complete`, `refine_failed`, and a text delta containing U+2028. It proves LF decoding and value preservation only; it is not copied from a user session. Generic fallback remains a product integration test.

## Extension interpretation

Prime Agent `0.8.1` documents `~/.prime/agent/extensions/` and `.prime/agent/extensions/`, while Pi uses its own configured agent root. Prime maps both current and legacy Pi package import names to its bundled modules, so a source extension that uses only their shared subset can work. The public APIs are not identical, however: Prime adds refinement hooks, while the locally compared `@earendil-works/pi-coding-agent@0.82.1` API has hooks and context fields that Prime `0.8.1` does not expose. PiUI therefore keeps inventories, enablement, commands, and UI contributions runtime-scoped. It never copies or auto-enables an extension across roots.

## Result interpretation

`pass` means the fixed installed sources and the recursively discovered literal local entrypoint closure expose the named contract anchors, and the report records their exact hashes. It is not registry signature verification, source attestation, execution, containment, or launch authorization. It does not mean a provider call, OAuth flow, real session resume, concurrent-open failure, descendant cleanup, or packaged Tauri flow ran successfully.

Those dynamic paths remain product integration/E2E work. In particular:

- a real `session_already_active` result must become a visible conflict state, not an automatic retry;
- PiUI still owns process-group/Windows Job Object containment and must not rely on EOF alone for arbitrary descendants;
- authentication needs a separately approved controlled interactive/external flow;
- raw Prime event payloads can contain paths or user-derived summaries, so the host must project a bounded allowlist and keep generic fallback.
