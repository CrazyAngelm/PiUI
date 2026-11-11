# AGENTS.md — mandatory PiUI / Nano Desktop development rules

## User-authored system files

- `contracts/system-file-v5.schema.json` is the current portable graph contract;
  keep v1-v4 import compatibility. Keep
  UI import/export and `pnpm system:check` on the same parser; adapter-specific
  static checks belong to `src/harness-adapters/validation.ts`.
- Import is a new draft, not authorization to run, overwrite saved definitions,
  evaluate code, load includes or mutate native/global configuration. Failed
  validation preserves the current graph. Save remains an atomic host action.
- A breaking file-format change needs its own version and migration/round-trip
  tests. Do not change native session formats or IPC versions merely to rename
  an exchange document field. Never silently drop unsupported fields.
- Maintain `skills/piui-systems/` and examples when changing the exchange format
  or adapter capabilities. Skills must distinguish verified configuration from
  available native models/tools and must not advertise unsupported isolation.

This file is intended for coding agents and engineers working on the PiUI repository (the product is named Nano Desktop since 0.3.0; internal names keep the `piui` prefix, ADR-046). The requirements below take precedence over the local convenience of any particular task.

## Goal

Build a fast, extensible desktop workbench for native agent harnesses (Codex,
Claude Code, Pi, Hermes, Prime Agent and ACP agents) with Codex-quality chat UX
and an n8n-like editor for multi-agent pipelines (ADR-026). Do not create another
agent harness: harnesses own inference, tools, credentials and history.

Current plan and decisions: `docs/PLAN_2026-09-26_RU.md`; progress log:
`docs/REWORK_PROGRESS.md`.

## Rework rules (2026-09-26)

- Claude Code runs only on the user's Claude subscription (ADR-029): spawn the
  user's installed `claude` executable, scrub API-key/cloud-provider env vars,
  never pass `--bare`, refuse non-subscription auth, never touch credentials.
- New UI code: Svelte 5 runes, tokens in `styles/tokens.css`, primitives in
  `src/lib/ui`, Lucide icons, Svelte Flow for graphs (ADR-027). The shell is
  `src/app/shell`; the classic views (`?view=legacy`, `?view=classic`) were
  removed after parity (docs/CLASSIC_PARITY.md).
- Every screen must work in the browser UI Lab (`pnpm --filter @piui/desktop dev`)
  through `host-api/transport.ts`; never import Tauri APIs outside the transport.
- Svelte 5.38 native TS stripping keeps optional parameters (`fn(a?: T)`) in
  component scripts, which breaks the build: write `a: T | undefined = undefined`.
- Plugins (ADR-032) run outside the WebView with explicit trust; this replaces
  the older ban on runtime-loaded harness code, not the isolation rules below.

## Non-negotiable rules

- Do not implement an agent loop, provider clients, compaction, tools, or session branching inside PiUI when Pi already provides them.
- Send every active-session command through the typed runtime adapter. Do not write to session JSONL directly.
- Treat Pi JSONL as the source of truth. The PiUI database is only cache/index/UI metadata and must be fully rebuildable.
- Do not read or modify `auth.json` in the frontend. Do not emit keys, OAuth tokens, the full environment, or prompt content in ordinary logs.
- Do not give the WebView general shell/filesystem access. The frontend invokes only allowlisted Tauri commands with validated arguments.
- Do not load project-local PiUI JavaScript before an explicit trust decision.
- Evaluate every new core feature against this principle first: “could this be an extension contribution?” If so, keep it out of core.
- Every custom renderer must have a generic fallback. The session must remain readable when its extension is disabled.
- Do not use Electron. Do not add SSR, a cloud backend, telemetry, or an account system without a separate ADR.
- Do not introduce a second chat format.
- Do not block first paint on network checks, model-catalog checks, or package updates.

## Architectural layers

