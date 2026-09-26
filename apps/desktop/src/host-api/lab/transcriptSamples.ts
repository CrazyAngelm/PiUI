import { createRandom } from './labRandom';

/**
 * Fixed transcript text for the lab scenarios. Everything here is invented:
 * projects, paths, people and numbers are illustrative only.
 */
const FENCE = '```';

export const LISBON_PROMPT = 'Plan a relaxed two-day weekend in Lisbon for two people. We like food markets, viewpoints and one museum.';

export const LISBON_PLAN = `# Lisbon in two days

A slow-paced plan that keeps walking hills to a minimum and leaves room for long lunches.

## Saturday — Baixa, Alfama and the river

1. **Breakfast** at a pastelaria near Rossio (order a *galão* and a *pastel de nata*).
2. Take **tram 28** early (before 9:30) to beat the queue, get off at Miradouro de Santa Luzia.
3. Wander down through **Alfama**; the lanes below the cathedral are quietest before noon.
4. Lunch at the **Time Out Market** — shared plates, no reservations needed.
5. Sunset at **Miradouro da Senhora do Monte**.

## Sunday — Belém at your own pace

| Time  | Stop                     | Notes                                   |
|-------|--------------------------|-----------------------------------------|
| 10:00 | Jerónimos Monastery      | Buy tickets online; cloister is the highlight |
| 12:30 | Lunch by the river       | Grilled sardines are in season          |
| 14:30 | MAAT                     | The one museum — contemporary, air-conditioned |
| 17:00 | Walk to Padrão dos Descobrimentos | Flat riverside path            |

> Tip: a 24-hour transport card pays for itself after four rides.

Useful links: [Carris tram map](https://example.invalid/lisbon/tram-28) · [Market opening hours](https://example.invalid/lisbon/market)`;

export const LISBON_FOLLOW_UP = 'Make Sunday even more relaxed and add a rainy-day backup.';

export const LISBON_REVISED = `Here is a gentler Sunday:

- Sleep in; brunch in **Príncipe Real** around 11:00.
- Take a taxi to Belém instead of the tram.
- Pick **either** Jerónimos *or* MAAT — not both.
- Finish with ice cream on the riverside at ~~18:00~~ whenever you feel like it.

### Rainy-day backup

- Gulbenkian Museum and its garden café
- Fado matinée in a small Alfama venue (book a day ahead)
- A long lunch — rain is a perfectly good excuse`;

export const LIFETIMES_PROMPT = 'Explain Rust lifetimes with a small example that fails to compile and the fixed version.';

export const LIFETIMES_THINKING = 'The user wants intuition first, then a concrete borrow-checker error. Use the classic longest() example, show the E0106 error, then the annotated version and a note on elision rules.';

export const LIFETIMES_ANSWER = `## The short version

A lifetime is the region of code where a reference is **guaranteed to be valid**. The compiler checks that no reference outlives the value it points to.

### A function that does not compile

${FENCE}rust
fn longest(a: &str, b: &str) -> &str {
    if a.len() > b.len() { a } else { b }
}
${FENCE}

${FENCE}text
error[E0106]: missing lifetime specifier
 --> src/main.rs:1:33
  |
1 | fn longest(a: &str, b: &str) -> &str {
  |               ----     ----     ^ expected named lifetime parameter
${FENCE}

The return value borrows from *either* argument, so the compiler cannot guess which one it must outlive.

### The fix

${FENCE}rust
fn longest<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.len() > b.len() { a } else { b }
}
${FENCE}

\`'a\` says: *the result lives at most as long as the shorter of the two inputs.*

### Elision rules (why you rarely write them)

1. Each reference parameter gets its own lifetime.
2. With exactly one input lifetime, it is assigned to all outputs.
3. With \`&self\`, the output borrows from \`self\`.

> Rule of thumb: add explicit lifetimes only when the compiler asks — and read its suggestion, it is usually right.`;

export const TRANSPORT_PROMPT = 'Route every host call in apps/desktop through a single transport so the UI can run in a plain browser. Keep Tauri behaviour identical.';

export const TRANSPORT_PLAN = `Plan
1. Find direct @tauri-apps/api imports under src/
2. Add host-api/transport.ts with hostInvoke/hostListen
3. Switch typed clients to the transport
4. Load the UI Lab host lazily outside Tauri
5. Run svelte-check and the unit suite`;

export const RG_COMMAND = 'rg -n "@tauri-apps/api" apps/desktop/src';

