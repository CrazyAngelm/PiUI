# Stage 5A result — shared pipeline kernel (kernel protocol 2)

This is the outcome of the Stage 5A shared-core boundary of `FABLE_PLAN.md`
in the Desktop worktree (`codex/nano-unified-shell-cli`, base `271c5ae`). It
has completed four independent GPT-6.1 Sol/max read-only CLI reviews, followed
by root's reproduction and verification of their corrections. The reviews
found six defects in protocol 2;
[Review remediation](#review-remediation) closes them, and the package
section names the remediated candidate. No application was launched,
nothing was installed or deployed, and the server keeps its current kernel
binary. Every check uses synthetic fixtures. No paid turn ran.

## Root acceptance proof

Review identities are `kernel-v2-sol-1` through `kernel-v2-sol-4`. Each read
the same frozen source/evidence inline, without tools, because native read-only
filesystem execution was blocked. These are static reviews, not independent
test runs; the original findings and root's disposition remain in evidence.

Root verified all 59 packaged source entries: 57 match the current source
directly, the generated minimal workspace matches, and Cargo's locked subset
matches the repository. Source fingerprint is
`dd57a9f6f6a5d1517ae1168fdf93ce2fdf30daa92ff0fcbc48ac42a8ec490115`.
Both native files match their recorded hash and source fingerprint. Windows
output is hash-identified, not claimed bit reproducible.

The current integrated Desktop library test executable passed all 16
`orchestration_api` tests after the other Nano modules became buildable; this
closes the earlier isolated-tree proof gap. It is a Rust unit-test executable,
not a launch of the installed Desktop or WebView.

Root also executed the corrected Linux binary inside the exact server runtime
base as non-root user 1654, with no network and a read-only filesystem/mount.
Default v1, default v2 refusal, identical v1 under opt-in, v2 creation and a
fresh-process reload all passed. This proves runtime-base compatibility, not
the later source Docker build or deployment. The server still needs to import
the accepted source package and complete Stage 5B acceptance.

Evidence is in `kernel-v2-final/` and
`kernel-v2-review/fixed-pinned-runtime.json` under the task evidence root.
The accepted source manifest is regenerated after the milestone commit so its
`sourceRevision` names that commit rather than the pre-review candidate.

## Outcome

- **Protocol 2 sits beside protocol 1.** `crates/piui-graph-kernel/src/v2/`
  puts protocol 2 in front of the shared compiler (`compile_system_document`)
  and the existing deterministic `Coordinator`. These protocol 1 parts are
  unchanged:
  - `handle_frame` and `handle` in `lib.rs`;
  - `wire.rs`, with `PROTOCOL = 1`;
  - its 13 tests and the v1 fixture.

  Started without arguments, the executable answers byte for byte as before,
  including `unsupportedProtocol` for a protocol 2 frame. Started as
  `piui-graph-kernel --with-protocol-2`, it answers protocol 2 frames too:
  - a frame is protocol 2 only when it is a JSON object with exactly one
    `protocol` member whose value is 2;
  - every other frame keeps its protocol 1 answer.

  The shipped server host starts the kernel without arguments, so it keeps
  protocol 1.
- **One agent-request admission.** `crates/piui-orchestration/src/admission.rs`
  holds the agent-request admission that Desktop ran inline in
  `orchestration_api.rs`: `check_agent_request`, `agent_request_actor` and
  `admit_agent_request`.
  - Desktop's `handle_agent_request` now calls these functions. A refusal maps
    to the same `StoreError` disposition as before.
  - The scheduler, the bridge and the public orchestration contract are
    unchanged.
  - The same file adds the pure definition refusal matrix
    (`definition_refusals`).
- **Typed intents only.** Every command returns a state to persist (with a
  child run, if any) and an effect. The kernel performs no inference, tool
  call, process or file operation, timer, retry or scheduling. The host owns
  identifiers, history reads and verification, approvals, pipeline-name
  resolution, run inputs, persistence and every effect.
- **No new policy values.** The kernel adds no quota, timeout, retry count,
  depth default or policy gate. The sub-pipeline depth and cycle checks reuse
  existing rules: `MAX_SUBPIPELINE_DEPTH = 4`, `child_trigger`,
  `subpipeline_cycle` and the existing `subpipeline-*` failure codes. Script
  timeouts come from the frozen step. Capability and delegation checks are the
  existing `validate_profile_capabilities`, `authorize_spawn` and adapter
  `agentOperations`.

## Review remediation

Each defect was reproduced by root on the first candidate
(`6e32ef02…`, `root-review-red.json`). Protocol 1 and native Desktop keep
their behavior; the fixes are at the protocol 2 boundary, an opt-in core
helper and the packager.

1. **One reservation per lease id.** `lease` refuses an id that a task of the
   run already holds (`leaseConflict`). A spawn is leased under its request
   id, so an `agentRequest` spawn whose id another task holds is
   `agentRequestRefused` (`conflict`, `spawnLeaseRefused` or
   `spawnAgentLeaseRefused`). An identical retry still returns the same lease
   of the same step. Nothing is returned for the host to persist.
2. **A spawn runs on its target's adapter.** The shared
   `admit_agent_request` no longer checks the spawned profile against the
   caller's capabilities (`AgentRequestError::UnsupportedCapability` is
   removed). Protocol 2 admits the spawned profile with its own frozen
   capabilities, so a full-access lead can spawn a read-only reviewer on a
   read-only adapter. Desktop keeps its former check in
   `handle_agent_request`: a controlled `spawn` that the caller's adapter
   cannot launch is `invalid` and records nothing.
