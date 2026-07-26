# PiUI desktop

This package is the Svelte/Tauri composition layer for PiUI's foundation plus a temporary local live-RPC preview.

## What works in this slice

- local project registration and explicit trust state;
- read-only session/timeline/tree presentation with generic fallbacks;
- deterministic fake-runtime start/stop diagnostics;
- explicit local Pi RPC start/stop for trusted projects, existing-session continuation, new-session creation, prompt/steer/follow-up/abort, streamed generic timeline blocks, and model/thinking controls;
- safe diagnostics explanation and responsive, keyboard-accessible shell.

## Intentionally unavailable

- headless/provider authentication UI (Pi auth remains external);
- safe concurrent CLI/PiUI writer coordination, branch navigation, managed runtime packaging, and release-ready process containment;
- unrestricted filesystem, shell, process, or credential API in the WebView.

The local live-RPC path is a developer preview, not a release/containment claim. The production gate and missing evidence are recorded in [`../../spikes/PHASE0_GATE.md`](../../spikes/PHASE0_GATE.md) and [`../../docs/13_FOUNDATION_STATUS.md`](../../docs/13_FOUNDATION_STATUS.md).

## Commands

```bash
pnpm --filter @piui/desktop check
pnpm --filter @piui/desktop test
pnpm --filter @piui/desktop build
pnpm --filter @piui/desktop test:e2e
pnpm --filter @piui/desktop perf:smoke
```
