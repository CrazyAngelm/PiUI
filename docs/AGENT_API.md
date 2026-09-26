# Local agent/operator API v1 and v2

PiUI exposes an opt-in loopback API to external operator agents through the same
application functions as the desktop. Use the CLI plus `skills/piui-control/`.
MCP is not required: agents with a command tool can submit JSON directly without
browser startup, UI automation or an extra MCP server. This API coordinates native
Pi, Codex, Prime and Hermes; it does not implement inference or translate history.
Protocol v1 remains available for all original methods. Calendar schedule methods
use protocol v2; `scripts/agent-api.mjs` selects v2 for those methods automatically.

## Start with API (required after each ordinary close)

Build the desktop normally (`pnpm build`, then `cargo build --release -p piui-desktop --bin
piui-desktop`). Close any previously opened PiUI normally before starting the API
host; never open two hosts against the same app data directory. On Windows:

```powershell
powershell -NoProfile -File scripts/start-agent-api.ps1 -Executable D:\Projects\PIUI\target\release\piui-desktop.exe
$env:PIUI_AGENT_API_CONNECTION = Join-Path $env:LOCALAPPDATA 'PiUI-agent-api/connection.json'
node scripts/agent-api.mjs call ping
```

For the installed Windows application, pass
`-Executable "$env:LOCALAPPDATA\Programs\PiUI\PiUI.exe"` instead. The starter
recognizes both executable names and refuses to launch while either is open.
Use a build containing the API: an older EXE can open normally while ignoring
the API environment variables. Updating source files does not update that EXE.
The ordinary desktop shortcut does not enable the opt-in API; use the starter
again after closing the application. A leftover connection file does not prove
that its host is still running. `ECONNREFUSED` means no listener accepted the
connection; verify the executable/build and restart with the starter, then `ping`.

The maintained Windows desktop entry is **PiUI (Operator API)**. Install or refresh
it without starting or stopping the application:

```powershell
powershell -NoProfile -File scripts/install-agent-api-shortcut.ps1
```

After active work finishes, close PiUI normally and double-click that entry. The
status window remains visible: `readiness: ready` includes a successful authenticated
`ping`. Existing processes cause an explicit refusal before touching connection data.
The starter serializes simultaneous clicks. It does not automatically close, kill,
resume or repeat any sessions/runs. Reopen existing sessions and inspect saved run
IDs after startup; a restart does not promise uninterrupted active execution.

The connection file is now written atomically **after successful ping**, with PID
and process start time. If startup/readiness fails it is not published, and the
started application is left alone. On the next API start, the prior file is cleared
only after proving no PiUI process is running. For cleanup alone after ordinary close:

```powershell
powershell -NoProfile -File scripts/start-agent-api.ps1 -ClearStaleConnection
```

This command refuses while any PiUI process is running. An old connection is never
used as permission to spawn another host or repeat an unknown run. The CLI's
`ECONNREFUSED` diagnostic explains this recovery path; no request was sent.

The starter generates a 256-bit capability in an owner-only directory, obtains an
available port from the OS, and starts PiUI with both environment variables. It
refuses an already running PiUI. It reports the connection file, never its token.
A port race fails at host bind; regenerate by running the starter after closing
the failed host. A successful starter result now requires authenticated `ping`; process creation alone is insufficient.
On Windows the CLI discovers the default starter connection file automatically.
The CLI also accepts `PIUI_AGENT_API_CONNECTION` or the same `PIUI_AGENT_API_PORT` and
`PIUI_AGENT_API_TOKEN` environment variables as the host. Do not print the file.

On Linux, start the built desktop from a shell with a privately generated 64-hex
`PIUI_AGENT_API_TOKEN` and a chosen free, nonzero `PIUI_AGENT_API_PORT`, then invoke
the CLI in that environment. No Windows launcher or filesystem ACL assumption is
used by the portable TCP transport. The Windows starter is Windows-only.

Without both variables the API is disabled (a partially specified configuration
fails closed). It binds only 127.0.0.1, accepts no HTTP/CORS, and authenticates before
parsing commands. The port is not a security boundary. Keep the capability with
the external operator; the native runtime strips these environment variables
before spawning managed agents. Do not add the operator connection file to their
resources. This is user-level operator authority, not an OS sandbox: full-access
local programs can read user files. Within graphs, use existing authenticated
coordinator send/observe/spawn tools and their frozen authority checks.