export const RG_OUTPUT = `apps/desktop/src/host-api/client.ts:1:import { invoke } from '@tauri-apps/api/core';
apps/desktop/src/host-api/client.ts:2:import { listen } from '@tauri-apps/api/event';
apps/desktop/src/host-api/workspaceClient.ts:1:import { invoke } from '@tauri-apps/api/core';
apps/desktop/src/host-api/workspaceClient.ts:2:import { listen } from '@tauri-apps/api/event';
apps/desktop/src/host-api/orchestrationClient.ts:1:import { invoke } from '@tauri-apps/api/core';
apps/desktop/src/host-api/composerClient.ts:1:import { invoke } from '@tauri-apps/api/core';
apps/desktop/src/host-api/harnessModels.ts:1:import { invoke } from '@tauri-apps/api/core';
apps/desktop/src/features/workspace/SessionComposer.svelte:3:  import { listen } from '@tauri-apps/api/event';`;

export const TRANSPORT_DIFF = `diff --git a/apps/desktop/src/host-api/transport.ts b/apps/desktop/src/host-api/transport.ts
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/apps/desktop/src/host-api/transport.ts
@@ -0,0 +1,21 @@
+import { invoke } from '@tauri-apps/api/core';
+import { listen } from '@tauri-apps/api/event';
+
+export type HostInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
+export type HostListen = <T>(channel: string, handler: (payload: T) => void) => Promise<() => void>;
+
+export const desktopAvailable = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
+
+let labTransport: Promise<HostTransport> | undefined;
+function lab(): Promise<HostTransport> {
+  labTransport ??= import('./lab/labHost').then((module) => module.createLabHost());
+  return labTransport;
+}
+
+export const hostInvoke: HostInvoke = async (command, args) =>
+  desktopAvailable ? invoke(command, args) : (await lab()).invoke(command, args);
diff --git a/apps/desktop/src/host-api/workspaceClient.ts b/apps/desktop/src/host-api/workspaceClient.ts
index 7c41d2a..9e0f6b3 100644
--- a/apps/desktop/src/host-api/workspaceClient.ts
+++ b/apps/desktop/src/host-api/workspaceClient.ts
@@ -1,5 +1,4 @@
-import { invoke } from '@tauri-apps/api/core';
-import { listen } from '@tauri-apps/api/event';
+import { desktopAvailable, hostInvoke, hostListen } from './transport';
 import type { WorkspaceCatalog, WorkspaceCommand, WorkspaceEvent } from '../../../../contracts/workspace-v15';
@@ -52,8 +51,8 @@ export function createWorkspaceClient(
-export const workspaceHost: WorkspaceClient = createWorkspaceClient(invoke, (channel, handler) =>
-  listen(channel, (event) => handler(event.payload)));
+export const workspaceHost: WorkspaceClient = createWorkspaceClient(
+  (route, args) => hostInvoke<WorkspaceResult>(route, args),
+  (channel, handler) => hostListen<WorkspaceEvent>(channel, handler),
+);`;

export const CHECK_COMMAND = 'pnpm --filter @piui/desktop check';

export const CHECK_OUTPUT = `> @piui/desktop@0.2.0 check
> svelte-check --tsconfig ./tsconfig.json

Loading svelte-check in workspace: apps/desktop
Getting Svelte diagnostics...

svelte-check found 0 errors and 0 warnings`;

export const TEST_COMMAND = 'pnpm --filter @piui/desktop test';

/** A long but ordinary test report (well below the 16 KiB history limit). */
export function vitestReport(files: number, seed: string): string {
  const random = createRandom(seed);
  const areas = ['host-api', 'features/workspace', 'features/orchestration', 'features/sessions', 'components', 'features/runtime'];
  const names = ['client', 'state', 'view', 'form', 'layout', 'actions', 'updates', 'preflight', 'history', 'markdown'];
  const lines = [' RUN  v3.2.4 apps/desktop', ''];
  let tests = 0;
  for (let index = 0; index < files; index += 1) {
    const count = random.int(2, 17);
    tests += count;
    const file = `src/${random.pick(areas)}/${random.pick(names)}${index % 3 === 0 ? 'Client' : ''}.test.ts`;
    lines.push(` ✓ ${file} (${count} tests) ${random.int(4, 240)}ms`);
  }
  lines.push('', ` Test Files  ${files} passed (${files})`, `      Tests  ${tests} passed (${tests})`);
  lines.push('   Start at  09:12:04', `   Duration  ${random.int(3, 9)}.${random.int(10, 99)}s`);
  return lines.join('\n');
}

