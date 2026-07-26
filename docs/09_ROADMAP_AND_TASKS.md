# 09. Порядок реализации и инженерные задачи

## 1. Правило исполнения

Реализация идёт через вертикальные проверяемые slices. Нельзя сначала построить весь красивый frontend, а затем «подключить Pi». Самый ранний рабочий slice должен открыть реальную session, отправить prompt, отобразить streaming и пережить crash процесса.

Первый обязательный gate — spikes из Phase 0. Их результаты могут уточнить transport, но не отменяют инвариант: Pi остаётся владельцем agent/session semantics.

## 2. Рабочие потоки

- **W0 Contracts:** schemas, DTO, fixtures, compatibility.
- **W1 Runtime:** Rust supervisor, RPC codec, Pi adapter, process tree.
- **W2 Data:** project registry, scanner, SQLite index, attachments.
- **W3 UI:** shell, sidebar, timeline, composer, settings, accessibility.
- **W4 Extensions:** discovery, standard RPC UI, declarative SDK, sandbox.
- **W5 Platform/Release:** packaging, updater, diagnostics, perf/security matrices.

После Phase 0 потоки могут идти параллельно через зафиксированные contracts. Изменение contract требует синхронного обновления W0 и dependent fixtures.

## 3. Phase 0 — обязательные технические spikes

Каждый spike заканчивается маленьким executable harness, captured fixtures и decision note. Скриншот/устное описание не считаются результатом.

### SPIKE-01 — Открытие существующей session без ghost file

**Вопрос:** как корректно запустить RPC и открыть конкретную Pi session, не создавая лишнюю пустую сессию?

**Действия:**

- проверить supported CLI startup arguments и `switch_session`;
- записать список файлов до/после каждого варианта;
- протестировать path с пробелами/Unicode;
- проверить новую и существующую session;
- зафиксировать startup events/state.

**Pass:** deterministic procedure с stable session identity и без ghost file.

**Fail/решение:** спроектировать минимальный Pi bridge/upstream request; не обходить прямой записью JSONL.

### SPIKE-02 — Graceful shutdown и process tree

**Вопрос:** как RPC process завершает текущую session и descendants?

- EOF stdin;
- signal/terminate;
- documented shutdown command, если есть;
- running/idle states;
- Unix process group и Windows Job Object;
- child tool process fixture.

**Output:** state diagram, timeout values, platform implementation test.

### SPIKE-03 — Tree navigation

**Вопрос:** можно ли перейти на произвольный existing tree node официальным RPC/SDK способом?

**Output:** supported command/capability или bridge API proposal. До ответа UI tree read-only.

### SPIKE-04 — Provider auth

**Вопрос:** можно ли реализовать login/status/logout без полноценного terminal emulator?

- OAuth/provider interactive flows;
- API key flow;
- model refresh после auth;
- secret visibility/logging.

**Output:** выбранный MVP flow и список upstream gaps.

### SPIKE-05 — Extension UI Protocol parity

Создать Pi extension fixture, вызывающий все documented `ctx.ui` operations. Зафиксировать RPC events, cancellation и unsupported APIs.

**Output:** golden event corpus + mapping table + timeout/cancel behavior.

### SPIKE-06 — Concurrent access

Открыть одну session в CLI и PiUI harness одновременно, выполнить appends/turns и изучить locking/state behavior.

**Output:** conflict detector criteria и safe UX. Нельзя предполагать multi-writer safety.

### SPIKE-07 — Managed Pi packaging

Упаковать Pi runtime как Tauri sidecar/app-managed artifact на Windows/Linux test builds. Сначала проверить готовые official standalone Pi release artifacts; затем, только при необходимости, воспроизводимую сборку Bun executable из versioned upstream release source:

- asset inventory, target triples и bundled runtime assets;
- upstream `SHA256SUMS`/provenance verification;
- executable naming/architecture;
- launch permissions, quarantine и antivirus behavior;
- версия/capability probe;
- подписанный PiUI runtime manifest;
- update/rollback layout;
- package size и cold-start/RSS overhead;
- одинаковое чтение `~/.pi/agent` config/packages/sessions в managed и system modes.

**Output:** packaging ADR amendment, reproducible acquisition/build script, SBOM/provenance record и test artifacts.

### SPIKE-08 — WebView baseline

