# Testing PiUI

How to run the automated checks, what each one proves and what CI runs. The
quality targets and budgets live in
[08_TESTING_AND_PERFORMANCE.md](08_TESTING_AND_PERFORMANCE.md).

None of these checks run a paid model turn, read credentials or touch the
installed app. Synthetic evidence (UI Lab, fixture peers) is reported
separately from real-harness evidence.

## Commands

| Command | What it checks | Where |
| --- | --- | --- |
| `pnpm check` | svelte-check: TypeScript and Svelte in `apps/desktop/src` | any OS |
| `pnpm --filter @piui/desktop check:e2e` | Types of the Playwright specs (`apps/desktop/e2e`) | any OS |
| `pnpm test` | Vitest unit tests (`src/**/*.test.ts`, `scripts/**/*.test.mjs`); `e2e/` is excluded | any OS |
| `pnpm contract:test` | Contract fixtures, schema validators, backward compatibility | any OS |
| `pnpm system:check examples/systems/*.piui.json` | Portable system files through the UI parser | any OS |
| `node --test crates/piui-runtime/bridge/*.test.mjs` | Native bridge adapters against fake peers | any OS |
| `pnpm agent:api:test` | Agent API client and starter | any OS |
| `pnpm test:lab` | Playwright E2E against the browser UI Lab, plus the production build under the app CSP | any OS |
| `pnpm test:e2e` | Tauri/WebView2 E2E: debug app, isolated data, new shell | Windows |
| `pnpm test:smoke`, `pnpm perf:smoke` | Static source smoke and initial asset budget (after `pnpm build`); not E2E evidence | any OS |
| `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` | Rust formatting, lints and tests | Windows, Linux (Tauri system packages) |

## Browser E2E against the UI Lab (Playwright)

The UI runs in a plain browser against the deterministic UI Lab host
(`src/host-api/lab`, selected by `?lab=demo|empty|safe|long`). It answers the
host's commands with the same shapes and error codes, simulates native turns
and pipeline runs with timers, and never starts an agent, touches a file or
calls the network. Each test gets a fresh page, so the lab starts from its seed.

```bash
pnpm test:lab                                        # both projects
pnpm --filter @piui/desktop test:lab --project=lab   # dev server only
pnpm --filter @piui/desktop test:lab:prod            # production build + CSP only
pnpm --filter @piui/desktop test:lab -g "approvals"  # by title
pnpm --filter @piui/desktop test:lab --headed        # watch it
```

Projects (`apps/desktop/playwright.config.ts`):

- `lab` — the Vite dev server on `127.0.0.1:5391` (`--strictPort`). A global
  setup visits every lazy view once so a cold server does not race the specs.
- `prod-csp` — `vite build`, served by `e2e/serve-dist.mjs` on `127.0.0.1:5392`
  with the `Content-Security-Policy` read from `src-tauri/tauri.conf.json` at
  start. The walk fails on any `securitypolicyviolation` event or console CSP
  error, and checks that closing dialogs and menus leaves the page clickable.

Browser: local runs use the installed Microsoft Edge (`channel: 'msedge'`), so
nothing is downloaded. CI installs Playwright's Chromium. Overrides:
`PIUI_E2E_CHANNEL` (`chromium`, `chrome`, `msedge`), `PIUI_E2E_LAB_PORT`,
`PIUI_E2E_PROD_PORT`, `PIUI_E2E_WORKERS`. A dev server already running on the
lab port is reused locally, never in CI.

Output (all git-ignored under `apps/desktop/`):

- `playwright-report/` — HTML report (`pnpm --filter @piui/desktop exec playwright show-report`);
- `test-results/playwright/` — traces, failure screenshots and page snapshots;
- `test-results/screenshots/<screen>-<light|dark>.png` — every main screen in
  both themes, written on every run for visual review (not compared).

Covered flows, each with at least one failure path:

- Shell: sidebar sections and `aria-current`, project collapse, trust from the
  project menu and Settings (cancel keeps it restricted), the unsaved-pipeline
  guard (Escape does not discard), Ctrl+K palette (commands by visible label,
  chats by title, "Nothing found"), theme (dark, light, system, palette toggle),
  Russian copy that persists and leaves chat titles untranslated.
- Chat: Home → harness → model → reasoning → send → streamed answer, with the
  model and reasoning verified in the native session settings; restricted
  project asks for trust; safe mode; signed-out Claude Code; approval allow,
  deny and from the Inbox; follow-up queue that drains after the turn; steer
  into a running turn; an uncertain delivery that blocks the queue.