## Create and execute without UI

1. `call workspace` with `{ "type": "catalog" }` lists workspace IDs, trust,
   installed harnesses and native sessions. `addProject` takes `{ "path": "..." }`
   and registers a restricted project; registration does not grant trust.
   `setProjectTrust` takes `{ "projectId": "...", "trustState": "trusted" }` only
   following the user's explicit trust decision for that directory.
2. `call models` with `{ "workspaceId": "...", "harness": "codex" }` returns the
   native catalog/resources. Use its actual model IDs, reasoning levels and
   resources. Prime's query uses the host's isolated supervisor.
3. Author portable v4 JSON following `skills/piui-systems/` and the schema at
   `contracts/system-file-v4.schema.json`. All graph topology is data; no visual
   node positioning is necessary. Result, send, observe and spawn are distinct
   edges. Teams, arbitrary DAG pipelines, callable profiles, conditions, structured
   result fields, explicit reviews and approvals retain their existing semantics.
4. Prepare a **new** plan file with stable IDs, then save and run:

```text
node scripts/agent-api.mjs prepare task.piui.json WORKSPACE_ID execution-plan.json
node scripts/agent-api.mjs save execution-plan.json
node scripts/agent-api.mjs run execution-plan.json
```

Preparation uses the exact UI parser/compiler, including v1/v2/v3 compatibility
and adapter checks. It makes no API calls. Save atomically persists the profiles,
team, pipeline and launch command without executing. Run is explicit and starts
native execution immediately through the existing scheduler. When the user asks
for execution, perform these commands consecutively; no UI confirmation is needed.
The plan file must be retained before sending. Re-running `prepare` creates a new
system; never use it as a retry for an uncertain save/run.

Every method can be called with `node scripts/agent-api.mjs call METHOD params.json`
or with `-` to read JSON from stdin. `scripts/agent-api.mjs` also exports
`callApi(connection, method, params, {signal})` for programmatic use. Cancellation
of the client request only stops waiting; it does not cancel native work.

## Methods and contracts

The discriminated envelopes are in `contracts/agent-api-v1.ts` and
`contracts/agent-api-v2.ts`. DTOs are reused from `contracts/orchestration-host-v7.ts`,
`workspace-v15.ts` and `harness-models-v18.ts`.
This is a new external protocol; existing IPC and portable-file versions are unchanged.

