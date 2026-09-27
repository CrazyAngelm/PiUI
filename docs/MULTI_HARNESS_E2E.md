# Multi-harness native workspace E2E

## Status

**Removed.** This proof drove the previous workspace shell (`?view=legacy`),
which was deleted with the classic views after parity
([CLASSIC_PARITY.md](CLASSIC_PARITY.md)). `workspace-webview2-e2e.mjs` and the
`--workspace` scenario no longer exist; the default native proof drives the new
shell (`scripts/shell-webview2-e2e.mjs`, see [TESTING.md](TESTING.md)) and
`--agent-api` keeps the agent API proof. The text below is kept as the record of
what the removed proof checked.

It passed in the managed Windows Tauri/WebView2 harness. Evidence: `target/piui-evidence/28012-1788697591831/report.json`.

`apps/desktop/scripts/workspace-webview2-e2e.mjs` is the redesigned-workspace scenario for the existing Windows Tauri/WebView2 harness. It does not start Vite, Cargo, Tauri, Node adapters, or any other process. The existing outside controller and the feature-gated Windows Job runner must remain the only process owners.

The scenario uses the authenticated debug-only WebView automation transport. Every application operation goes to the real Tauri command handler. It has no browser mock store and no branch that turns a failed host request into a successful check.

## Proof contract

The normal-process scenario requires and checks:

- the default `DesktopRoot -> WorkspaceShell` route starts in **Sessions**;
- the real workspace v11 catalog reports protocol 11;
- an isolated existing folder is registered with typed `add_project_v10`, then its explicit **Review trust** / **Trust** decision is completed in the UI;
- actual unavailable or unverified harness status and its host reason remain visible in the new-session UI;
- a prompt-free native session starts only if the host reports either Prime Agent SDK `0.9.2` or a Codex app-server inside its verified version range (`crates/piui-runtime/bridge/CONTRACT.md`) as available;
- the native session is snapshotted, renamed, and kept open across the read-only legacy-history route; visible UI controls then close it, explicitly reopen the same opaque zero-turn workspace session without a duplicate catalog row, prove Idle, and close it again for safe-mode restart;
- snapshot JSON does not expose `nativeId` or `nativePath`;
- profile, team, pipeline, and launch-command definitions are created, read, updated, reloaded, and deleted through the visible workspace UI and the real orchestration store;
- the saved launch-command UI starts one real coordinator request whose intentionally unsupported Prime Agent read-only policy is rejected before native session creation; the UI and read-only host recovery show the durable failed run and exact safe preflight task code (`runtime-unavailable` when Prime is unavailable, otherwise `unsupported-policy`), never a fabricated success;
- the keyboard shortcut for **New chat**, screen-reader landmarks and control labels, light and dark themes, and the narrow labelled navigation drawer work in the actual WebView;
- unknown workspace command variants, a forged native-path field, a forged ordinary-session `profileId` field, a forged actor field, a forged approval reply, and forged native/orchestration workspace ids are rejected by Tauri decoding or the host use case;
- actual native-window screenshots are captured for unavailable readiness, light theme, dark narrow layout with the drawer closed and open, workspace definitions, the real policy-rejected failed run, and safe mode;
- phase durations plus Navigation Timing and Paint Timing samples are returned as measured milliseconds. They are evidence, not pass thresholds. The browser sample is a Tauri WebView2 dev-server navigation, not cold packaged startup.

The second process starts the same isolated app-data directory with `--safe-mode`. It requires and checks:

- workspace runtime actions and definition editing are visibly read-only;
- typed native session creation is rejected by the host;
- typed orchestration run creation using definitions persisted by the normal process is rejected by the host, while visible **Start run** and saved **Launch** controls remain disabled;
- no synthetic run is accepted as proof.

The ordinary session lifecycle does not send a model prompt. The coordinator launch uses an intentionally unsupported Prime Agent read-only policy, so scheduler preflight records failure before creating a native session or sending task instructions. A credentialed model-turn probe is separate root-owned evidence. The fixture replaces user profile, application-data, session, agent, WebView profile, and temporary roots with controller-owned directories. The scenario never reads or copies `auth.json`.

## Integration with the existing launcher

The scenario exports:

```js
import { runWorkspaceWebview2Proof } from './workspace-webview2-e2e.mjs';
```

Call it only after the existing inner harness has:

1. started Vite through `piui-e2e-job.exe`;
2. built Tauri with `e2e-webview-automation`;
3. started the real Tauri executable through the same Job runner;
4. observed a ready automation page at the default `pageOrigin` route;
5. created the isolated fixture and verified isolated Tauri/WebView data.

The exact call is:

```js
const normalWorkspace = await runWorkspaceWebview2Proof({
  automation,
  expectedPageUrl: pageOrigin,
  harness: { fixture, ownedChild: app, appOwnerPid: app.child.pid },
  mode: 'normal',
  commandBoundMs: COMMAND_BOUND_MS,
  startupBoundMs: STARTUP_BOUND_MS,
  captureScreenshot: captureActualTauriWindow,
  resizeWindow: resizeExactTauriWindow,
});
```

After controlled termination of that app, start the same executable and environment with `--safe-mode`, wait for a new automation generation at the default route, then call:

```js
const safeWorkspace = await runWorkspaceWebview2Proof({
  automation,
  expectedPageUrl: pageOrigin,
  harness: { fixture, ownedChild: app, appOwnerPid: app.child.pid },
  mode: 'safe',
  commandBoundMs: COMMAND_BOUND_MS,
  startupBoundMs: STARTUP_BOUND_MS,
  captureScreenshot: captureActualTauriWindow,
  resizeWindow: resizeExactTauriWindow,
});
```