1. `ui` — Svelte components and local presentation state.
2. `host-api` — generated TypeScript bindings to Rust commands/events.
3. `application` — use cases: projects, sessions, attachments, extensions.
4. `runtime` — Pi process supervisor and RPC adapter.
5. `index` — read-only session scanner and rebuildable SQLite index.
6. `platform` — process groups, filesystem watch, trash, notifications, updates.

The UI does not access the `runtime`, `index`, or OS layers directly.

## Coding conventions

- UI changes follow [shared interface rules](docs/UI_STYLE.md) across all screens.

- Rust: stable toolchain, edition 2024, `cargo fmt`, `clippy -D warnings`, errors through typed enums; `unwrap()` is prohibited outside tests and provable startup invariants.
- TypeScript: `strict: true`, no `any` in public contracts; discriminated unions for events; exhaustive `switch` with `never`.
- Svelte: local state in the component, cross-screen state in small domain stores; do not create a global store “for the whole application”.
- CSS: design tokens through custom properties, component-scoped CSS; no utility-class DSL in core UI.
- IPC: schema-first. Changing an event/command contract requires a version bump, compatibility test, and an update to `contracts/`.
- Logs: structured fields; no messages such as `console.log(object)` for RPC payloads in production.

## Definition of Done for every task

- A happy path and at least one failure path are implemented.
- Unit tests are added; a user flow has an integration/E2E test.
- No regression in safe mode or the generic fallback.
- Keyboard-only operation and screen-reader labels are verified for each new interactive element.
- The impact on startup/RSS/rendering is measured if a hot path is affected.
- The specification or ADR is updated if behavior changes.
- No platform-specific assumption is made on Windows or Linux without a separate branch and test.

## Prohibited shortcuts

- Parse stdout with a normal general-purpose line reader that splits on Unicode line separators. Pi RPC requires LF-only framing.
- Kill only the parent PID while leaving child tool processes.
- Run a real Prime Agent probe or test without an explicit non-default `--daemon-socket`; isolated session directories alone do not isolate the supervisor.
- Hide project trust behind a generic “Continue” button.
- Automatically copy external files into a project without a user-visible decision.
- Render raw HTML from Markdown, tool output, or an extension payload.
- Load an extension bundle into the main DOM with full permissions by default.
- Treat `ctx.hasUI === true` as evidence of full TUI support in RPC.
- Rename or move session files for UI sorting.

## Priorities when requirements conflict

1. Preservation of user files and sessions.
2. An explicit trust model and no false promise of a sandbox.
3. Compatibility with the Pi CLI.
4. Correctness of the runtime protocol.
5. UI responsiveness.
6. Extensibility.
7. Visual polish.

## Quality commands the repository must provide

```bash
pnpm check          # TypeScript/Svelte formatting, lint, typecheck
pnpm test           # unit tests
pnpm test:e2e       # Playwright against packaged/dev Tauri harness
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm contract:test  # schema fixtures and backward compatibility
pnpm perf:smoke     # startup, idle RSS, long-session scroll, stream batching
```

## Build and release storage hygiene (mandatory)

- `target/` is reproducible build output, not a release archive. A release task
  is not complete while superseded `target/debug` or `target/release` trees are
  retained merely for convenience.
- Before cleanup, prove that no PiUI, Cargo, or Rust compiler process is using
  the repository target directory. Verify that the installed executable and
  every release file that must survive (installer, portable executable,
  checksums, and required evidence) already exist outside `target/` under the
  fixed repository `artifacts/` or `evidence/` directories.
- After successful packaging, installation, hash comparison, and launch/health
  verification, delete obsolete build trees. Remove the whole repository
  `target/` when no build output is still required; otherwise remove only the
  exact superseded `target/debug` or `target/release` tree after preserving the
  current verified deliverables.
- Apply this post-verification rule to isolated spike `src-tauri/target` trees
  and task-created temporary build/package staging too. Preserve each sole
  deliverable, report, checksum, or rollback copy in a stable location outside
  the generated tree before cleaning it.