/** A very long build log (> 16 KiB) so closed-history views show truncation. */
export function cargoBuildLog(lines: number): string {
  const random = createRandom(`cargo:${lines}`);
  const crates = ['serde', 'tokio', 'tauri', 'rusqlite', 'sha2', 'uuid', 'chrono', 'jsonschema', 'windows-sys', 'tracing'];
  const output = ['   Compiling proc-macro2 v1.0.95', '   Compiling unicode-ident v1.0.18'];
  for (let index = 0; index < lines; index += 1) {
    const crate = random.pick(crates);
    const version = `${random.int(0, 2)}.${random.int(0, 60)}.${random.int(0, 30)}`;
    output.push(index % 17 === 0
      ? `warning: unused import: \`std::fmt::Write\` --> crates/piui-${random.pick(['index', 'runtime', 'platform'])}/src/lib.rs:${random.int(10, 900)}:5`
      : `   Compiling ${crate}-lab-${index} v${version} (registry+https://example.invalid/crates)`);
  }
  output.push('    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2m 41s');
  return output.join('\n');
}

export const TRANSPORT_SUMMARY = `## Done: one host transport

Every typed client now calls \`hostInvoke\` / \`hostListen\`; nothing under \`src/features\` imports Tauri directly anymore.

### What changed

| File | Change |
|------|--------|
| \`host-api/transport.ts\` | **New.** Picks Tauri or the UI Lab host at runtime |
| \`host-api/workspaceClient.ts\` | Uses the transport; error mapping unchanged |
| \`host-api/orchestrationClient.ts\` | Uses the transport for commands and both event channels |
| \`host-api/lab/labHost.ts\` | **New.** Minimal in-memory stand-in, loaded lazily |

### Behaviour inside Tauri

Unchanged — \`desktopAvailable\` is computed once and the desktop path calls \`invoke\`/\`listen\` exactly as before:

${FENCE}ts
export const hostInvoke: HostInvoke = async (command, args) =>
  desktopAvailable ? desktopTransport.invoke(command, args) : (await lab()).invoke(command, args);
${FENCE}

### Checks

- \`svelte-check\`: 0 errors, 0 warnings
- unit tests: **226 passed**
- The lab chunk is not part of the initial bundle (verified in \`dist/.vite/manifest.json\`).

Next step: flesh out the lab host so every screen works in the browser. See the [transport notes](https://example.invalid/piui/docs/transport).`;

export const TRANSPORT_FOLLOW_UP = `Yes — \`SessionComposer.svelte\` still calls \`listen\` from \`@tauri-apps/api/event\` for \`piui://composer-v19\`.
In a plain browser that call rejects, so the composer never loads its queue. It should go through \`hostListen\` like everything else.`;

export const SCHEDULER_PROMPT ='The orchestration scheduler test fails about 1 in 20 runs on CI. Find the race and fix it.';

export const SCHEDULER_THINKING = `The flaky test is cancellation_preserves_a_concurrently_succeeded_parallel_task. Timing-dependent assertions usually mean the test observes an intermediate revision.
Plan: read the test, grep for the revision assertion, then run the full e2e suite to confirm nothing else relies on the old ordering.`;

export const SCHEDULER_TEST_SOURCE = `fn cancellation_preserves_a_concurrently_succeeded_parallel_task() {
    let mut run = two_parallel_tasks();
    lease_both(&mut run);
    complete(&mut run, "step-a", Succeeded);
    let cancelled = Coordinator::cancel_run(&mut run, run.revision()).unwrap();
    assert_eq!(run.revision(), 5); // <- depends on completion order
    assert_eq!(cancelled.len(), 1);
}`;

export const SCHEDULER_GREP_OUTPUT = `apps/desktop/src-tauri/src/orchestration_scheduler.rs:2362:    fn cancellation_preserves_a_concurrently_succeeded_parallel_task() {
apps/desktop/src-tauri/src/orchestration_scheduler.rs:2388:        assert_eq!(run.revision(), 5);
apps/desktop/src-tauri/src/orchestration_scheduler.rs:2401:        assert_eq!(run.tasks()[1].status(), TaskStatus::Cancelled);`;