Минимальный Tauri+Svelte shell на reference machines:

- cold/warm startup;
- idle RSS/CPU;
- 10k virtualized blocks;
- iframe/worker isolation capability;
- platform rendering differences.

**Pass:** реалистичный путь к hard budgets. Иначе пересмотреть UI stack до product implementation.

### SPIKE-09 — Session scanner compatibility

Прогнать реальный corpus Pi sessions:

- format versions;
- partial lines;
- branches/custom entries/compaction/images;
- external appends;
- file roots/config resolution.

**Output:** parser fixtures и unsupported state behavior.

### SPIKE-10 — Pi version/capability probe

Определить надёжный способ узнать executable version и доступные RPC commands, включая unknown/new fields.

**Output:** initial `RuntimeCapabilities` contract.

## 4. Gate G0 — разрешение на продуктовую разработку

G0 проходит, если:

- SPIKE-01/02 имеют безопасный путь;
- RPC codec/fixtures подтверждены;
- auth имеет честный MVP fallback;
- scanner не требует записи session files;
- Tauri baseline не нарушает hard memory/startup budgets без перспективы;
- bridge gaps формально описаны и ограничены.

При провале транспорт может перейти на in-process Pi SDK adapter, но только после нового ADR с анализом isolation, extension loading и packaging. Frontend contracts сохраняются.

## 5. Phase 1 — каркас и contracts

### FOUNDATION-01 — Monorepo

Создать workspace layout из `03_ARCHITECTURE.md`, pinned toolchains, formatting/lint/typecheck/test commands.

**Acceptance:** clean clone выполняет все empty quality commands на Windows/Linux CI.

### CONTRACT-01 — Runtime protocol v1

Реализовать schema/source types для commands/events/errors/capabilities.

**Acceptance:** Rust↔TS compatibility tests и generated API docs.

### CONTRACT-02 — Fake Pi runtime

Scriptable binary с scenarios: stream, tool, UI request, malformed, hang, crash.

**Acceptance:** deterministic integration tests without network.

### RUNTIME-01 — LF JSONL codec

Chunk parser, max frame, correlation, unknown event.

**Acceptance:** unit/fuzz corpus, no panic/OOM.

### RUNTIME-02 — Supervisor skeleton

Spawn/ready/stop/crash state machine, stderr ring buffer, process group abstraction.

### UI-01 — Core shell

Window, design tokens, sidebar/main layout, error boundary, safe-mode boot state.

### UI-02 — Host API client

Generated typed bindings, reconnect/snapshot/revision handling.

### QUALITY-01 — Test/fixture harness

Vitest, Rust integration, Playwright/Tauri harness, performance result format.

## 6. Phase 2 — read-only projects и history

### PROJECT-01 — Registry

Add/remove/locate/reorder projects, canonical path handling, missing state.

### TRUST-01 — Restricted/trust flow

Trust record, literal warning, no runtime/project code before trust.

### DATA-01 — Session root resolution

Runtime/config probe, roots watcher setup, diagnostics.

### DATA-02 — Incremental scanner

Header/entries parser, partial tail, revisions, watcher coalescing.

### DATA-03 — SQLite projection

Migrations, projects, sessions index, rebuild command.

### UI-03 — Project/session sidebar

Loading/empty/missing/parse-state, recent sorting, new chat disabled in restricted mode.

### UI-04 — Read-only timeline

Normalized blocks, Markdown sanitizer, tool/custom generic cards, images, pagination.

### UI-05 — Timeline virtualization

10k-block fixture, scroll anchor, lazy code highlighting.

### SEARCH-01 — Session search

Name/preview search; FTS body can be deferred to public 1.0.

**Gate G1:** пользователь добавляет папку, видит существующие Pi sessions и безопасно читает их без запуска Pi.

## 7. Phase 3 — live Pi chat MVP

### RUNTIME-03 — Real Pi adapter

Managed/system/custom profiles, capability probe, open existing/new session.

### RUNTIME-04 — Command mapping

Prompt/steer/follow-up/abort/state/models/thinking/queue commands.

### RUNTIME-05 — Live normalization

Pi events → `SessionDelta`, revision/snapshot/idempotence.

### UI-06 — Composer

Draft, Send/Steer/Queue next/Stop, shortcuts, pending/error states.

### UI-07 — Streaming timeline