- Cleanup commands must resolve and verify the exact repository root and target
  path before recursive deletion. Never accept an arbitrary cleanup path, never
  follow a reparse point, and never delete the installed application, source,
  user data, native histories, `artifacts/`, or `evidence/` as build cleanup.
- Report measured free space before and after cleanup. If verification fails or
  an output is still the only rollback/evidence copy, retain that exact output
  and report the blocker instead of claiming the release or cleanup complete.

## Before implementation begins

The first task is to complete the spikes in `docs/12_OPEN_RISKS.md`. Do not build UI on assumptions about RPC-process termination, initial session creation, OAuth, or tree navigation.

## Multi-harness systems (mandatory)

PiUI is a desktop shell and a durable coordinator, not a model/tool loop. Native
harnesses own inference, credentials, compaction, tools, approvals and history.
Pi JSONL is authoritative for Pi; Prime and Codex retain their own native history
formats. Never translate one harness history into another chat format.

- A graph is harness-neutral: profiles select adapters; result, message,
  observation and delegation edges carry distinct meanings and permissions.
  Result dependencies must pass through verified native history references and
  the existing dependency-context resolver, including Codex -> Prime and back.
- Adapter-owned configuration lives in `src/harness-adapters/` (presentation),
  `src-tauri/src/harness_configuration.rs` (host enforcement), and
  `crates/piui-runtime/bridge/` (native transport). Keep harness branches out of
  graph scheduling. A manifest is presentation metadata, not proof of security.
- Adding a harness requires its typed identity/contract version, configuration
  manifest, native bridge, discovery/version verification, process containment,
  lifecycle/history binding, approval and cancellation mapping, generic event
  fallback, and adapter tests. Arbitrary runtime-loaded JS is not a plugin API.
- Unsupported required settings fail before native execution. Do not silently
  ignore requested tools, skills, MCP, reasoning, speed or permission settings.
  Use native model catalogs for actual reasoning availability; example values
  in a configuration manifest are not guarantees for every model.
- Resource settings are per-session overrides. Never modify the user's global
  auth/config, another agent's settings, or a shared Prime daemon to implement
  them. A disabled skill is not a filesystem access restriction.
- Coordinator child admission must prove same-or-less file, tool, resource and
  further-delegation authority. Check every generation from the frozen run
  snapshot, including an allowed profile. Native defaults across different
  harnesses are incomparable; reject such delegation rather than guessing.
  This comparison does not assert OS isolation where an adapter has none.
- Save a graph's profiles, team, pipeline and launch reference atomically with
  revision checks. Failed saves preserve all prior definitions. Run retries
  retain their request identity until their outcome is known.
- English is the default UI language. Visible interface strings belong to the
  locale catalog; support Russian without translating user prompts or history.
- Validate changes through the native WebView and adapter tests, including a
  cross-harness result edge, denied escalation, unsupported capability, reload,
  safe mode and keyboard operation. Report synthetic and real-provider evidence
  separately. Never claim hundreds of paid model turns from a transport probe.

## Nano account and Nano harness (mandatory)

Design and behaviour: `docs/NANO_DESKTOP.md`; server contract:
`docs/NANO_DESKTOP_API.md`; decisions ADR-046 to ADR-049; contracts
`contracts/nano-account-v1.ts` and `contracts/nano-server-v1.ts`.

- A signed-out application and any application in safe mode make **no** Nano
  network call (no discovery, refresh, relay, dictation or cloud window). Sign-in
  is optional; every harness, Fusion, pipeline and plugin feature that works
  without an account must keep working without one. Local sign-out works in safe
  mode without a network call.