export const SCHEDULER_ANALYSIS = `Found it. The assertion pins **run revision 5**, but the second task's lease and the first task's completion can commit in either order when both tasks start in the same scheduling pass:

- order A: lease(b) → complete(a) → cancel → revision **5**
- order B: complete(a) → lease(b) → cancel → revision **5**, but only when \`advance_conditions\` is a no-op

With a skipped condition the revision becomes **6**. I'll assert on task statuses instead of the absolute revision, then run the full e2e suite to be sure nothing else depends on the ordering.`;

export const SCHEDULER_E2E_COMMAND = 'pnpm --filter @piui/desktop test:e2e';

export const SCHEDULER_E2E_OUTPUT = `> node scripts/e2e-platform.mjs
[e2e] building piui-e2e-job (debug)…
[e2e] launching WebView2 harness on port 9517
[e2e] ✓ workspace: create, send, interrupt (18.2s)
[e2e] ✓ workspace: approval round-trip (9.7s)
[e2e] ✓ orchestration: two-step dependency DAG (31.4s)
[e2e] ✓ orchestration: cancel preserves completed parallel task (12.9s)
[e2e] ✓ safe mode: runtime actions rejected (4.1s)
[e2e] 5 passed, 0 failed — 1m 16s`;

export const SCHEDULER_FIX_DIFF = `--- a/apps/desktop/src-tauri/src/orchestration_scheduler.rs
+++ b/apps/desktop/src-tauri/src/orchestration_scheduler.rs
@@ -2385,8 +2385,9 @@ fn cancellation_preserves_a_concurrently_succeeded_parallel_task() {
         complete(&mut run, "step-a", Succeeded);
         let cancelled = Coordinator::cancel_run(&mut run, run.revision()).unwrap();
-        assert_eq!(run.revision(), 5); // <- depends on completion order
         assert_eq!(cancelled.len(), 1);
+        assert_eq!(run.tasks()[0].status(), TaskStatus::Succeeded);
+        assert_eq!(run.tasks()[1].status(), TaskStatus::Cancelled);
     }`;

export const SCHEDULER_DONE = `Fixed. The test now checks **what** happened instead of **how many** revisions it took:

- \`step-a\` stays **Succeeded** after the cancel
- \`step-b\` becomes **Cancelled**

The full e2e suite passed (5/5). I ran the unit test 200 times locally with \`--test-threads=8\`: no failures.`;

export const SCHEDULER_DECLINED = `Understood — I did not run the e2e suite. The fix only touches a unit-test assertion, so the risk is low, but please run \`pnpm test:e2e\` before merging:

${FENCE}diff
-        assert_eq!(run.revision(), 5);
+        assert_eq!(run.tasks()[1].status(), TaskStatus::Cancelled);
${FENCE}`;

export const RENDERER_PROMPT = 'Draft a design doc for incremental markdown rendering in the chat timeline. Keep streaming smooth for 5k-message sessions.';

export const RENDERER_THINKING = 'Constraints: no raw HTML, the parser is line based, blocks are immutable once complete. Cheapest win is caching parsed blocks by (id, text length) and only re-parsing the streaming tail.';

export const RENDERER_PARAGRAPHS: readonly string[] = [
  '## 1. Problem\n\nToday every text delta re-parses the whole message. For a 40 KB answer that is ~300 full parses per turn, which shows up as dropped frames once a session has a few thousand blocks.',
  '## 2. Goals\n\n- Parse cost proportional to the **new** text, not the whole message\n- No change to the safe Markdown subset (still no raw HTML)\n- Stable DOM for completed blocks so text selection survives streaming',
  '## 3. Approach\n\nSplit the source at the last *closed* block boundary (blank line outside a fence). Everything before it is frozen and cached by `(blockId, offset)`; only the tail is parsed on each delta.',
  '### 3.1 Fence tracking\n\nA fence opened in the frozen prefix keeps the boundary inside the fence, so an unterminated code block never splits.',
  '## 4. Virtualization\n\nCompleted messages outside the viewport render as fixed-height placeholders measured on first paint. The timeline keeps a height index keyed by block id.',
  '| Metric | Before | Target |\n|---|---|---|\n| Parse time per delta (40 KB) | 6.1 ms | < 0.5 ms |\n| Frames dropped / turn | 38 | 0 |\n| Memory for 5k blocks | 212 MB | 120 MB |',
  '## 5. Risks\n\n1. Heading/list continuation across the boundary\n2. Search needs the full text — keep it in the store, not the DOM\n3. Copy of a partially visible message must still copy the full answer',
  '## 6. Rollout\n\nShip behind the `timeline.incremental` flag, measure with `pnpm perf:smoke`, then make it the default.',
];