Aggregate both returned `checks`, `timings`, and `screenshots` into the inner JSON report. Do not print `status: "pass"` unless both calls return and controlled teardown proves an empty Job Object.

`resizeExactTauriWindow` is also required and receives `{ width, height, appOwnerPid }`. Use the same direct-child HWND ownership check before resizing. The scenario verifies the resulting WebView viewport crosses the CSS breakpoint; a no-op resize cannot pass.

The classic compatibility proof (`--classic`, opt-in) must navigate to `?view=classic`. Since the new shell became the default view, the workspace calls above navigate to `?view=legacy`, the shell they were written for, until the new shell reaches parity; the default route is covered by the shell proof (`scripts/shell-webview2-e2e.mjs`, see [TESTING.md](TESTING.md)). The loopback origin stays unchanged, so the authenticated automation origin check remains valid. Do not put these suites on the same URL.

The outside controller runs this scenario through the managed `--workspace` branch of `tauri-webview2-dialog-e2e.mjs` and recognizes its workspace-v11 pass target. The scenario does not spawn a second launcher. The classic scenario keeps its separate `?view=classic` route.

`captureActualTauriWindow` is intentionally required. The scenario calls it as `captureActualTauriWindow({ name, path, appOwnerPid })`. `appOwnerPid` is the contained Tauri Job-runner owner pid and must equal `ownedChild.child.pid`; it is not claimed to be the native app pid. The native helper must find exactly one direct `piui-desktop.exe` child with the exact E2E window title; it must not capture the desktop or another process. `path` is fixed below the controller-owned fixture root. The helper must write the exact PNG path and return the same path. The scenario checks file existence and the PNG signature. The existing automation module has `evaluate`, key dispatch, and reload only. An HTML/DOM dump is not a screenshot. Preserve or publish the named artifacts before the outside controller removes its run directory.

## Current verification state

The complete normal and safe-mode scenario passed in the real managed Windows harness. The retained report is `target/piui-evidence/21760-1788691641684/report.json`.

The run used:

- actual Tauri and WebView2 `152.0.0.0`;
- verified Prime Agent SDK `0.9.2` for the prompt-free native lifecycle;
- isolated, empty native homes without provider credentials;
- controller-owned Windows Job processes and exact direct-child window capture;
- seven retained `2360×1560` or `1440×1400` native PNGs.

The normal process passed all declared checks. This includes visible project trust, honest unavailable-harness state, zero-turn native start/snapshot/rename, legacy-history continuity, themes and narrow drawer states, full definition CRUD with host readback and deletion, the saved-command `unsupported-policy` terminal failed run, forged-boundary rejections, the first graceful close, same-opaque-ID Idle reopen without a duplicate catalog row, and the second graceful close. Neither graceful close displayed `.inline-error[role="alert"]`.

The safe restart selected the exact persisted non-personal project in the visible UI. It passed host rejection for native creation and orchestration start, kept **Create session**, **Start run**, and the saved **Launch** action disabled, showed the read-only notices, and retained the closed native session as readable history. Direct pixel inspection of `workspace-safe-mode.png` confirms the selected project, Closed native session, safe-mode notices, saved pipeline, saved launch command, and disabled Launch control. Direct pixel inspection of `workspace-run-failed.png` confirms the failed run, safe unsupported-policy message, failed task, and exact `unsupported-policy` code.

Measured timings from the report, in milliseconds:

| Sample | Shell observed | Scenario total | Key phases |
| --- | ---: | ---: | --- |
| normal | 260 | 18,911 | startup 29; trust 207; native lifecycle 2,306; appearance 2,644; orchestration CRUD/run 5,627; close/reopen/reclose 7,412 |
| safe | 168 | 591 | safe-mode proof 551 |

Navigation values were also retained in the report. WebView2 did not expose first-paint or first-contentful-paint entries for these samples, so both remain `null`; no value was fabricated. Complete owned-process-tree memory snapshots were recorded with every image. Normal working-set samples ranged from `477,020,160` to `758,255,616` bytes and private-byte samples from `255,295,488` to `510,935,040` bytes. The safe capture recorded `471,408,640` working-set bytes and `245,002,240` private bytes. These measurements are evidence, not thresholds.

The outside controller proved `outer-job-empty-before-fixture-removal` and `fixture-removed`. The earlier diagnostic failures at `22288`, `18012`, and `24712` found the stale close projection, cached-model reopen override, and safe project-selection bug. The final run proves those fixes in their actual lifecycle paths.

This scenario does not claim a successful model pipeline. The ordinary session sends no prompt. The coordinator fixture is deliberately rejected at policy preflight before session creation. A credentialed successful model turn remains separate root-owned evidence.

## Result shape

Each successful scenario call returns only bounded proof data:

```json
{
  "checks": ["..."],
  "timings": { "browser": { "sample": "tauri-webview2-dev", "firstContentfulPaintMs": 0 }, "startup": 0, "total": 0 },
  "screenshots": ["controller-owned/path.png"]
}
```

The numeric values above show the schema only. They are not claimed measurements. Actual values must come from `performance.now()` during the WebView2 run.

## UI refinement verification, 2026-09-06

The updated scenario passed with native Codex 0.147.0 on WebView2 152.0.0.0.
It additionally proves trust-modal focus containment, Escape preserving an
unsaved profile, explicit discard before a New chat shortcut, a visible composer,
follow-to-latest and preservation of the reader’s scroll position. Eight native
screenshots and the controller’s empty-Job cleanup proof accompany the report.

The normal scenario took 11,710 ms and safe mode 631 ms. Dev WebView DOM-content
loaded was 177 ms; first-paint fields were unavailable. The conversation screenshot
measured 729,878,528 working-set bytes across the owned 13-process tree, including
the native Codex process. These are development snapshots, not packaged startup
or an isolated PiUI idle-RSS benchmark.
