# Nano graph kernel protocol v1

The `piui-graph-kernel` executable is a private, stateless adapter around
`piui-orchestration`. It is not an HTTP service, native agent bridge, provider
client or replacement transcript. The .NET host starts it through private pipes
and retains all authentication, tenant ownership and durable execution duties.
Wire types: [nano-graph-kernel-v1.ts](../contracts/nano-graph-kernel-v1.ts).
Rust decoder: `crates/piui-graph-kernel/src/wire.rs`.
The executable request fixture is
[nano-graph-kernel-v1.json](../contracts/fixtures/nano-graph-kernel-v1.json).

## Transport and persistence

Each stdin request is one UTF-8 JSON value terminated by LF. CRLF is accepted as
JSON whitespace; Unicode line separators inside a string do not end the frame.
Each stdout response is one compact JSON value followed by LF. Invalid frames
return a fixed error without echoing input. The process does not log bodies,
instructions, snapshots or native text. Pipe I/O failure exits unsuccessfully.
The trusted host applies its existing transport/admission bounds; the kernel
introduces no guessed size, concurrency or time limits.

Request envelope: `{protocol: 1, requestId, command}`. `requestId` is correlation,
not an idempotency database. Every non-create command includes
`state: {snapshot, expectedRunRevision}`. `snapshot` is the exact JSON string
previously returned and persisted by the host. Only orchestration schema 6 is
accepted: this boundary never upgrades or strips an unknown stored schema.
Unknown commands, fields, enum values, malformed snapshots and stale revisions
are rejected. Errors return no replacement snapshot, so the original remains
stored. The host must not downgrade unsupported data to an empty graph.

An `ok` response contains `snapshot`, a small `run` summary and an explicit
`effect`. `idle` means no native lease; `observed` is a read; `changed` is a domain
transition without an external action. The host must atomically compare its
saved run revision and persist the returned snapshot, request identity and
lease/launch/cancellation outbox effect **before** the corresponding side effect.
Repeating the same input is deterministic, but the host must reject a reused
request identity with different input and return its persisted original outcome
for an identical retry. A lost response never authorizes another native turn.

## Native admission sequence

1. Resolve the caller's current membership, workspace and cloud profile. Validate
   the entire portable graph and its cloud bindings; freeze the resolved core
   definition and verified adapter capabilities. Browser-supplied capability
   claims are not accepted. `create` checks every profile's permissions and
   mandatory tool rules with the existing `validate_profile_capabilities`.
2. `lease` reserves a deterministic ready task. Persist that snapshot before
   reserving/binding a host execution identity. No native execution has started.
3. `dispatch` requires the exact run revision, task revision and lease ID, plus
   the host's admitted execution reference. Persist its snapshot and launch
   outbox atomically. Dispatch the native turn using the outbox's durable attempt
   identity. The host rechecks actual adapter capabilities/resources at admission.
   `releaseLease` is allowed only after the host has proved admission had no
   native side effect. An unknown admission outcome uses `markUncertain` instead.
   `rejectReady` records a certain prelaunch refusal; it never simulates a failed
   provider turn or a native history record.
4. The host resolves dependency references from the same workspace's authoritative
   native history, verifies the exact final block/hash and applies field selection.
   These values are untrusted task context, never authority. A reference in a
   request is not proof that the browser or the kernel read native history.
5. `completeChecked` receives the admitted execution ID and native final text
   read by the host. It calls `complete_checked_task`, so result validation,
   routers, review rounds and approval stops retain the coordinator's semantics.
   Native text is not appended to a new chat format. The kernel checks revision
   and execution identity; only the host can prove history ownership/content.

The host must not treat a schema-valid profile as proof of available models,
resources, reasoning, permissions or native isolation. The per-profile capability
map covers the core's permission/tool checks. Native resource/model validation
and a real lease-to-runtime binding remain host/adapter requirements.

## Recovery and cancellation

`restore` turns interrupted leases/executions into `uncertain`. It does not
return them to ready. `reconcile` records a host-verified native result or a
confirmed failure/cancellation without dispatch; core restrictions on recovering
structured/reviewed/approval results remain enforced. `retryUncertain` is the
separate, explicitly user-authorized replay transition and retains the previous
attempt. Background recovery must never call it automatically.