3. **No unknown members.** The protocol 2 request DTO
   (`v2::wire::AgentRequest`) rejects unknown members in every operation,
   `roster` included (`invalidRequest`). A stored snapshot loads only when its
   agent request records decode exactly as stored; a `roster` record with an
   extra member is `invalidSnapshot`. The shared `AgentToolOperation` and
   `AgentRequestKind` are unchanged for Desktop and protocol 1.
4. **Cancelled work holds no reservation.** The new opt-in
   `Coordinator::release_cancelled_leases` releases the lease of every task a
   transition cancelled. Protocol 2 applies it to every state it returns
   (parent and child), so a failure's fail-fast, `rejectLeased`,
   `rejectReady`, `reconcile`, a failed host step, a failed pinned step and a
   failed child leave a loadable state. As a backstop, a state that
   `deserialize_run` would refuse is never returned (`invalidTransition`).
   Protocol 1 and Desktop do not call the helper.
5. **Native artifact files.** `writeNativeArtifact` checks the executable,
   `manifest.json` and `SHA256SUMS.txt` with `lstat` before the first write:
   a link (also a dangling one or a junction), a non-regular file or a hard
   link (`nlink > 1`) is refused and nothing is written.
6. **One target.** `buildNative` resolves the host target from `rustc -vV`
   before the build, passes it to Cargo as `--target`, accepts only the
   executable under `<target-dir>/<host>/` and records the same target.
   `CARGO_BUILD_TARGET` or a `build.target` setting cannot select another.

## Protocol 2 commands

Each command that carries `state` reads
`{snapshot, binding, expectedRunRevision, owner}`. A response includes
`state` (and `run`) for every command except `compile` and `validate`.