Batch 16–33 ms, interrupted blocks, autoscroll policy, screen-reader throttling.

### UI-08 — Model/thinking controls

Dynamic model list, recent models, capability-based thinking picker.

### DATA-04 — Draft persistence

Debounced drafts, rekey new session, optional disable.

### RECOVERY-01 — Runtime crash/reopen

Read-only recovery, no prompt repeat, force-stop escalation.

### SESSION-01 — New/open/rename

Only official Pi operations; pending confirmation; no fake session IDs.

### SESSION-02 — Tree/fork/clone

Enable only supported operations; read-only branch panel fallback.

### SESSION-03 — Export/trash

Pi export where supported, system trash, active-runtime close.

**Gate G2 (internal alpha):** реальная CLI session round-trip, streaming, stop/steer/follow-up, model switch, crash recovery, no JSONL writes.

## 8. Phase 4 — attachments и standard extensions

### ATTACH-01 — Images

Paste/drop/picker, MIME/size validation, preview, RPC encoding, model support error.

### ATTACH-02 — Project path references

Structured relative refs, composer chips, stable prompt convention.

### ATTACH-03 — External files

Reference original vs managed copy, hash/provenance/quota/cleanup.

### EXT-01 — Package discovery

Global/project package locations, manifest discovery as data, conflicts, trust.

### EXT-02 — Standard RPC UI dialogs

Select/confirm/input/editor/cancel/timeout/modal queue.

### EXT-03 — Standard status/widgets/title/editor effects

Native core surfaces and generic fallback.

### UI-09 — Commands palette/slash autocomplete

Core + `get_commands`, collision rules, keyboard navigation.

### SETTINGS-01 — Settings shell

General/runtime/models-auth/extensions/appearance/keybindings/security/advanced.

### AUTH-01 — Approved MVP auth flow

Результат SPIKE-04, secret-safe diagnostics.

**Gate G3 (feature-complete MVP):** images/files, standard extension UX, settings/auth path, trust and recovery complete.

## 9. Phase 5 — declarative PiUI SDK

### SDK-01 — Manifest schema/parser

JSON Schema v1, path/engine validation, invalid/incompatible backend-only fallback.

### SDK-02 — Context expression engine

No eval, namespace/limits, tests.

### SDK-03 — UiNode schema/renderer

All v1 nodes, size/depth limits, sanitization, accessibility.

### SDK-04 — Commands/actions/status

Command broker, composer/status/context contributions, ordering/collisions.

### SDK-05 — Settings contribution

Schema controls, namespaced storage, secret references.

### SDK-06 — Tool/custom renderers

Matcher/priority/raw fallback/independent disable.

### SDK-07 — Sidebar/right-panel/preview/theme

Semantic slots, lifecycle, contrast validation.

### SDK-08 — Worker host

Isolated module worker, handler registry, permissions, timeout/crash loop.

### SDK-09 — Extension author tooling

Validate/dev/pack/inspect permissions, example packages, docs.

### SDK-10 — Compatibility suite

Previous fixtures, optional unknown contribution, API deprecation checks.

**Gate G4:** backend-only and dual Pi/PiUI package demonstrably work; declarative v1 frozen for public beta.

## 10. Phase 6 — rich views и trusted shell

### SANDBOX-01 — View broker

Opaque channel, handshake, request/response/subscriptions, lifecycle.

### SANDBOX-02 — CSP/origin/navigation policy

No direct Tauri, blocked links/download/popups, resource scheme.

### SANDBOX-03 — Permission broker

Once/project/global scopes, origin/resource checks, revoke/update invalidation.

### SANDBOX-04 — Network proxy

HTTPS origins, redirect/private-network policy, limits.

### SANDBOX-05 — Crash/rate/memory containment

Timeout, dispose/suspend, crash fallback and diagnostics.

### SHELL-01 — Trusted shell surface

Global-only activation, same broker, full application model, no raw host.

### SHELL-02 — Immutable recovery layer

Native safe-mode/startup modifier/menu, core fallback and crash-loop detection.

### SHELL-03 — Reference alternate shell

Минимальный example, доказывающий полный layout replacement и recovery.

**Gate G5:** security tests подтверждают isolation; shell не может отключить recovery.

## 11. Phase 7 — public 1.0 hardening