For cancellation, first stop new admissions (`controlFlow` pause), persist
`cancellationRequests` in the outbox, and ask the native adapter to stop each
recorded execution. Confirmed interruption can then be recorded with `cancel`.
An unconfirmed stop uses `markUncertain` instead of claiming the process ended.
`cancel` returns cancellation references as well, but its domain status alone
is not an OS/native stop acknowledgement. A host that uses it before stop
acknowledgement must keep that pending external outcome durable and visible.

## Supported graph surface

| Feature | Kernel v1 |
|---|---|
| Scheduled native agent tasks and LLM steps | Core transitions; host must prove actual native capability |
| Result dependencies, input bindings and pinned-data start option | Existing core semantics; history verification remains host-owned |
| Program/agent routers, conditions, review rounds, human acceptance, pause/resume | Existing core semantics |
| Scripts, plugin nodes and nested pipeline executors | Entire graph refused before any lease |
| Callable/coordinator spawn, message or observation graphs | Entire graph refused before any lease |
| Credentials, model inference, tools, files, runtime processes, tenant authorization | Never implemented here |

Unsupported graphs remain valid portable drafts. The host displays the refusal;
it must not remove unsupported nodes or flatten them into team work items. A
future protocol may add the missing admission/commands with its own evidence.

Program routers are pure coordinator calculations. Human approval still gates
their selected branches; their declared `selectedBranchIds` text-list can be
bound as downstream input without inventing a native history reference. A
program router cannot provide a boolean review verdict: `review` on that node
is refused, and review belongs to a separate native review step.

## Example transition

After the host persisted a created run at revision 0, it sends:

```json
{"protocol":1,"requestId":"host-command-id","command":{"type":"lease","state":{"snapshot":"<exact persisted Run JSON>","expectedRunRevision":0},"leaseId":"host-attempt-id"}}
```

The `leased` effect includes `runId`, new `runRevision`, `taskRevision`, `leaseId`,
`stepId`, `memberId`, the frozen `profile`, `taskInstructions`, and dependency
references/outputs. A `dispatched` effect adds the admitted `execution`. These
are transaction payloads; neither response delivery nor reading a lease is
permission for the host to skip its outbox transaction.

Tests exercise the actual Rust boundary with synthetic definitions and history
references. They do not claim a real-provider turn, tenant database transaction,
or OS process cancellation; those belong to the .NET/native integration proof.

## Packaging for the server

Run `node crates/piui-graph-kernel/package.mjs source` from a source checkout.
It writes a content-addressed source artifact under `artifacts/graph-kernel/`:
the kernel and its existing `piui-orchestration` / `piui-contracts` dependencies,
an inherited minimal workspace, Cargo.lock, pinned toolchain, protocol contract,
fixture, tests, license and this document. It includes no registry dependencies,
native histories, application cache or developer paths. Text is normalized to
UTF-8/LF, and every file has a SHA-256/byte count in `manifest.json` and
`SHA256SUMS.txt`. Offline Cargo pruning must retain exactly the source lock's
package identities/checksums. Any dependency drift is refused.

The source fingerprint identifies the actual packaged bytes, including an
uncommitted candidate. `sourceRevision` records the checkout context at initial
packaging; it is not a claim that all packaged files belong to that commit.
An identical existing artifact is verified and reused. No other artifacts are
replaced or removed; only the packager's verified temporary directory is cleaned.

The server repository can vendor this artifact as one versioned dependency and
build it in a Linux Rust build stage using its pinned toolchain:

```sh
cargo build --locked --release --manifest-path vendor/nano-graph-kernel/Cargo.toml \
  --package piui-graph-kernel --bin piui-graph-kernel
```

The final .NET image receives only that stage's native `piui-graph-kernel`
executable and its source/checksum metadata. It does not run Cargo, contact a
package registry or start a public listener at runtime. Build the Linux artifact
on Linux; a Windows `.exe` is a local proof artifact, not a cloud deliverable.

`node crates/piui-graph-kernel/package.mjs build` additionally builds the exact
source artifact with `--locked`, probes its stdin/stdout with the shared valid
fixture and an unsupported protocol request, then copies and verifies the
executable outside `target/`. Its native manifest records the Rust host target,
source fingerprint, binary hash and probe result. `CARGO_TARGET_DIR` may reuse
an existing build cache; it is never the artifact destination. The stage's normal
unit tests and independent reviews remain required in addition to this probe.

Host result selection uses the pure `projectResult` command (state, verified text, fields) and `projected` effect. It calls core `project_result`, leaves the snapshot unchanged, and rejects missing/duplicate selections as invalidRequest. It never reads history or turns browser text into a verified reference.
