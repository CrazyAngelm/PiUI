# PiUI

<p align="center">
  A fast, local desktop interface for browsing and continuing <a href="https://pi.dev/">Pi</a> sessions.
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://github.com/CrazyAngelm/PiUI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/CrazyAngelm/PiUI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/CrazyAngelm/PiUI/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/CrazyAngelm/PiUI?include_prereleases"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

> [!IMPORTANT]
> PiUI is an early developer preview. The current Windows build is unsigned, does not auto-update, and is not a managed Pi distribution or an OS sandbox. Read the [current limitations](#current-limitations) before using it with important sessions.

## Install

### Windows 10/11 (recommended)

1. Install the official [Pi CLI](https://pi.dev/) and confirm that `pi --version` works in a new terminal.
2. Open the [PiUI v0.1.0 release](https://github.com/CrazyAngelm/PiUI/releases/tag/v0.1.0).
3. Download `PiUI_0.1.0_x64-setup.exe` and the matching `SHA256SUMS.txt`.
4. Verify the checksum, run the installer, and open **PiUI** from the Start menu.
5. Choose **New chat** for a personal session or **Add project** to register an existing folder.

Verify the installer after downloading both files:

```powershell
Get-FileHash .\PiUI_0.1.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

The hash printed by `Get-FileHash` must match the installer entry in `SHA256SUMS.txt`.

Because this developer-preview build is not code-signed, Windows may show an unknown-publisher warning. Verify the checksum before running it. If you do not want to run an unsigned binary, [build from source](#build-from-source).

The portable `PiUI_0.1.0_windows_x86_64.exe` asset can be used without an installer. It has the same preview limitations.

### Linux and macOS

Prebuilt Linux and macOS packages are not published yet. Use the [source build](#build-from-source). Platform packaging, signing, and the complete release matrix remain open work.

### Updating

PiUI does not silently update itself. Download a newer release from GitHub and install it over the previous version. Pi sessions remain owned by Pi; PiUI's local SQLite database is only a rebuildable cache and UI metadata.

## First run

1. Start PiUI.
2. Use **New chat** to start without adding a project, or use **Add project** and explicitly review the folder trust prompt.
3. Select an existing session or create a new one.
4. Start the local Pi runtime, choose a model, and send a prompt.

Do not write to the same session from PiUI and the Pi CLI at the same time. Concurrent-writer semantics are not yet supported.

## What PiUI does

- discovers existing Pi JSONL sessions without introducing another chat format;
- renders a safe, bounded transcript with Markdown, reasoning, and grouped tool activity;
- continues indexed sessions or creates Pi-owned personal chats;
- starts a locally installed Pi CLI in RPC mode only after an explicit user action;
- streams typed runtime events through a narrow Rust/Tauri host API;
- keeps a rebuildable SQLite catalog separate from Pi's session files;
- provides project trust controls and local appearance preferences;
- supports keyboard navigation, safe generic fallbacks, and reduced motion.

PiUI wraps Pi. It does not replace Pi's agent loop, providers, tools, compaction, authentication store, or session branching.

## Current limitations

- The local live-RPC path is a preview, not a managed-runtime provenance guarantee.
- The Windows artifacts are unsigned and the application has no automatic updater.
- Concurrent Pi CLI/PiUI writes to one session are unsupported.
- Authentication stays in Pi's standard flow; PiUI does not read or expose `auth.json`.
- Packaged browser/Tauri E2E, managed-runtime acquisition, updater, and the full Windows/Linux platform matrix remain release gates.
- Project-local extension JavaScript stays disabled until its trust and isolation design is complete.

See [Foundation status](docs/13_FOUNDATION_STATUS.md), [open risks](docs/12_OPEN_RISKS.md), and the [release checklist](CHECKLIST_RELEASE.md) for the exact status.

## Build from source

### Prerequisites

- Git
- Node.js 22+
- pnpm 10.23+
- Rust 1.94.1 with `rustfmt` and `clippy`
- the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)
- a local Pi CLI for the live-runtime preview

### Development build

```bash
git clone https://github.com/CrazyAngelm/PiUI.git
cd PiUI
pnpm install --frozen-lockfile
pnpm tauri dev
```

### Release build

```bash
pnpm install --frozen-lockfile
pnpm repo:check
pnpm check
pnpm test
pnpm contract:test
cargo test --workspace
pnpm tauri build --no-bundle
```

The executable is written to `target/release/`. On Windows, maintainers can create the NSIS installer with:

```powershell
pnpm tauri build --bundles nsis --ci
```

## Quality checks

```bash
pnpm repo:check
python tools/validate_spec.py
pnpm check
pnpm test
pnpm contract:test
pnpm build
pnpm test:e2e
pnpm perf:smoke
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`pnpm test:e2e` is currently a static UI smoke check rather than a packaged desktop E2E suite.

## Repository layout

```text
apps/desktop/           Tauri 2 host and Svelte 5 interface
crates/piui-contracts/  Safe host/UI DTOs and fixtures
crates/piui-index/      Rebuildable SQLite index and LF-only session scanner
crates/piui-runtime/    Pi RPC adapter, lifecycle, and stream projection
crates/piui-platform/   Native identity and process-containment primitives
crates/piui-extensions/ Extension manifest validation
contracts/              Versioned TypeScript contracts
docs/                   Product, architecture, security, and release documentation
spikes/                 Isolated evidence and experiments, not runtime dependencies
```

## Documentation

- [Product scope](docs/01_PRODUCT.md)
- [UX and information architecture](docs/02_UX.md)
- [Architecture](docs/03_ARCHITECTURE.md)
- [Pi integration](docs/04_PI_INTEGRATION.md)
- [Extension SDK](docs/05_EXTENSION_SDK.md)
- [Data and sessions](docs/06_DATA_AND_SESSIONS.md)
- [Security model](docs/07_SECURITY.md)
- [Testing and performance](docs/08_TESTING_AND_PERFORMANCE.md)
- [Roadmap](docs/09_ROADMAP_AND_TASKS.md)
- [Architecture decisions](docs/10_ADR.md)

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before opening a pull request. Changes to IPC contracts require a version bump, compatibility coverage, and an update under `contracts/`.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). Never publish credentials, prompts, session files, or local filesystem paths in an issue.

## License

PiUI is licensed under the [MIT License](LICENSE). Third-party dependencies and referenced external materials remain subject to their own licenses and terms.