export const CRASH_PROMPT = 'PiUI crashes on startup after I restored my user profile from backup. Can you investigate?';

export const CRASH_LOG_COMMAND = 'Get-Content $env:APPDATA\\piui-lab\\logs\\startup.log -Tail 12';

export const CRASH_LOG_OUTPUT = `2026-09-25T08:14:02Z INFO  host starting version=0.2.0 safe_mode=false
2026-09-25T08:14:02Z INFO  index opened path=<app-data>/index.sqlite3
2026-09-25T08:14:02Z WARN  index schema version mismatch expected=14 found=12
2026-09-25T08:14:02Z INFO  running migration 12 -> 13
2026-09-25T08:14:03Z ERROR migration 13 -> 14 failed code=IO_ERROR
thread 'main' panicked at apps/desktop/src-tauri/src/state.rs:341:14:
called \`Result::unwrap()\` on an \`Err\` value: Custom { kind: Other, error: "index migration failed" }
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
error: process didn't exit successfully (exit code: 101)`;

export const CRASH_ANALYSIS_PARTIAL = `The log shows the index migration from schema 13 to 14 failing, followed by an \`unwrap()\` panic in \`state.rs\`. The restored backup contains an **older index** than the binary expects, and`;

export const CRASH_ERROR = 'Codex could not reach the model provider.';

export const CRASH_RETRY = 'Please continue where you left off.';

export const CRASH_ANSWER = `Picking up from the log:

1. The restored \`index.sqlite3\` is at schema **12**.
2. Migration 12 → 13 succeeds; 13 → 14 fails with \`IO_ERROR\` because the backup made the file **read-only**.
3. \`state.rs:341\` then \`unwrap()\`s the error and the host panics.

### Immediate workaround

${FENCE}powershell
attrib -R "$env:APPDATA\\piui-lab\\index.sqlite3"
${FENCE}

The index is rebuildable, so deleting it is also safe — Pi JSONL remains the source of truth.

### Proper fix

Replace the \`unwrap()\` with a typed startup error that opens **safe mode** and explains that the local index could not be upgraded.`;

export const COMPACTION_TOPICS: readonly string[] = [
  'How does Pi decide when to compact a session?',
  'What exactly is kept after compaction — the last user message too?',
  'Can PiUI show which messages were summarized?',
  'Does compaction change the session JSONL file?',
  'What happens to tool outputs that were summarized?',
];

export const COMPACTION_SUMMARY = 'Context compacted: 96 earlier messages were summarized to stay within the model window. The summary keeps decisions, open questions and file paths.';

export function compactionAnswer(topic: string, index: number): string {
  return [
    `**${topic}**`,
    '',
    index % 2 === 0
      ? '- Compaction is triggered by the native harness when the context approaches the model limit.\n- PiUI never rewrites history; it only renders the compaction entry the harness appended.'
      : '- The summary entry replaces older turns in the **model context**, not in the transcript.\n- Tool outputs are summarized with their file paths so they can be re-read on demand.',
    '',
    `See also: [compaction notes §${index + 1}](https://example.invalid/piui/docs/compaction#${index + 1})`,
  ].join('\n');
}

/** An API reference larger than the 64 KiB display limit: closed history truncates it. */
export function longReferenceAnswer(): string {
  const random = createRandom('long-reference');
  const sections = ['# Workspace protocol v15 — field reference', '', 'Generated for the lab. Every field, every error code, every event.'];
  const commands = ['catalog', 'createSession', 'openSession', 'snapshot', 'send', 'interrupt', 'closeSession', 'setModel', 'renameSession', 'respond'];
  for (let index = 0; index < 124; index += 1) {
    const command = commands[index % commands.length] ?? 'catalog';
    sections.push(
      '',
      `## ${index + 1}. \`${command}\` — case ${random.int(100, 999)}`,
      '',
      `The \`${command}\` command is validated before any native process is touched. Unknown fields are rejected, identifiers are opaque and the host re-checks project trust on every call. Revision ${random.int(1, 400)} illustrates the ordering guarantee: events for one session are strictly increasing, gaps trigger a snapshot, and a closed watermark is never reopened by a late event.`,
      '',
      `- **Errors:** \`INVALID_ARGUMENT\`, \`NOT_FOUND\`, \`${random.pick(['NOT_TRUSTED', 'SAFE_MODE', 'RUNTIME_FAILED', 'CONFLICT'])}\``,
      `- **Latency budget:** ${random.int(2, 90)} ms p95 on the reference machine`,
      `- **Emits:** ${random.pick(['session', 'block', 'textDelta', 'approval', 'approvalResolved'])} events`,
    );
  }
  return sections.join('\n');
}

