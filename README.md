# PiUI

<p align="center">
  A local desktop workbench for native agent harnesses — Codex, Claude Code, Pi, Hermes and Prime Agent — and for designing, running and scheduling multi-agent pipelines.
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
> PiUI 0.2.0 is a developer preview. Windows is the primary, verified platform. Linux packages build, but native agent lifecycle containment is only verified on Windows; macOS is experimental. A release is code-signed and can update itself only when its notes say so; otherwise it is unsigned and never checks for updates. PiUI is not an OS sandbox. Read the [current limitations](#current-limitations) before using it with important work.

## What PiUI does

- **Chat with the agent tools you already use.** One chat surface drives Codex, Claude Code, Pi, Hermes and Prime Agent with a harness → model → reasoning picker fed by each harness's own catalog, streaming activity, diffs, inline approvals, a message queue with steer and follow-up, slash commands and in-chat search. Each harness keeps its own sign-in, models, tools, approvals and history; PiUI never adds its own agent loop or provider client and never reads or stores credentials.
- **Claude Code on your subscription only.** PiUI starts your installed `claude`, removes API-key and cloud-provider variables, refuses any sign-in that is not your Claude subscription, keeps fast mode off and stops a session that reports paid extra usage.
- **Pipelines.** A visual editor for multi-agent systems: agent, router, model-call and script steps; result, route, message, observation and delegation connections; templates, run inputs, review-loop limits, checks and a read-only assistant that proposes changes. See [portable system files](docs/SYSTEM_FILES.md).
- **Runs.** A run canvas with the state of every step, live activity, each step's result, conversation, inputs, attempts and token usage, and operator actions: approve, reject, run again from a step, cancel, retry.
- **Automations.** One-time, interval and day-of-week schedules that start a saved pipeline while PiUI is open. Each schedule is turned on separately. See [scheduled runs](docs/SCHEDULED_RUNS.md).
- **Local-first.** No account, cloud backend or telemetry. Harnesses talk to their own providers. Project trust lets agents work on a folder within each chat's permissions and is never presented as a sandbox. Start with `--safe-mode` to open PiUI without running extensions or agents.

## Supported harnesses

| Harness | Tested versions | Notes |
| --- | --- | --- |
| Codex (app-server) | 0.147.x – 0.157.x | Newer versions are reported as unverified and do not start. MCP form requests appear as approval cards. |
| Claude Code | 2.1 or a later 2.x release | Claude subscription login only: run `claude` in a terminal and use `/login`. |
| Pi | the installed `pi` CLI | Pi JSONL stays the source of truth for Pi history. |
| Hermes | 0.21.0 | Through its ACP interface. |
| Prime Agent | 0.9.2, 0.9.3 | |

Settings → Harnesses shows what PiUI found on this computer, the versions and what still needs setup.

## Install

### Windows 10/11 (recommended)

1. Install at least one harness and sign in with its own tool.
2. Open the [PiUI releases](https://github.com/CrazyAngelm/PiUI/releases) and choose **v0.2.0**.
3. Download `PiUI_0.2.0_x64-setup.exe` and `SHA256SUMS.txt`.
4. Verify the checksum, run the installer (per-user, no administrator rights) and open **PiUI** from the Start menu.

```powershell
Get-FileHash .\PiUI_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

The hash printed by `Get-FileHash` must match the installer's line in `SHA256SUMS.txt`. If the release notes say the build is not code-signed, Windows may warn about an unknown publisher; verify the checksum first, or [build from source](#build-from-source). The portable `PiUI_0.2.0_windows_x86_64.exe` runs without installing.

### Linux (x64)

Download `PiUI_0.2.0_amd64.deb` (install with `sudo apt install ./PiUI_0.2.0_amd64.deb`) or `PiUI_0.2.0_amd64.AppImage` (make it executable and run it), and check it with `sha256sum --check --ignore-missing SHA256SUMS.txt`. The packages need WebKitGTK 4.1 (Ubuntu 22.04 or newer). Native agent lifecycle containment is not yet verified on Linux, so harnesses show as not verified there.

### macOS (experimental)

When a release lists `PiUI_0.2.0_universal.dmg`, it runs on Apple Silicon and Intel Macs. It is ad-hoc signed and not notarized: open it with right-click → **Open** the first time.

### Updating

When a release publishes an update feed, Settings → About offers **Check for updates**, the release notes and **Download and restart**. PiUI asks before installing, verifies the download against the signing key built into your version, stops running chats and pipeline steps as it does when you quit, installs the update and starts again. **Check for updates automatically** is off until you turn it on. Otherwise download a newer release and install it over this one. Chats, pipelines and settings stay in place either way; harness histories stay with their harnesses.

## First run

1. Start PiUI and choose **New chat**. Pick a harness, a model and a reasoning level, then send a message.
2. To work on files, choose **Add project…** and review the trust prompt for that folder.
3. Open **Pipelines** to start from a template, **Runs** to follow a pipeline and **Automations** to schedule one.

Do not write to the same session from PiUI and the harness's own CLI at the same time.

## Current limitations

- Windows builds are unsigned until a code-signing certificate is configured for releases, and a build updates itself only when it was released with the update key ([Releasing PiUI](docs/RELEASING.md)).
- Linux and macOS: native agent lifecycle containment is not yet verified and the Linux WebKit end-to-end harness is not implemented; macOS builds are not notarized.
- Automations run only while PiUI is open.
- A Codex model-call step keeps Codex's own tools inside a read-only sandbox; Pi and Claude Code run model calls without tools. Codex MCP tool approvals apply to one call, and URL-mode MCP requests are declined.
- Script steps run your code on this computer with your permissions; they are not sandboxed.
- The previous interface stays reachable from Settings → About for this release and is removed in the next one.
- Concurrent writes to one session from PiUI and a harness CLI are unsupported.
- Project-local extension JavaScript stays disabled until its trust and isolation design is complete.

See [Foundation status](docs/13_FOUNDATION_STATUS.md), [open risks](docs/12_OPEN_RISKS.md), the [multi-harness implementation status](docs/MULTI_HARNESS_IMPLEMENTATION.md) and the [release checklist](CHECKLIST_RELEASE.md) for the exact status, and the [changelog](CHANGELOG.md) for what changed.

## Build from source

### Prerequisites

- Git
- Node.js 22+
- pnpm 10.23+
- Rust 1.94.1 with `rustfmt` and `clippy`
- the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)
- at least one supported harness for live chats

### Development build

```bash
git clone https://github.com/CrazyAngelm/PiUI.git
cd PiUI
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm --filter @piui/desktop dev` serves the interface in a browser against the in-memory UI Lab host, which never runs an agent; see [apps/desktop/README.md](apps/desktop/README.md) for its scenarios.

### Release build

```bash
pnpm install --frozen-lockfile
pnpm repo:check
pnpm release:windows   # NSIS installer + portable executable in artifacts/
pnpm release:linux     # .deb + AppImage
pnpm release:macos     # universal .app + .dmg (experimental)
```

Without signing variables these are unsigned builds that never check for updates. [Releasing PiUI](docs/RELEASING.md) explains code signing, signed updates, tagging and verification.

## Quality checks

```bash
pnpm repo:check
python tools/validate_spec.py
pnpm check
pnpm test
pnpm contract:test
pnpm build
pnpm test:smoke
pnpm test:e2e
pnpm perf:smoke
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`pnpm repo:check` also fails when the declared PiUI versions disagree. `pnpm test:smoke` is the static source check. `pnpm test:e2e` dispatches to the real Windows Tauri/WebView2 harness, which passes through a feature-gated debug-only loopback driver and outside-Job fixture cleanup. Linux still fails explicitly because its WebKit harness is not implemented yet.

## Repository layout

```text
apps/desktop/               Tauri 2 host and Svelte 5 interface
crates/piui-contracts/      Safe host/UI DTOs and fixtures
crates/piui-index/          Rebuildable SQLite index and LF-only session scanner
crates/piui-runtime/        Native harness bridges, lifecycle and stream projection
crates/piui-orchestration/  Harness-neutral pipeline policy and run coordination
crates/piui-platform/       Native identity and process-containment primitives
crates/piui-extensions/     Extension manifest validation
contracts/                  Versioned TypeScript contracts
docs/                       Product, architecture, security and release documentation
scripts/                    Repository checks and release tooling
spikes/                     Isolated evidence and experiments, not runtime dependencies
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
- [Releasing PiUI](docs/RELEASING.md)
- [Changelog](CHANGELOG.md)

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before opening a pull request. Changes to IPC contracts require a version bump, compatibility coverage, and an update under `contracts/`.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). Never publish credentials, prompts, session files, or local filesystem paths in an issue.

## License

PiUI is licensed under the [MIT License](LICENSE). Third-party dependencies and referenced external materials remain subject to their own licenses and terms.
