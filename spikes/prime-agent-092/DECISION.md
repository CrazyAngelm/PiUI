# Prime Agent 0.9.2 live integration decision

**Status:** the documented SDK is a viable live integration route when it runs inside a PiUI-owned, per-session child process. It does not require a Prime daemon. This spike does **not** authorize use of the default Prime daemon, direct JSONL writes, strict permission modes that the adapter cannot enforce, or an unconditional “full Prime support” claim.

**Pinned package:** `prime-agent@0.9.2` on Node `>=22.8.0`.

## Decision

Use the package root export to construct:

1. `createAgentSessionServices(...)` with explicit `cwd`, `agentDir`, native auth/settings/resource policy, and telemetry policy;
2. `createAgentSessionFromServices(...)`;
3. `createAgentSessionRuntime(...)` for new/resume/fork/import replacement and session leases;
4. `InProcessAgentConnection` as the typed operation adapter; and
5. one PiUI-owned Node child per active Prime root, assigned to the platform process container **before** SDK initialization.

The test bridge uses synthetic in-memory auth and a synthetic registered streaming provider. It makes no provider request and reads no credential file. Production must instead compose Prime's exported `AuthStorage`, `SettingsManager`, `ModelRegistry`, and `DefaultResourceLoader` against a host-private, explicitly selected native Prime `agentDir`. PiUI must not parse or copy `auth.json`. Project resources remain behind the product trust decision.

The bridge requires a unique, non-default `--daemon-socket` argument as a fail-closed launch guard. It deliberately does not pass it to Prime or instantiate `DaemonClient`, `runRpcMode`, or the CLI. Dynamic startup reports `daemonContact: "none"`. This preserves the repository rule while proving that the selected SDK path creates, connects to, and stops no daemon at all.

## Why not the daemon

Prime's public daemon owns resident workers, cross-root routing, schedules, heartbeats, replay, and recovery. Even a non-default endpoint would add a second lifecycle owner beside PiUI's host process. The SDK route keeps ownership simple: Rust owns the Node child and OS container; `AgentSessionRuntime` owns the active session, RLM runtimes, kernel, and graceful async disposal.

`InProcessAgentConnection` explicitly rejects daemon-only coordination. A UI must capability-gate those operations rather than retrying through the user's default daemon.

## Proven lifecycle

`tests/test_lifecycle.py` ran the real installed package on Windows with an isolated workspace, session root, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, and `XDG_CONFIG_HOME`.

- Prompt-free startup returned state and created no JSONL file.
- Explicit flush created one valid v3 session header in the isolated session root.
- `newSession()` created a distinct session and `switchSession()` resumed the first ID.
- A traversal resume was rejected and the host stayed usable.
- A synthetic provider drove the real `ipython` tool through `promptAndWait()` without network or billing.
- The kernel called native `rlm(...)`; a real child runtime reached terminal status `done`.
- `abort()` plus `abortBash()` reaped a native bash fixture's child and grandchild.
- EOF aborted activity, awaited `InProcessAgentConnection.dispose()`, and reaped the kernel tree.
- Forced host failure was contained by the owner process-tree kill; the host, child, and grandchild were all gone.

The test launcher uses an explicit `--kernel-python` which is validated and passed as `PRIME_AGENT_KERNEL_PYTHON`. This avoids interactive bootstrap and uses the already installed Prime kernel runtime executable. The executable is code, not a session or credential store. Kernel state and session artifacts remain under the isolated fixture directories.

The test contains separate Windows and Unix process-container branches. Only Windows was executed for this report. Linux must run the same test in CI before claiming Linux containment.

## Operation surface

The exact method inventory is frozen in `reports/latest.json` from the installed declaration file.

### Dynamically proven in this spike

- state: `getState`, session ID/file and idle state;
- lifecycle: `newSession`, `switchSession`, `dispose`;
- prompting/tooling: `promptAndWait`, native `ipython`, `executeBashAndWait`;
- cancellation: `abort`, `abortBash`;
- RLM: native child creation and terminal snapshot through `getRlmChildSnapshots`.

### Exported in-process adapter surface, not all dynamically exercised here

Snapshots/messages/resources/model catalog/session stats/tree/listing; prompt/steer/follow-up and queue management; model/thinking/service-tier/transport controls; compaction/refinement/retry/reload; fork/tree navigation/import/export/naming; RLM max-depth controls; saved-session rename/delete; and direct child `watchSession`. Consumers must preserve typed failures and capability-gate operations that need configuration absent from a given session.

### Explicitly unavailable without host controllers or daemon mode

- cross-session `sendAgentMessage` and agent-message safety controls;
- schedules and heartbeat mutation;
- global active-session observation/attach/replay.