| Methods | Parameters / result |
| --- | --- |
| `ping` | `{}`; API identity/version |
| `workspace` | WorkspaceCommand; catalog, create/open/snapshot, send/steer/follow-up, interrupt/close, rename/model, approval/input response |
| `models` | HarnessModelsRequest; native models and resources |
| `addProject`, `setProjectTrust` | Explicit path registration / trust decision, described above |
| `catalog` | WorkspaceRequest; definition summaries and revisions |
| `getProfile`, `getTeam`, `getPipeline`, `getLaunchCommand` | GetDefinitionRequest; full stored value/revision |
| `saveGraph` | SaveGraphRequest; atomic save of the complete graph |
| `saveProfile`, `saveTeam`, `savePipeline`, `saveLaunchCommand` | SaveDefinitionRequest of the corresponding type |
| `deleteProfile`, `deleteTeam`, `deletePipeline`, `deleteLaunchCommand` | DeleteDefinitionRequest; revision checked |
| `listSchedules` | Protocol v2 WorkspaceRequest; schedule snapshots, next occurrence and last outcome |
| `saveSchedule` | Protocol v2 SaveScheduleRequest; creates disabled and revision-checks edits |
| `setScheduleEnabled` | Protocol v2 SetScheduleEnabledRequest; explicit revision-bound enable or disable |
| `deleteSchedule` | Protocol v2 ScheduleMutationRequest; revision checked |
| `startRun` | StartRunRequest (optional `inputs` for the pipeline's declared run inputs); durable run and current task states |
| `listRuns`, `getRun`, `usage` | WorkspaceRequest / RunRequest / RunRequest |
| `waitRun` | RunRequest plus `afterRevision`, `timeoutMs`; current run after change or caller-selected timeout |
| `cancelRun`, `cancelTask` | RunMutationRequest / CancelTaskRequest; native cancellation |
| `controlFlow` | FlowControlRequest: pause, resume, decide, repeat |
| `reconcileTask`, `retryTask` | ReconcileUncertainTaskRequest / RetryUncertainTaskRequest |

`waitRun` subscribes before reading the durable state to avoid missed changes.
An unchanged revision after timeout means nothing changed; null means no such run.
There is no invented default polling interval or execution deadline. Choose the
wait duration for the caller's actual execution environment. Use `workspace`
`snapshot` for live text/tool blocks and pending approvals. Map run tasks to
sessions via `workspace` catalog's `runId`/`memberId`; do not guess native IDs.
Run results and dependency context remain backed by native histories. `usage`
returns available receipts; missing counters mean unavailable, not zero.

Run states may require attention: inspect tasks for failure, uncertainty, approval,
paused status and review decisions. An acknowledgement or idle session is not
proof of a successful run. Only conclude completion from durable run/task state and
expected results. Use native approval responses only within the user's authority;
never automatically approve all prompts to make a workflow advance.

Schedules target saved launch commands. They support one absolute date/time and
fixed-rate positive whole-number intervals in minutes or hours. UTC instants are
authoritative; the IANA time-zone name is retained for editing and display. The
missed-occurrence policy is explicit (`skip` or one coalesced run), as is overlap
handling (`skip` or allow). Saving never enables execution. Changing the target,
timing, either policy or the schedule's `inputs` disables the schedule and requires
a new enable action.

A pipeline may declare run `inputs`. `startRun` and schedules supply values as
`inputs: {name: value}`; declared defaults fill omitted values, and a missing
required value, an undeclared name or a value of the wrong kind is refused with
`invalid` before anything runs. A prepared plan's `start` has no values: add them
to the plan before `run` when the system requires them. Inputs are untrusted task
data shown to every agent; they never change permissions.

The host atomically records an occurrence and its frozen run before native
dispatch. A restart can resume that same prepared run; a task that crossed the
native boundary becomes uncertain through the existing recovery contract and is
never replaced. Schedules run only while the PiUI host process is active. They do
not start PiUI, wake a sleeping computer or install an operating-system task.

## Changes, retries and recovery

For saved-system edits, fetch full definitions and include their `expectedRevision`
in a single `saveGraph`. A conflict preserves the prior generation; reload and
reconcile intentionally. Saved definitions do not rewrite a frozen active run.
On connection loss, inspect `getRun` using the persisted `runId` and `get*` using
the saved definition IDs. `already-exists` is not permission to create new IDs.
Compare what exists with the intended request. A repeated start with the same ID
is rejected and cannot create a second run. If a run exists but is uncertain, use
its recorded recovery path and current revisions; never claim success by writing
native logs or fabricating a native-history reference.

For protocol-v1 host compatibility, the CLI omits `networkAccess: false` from
`saveGraph` profile values because omission has the same denied-network meaning.
It preserves `networkAccess: true`, so an older host rejects an unsupported
capability request instead of silently weakening it.

Safe mode and project trust are enforced by the existing host functions. Unsupported
settings, denied delegation escalation and conflicts propagate as errors. The API
has no arbitrary shell, raw runtime request, authenticated-sender or completion
report method. Graph creation is not permission to modify global harness config.

## Verification

`node --test scripts/agent-api.test.mjs` checks parser compatibility, topology,
escalation validation, framing and error propagation. `cargo test -p piui-desktop
--lib agent_api::tests` checks opt-in/authentication. The Windows workspace E2E
suite also exercises this API against the real host and native Codex, with an
isolated synthetic Responses provider, including result dependencies, rollback,
repeated run identity, UI visibility and safe mode. Synthetic provider evidence is
separate from real paid-provider reliability. Linux native WebView verification
must run on Linux; Windows results do not establish it.

For the isolated API-only Windows acceptance path use `pnpm agent:api:e2e`. It
uses the same owned WebView2 fixture without depending on unrelated editor flows.