export const STORYBOARD_PROMPT = 'Storyboard a 45-second launch trailer for the new video-studio release. Six shots, upbeat, ends on the logo.';

export const STORYBOARD_ANSWER = `# Launch trailer — storyboard v1

**Runtime:** 45 s · **Aspect:** 16:9 · **Mood:** upbeat, precise, warm

| # | Duration | Visual | Audio |
|---|----------|--------|-------|
| 1 | 0:00–0:05 | Macro shot: cursor lands on the timeline, frames ripple outward | Soft synth swell |
| 2 | 0:05–0:12 | Split screen: raw footage → graded footage in one sweep | Beat drop |
| 3 | 0:12–0:20 | Three editors collaborating, avatars bouncing on the timeline | Claps on beat |
| 4 | 0:20–0:30 | Render queue fills and completes in fast motion | Rising arpeggio |
| 5 | 0:30–0:40 | Final cut plays full screen, captions animate in | Melody resolves |
| 6 | 0:40–0:45 | Logo lockup on warm gradient | Single piano note |

## Notes for the edit

- Keep every UI shot **under 3 seconds** of static screen.
- Captions: sentence case, max 6 words.
- Deliver a 9:16 cut from shots 2, 4 and 6.`;

export const RENDER_PROMPT = 'Review the render farm config and tell me why jobs queue for so long.';

export const RENDER_CONFIG = `# render.yaml (lab)
queues:
  default:
    max_parallel: 2
    gpu: required
  previews:
    max_parallel: 8
    gpu: optional
workers:
  - name: node-a
    gpus: 2
  - name: node-b
    gpus: 2
retry:
  attempts: 5
  backoff_seconds: 300`;

export const RENDER_PARTIAL = 'The default queue allows only **2** parallel jobs while the farm has **4** GPUs, and the 300-second retry backoff keeps failed jobs parked. Increasing `max_parallel` to 4 should';

export const RENDER_ERROR = 'Hermes could not complete session/prompt (provider, -32603).';

export const AUDIT_PROMPT = 'Audit the legacy auth module for security problems. Read-only: do not change files.';

export const AUDIT_ANSWER = `# Legacy auth audit

Scope: \`src/auth/\` (read-only review, no changes made).

## Findings

| Severity | Issue | Location |
|----------|-------|----------|
| **High** | Session tokens compared with \`==\` (timing leak) | \`session.js:88\` |
| **High** | Password reset tokens never expire | \`reset.js:41\` |
| Medium | Bcrypt cost factor 8 | \`hash.js:12\` |
| Low | Login errors reveal whether the user exists | \`login.js:130\` |

### Recommended order

1. Constant-time comparison for tokens.
2. 30-minute expiry on reset tokens; invalidate on use.
3. Raise the bcrypt cost to 12 and rehash on next login.
4. Return a single generic login error.

> Nothing here requires a data migration except (3), which is transparent to users.`;

export const AUDIT_GREP_OUTPUT = `src/auth/session.js:88:  if (token == stored.token) {
src/auth/reset.js:41:  const reset = { token: randomToken(), createdAt: Date.now() };
src/auth/hash.js:12:const COST = 8;
src/auth/login.js:130:    return res.status(404).send('No such user');`;

export const KEYMAP_PROMPT = 'List the keyboard shortcuts of the pipeline editor and flag any that collide with the chat composer.';

export const KEYMAP_THINKING = 'Collect every keydown handler under app/pipelines and app/shell, normalise the modifiers, then compare the two sets. Report only real collisions, not shortcuts that are scoped to different focus targets.';

export const KEYMAP_GREP_COMMAND = 'rg -n "key ===|ctrlKey|metaKey" apps/desktop/src/app';

export const KEYMAP_GREP_OUTPUT = `apps/desktop/src/app/pipelines/PipelineEditor.svelte:212:    if (event.key === 'Delete' || event.key === 'Backspace') removeSelection();
apps/desktop/src/app/pipelines/PipelineEditor.svelte:219:    if ((event.ctrlKey || event.metaKey) && event.key === 'd') duplicateSelection();
apps/desktop/src/app/pipelines/PipelineEditor.svelte:226:    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') runPipeline();
apps/desktop/src/app/shell/Composer.svelte:88:    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') send();`;

