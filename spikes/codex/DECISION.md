# Codex app-server integration spike decision

Status: **GO for a version-pinned thin runtime adapter; keep live turns gated until a coordinated authenticated probe.**

Captured on Windows x64 against `codex-cli 0.147.0`. The checked-in report is
[`reports/verification.json`](reports/verification.json). No `turn/start`, auth request,
MCP request, or model request was sent.

## Sources and provenance

1. Installed npm manifest: `%APPDATA%/npm/node_modules/@openai/codex/package.json`
   (`0.147.0`, repository `github.com/openai/codex`).
2. Installed native manifest beside the executable:
   `vendor/x86_64-pc-windows-msvc/codex-package.json` (`0.147.0`, entrypoint
   `bin/codex.exe`). The verified executable SHA-256 is in the report.
3. This CLI's official generators:
   `codex app-server generate-ts --experimental --out <temp>` and
   `codex app-server generate-json-schema --experimental --out <temp>`. The probe
   generated 723 TypeScript and 361 JSON schema files, checked the relevant unions and
   fields, and recorded the v2 bundle SHA-256. Generated output is disposable because it
   contains no embedded generator version; the version/package checks and generation
   happen in the same run.
4. Versioned upstream documentation:
   <https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/README.md>.
   It defines the lifecycle, approvals, and stdio JSONL framing.
5. PiUI containment source:
   `crates/piui-platform/src/containment/windows_job.rs`. The spike-only bridge consumes
   this exact crate. It creates the target suspended, assigns it to a verified
   `KILL_ON_JOB_CLOSE` Job, resumes it, then requires `active_process_count() == 0`
   after force termination before success.

## Wire and handshake

Stdio is newline-delimited UTF-8 JSON. Split only at byte `0x0A`. The protocol is
JSON-RPC 2.0 semantics with the `"jsonrpc":"2.0"` member omitted on the wire.
Requests are `{method,id,params}`, notifications omit `id`, success is `{id,result}`,
and failure is `{id,error:{code,message,data?}}`.

Each connection must perform this sequence before any other method:

1. Send `initialize` with
   `{clientInfo:{name,title,version},capabilities:{experimentalApi,requestAttestation,...}}`.
2. Wait for the matching `{id,result}`. The result has `userAgent`, `codexHome`,
   `platformFamily`, and `platformOs`.
3. Send the notification `{method:"initialized"}` with no `params`.

Responses, notifications, and server-initiated requests share stdout. Dispatch a response
only when its ID matches an outstanding client request and the frame has `result` or
`error` but no `method`. Dispatch server requests by both `method` and their independent
ID. Preserve unknown notifications as generic events instead of failing the session.

## Thread contract

| Operation | Request | Result / observed rule |
|---|---|---|
| Create | `thread/start` | Returns thread plus effective model/provider/cwd/approval/sandbox settings and emits `thread/started`. A zero-turn thread is idle and is not necessarily materialized or listable. |
| Resume | `thread/resume {threadId,...}` | Prefer ID. For non-running threads, generated docs define precedence `history > non-empty path > threadId`; do not use unstable `history` or `path` in core. Supports `excludeTurns` and `initialTurnsPage`. |
| List | `thread/list {cursor?,limit?,sortKey?,sortDirection?,modelProviders?,sourceKinds?,archived?,sectionId?,cwd?,...}` | Returns `{data,nextCursor,backwardsCursor}`. Cursors are opaque. No client default page size was invented. |
| Read | `thread/read {threadId,includeTurns?}` | Returns `{thread}`. Use `includeTurns` only when full hydration is intended. Prefer `thread/turns/list` and `thread/items/list` for paginated history. |

A prompt-free two-process probe showed that `thread/start` can return both an ID and a
string path while no file exists; after graceful EOF a fresh app-server rejected
`thread/resume` with `-32600`. The probe then used experimental `thread/inject_items` only
to materialize a synthetic local zero-turn thread. Native `thread/read` and
`thread/resume` succeeded after injection. `thread/list` returned a valid empty page and
did not expose that fixture. Therefore neither start success nor a non-null path proves a
durable history. PiUI identifies a new Codex thread immediately but marks its snapshot
`materialized:false`, so the host must not persist a resumable native reference until the
first accepted turn flips it to true. A successful ordinary native resume starts as
`materialized:true`. Binding events carry identity only and are not persistence proof.
Pi JSONL remains PiUI's source of truth for Pi sessions; adding Codex support must not
turn Codex rollout files into a second Pi chat format.

## Turn and stream contract

`turn/start` requires `threadId` and `input`. Text input is
`{type:"text",text,text_elements}`. It returns `{turn}`; execution begins with
`turn/started`. `turn/interrupt` requires both `threadId` and `turnId` and returns `{}`.
The no-active-turn failure was observed as code `-32600`.

Minimum lifecycle to normalize:

`turn/started` -> `item/started` -> zero or more deltas/progress -> `item/completed` ->
`turn/completed`.

