# Run debugging: pinned data, debug in editor, archive and delete

Status: implemented on `feat/run-debugging` (P3 item 10 of
[PLAN_REMAINING_2026-09-26_RU.md](PLAN_REMAINING_2026-09-26_RU.md)).
Contracts: orchestration v6.4 (additive, `contracts/orchestration-v6.ts`,
`contracts/orchestration-host-v6.ts`) and run debugging v1
(`contracts/orchestration-run-debugging-v1.ts`). Decisions: ADR-034.

The goal is n8n-style debugging without paid re-runs: reuse the outputs of
steps that already worked, fix one step and run the rest.

## Pinned data

A saved pipeline step may hold **pinned data** (`PipelineStep.pinnedOutput`):
the step's text output (a native final answer or a script's stdout, at most
256 KiB, with a `truncated` flag for a cut script output) and/or its structured
result (a JSON object of at most 256 KiB), the time it was pinned and the run it
came from. All pins of one pipeline are bounded to 1 MiB. Pinned data is task
data, never policy: downstream agents receive it as untrusted context, exactly
like a recorded result.

Pins are refused (by the coordinator, the host, the editor's checks and the UI
Lab alike) on:

- callable roles: they run only when an agent calls them;
- program routers: the coordinator evaluates them for free;
- reviewing steps: a pinned verdict would repeat the same round forever.

Agent routers can be pinned; their selection is checked like a native answer.

**Pin output.** In a finished run's step panel, *Pin output* is offered for the
latest attempt of a succeeded step that belongs to the saved pipeline. The UI
reads the saved pipeline (and asks before replacing an existing pin); the host
then reads the step's recorded output itself — script and pinned text from the
run record, native final answers from native history verified by their content
hash — and writes it into the saved step in one journal transaction, checked
against the pipeline revision the person saw and the task revision that was
read. An editor that has the pipeline open with changes then gets the usual
revision conflict instead of overwriting the pin.

**In the editor** a pinned step shows a *Pinned* chip on its card and a
*Pinned data* section in the inspector: source run and time, a view of the text
and result, and *Unpin* (one undo step; *Save* keeps it). Duplicating a node
drops its pins; changing a node's type keeps them; assistant proposals keep the
pins of nodes that survive. The script test's default sample stdin uses the
pinned upstream outputs (text, and the result a run would record).

**Portable system files never carry pinned data.** Pins are copies of run
results (native history content), which exports deliberately exclude, and the
v4 format stays unchanged. Exporting a graph with pins says so.

## Runs with pinned data

The Start dialog opens for a pipeline with pinned steps and shows the explicit
option **Use pinned data (pinned steps don't run)**, checked by default, with
the pinned steps listed. `StartRunRequest.usePinnedData` is frozen in the run
(`OrchestrationRunV6.usePinnedData`).

With it, the coordinator admits every pinned step that becomes ready —
dependencies succeeded, condition and routes satisfied, run running and not
paused — as succeeded with its pinned output, in the same transaction that
advances program routers, before any launch: no native session, model call or
script process. The pinned output is checked against the step's result fields
like a native result; if it does not satisfy them the step fails (nothing ran,
so the failure is certain) and ready work stops as for any failure. The task is
marked `pinned` and has no execution. Downstream steps receive it through the
normal dependency path: native steps as a recorded dependency output, scripts
on stdin. Approval gates still apply. *Run again from here* re-admits a pinned
step from its pin. Agents cannot spawn a pinned step. A review whose correction
step is pinned would only repeat the same input, so the reviewer's rejection
waits for a person (`review-retry-pinned`: *Accept last result* or *Reject*).

Without the option every step runs and the run's frozen snapshot holds no pins
(they took no part in it). Asking for pinned data when the saved pipeline has
no pin is refused with `conflict` rather than silently running every step.
Automations never use pinned data. Pinned artifact paths are not re-checked.

The run canvas marks pinned tasks with a *Pinned* chip; the step panel explains
that nothing ran and where the data came from.

## Debug a past run in the editor

*Debug in editor* in the run header opens the pipeline exactly as the run used
it (its original definitions, without helpers spawned at run time) as a **new
unsaved draft**: new pipeline, team, launch and profile ids, the saved
positions, named "<pipeline> (run #id)". Saving is an explicit action and
creates a copy; the saved pipeline is never changed. A small dialog lists the
run's succeeded steps with their outputs (read by the host as for *Pin
output*); checked ones become the draft's pinned data, and the others say why
they cannot (always-running step, larger than 256 KiB, unreadable history, no
output). If the outputs cannot be read, the draft can still open without pins.
Fix one step, save, and start with pinned data: only the rest runs.

## Archive and delete runs

The run header's *More* menu archives or unarchives a run. Archived runs are
hidden from the list until *Show archived runs*. Archiving is UI metadata kept
beside the runs in the journal (`archivedRunIds`); the run record, its revision
and scheduling are unchanged.

*Delete run…* opens a dialog that lists exactly what is removed and what stays:

- removed: the run's entry in PiUI's run journal (its steps, the results PiUI
  recorded, attempts and messages), its row in the run list, and script working
  copies PiUI may still hold for it;
- not touched: the agents' native sessions and their history (the linked chats
  stay), files in the project folder, the saved pipeline, its pins and
  automations.

The host deletes at the revision the person confirmed (a changed run is not
deleted), refuses running and uncertain runs (`run-active`), writes a new
create-only, fsynced journal generation without the run, and then removes left
over script working copies of the run's executions from PiUI's application
data folder. Each target must be a host-allocated id naming a plain directory
whose resolved parent is exactly the resolved script folder; links, junctions
and other reparse points are never followed or removed. Schedule occurrences
that started the run keep their history.

Archive and delete wait until a run no longer runs. Safe mode keeps runs and
pipelines read-only: pinning, archiving and deleting are refused by the host and
not offered in the UI. Every new control is a labelled button, checkbox or menu
item reachable by keyboard; dialogs return focus.

## Evidence

- Rust: `crates/piui-orchestration/src/pinned_tests.rs` (validation, admission
  without launching, dependency hand-off to scripts and native steps, result
  contract, agent routers, pause/approval/repeat, review hold, spawn refusal,
  stored-data consistency, additive compatibility) and
  `apps/desktop/src-tauri/src/orchestration_run_debugging_tests.rs` (outputs,
  pinning and refusals, runs with and without pinned data, archive persistence,
  delete of finished runs only with script folder cleanup, reparse points,
  safe mode, shared fixture, an older journal loading unchanged).
- TypeScript: `host-api/pinnedData.test.ts`, `host-api/runDebuggingClient.test.ts`
  (shared fixture, in `contract:test`), `host-api/lab/runDebuggingFake.test.ts`,
  `app/pipelines/pinnedEditing.test.ts` (open/save keeps pins, a run opened as a
  draft and started from the editor with pinned data in the UI Lab) and
  `app/runs/runDebugging.test.ts` (store, markup, Russian copy).
- No agent, model call or paid turn ran; scripts in host tests are synthetic
  outcomes recorded through the journal.