Native RLM spawning and child result lifecycle work in-process. However, the Python `agent_message` and `agent_observe` skills are removed when no `AgentSessionMessageController` / `AgentObserveController` is supplied. The root package exports the controller **types**, not a ready in-process coordinator. Therefore ordinary RLM children cannot be advertised as having explicit family messaging/observation until PiUI's coordinator injects compatible controllers and adds integration tests. Automatic RLM terminal result delivery to the parent still works.

## Permission and trust boundary

- `native`: preserve Prime's configured native policy; do not claim an OS sandbox.
- `read-only` or `workspace-write`: reject unless the owning adapter can enforce it. The SDK alone does not prove these strict modes.
- `full-access`: only an explicit user choice may enable bypass behavior.
- Never load project extensions, skills, prompts, themes, or context before trust.
- Never write the active JSONL except through the SDK runtime.
- Do not render raw extension or tool HTML in the WebView.

## Initialization timeout diagnosis

A stage-only diagnostic completed the credential-free Prime 0.9.2 path twice in about four seconds. The native-home/no-extension run measured 3.54 seconds for SDK import, 206 milliseconds for resource creation, 240 milliseconds for session/runtime creation, and less than 6 milliseconds for each of extension binding, state, model catalog, and disposal. It did not access credentials or sessions, call a provider, or contact a daemon.

The installed SDK's `createAgentSessionFromServices()` selects the initial model through `findInitialModel()`, which calls `ModelRegistry.refreshAvailableModels()`. With configured Prime team credentials and a cache miss, that path performs a model-catalog request whose upstream timeout is 10 seconds. PiUI's adapter also calls `connection.getAvailableModels()` before completing `initialize`, causing another refresh operation (normally cache-backed after the first call). Global extensions are a second configuration-dependent stage that the safe diagnostic intentionally did not execute.

A separate root E2E also completed Prime's actual zero-turn initialization through the contained native supervisor when run with an empty native home and credential-free environment. This covers the stdin-fed bridge bootstrap and request/response supervisor path that the stage-only Node diagnostic does not. It confirms that the core supervisor/adapter path completes inside the existing watchdog when user resources and credentials are absent. A corresponding safe Pi native-supervisor probe returned the explicit typed failure `The Pi runtime could not authenticate the selected model.` and then disposed cleanly, confirming that an authentication/environment blocker is reported as failure rather than success.

After the redundant refresh change, the contained live Prime proof also passed against the current native environment and real configured provider. Its 26.59-second total covered multiple separately watched operations: initial native model selection, explicit nonempty `models()`, one exact-marker prompt with no tool use, explicit `Succeeded`, graceful disposal, and ordinary resume with the same native identity and history. Every operation remained inside the unchanged per-operation watchdog. PiUI did not inspect, log, modify, or copy native authentication/settings, and the SDK did not use the inert unique daemon guard.

The earlier Prime 20-second failure therefore remains environment-dependent uncertainty, not evidence of a generic SDK, bridge-bootstrap, or supervisor failure. Credential refresh, the native initial model-catalog refresh, and global extensions are candidate stages; no evidence identifies one as the prior cause. The successful current native run proves the full configured path works with cached native registry state after the adapter change, but does not retroactively identify the earlier transient. Native session create/open happens only after PiUI first paint and explicit user action, so this work does not itself violate the first-paint rule. The watchdog remains unchanged.

The adapter now reuses `runtime.services.modelRegistry.getAvailable()` after native session construction instead of invoking a redundant second synchronous refresh during `initialize`. The explicit `models()` operation still uses `connection.getAvailableModels()` and preserves Prime's native refresh semantics. A fixture compatibility test proves one authoritative refresh during native initialization and a second refresh only after explicit `models()`. This evidence requires no supervisor API change. A staged asynchronous readiness API would be a separate product requirement, not a timeout workaround justified by this probe.

## Required production shutdown

1. stop accepting commands;
2. call typed abort methods for active model/bash work;
3. await idle where applicable;
4. await `InProcessAgentConnection.dispose()`;
5. close the child stdin/stdout transport; and
6. close/kill the OS job or process group as the descendant-containment backstop.

EOF is a graceful shutdown request, not containment by itself. A Windows Job Object with kill-on-close and a Unix process group are still mandatory.

## Remaining gates

- Inject and prove native family messaging/observation, or mark them unavailable.
- Exercise native production auth/model/resource composition without PiUI reading credentials and without loading untrusted project code.
- Run the containment suite on Linux.
- Test production host schema projection/redaction and malformed bridge frames.
- Prove packaged-app Job assignment occurs before SDK/kernel/subagent creation.