Relevant deltas include `item/agentMessage/delta`, reasoning summary/text deltas,
`item/plan/delta`, `item/commandExecution/outputDelta`, terminal interaction,
`item/fileChange/patchUpdated`, MCP progress, `turn/diff/updated`, and
`turn/plan/updated`. Final turn status is `completed`, `interrupted`, `failed`, or
`inProgress`. The probe validates these exact generated method names and a synthetic
interleaved JSONL fixture, but did not prove ordering, replay, or interrupt races against
a real turn.

## Approval contract

Approvals are server-to-client requests, not notifications. The client must return a
normal response with the same request ID.

- `item/commandExecution/requestApproval` ->
  `{result:{decision:"accept"|"acceptForSession"|"decline"|"cancel"|typed amendment}}`.
- `item/fileChange/requestApproval` ->
  `{result:{decision:"accept"|"acceptForSession"|"decline"|"cancel"}}`.
- `item/permissions/requestApproval` returns a granted permission profile and scope; it is
  not an accept/decline enum.
- Version 0.147.0 still advertises legacy `execCommandApproval` and
  `applyPatchApproval`, whose `ReviewDecision` enum is different.
- `serverRequest/resolved {threadId,requestId}` clears a pending prompt, including
  multi-client/lifecycle cleanup.

Unsupported mandatory requests must fail visibly. Never auto-accept. Preserve Codex's
native configured permission policy unless the user explicitly chooses a stricter mode
that the adapter can enforce or explicitly chooses bypass/full access.

## Startup and ownership decision

The safe probe constructs a new disposable `CODEX_HOME`, passes an environment allowlist
that excludes auth/token/key variables, sets analytics false, and disables `apps`,
`plugins`, `remote_plugin`, `recommended_plugins`, and `shell_snapshot`. A preliminary
isolated default control attempted an unauthenticated featured-plugin warmup, so the
prompt-free evidence run disables that path and does not use startup network absence as
an auth proof. The disposable home is the auth/session isolation boundary and is deleted
without reading its rollout contents.

On Windows, launch the native executable suspended and assign it to PiUI's Job before
resume. The live probe used Codex `process/spawn` with fixed harness-owned argv to start a
root plus grandchild without a model turn. Both PIDs were live before EOF. After EOF and
host containment, the Job reported zero active processes and both were dead. A clean
app-server exit alone is not cleanup evidence.

The Codex-specific Linux containment path was not run. Production Linux must create a
dedicated process group before exec, terminate the negative PGID, reap the root, and
verify descendants. Existing `UnixProcessGroup` tests prove the generic primitive, not a
Codex capture. Job/process-group escape mechanisms remain an OS-level residual and must
not be presented as a sandbox guarantee.

## Adapter verification notes

The thin adapter uses Codex's named built-in permission profiles because the pinned server
can downgrade legacy sandbox shorthand. Prompt-free disposable-home probes verified
`:read-only -> readOnly`, `:workspace -> workspaceWrite`, and
`:danger-full-access -> dangerFullAccess`, each with `approvalPolicy:"never"` and the
matching `activePermissionProfile.id`. The adapter validates these effective fields and
fails closed on a mismatch.

For a new thread, the adapter sets the app-server child process cwd but omits the redundant
`thread/start.cwd` request field. A prompt-free disposable-home comparison proved that
sending both cwd and a writable sandbox persists the project as trusted in the user's
Codex config, while omitting request cwd preserves the same effective cwd without creating
that config. Resume sends cwd as a consistency/security override and validates the returned
cwd before exposing the thread.

Resume requests use `excludeTurns:true` with the server's paged recent-turn bootstrap at
full item detail. This avoids one unbounded all-history native frame; PiUI's separate
read-only history/index layer owns older history rather than accumulating it into one
adapter snapshot.

Managed coordinator starts register only the fixed `workspace` namespace and pass both
process session flags and thread overrides to disable Codex native multi-agent features.
Explicit `nativeSubagents:true` is rejected because effective enablement is not exposed on
the thread response. `config/read` can report effective disablement but also returns the
full user/project configuration, so the adapter does not call it under PiUI's no-global-
settings-read boundary. A higher-priority managed cloud override therefore remains an
unproven limitation rather than a sandbox claim.

One explicitly coordinated contained native model turn was admitted without an adapter
model/provider override. Native 0.147.0 then emitted a terminal failed turn, but supplied
neither `codexErrorInfo` nor an HTTP status. The adapter safely classified it only as a
generic Codex turn error and did not expose raw provider text. This evidence cannot
distinguish native account/provider environment failure from a native request failure, so
real-turn readiness remains unproven.

## Next implementation seam

Implement one thin adapter behind the typed runtime boundary:

- Rust owns one native app-server process tree per active session.
- The adapter performs the handshake and multiplexes client responses, server requests,
  and notifications.
- Keep thread IDs, turn IDs, opaque cursors, and outstanding approval request IDs typed.
- Normalize known events into PiUI runtime events and retain a generic fallback.
- Do not read/write rollout JSONL, auth files, or global settings in the frontend.
- Do not start a real turn until an authenticated, non-default isolated supervisor socket
  and approval/interrupt coordination probe is authorized.

The version gate must fail closed when the installed CLI or generated contract differs
from `0.147.0`; regenerate and review rather than silently accepting drift.
