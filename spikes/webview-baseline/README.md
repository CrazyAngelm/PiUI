# PiUI SPIKE-08 — WebView baseline

A self-contained, deliberately narrow Tauri 2 + Rust + Svelte 5 + Vite harness for measuring the PiUI desktop WebView before product UI work begins.

## Scope

- Accessible static shell: persistent 272 px sidebar and chat surface.
- CSS semantic tokens from `docs/02_UX.md`.
- `?fixture=10k` renders a fixed-height, virtualized 10,000-row timeline; only the viewport plus overscan is mounted.
- No Pi runtime, IPC commands, network calls, shell/filesystem access, Electron, Tailwind, Tauri plugins, or extension loading.
- Empty Tauri capability permission set and a production CSP that allows local app assets only.

This is not a product foundation and does not establish any runtime/session behavior.

## Prerequisites

- Node.js 22+ and pnpm 10.23.0
- Stable Rust toolchain
- The platform dependencies required by Tauri 2 (including WebView2 on Windows or WebKitGTK on Linux)

## Commands

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm cargo:check
pnpm tauri dev
pnpm perf:baseline
```

For DOM inspection, open the Vite development URL with `?fixture=10k`; a packaged release build is required for performance numbers.

## Measurement protocol

`pnpm perf:baseline` creates `reports/baseline-result.json` and `reports/baseline-report.md`. It is a report template, not a benchmark: it marks startup, visible-window RSS/CPU, 10k-block scrolling, and platform rendering **inconclusive**.

On each reference machine, collect and append:

1. packaged release build and commit/dependency versions;
2. OS, hardware profile, display scale, and system WebView version;
3. 20 cold and 20 warm process-start-to-first-visible-frame samples (p50/p95);
4. visible-window, no-Pi-runtime RSS and CPU after 60 seconds idle, with process-tree attribution;
5. scroll frame-time/long-task samples for `?fixture=10k`;
6. Windows WebView2 and Linux WebKitGTK rendering/accessibility notes.

The target hard gates are documented in `docs/08_TESTING_AND_PERFORMANCE.md`: warm startup p50 ≤ 0.8 s / p95 ≤ 1.5 s, RSS ≤ 160 MiB on Windows/macOS or ≤ 190 MiB on Linux, and long-session scroll p95 ≤ 20 ms. This spike makes no claim that any budget is met.

## Security posture

The frontend has no host API calls. `src-tauri/capabilities/default.json` grants no permissions; no shell, filesystem, dialog, HTTP, or plugin capabilities are present. The CSP blocks remote scripts, framing, form posts, and external connections. Production developer tools are disabled.

See [decision note](docs/DECISION.md) for the SPIKE-08 go/no-go evidence still required.