- Nano credentials live **only in the Rust host**: refresh token in the OS
  credential store (memory-only if the store fails, never a file), access token
  in memory. Tokens, authorization codes, PKCE verifiers, relay keys and cloud
  launch codes never reach the WebView, an IPC payload or event, a bridge
  frame, a process environment, a log, a test snapshot, the Lab or an exported
  system file. The one exception is the per-session relay key, on exactly this
  path: host -> the environment of that session's own Nano bridge process
  (`PIUI_NANO_RELAY_KEY`, which the bridge reads once and deletes) -> the Pi
  child environment (`NANO_RELAY_KEY`). It is never in the `initialize` frame
  or any other bridge frame. Token types redact `Debug`. Never add a Tauri
  plugin that can return a secret to JavaScript, and never open a URL the
  WebView supplied: links are enums resolved in the host.
- The relay is the only new listener: `127.0.0.1:<ephemeral>`, per-session
  256-bit key compared in constant time before the body is parsed, `Host`
  check, refusal of any `Origin` or `Sec-Fetch-Site`, fixed path allowlist, an
  upstream URL built only from the pinned base, entitled modes only, concurrency
  and size caps, unbuffered streaming, no prompt building, no agent loop, no
  bodies or headers in logs. Every relay session and request is bound to the
  account generation it started under: sign-out, expiry, device revocation or
  a new sign-in refuses it before forwarding and before a retry and cuts its
  upload, upstream request and stream. It dies with its session.
- Nano lane (`harness: "nano"`): unmodified upstream Pi (>= 1.4.0) through
  `crates/piui-runtime/bridge/pi.mjs`, Pi JSONL history, no second chat format.
  Required flags: `--mode rpc --no-approve --offline`, plus `--provider nano
  --model <mode>` when a model is given (a reopened session without one keeps
  its recorded model, which must be a `nano` model); the bridge process and the
  child environment are **cleared** to an OS allowlist (the child adds
  `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`,
  `PI_TELEMETRY=0` and `NANO_RELAY_KEY`). The agent directory is host-owned and private: never read or
  write the user's `~/.pi`, `auth.json` or global Pi configuration. Permission
  modes are `native` (approval guard), `read-only` and `full-access`;
  `workspace-write`, thinking levels, speed tiers, per-agent tools, skills, MCP,
  native subagents, the board tool, the coordinator role and a Fusion lead are
  refused before launch. Fusion allows Nano only as the sidekick. Never describe
  the Nano agent as sandboxed.
- Nano models are the server's modes (`auto`, `free`, `fast`, `smart`) from the
  account's entitlements; never name, promise or hard-code a provider model, and
  never treat a mode as available unless entitlements say so. Money is not
  shown; credits are whole numbers.
- Frozen identifiers (ADR-046): the product name is visible text only. Keep the
  bundle id `dev.piui.desktop`, `piui-foundation.sqlite`, `piui-system` /
  `*.piui.json`, `piui-plugin.json`, `piui.manifest.json`, `engines.piui`, the
  `piui-plugin` scheme, `piui://` events (including `piui://nano-account-v1`),
  `--piui-*` tokens, `PIUI_*` variables, `.piui/`, `piui-workspace`, bridge
  `clientInfo`, crate and npm names and `piui.*` storage keys. A change needs
  its own ADR and a tested, non-destructive copy.
- `PIUI_NANO_ISSUER` (a development issuer such as `http://127.0.0.1:8787`) is
  honoured **only** in debug builds and builds with the `e2e-webview-automation`
  feature, and plain `http` only for a loopback issuer. Release builds always
  use `https://nanoagents.ru` and never read the variable. Use
  `tools/nano-dev-server/` for development and E2E; its evidence is synthetic
  and is reported separately from real-provider evidence.
- The cloud window (`nano-cloud`) has no IPC: no capability may list it and the
  command guard stays an allowlist (main window, app origin). Its navigation is
  limited to Nano origins; other links open in the system browser.
- Dictation audio is held in memory only and goes through the host; the WebView
  never makes a Nano request, so the CSP stays unchanged.
