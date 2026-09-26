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

## Browser development (UI Lab)

`pnpm --filter @piui/desktop dev` serves the UI at http://localhost:1420 without Tauri. Every host call then goes
through [`src/host-api/transport.ts`](src/host-api/transport.ts) to the UI Lab host in
[`src/host-api/lab/`](src/host-api/lab/): a deterministic, in-memory fake of the Rust host with the same commands,
JSON shapes, error codes and event channels. It simulates native turns and orchestration runs with timers and never
runs an agent, touches a file or makes a network request. Choose a scenario with `?lab=`:

- `demo` (default): four projects, twelve chats on all five harnesses (one paused on an approval, one on an MCP
  form request, one streaming), saved agent systems, schedules and runs that succeeded, failed, are running or await
  approval;
- `empty`: first run — only the host-owned Chats workspace and harness setup states;
- `safe`: the demo after a restart in safe mode (runtime actions refused, interrupted runs need reconciliation);
- `long`: one ~3,000-block transcript for performance work.

Add `&claude=signed-out` to any scenario to see Claude Code without a subscription login: the new-chat composer's
sign-in status and a saved "Claude check" system whose run fails before it starts.

The classic `client.ts` routes (bootstrap, preferences, projects, trust) still use `mockClient.ts` in the browser.

## Commands

```bash
pnpm --filter @piui/desktop check
pnpm --filter @piui/desktop test
pnpm --filter @piui/desktop build
pnpm --filter @piui/desktop test:e2e
pnpm --filter @piui/desktop perf:smoke
```
