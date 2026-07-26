# PiUI sources and research basis

**Verification date:** July 23, 2026.
**Observed Pi version:** `v0.81.1`; links to `latest` were checked on the same day.

This list records the external materials on which the specification’s factual claims and architectural constraints are based. Sources do not become PiUI runtime dependencies. Before implementation begins, the team must recheck Pi documentation if the installed version differs from the version verified during research.

## Pi: product, integration, and security

- [Pi — home page](https://pi.dev/) — the philosophy of a minimal agent harness, embedding methods, and the general extensibility model.
- [Pi quickstart](https://pi.dev/docs/latest/quickstart) — installation, authentication, file references, and CLI session selection.
- [Pi extensions](https://pi.dev/docs/latest/extensions) — tools, commands, events, `ctx.ui`, custom renderers, and extension lifecycle.
- [Pi RPC mode](https://pi.dev/docs/latest/rpc) — JSONL protocol, commands, events, prompt/steer/follow-up, images, and Extension UI Protocol.
- [Pi session format](https://pi.dev/docs/latest/session-format) — JSONL session tree, entries, and history recovery rules.
- [Pi packages](https://pi.dev/docs/latest/packages) — packaging and distribution of extensions, prompts, and themes.
- [Pi security](https://pi.dev/docs/latest/security) — project trust and the absence of a built-in full sandbox for tools.
- [Pi SDK](https://pi.dev/docs/latest/sdk) — programmatic creation of an agent session, `SessionManager`, and methods unavailable or incomplete in RPC.
- [Pi providers](https://pi.dev/docs/latest/providers) — models, credentials, and interactive authorization flows.
- [Official Pi repository](https://github.com/earendil-works/pi) — source code, versions, issues, standalone Bun binaries/build path, and the point for verifying the actual API before integration.

## Desktop stack

- [Tauri 2](https://v2.tauri.app/) — cross-platform desktop shell on the system WebView.
- [Tauri sidecars](https://v2.tauri.app/develop/sidecar/) — packaging and management of external executables.
- [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/) — platform WebView engines and test-matrix requirements.
- [Tauri security](https://v2.tauri.app/security/) — IPC, capabilities, trust boundaries, and frontend access minimization.
- [Svelte overview](https://svelte.dev/docs/svelte/overview) — compiled UI model.
- [Svelte lifecycle](https://svelte.dev/docs/svelte/lifecycle-hooks) — Svelte 5 render effects and lifecycle semantics.
- [Bits UI](https://www.bits-ui.com/) — headless accessibility primitives for focused use without a full UI kit.

## Product and UX references

- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/) — organizing threads by project and shared history/config with the CLI.
- [Official Hermes Desktop guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/desktop.md) — chat-first desktop UX, sessions, model controls, and shared data with the CLI.
- [OpenCovibe](https://github.com/AnyiWang/OpenCovibe) — a Tauri/Svelte desktop coding UI example and process/session patterns; suitable only for focused audit.
- [Community Hermes Desktop](https://github.com/fathah/hermes-desktop) — a broad Electron client; used as a negative/feature-scope reference, not as a foundation.
- [Alma](https://alma.now/) — desktop AI orchestration as a visual reference; not an architectural foundation for PiUI.

## Source-use rule

1. Official Pi documentation and source code take precedence over examples from third-party clients.
2. Any undocumented behavior is confirmed by a spike test on the minimum and target Pi versions.
3. Copying third-party code is permitted only after verifying its license, provenance, and necessity; the decision is recorded in a separate ADR.
4. Links to “latest” do not pin an API forever. Supported Pi versions and derived capabilities are recorded in every PiUI release.