export const KEYMAP_ANSWER = `## Pipeline editor shortcuts

| Shortcut | Action | Scope |
| --- | --- | --- |
| Delete / Backspace | Remove the selected nodes | Canvas |
| Ctrl+D | Duplicate the selection | Canvas |
| Ctrl+Enter | Run the pipeline | Editor |

**One collision:** Ctrl+Enter also sends a chat message. The handlers are scoped to different focus targets, so today they never fire together, but the editor handler listens on \`window\`. Scope it to the canvas element to keep it from ever reaching the composer.`;

/** Live reply fragments used by chat turns. */
export const LIVE_REPLY_OPENINGS: readonly string[] = [
  'Here is what I found.',
  'Done — summary below.',
  'Short answer first, details after.',
  'I checked the workspace before answering.',
];

export const LIVE_REPLY_SECTIONS: readonly string[] = [
  '### What I checked\n\n- Read the relevant module and its tests\n- Ran the focused test file\n- Compared the behaviour with the contract fixture',
  '### Result\n\n| Check | Status |\n|---|---|\n| Types | ✅ clean |\n| Unit tests | ✅ passing |\n| Contract fixture | ✅ unchanged |',
  `### Example\n\n${FENCE}ts\nconst snapshot = await workspaceHost.snapshot(sessionId);\nif (snapshot.session.status === 'idle') await send(draft);\n${FENCE}`,
  '### Next steps\n\n1. Review the diff\n2. Run the full suite before merging\n3. Update the changelog if the behaviour is user-visible',
  '> Note: this is the UI Lab host — no model was called and no file was changed.',
];

export const LIVE_THINKING: readonly string[] = [
  'Start from the user request, check the existing code path, prefer the smallest change that keeps the contract intact.',
  'Two candidate approaches. The first touches fewer files; confirm with a focused test before proposing it.',
  'The question is mostly explanatory. A short answer with one example and a table of trade-offs should be enough.',
];

export const LIVE_COMMANDS: readonly { command: string; output: string }[] = [
  { command: 'pnpm vitest run src/host-api', output: ' ✓ src/host-api/workspaceClient.test.ts (4 tests) 13ms\n ✓ src/host-api/orchestrationClient.test.ts (8 tests) 31ms\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)' },
  { command: 'git status --short', output: ' M apps/desktop/src/host-api/transport.ts\n M apps/desktop/src/features/workspace/SessionComposer.svelte\n?? apps/desktop/src/host-api/lab/labHost.test.ts' },
  { command: 'rg -n "TODO" apps/desktop/src --count', output: 'apps/desktop/src/app/App.svelte:3\napps/desktop/src/features/orchestration/SystemGraphEditor.svelte:1\napps/desktop/src/host-api/client.ts:1' },
  { command: 'cargo test -p piui-orchestration --quiet', output: 'running 61 tests\n.............................................................\ntest result: ok. 61 passed; 0 failed; 0 ignored; finished in 0.84s' },
];

export const LIVE_DIFFS: readonly { path: string; diff: string }[] = [
  {
    path: 'apps/desktop/src/features/workspace/workspaceUx.ts',
    diff: `--- a/apps/desktop/src/features/workspace/workspaceUx.ts
+++ b/apps/desktop/src/features/workspace/workspaceUx.ts
@@ -1,6 +1,8 @@
 /** A project switch never starts or stops a native session. */
 export function sessionForProject(sessions: WorkspaceSession[], projectId: string, currentId: string): string {
-  return sessions.some((session) => session.id === currentId && session.workspaceId === projectId) ? currentId : '';
+  const current = sessions.find((session) => session.id === currentId);
+  if (current?.workspaceId === projectId) return currentId;
+  return '';
 }`,
  },
  {
    path: 'contracts/README.md',
    diff: `--- a/contracts/README.md
+++ b/contracts/README.md
@@ -12,3 +12,6 @@ Versioned host contracts.
 - workspace-v15: sessions, events and approvals
 - orchestration-host-v7: schedules
+
+Browser development uses the UI Lab host (apps/desktop/src/host-api/lab).
+It implements these contracts in memory and never runs an agent.`,
  },
];
