# PiUI

> A minimal, local desktop interface for browsing and continuing [Pi](https://pi.dev/) sessions.

PiUI is an **early developer preview**, not a production-ready Pi distribution or sandbox. It wraps Pi rather than replacing its agent loop, provider clients, tools, session format, or authentication store.

## What PiUI does today

- registers local project folders behind an explicit trust decision;
- discovers existing Pi JSONL sessions read-only and renders a bounded, safe timeline;
- starts a locally installed Pi CLI in RPC mode only after an explicit user action;
- continues an indexed session or starts a Pi-owned personal chat;
- streams typed user, assistant, reasoning, and tool activity into one transcript;
- keeps a rebuildable SQLite index separate from Pi JSONL;
- provides local appearance preferences, including theme, text size, density, motion, and conversation width.

## Current limitations

This repository is public because the source is useful for review and contribution. It is **not** a claim that every release gate is complete.

- The live-RPC path is a developer preview, not a managed/runtime-provenance guarantee.
- Concurrent writes to the same session from PiUI and the Pi CLI are not yet a supported workflow.
- Authentication stays in Pi's standard flow; PiUI does not read or expose `auth.json`.
- Windows and Linux are target platforms; release packaging, containment, updater, and platform-matrix gates remain open.

See [Foundation status](docs/13_FOUNDATION_STATUS.md), [open risks](docs/12_OPEN_RISKS.md), and the [release checklist](CHECKLIST_RELEASE.md) before treating PiUI as release-ready.

## Privacy and security boundary

PiUI is intentionally local-first:

- Pi JSONL remains the source of truth; PiUI does not write session JSONL directly.
- The WebView receives only typed, allowlisted host commands and safe display projections.
- Credentials, raw environment variables, filesystem paths, and agent-session artifacts must not be committed.
- `.pi/`, `.piui/`, local databases, logs, mutation outputs, build products, and `.env*` files are ignored by default.

If you find a vulnerability or accidentally committed sensitive data, follow [SECURITY.md](SECURITY.md). Do not put secrets, prompts, session files, or local paths in public issues.

## Development

### Prerequisites

- Node.js 22+
- pnpm 10.23+
- Rust 1.94.1 with `rustfmt` and `clippy`
- Platform prerequisites for [Tauri 2](https://v2.tauri.app/start/prerequisites/)
- A local Pi CLI only when exercising the live-RPC preview

### Install and verify

```bash
pnpm install --frozen-lockfile
pnpm repo:check
pnpm check
pnpm test
pnpm contract:test
pnpm build
pnpm test:e2e
pnpm perf:smoke
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Run the desktop app during development:

```bash
pnpm tauri dev
```

### Additional quality gates

```bash
pnpm repo:check
pnpm mutation:test
pnpm mutation:catalog-state
python tools/validate_spec.py
python tools/validate_runtime_evidence.py --check evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1
```

`pnpm test:e2e` is currently a static UI smoke check, not a packaged desktop E2E suite. The required release-level platform and real-Pi checks are documented in [docs/08_TESTING_AND_PERFORMANCE.md](docs/08_TESTING_AND_PERFORMANCE.md).

## Repository layout

```text
apps/desktop/           Tauri 2 host and Svelte 5 interface
crates/piui-contracts/  Safe host/UI DTOs and fixtures
crates/piui-index/      Rebuildable SQLite index and LF-only session scanner
crates/piui-runtime/    Pi RPC adapter, lifecycle, and safe stream projection
crates/piui-platform/   Native identity and process-containment primitives
crates/piui-extensions/ Extension manifest validation
contracts/              Versioned TypeScript contracts
fixtures/               Synthetic, credential-free test data
spikes/                 Isolated evidence and experiments; not runtime dependencies
docs/                   Product, architecture, security, and release documentation
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), and the [architecture documentation](docs/03_ARCHITECTURE.md) before opening a pull request. Changes to IPC contracts require a version bump, compatibility coverage, and an update under `contracts/`.

## Documentation

Most detailed project documentation is currently in Russian:

- [Product and scope](docs/01_PRODUCT.md)
- [UX and settings](docs/02_UX.md)
- [Architecture](docs/03_ARCHITECTURE.md)
- [Pi integration](docs/04_PI_INTEGRATION.md)
- [Security model](docs/07_SECURITY.md)
- [Testing and performance](docs/08_TESTING_AND_PERFORMANCE.md)
- [Changelog](CHANGELOG.md)
- [Sources and provenance notes](sources/SOURCES.md)

## License

PiUI is licensed under the [MIT License](LICENSE). Third-party dependencies and cited external materials remain subject to their own licenses and terms.