- Pipelines: Review loop template → Start inputs → Check with a graph issue →
  Run (required input refused, then accepted) → run canvas states → step panel
  tabs → "Accept last result" / "One more round" at a one-round review limit;
  a failed run keeps its failure when repeating is declined.
- Editor: Model call and Script nodes, their inspector tabs, the "not a
  sandbox" warning, Insert example (Node.js and Python), an empty script and an
  invalid time limit.
- Automations: weekday calendar schedule with the next-run preview, required
  pipeline inputs, on/off; empty time and empty day set are refused.
- Keyboard: skip link, sidebar tab order and activation, global shortcuts,
  dialog focus trap with Escape and focus return (also from a menu), pickers.
- Accessibility: axe-core (WCAG 2.1 A/AA) on twelve screens in light and dark;
  serious and critical violations fail. The only reviewed exception is listed
  in `e2e/screens.spec.ts` (`KNOWN`), with its reason.
- CSP: the production build under the shipped policy (see above).

Writing specs: use semantic locators (`getByRole` with the accessible name,
`getByLabel`). When a control has no accessible name, add one to the component
instead of using a CSS selector. Unexpected console errors fail a test; opt out
per test with `test.use({ allowConsoleErrors: true })` only when the failure is
the point. Keep specs in `apps/desktop/e2e/`; Vitest never loads them.

## Windows Tauri/WebView2 E2E

`pnpm test:e2e` (Windows only; Linux has no WebKit harness yet and fails
explicitly) runs `scripts/tauri-webview2-e2e-controller.mjs`, which:

1. builds the feature-gated `piui-e2e-job` runner and a debug `piui-desktop`
   with `e2e-webview-automation` (never a release build or the installed app);
2. starts Vite on a random loopback port and the debug app inside Windows Job
   Objects, with app data and the WebView2 profile in the isolated fixture
   `<repo>/target/piui-e2e/<run>` (the debug host accepts no other root);
3. drives the WebView through the debug-only, exact-origin loopback automation
   seam, then restarts the app with `--safe-mode`;
4. proves the Job is empty, removes the fixture and keeps logs, the report and
   native-window screenshots in `<repo>/target/piui-evidence/<run>/`.

Scenarios:

- default — the new shell (default view): landmarks, a project registered
  through the typed host shows as restricted, trust is an explicit dialog
  (focus trap, Escape restores focus, then trusted in the host catalog), the
  palette returns focus, the theme persists through the host across a reload,
  Russian persists, Pipelines and Home work; safe mode shows the banner,
  disables the composer and keeps the catalog readable. Claude Code and Hermes
  resolve to missing fixture paths and Pi/Prime to synthetic fixture peers, so
  no agent starts.
- `--classic` (`pnpm --filter @piui/desktop test:e2e:classic`) — the retained
  compatibility view (`?view=classic`): runtime chooser, extension inventories,
  Pi fallback and Prime read-only boundaries.
- `--workspace` (`test:e2e:workspace`) — the legacy workspace shell
  (`?view=legacy`) with installed native harness code and a local synthetic
  provider, until the new shell reaches parity.
- `--agent-api` (`pnpm agent:api:e2e`) — the agent API over the same harness.

Cargo output goes to `PIUI_E2E_CARGO_TARGET_DIR`, else `CARGO_TARGET_DIR`,
else `<repo>/target`. On a shared machine use a private directory and fewer
jobs, for example:

```bash
CARGO_TARGET_DIR=D:/Projects/PIUI/target/e2e-ci CARGO_BUILD_JOBS=3 pnpm test:e2e
```

Requirements: the WebView2 runtime, the Rust toolchain from
`rust-toolchain.toml`, Node 22+ and Python 3.13 (`py -3.13`, standard library
only) for native-window screenshots.

## What CI runs

`.github/workflows/ci.yml` (no secrets; release packaging stays in
`release.yml`):

- **Frontend quality** (Ubuntu): repository audit, spec and runtime-evidence
  validators, svelte-check, e2e spec types, Vitest, contract tests, example
  system files, bridge tests, agent API tests, build, static smoke, asset budget.
- **UI Lab E2E** (Ubuntu): installs Playwright Chromium, runs `pnpm test:lab`
  (lab + prod-csp). On failure it uploads `lab-e2e-report` (HTML report,
  traces, screenshots).
- **Rust** (Ubuntu and Windows): fmt, clippy with `-D warnings`, and tests for
  the whole workspace; Ubuntu installs the Tauri system packages; the cargo
  cache is shared per OS.
- **Tauri WebView2 E2E and no-bundle build** (Windows): Prime static spike,
  E2E Job runner lint and containment tests, `pnpm test:e2e` (new shell),
  `tauri build --no-bundle`.