| Command | Existing transition | Effect |
|---|---|---|
| `compile` | `compile_system_document` | `compiled` (definition or compile refusal) |
| `validate` | `definition_refusals` | `validated {refusals}`; no run, run id or inputs |
| `create` | checked binding facts, admission, `new_started_run` | `created` |
| `inspect`, `advance`, `projectResult` | load, `advance_automatic_steps`, `project_result` | `observed`, `changed`, `projected` |
| `lease` | by the executor of the next ready step: `lease_next_task`, `lease_next_script`, `lease_next_plugin_step`, `lease_next_pipeline_step` | `leased {executor: agent or llm}`, `scriptLeased`, `pluginLeased`, `pipelineLeased`, `idle` |
| `dispatch` | `dispatch_leased_task` | `dispatched {launch}` |
| `dispatchHostStep`, `completeHostStep` | `dispatch_leased_script`, `complete_script_task` (script and plugin) | `hostDispatched`, `changed` |
| `releaseLease`, `rejectLeased`, `rejectReady` | `release_task_lease`; release plus `reject_ready_task` (Desktop's `reject_leased_script` / `reject_leased_task`); `reject_ready_task` | `changed` |
| `completeChecked`, `markUncertain`, `reconcile`, `retryUncertain` | `complete_checked_task`, `mark_task_uncertain`, `reconcile_uncertain_task`, `retry_uncertain_task` | `changed` |
| `cancellationRequests`, `cancel`, `restore`, `controlFlow` | `cancellation_requests`, `cancel_run`, `restore`, `control_flow` | `cancellations` (each with its executor), `changed` |
| `agentRequest` | the shared `admit_agent_request` | `agentAdmission`: `roster`, `send`, `observe`, `spawn {lease}`, `spawnCommitted` |
| `markMessageDelivered` | `mark_message_delivered` | `changed` |
| `startPipelineChild` | rebuilt pipeline lease, `child_trigger`, ancestry and `subpipeline_cycle`, `resolve_child_inputs`, child admission, `new_started_run`, `dispatch_leased_script` | `childStarted` plus the new `child` state, in one response |
| `childOutputReferences`, `completePipelineChild` | `child_output_references`, `child_completion`, `complete_pipeline_task` | references, `changed` |

The plan's per-executor command names map onto the commands above:

- its lease commands are one `lease`, decided by the executor the
  coordinator leases next;
- its dispatch and complete commands for scripts and plugin nodes are
  `dispatchHostStep` and `completeHostStep`;
- its pipeline-step commands are `startPipelineChild` and
  `completePipelineChild`.

The plan's message acceptance is the `send` admission
(`Coordinator::accept_message`). It has no separate command. Script
uncertainty uses `markUncertain`, the call Desktop makes. Native Desktop has
no coordinator `wait` operation; none was invented.

## Binding, admission and reload

- **The binding is frozen at `create`.** The host chooses:
  - `owner`: `{location, scopeId}`, where `location` is a `WorkLocationV1`
    (local or cloud account/workspace/profile; there is no device location);
  - five explicit `executors` flags;
  - `profileCapabilities`, keyed only by frozen profiles.

  A blank owner field or a key for an unknown profile is `invalidRequest`.
  The kernel returns the binding as `state.binding` text:
  `{bindingVersion: 1, runId, owner, executors, profileCapabilities, ancestry}`.
  Every transition returns that text unchanged. A portable document carries
  no binding, location, permission or capability, and a compiled definition
  grants nothing until a host binds it.
- **Every load is checked again from frozen facts, before any transition.**
  The checks run in this order:
  1. snapshot version and decoding, with agent request records that decode
     exactly as stored;
  2. binding version and decoding;
  3. the binding names this run, its owner is valid and it has no foreign
     profile key (`invalidBinding`);
  4. the authenticated owner equals the frozen owner (`ownerMismatch`);
  5. the initial definition is admitted again against the frozen binding;
  6. every current step's executor, including spawned steps, is supported;
  7. the run revision (`revisionConflict`).

  A changed identity, a lost authority or a stale revision returns an error
  and nothing to persist. Every spawn (`spawn` and `spawnAgent`) is admitted
  against the spawned profile's own frozen capabilities, never the caller's.
- **Refusal matrix.** It has four typed codes:
  - `missingCapabilities`;
  - `unsupportedCapability`;
  - `unsupportedExecutor`;
  - `delegationDenied`.

  Their subjects are `profile`, `step`, `team`, `sendEdge` and `observeEdge`.
  `create` refuses with every refusal at once (`admissionRefused`), and
  `validate` returns the same list without a run.

  A host advertises only the executors it runs. The cloud fixture binds only
  `agent`, so cloud script, llm, plugin and sub-pipeline execution stay refused
  until the host supports them.
- **Delegation never escalates.** Spawn grants use the existing same-or-less
  check for every generation. Native defaults of unlike harnesses are
  incomparable and are refused, never guessed.
- **Native results.** A native result is a reference into the producing
  execution's own history:
  - `completeChecked` refuses a reference to another session
    (`foreignHistoryReference`);
  - `reconcile` refuses one that is not the task's recorded execution;
  - texts are read and hash-verified by the host.
- **Retry and restore keep their identity.**
  - Unknown outcomes stay uncertain, and `lease` refuses them, until the
    owner calls `reconcile` or `retryUncertain`.
  - An identical retry of an agent request returns the recorded message or
    `spawnCommitted` with the same execution.
  - A changed body under the same request id is `messageConflict`.

## Proof

The commands ran with `CARGO_HOME=D:/Users/redmi/CacheData/cargo`,
`CARGO_TARGET_DIR=D:/Users/redmi/CacheData/nano-unified-shell-kernel-target`
and `--offline --locked`, scoped to the owned crates. The counts include the
remediation:

- `cargo test -p piui-graph-kernel -p piui-orchestration`:
  - the kernel passed 41 tests (13 unchanged protocol 1 and 28 protocol 2);
  - orchestration passed 122 tests (the 113 existing, 8 admission tests and
    the cancelled-reservation helper).
- **The new tests are not vacuous.** Reverting one remediation at a time
  (the lease release, either lease-id check, the record round trip, the
  strict `roster` DTO) fails its protocol 2 test.
- `cargo clippy -p piui-orchestration -p piui-graph-kernel --all-targets -- -D warnings`:
  clean. `rustfmt --edition 2024 --check` on the changed Rust files: clean.
- `node --test crates/piui-graph-kernel/package.test.mjs`: 10 passed. The two
  file-symlink subtests are skipped because this Windows account cannot
  create file symlinks (`EPERM`). Hard links, directories and a junction ran
  against a canary.
- `tsc --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess` on
  `contracts/nano-graph-kernel-v2.ts` and `-v1.ts`: no errors.
- `vitest run src/features/orchestration/compileVectors.test.ts`: 3 passed.
- **Desktop.** `orchestration_api.rs` changed, so the actual Desktop crate was
  compiled and tested. `cargo test --offline --locked -p piui-desktop --lib
  orchestration_` passed 100 tests. They include the 16 `orchestration_api`
  tests: root's 15 and the new
  `controlled_spawn_target_must_be_launchable_by_the_calling_adapter`.
  - The worktree itself does not compile at the moment: another worker's
    in-progress `crates/piui-nano` lacks `discovery::AvatarKitsOffer`.
  - The run therefore used a scratch tree: `HEAD` plus only the Stage 5A and
    remediation files and the built `apps/desktop/dist`, with its own target
    folder.
- **Root's reproducer.** The red run still reproduces all six defects on the
  first candidate. `--fixed` passes on the remediated Windows build. The same
  27 frames are byte-identical on the Linux build.
- **Protocol 1 replay through processes.** The server's current kernel binary
  (`7c0c2dcf…`, source `37dd84ba…`) and the remediated binary each received
  28 frames, one process per frame as the server runs it:
  - all 28 answers are byte-identical in the default mode. They include a
    protocol 1 run with a reused lease id and one with a failure beside a
    leased task: protocol 1 still returns them and reloads them as
    `invalidSnapshot`, unchanged;
  - with `--with-protocol-2`, only the server's protocol 2 probe frame
    differs (`invalidRequest`).
- **Packaging.** These checks used real builds, with the first candidate's
  `package.mjs` beside the remediated one:
  - **Finding 6.** The first candidate's packager let Cargo follow
    `CARGO_BUILD_TARGET=i686-pc-windows-msvc`, and also a `[build] target` in
    `.cargo/config.toml`. The build failed only because that target is not
    installed. The remediated packager built and recorded
    `x86_64-pc-windows-msvc` under both. The Linux build (a shell copy of the
    `buildNative` command) did the same with
    `CARGO_BUILD_TARGET=x86_64-unknown-linux-musl`. That the first candidate
    would mislabel an installed alternate target is inferred; it was not run.
  - **Finding 5.** Each case built into a new folder and replaced one
    destination file, either with a hard link to a canary or with a junction.
    It then rebuilt at once into the same destination. With the hard link, the
    first candidate overwrote the canary. With the junction, it rewrote
    `manifest.json` and then failed with `EISDIR`. The remediated packager
    refused both and wrote nothing: the canary and the file times are
    unchanged.
  - **Static only.** The unit test that `--target` is passed before the build
    reads the source text.
- **Server acceptance.** The server importer's own `verifySource` accepts the
  remediated source artifact.

Fixtures: `contracts/fixtures/unified-shell/graph/kernel-v2/create-local.json`,
`create-cloud.json` and `refusal-cloud.json` (a request with its exact
response). The 49-vector compile corpus is unchanged
(`ceb4dfd0e679c7b6195caad5eb9242e55ea7c408289938e44c0588331513db03`), and
protocol 2 `compile` reproduces every vector.

## Package and provenance

Built by the existing workflow
(`node crates/piui-graph-kernel/package.mjs build --out <dir>`). The
`--out` option writes only to an existing plain folder outside the
repository. The worktree's `artifacts/`, the server's artifacts and its
manifest are untouched.

The remediated candidate is in
`D:/Projects/PIUI/evidence/nano-unified-shell-20261115/cli/kernel-v2-remediation/package/`:

- **Source.**
  `source-dd57a9f6f6a5d1517ae1168fdf93ce2fdf30daa92ff0fcbc48ac42a8ec490115`:
  - 59 files at revision `271c5ae`; `uncommittedFiles` lists 17 files;
  - Cargo manifests and `Cargo.lock` are byte-identical to the first
    candidate's;
  - `protocol: 1` stays and `protocols: [1, 2]` is added, so the server
    importer still accepts it;
  - integrity `27d7a7e7…` (manifest) and `74606680…` (SHA256SUMS).
- **Windows.**
  `x86_64-pc-windows-msvc-c825f7c4f75d6fd0299abc2c4d63a8523478894a06953e1048e0a932ef19b40e`,
  3,715,584 bytes, built with `--target x86_64-pc-windows-msvc`. Its probe
  passed in both launch modes: protocol 1 replay, create, the admission
  refusal, protocol 3, lease and owner mismatch. An MSVC link of this source
  is not bit-reproducible: every fresh link gave another hash, so this hash
  names this build only.
- **Linux.**
  `x86_64-unknown-linux-gnu-19f0926e7240d092787051e29a6a24163accedec0eb9266a55c2948d81f0c66b`,
  3,467,880 bytes, GLIBC_2.34 or newer.
  - It was built in the installed WSL Ubuntu 24.04 with the pinned rustc
    1.94.1, offline, from the crates the first candidate vendored out of the
    existing D: cache, with `--target x86_64-unknown-linux-gnu` resolved from
    `rustc -vV` exactly as `buildNative` does.
  - Clean builds into new target folders produced the same hash, including
    one with `CARGO_BUILD_TARGET=x86_64-unknown-linux-musl` set.
  - Every probe frame, including `validate`, and all 27 frames of root's
    reproducer are byte-identical to the Windows build.
  - This is not the server's pinned Docker image, and
    `prove-nano-graph-kernel.mjs` was not run.

The first candidate stays in `.../cli/kernel-v2/package/` as the red
baseline: source `106e6619…`, Windows `6e32ef02…`, Linux `3010eea2…`.

## Deliberate differences from native Desktop

Desktop's behavior is unchanged. These are protocol 2 semantics for root to
accept or revise:

1. **Unused authority.** Protocol 2 refuses unused grants, edges, callable
   steps or `spawnedAgentsJoinTeam` that the bound adapter cannot serve.
   Desktop refuses them only when they are used. Whether Desktop adopts the
   matrix belongs to Stage 5C.
2. **Spawn failures.** A spawn whose own profile lacks frozen capabilities is
   refused in the same command, with nothing to persist: no request record
   and no added step. Desktop first commits the admission with its request
   record (and, for `spawnAgent`, the added step). If the profile's launch
   policy then fails on this host, Desktop releases only the task lease and
   answers `unsupported-policy`.
3. **Caller capabilities.** They come from the frozen binding. So an unknown
   actor is checked before the operation offer, and both are `denied`.
   Desktop checks the operation offer first.
4. **Host-supplied request fields.**
   - `completePipelineChild` takes `expectedTaskRevision`.
   - `resolvedTexts` must be exactly the lease's `requiredTexts`: an extra
     text is `invalidRequest`, and a missing one is the certain
     `subpipeline-input-unavailable`.
   - `nativeTexts` may name only the child's output references.
5. **No pipeline triggers in `create`.** A child exists only through
   `startPipelineChild`, together with its parent's dispatch.
6. **Cycle checks.** The static cycle check sees launch commands the host
   resolved in `child.pipelines`. The frozen ancestry always refuses a cycle
   when it would start.
7. **New code.** `executorMismatch` is separate from `unsupportedExecutor`: it
   means a command for another executor kind, not a location limit.
8. **Lease identity.** Protocol 2 refuses a lease id that another task holds
   (`leaseConflict`; for a spawn, `conflict`). Protocol 1 and Desktop accept
   it and store a run that `deserialize_run` refuses. That is unchanged.
9. **Cancelled reservations.** Protocol 2 releases the lease of every task
   its transition cancelled. Protocol 1 and Desktop keep it, and that run no
   longer loads. That is unchanged; see decision 8.
10. **Strict request records.** Protocol 2 refuses unknown members in a
    `roster` request and in stored request records. Desktop's managed bridge
    decodes the shared `AgentToolRequest`, unchanged.
11. **Spawn capabilities.** Protocol 2 launches a controlled `spawn` on its
    target's frozen capabilities. Desktop also requires the calling agent's
    adapter to support the spawned profile, as before, and checks the
    spawned profile's own adapter again at launch.

## Decisions and patches for root

1. **Stage 5B launch.** The server must start the kernel with
   `--with-protocol-2`. Its opt-in prover should expect `unsupportedProtocol`
   for protocol 3 rather than protocol 2. The default prover passes unchanged.
2. **Rebuild after the commit.** After committing, rebuild the source package
   so that `sourceRevision` is exact. The importer ignores `protocols` and
   `uncommittedFiles`.
3. **Ancestry.** The server should compile with `launchCommandId` set to its
   draft identity. Without it a root run has no own launch command, and a
   cycle back to the root is caught one level later (still bounded by
   depth).
4. **Binding integrity.** The binding is trusted persisted host state, not an
   independently authenticated credential. The host keeps the stored
   snapshot/binding pair intact and authenticates the caller separately. The
   kernel's revalidation does not protect against a trusted-state edit that
   adds authority. Browser/runtime requests cannot supply a replacement binding.
5. **Pinned data.** It remains the host's run option (`usePinnedData`). The
   server keeps `unsupported_pinned_data` before `create`. The existing
   server codes `unsupported_cloud_*` map onto `unsupportedExecutor`,
   `delegationDenied` and `missingCapabilities` (omitted capabilities).
6. **Shared documents.** Root updated `docs/NANO_GRAPH_KERNEL.md`, the
   contract index and ADR-059 for the protocol 2 extension. The host proves
   capabilities, and the pure matrix decides over those facts.
   - The editor still compiles through `compileGraph`. Whether Desktop
     import and save call the Rust compiler is still open.
7. **Docker proof.** A Linux artifact from the pinned server image, and
   `prove-nano-graph-kernel.mjs` in it, need the image pull. Root owns that
   boundary.
8. **Desktop data-loss risk (pre-existing, unchanged).** The Desktop
   scheduler leases a ready task and awaits the native launch before
   `dispatch`. A parallel task that fails meanwhile cancels the leased task
   and keeps its lease; a reused lease id has the same effect. Such a run
   fails `deserialize_run`, and `OrchestrationStore::open` treats a
   generation containing it as invalid and removes the file. Desktop could
   adopt `release_cancelled_leases` and the lease-id check, but that changes
   Desktop behavior, so it is root's decision. This is a static finding from
   the code; no running app was exercised.
9. **Shared documentation.** `docs/NANO_GRAPH_KERNEL.md` still says only that
   the native manifest "records the Rust host target". Proposed: "builds the
   exact source artifact for the Rust host target of `rustc -vV`, passed to
   Cargo as `--target`, and records that target; an existing artifact file
   that is a link, a non-regular file or a hard link is refused before any
   write."
10. **Server build (Stage 5B).** The server's Dockerfile builds without
    `--target`, copies `target/release/piui-graph-kernel` and labels the
    `rustc -vV` host. In the pinned image these agree. With an explicit
    `--target "$target"` the executable moves to `target/$target/release/`.

The package hashes above identify the executed remediation candidate:
revision `271c5ae` plus the 17 uncommitted files, including root's update of
`docs/NANO_GRAPH_KERNEL.md`. The accepted source package must be regenerated
after the reviewed commit to record that commit and the final document bytes.

## Evidence

The report is
`D:/Projects/PIUI/evidence/nano-unified-shell-20261115/cli/kernel-v2/report.md`.
That folder also holds:

- `package/`;
- `replay-v1.json` and `linux-probe.json`;
- the logs (`package-build.log`, `server-verify-source.json`,
  `linux-vendor.log`);
- the proof scripts.

Scratch is
`D:/Users/redmi/CacheData/nano-unified-shell-20261115/kernel-v2-cli`. It
includes the artifacts that predate `validate`, moved aside.

The remediation report is
`D:/Projects/PIUI/evidence/nano-unified-shell-20261115/cli/kernel-v2-remediation/report.md`.
That folder holds:

- the remediated `package/`;
- the red and green reproducer records;
- `replay-v1.json` and `linux-probe.json`;
- `package-proofs.json` (finding 6) and `package-proofs-seeded.json`
  (finding 5);
- `mutation-check.log`, the Desktop logs and the other test logs.
