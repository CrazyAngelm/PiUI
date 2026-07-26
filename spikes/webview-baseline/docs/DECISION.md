# SPIKE-08 decision note — WebView baseline

**Status:** pending physical reference-machine evidence.

## Decision under test

Tauri 2 with Svelte 5 and the system WebView remains the candidate PiUI host only if it has a realistic path to the hard startup, idle RSS, and long-session scroll budgets on mandatory Windows and Linux environments.

## What this harness establishes

- A minimal Tauri 2/Rust/Svelte 5/Vite app builds without Electron, Tailwind, Tauri plugins, host commands, shell access, or filesystem access.
- The core window's capability set is empty, and the production CSP is local-asset-only.
- The UI has the intended baseline topology (272 px sidebar plus chat workspace), semantic CSS tokens, keyboard-visible focus states, labeled controls, and reduced-motion handling.
- `?fixture=10k` uses fixed-row virtualization, so the DOM is bounded to visible rows plus overscan instead of 10,000 mounted timeline blocks.

## Evidence not yet established

This repository run cannot establish any physical GUI metric. The following remain **inconclusive** until measured on the profiles in `docs/08_TESTING_AND_PERFORMANCE.md`:

- cold/warm first visible frame;
- idle RSS and CPU with a visible window;
- 10k-block frame times, main-thread stalls, and repeated open/close retention;
- WebView2 versus WebKitGTK rendering/accessibility differences;
- iframe/worker isolation. This harness intentionally contains neither surface, so it cannot validate rich-view isolation.

## Go/no-go rule

Do not treat Tauri as accepted for product implementation or claim a low-memory desktop shell until packaged release measurements on physical Windows and Linux reference machines meet, or demonstrably have a credible optimization path to, the documented hard gates. A hard-gate failure triggers reconsideration of the UI stack before coupling product features to it.

## Measurement artifact contract

Run `pnpm perf:baseline` to generate the report shape. Before a decision, replace each inconclusive record with raw samples, p50/p95/p99 where applicable, packaged-build identity, hardware/WebView versions, collection method, and a pass/fail conclusion. Keep raw JSON alongside the human-readable report; do not infer RSS from Node or from a hidden/non-packaged window.