### PERF-01 — Instrumentation and baseline

Startup/RSS/CPU/stream/scroll/index harness, fixed physical machine reports.

### PERF-02 — Optimization pass

Bundle audit, virtualization, memory leak cleanup, scanner throttling.

### A11Y-01 — Core accessibility audit

Keyboard, screen readers, zoom, contrast, reduced motion.

### SECURITY-01 — Threat-model verification

Fuzz corpus, capabilities audit, hostile content, grants, paths.

### SECURITY-02 — External review

Extension broker, updater, process/path boundary.

### RELEASE-01 — Windows packaging/signing/update

Installer, WebView2 policy, Job Object, upgrade/rollback.

### RELEASE-02 — Linux packaging/signing/update

Chosen formats, WebKitGTK matrix, Wayland/X11, process/trash/watch.

### RELEASE-03 — macOS candidate

Build/sign/notarize/test; release only if matrix green.

### RELEASE-04 — Managed Pi matrix

Pinned runtime artifact, hash, compatibility, rollback.

### DOCS-01 — User docs

Trust, runtime choice, projects/sessions, attachments, extensions, diagnostics.

### DOCS-02 — Developer SDK docs

Manifest, host API, examples, compatibility/versioning.

### QA-01 — Full release matrix

All gates from `08_TESTING_AND_PERFORMANCE.md`.

## 12. Не включать в критический путь 1.0

Следующие инициативы получают отдельные extensions/ADRs после core release:

- Git status/diff/review;
- worktree management;
- terminal emulator;
- file explorer/editor;
- subagent orchestration dashboard;
- plan mode;
- MCP management;
- SSH/remote Pi;
- cloud sync/account;
- extension marketplace;
- collaboration/team policies;
- mobile/web clients.

Core contracts не должны препятствовать им, но реализация не должна усложнять 1.0.

## 13. Параллелизация после G0

Рекомендуемые независимые lanes:

- Agent A: `piui-runtime` + fake runtime + process lifecycle.
- Agent B: session scanner/index + fixtures.
- Agent C: Svelte shell/sidebar/read-only timeline.
- Agent D: contracts/generation/test harness.
- Agent E: trust/security/path policy.
- Agent F после stable normalized blocks: composer/live timeline.
- Agent G после manifest schema: declarative SDK.
- Agent H после host API permissions: sandboxed views.
- Platform agents: Windows и Linux packaging/tests с ранних phases, не в конце.

Merge dependency:

```text
G0 -> Contracts/Fake Runtime
   -> Runtime Adapter -> Live Chat -> Recovery
   -> Scanner/Index  -> Sidebar/History
   -> Trust/Path     -> Attachments/Extensions
   -> Manifest       -> Declarative SDK -> Sandbox -> Shell
   -> Perf harness across all phases
```

## 14. Формат задания coding agent

Каждое задание должно содержать:

```text
Task ID:
Goal:
Relevant specs/contracts:
Allowed files/modules:
Dependencies/assumptions:
Required happy path:
Required failure path:
Tests/fixtures:
Performance/security constraints:
Out of scope:
Expected artifacts:
```

Agent обязан:

1. прочитать `AGENTS.md` и связанные docs;
2. проверить assumptions против fixtures/capabilities;
3. не расширять scope скрыто;
4. добавить tests вместе с кодом;
5. сообщить contract/ADR impact;
6. не заменять неизвестное поведение Pi прямой JSONL-правкой.

## 15. Pull request gates

- linked Task ID и acceptance criteria;
- tests green;
- contract diff reviewed;
- no new unrestricted Tauri capability;
- performance report для hot path;
- Windows/Linux consideration;
- screenshots только дополнение к semantic tests;
- docs/ADR updated;
- extension generic fallback verified where relevant;
- safe mode remains bootable.

## 16. Definition of product completion

PiUI 1.0 завершён не по количеству экранов, а когда:

- пользовательская история едина с CLI Pi;
- обязательный MVP workflow устойчив;
- расширение может добавлять backend behavior и GUI без core patch;
- полный trusted shell replacement доказан reference package;
- Windows/Linux проходят security/performance/recovery gates;
- отсутствие UI extension не ломает Pi extension;
- known upstream gaps либо закрыты, либо честно ограничивают видимую функцию;
- core остаётся минимальным и не включает вторую IDE.
