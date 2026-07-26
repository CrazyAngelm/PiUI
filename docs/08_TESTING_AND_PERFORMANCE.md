# 08. Тестирование, производительность и критерии приёмки

## 1. Цель качества

PiUI не считается «лёгким» по выбору Tauri или субъективному впечатлению. Лёгкость и скорость подтверждаются повторяемыми измерениями, где desktop shell и Pi runtime учитываются раздельно.

Performance budgets ниже — критерии проекта, а не уже достигнутые показатели.

## 2. Reference environments

Минимум три baseline machine profiles:

### Low/mid Windows

- 4 физических/логических производительных cores уровня Intel i5-8250U или близкого;
- 16 GiB RAM;
- SSD;
- поддерживаемая Windows 11 x64;
- system WebView2 stable;
- 1920×1080, 100–150% scale.

### Linux baseline

- 4-core x86-64;
- 16 GiB RAM;
- SSD;
- актуальный поддерживаемый Ubuntu LTS/GNOME и один дополнительный distro family;
- system WebKitGTK version из release matrix;
- Wayland и X11 smoke coverage.

### macOS candidate

- Apple M1, 8 GiB RAM;
- поддерживаемая macOS;
- system WKWebView.

CI runners полезны для regression, но release performance decision принимается на закреплённых физических машинах.

## 3. Test datasets

Версионированные synthetic/anonymized fixtures:

- `empty-project`: 0 sessions;
- `normal-project`: 50 sessions, 1,000 entries;
- `large-project`: 500 sessions, 50,000 entries;
- `long-session`: 10,000 timeline blocks;
- `tool-heavy`: 2,000 tool calls, большие JSON/text results;
- `branch-heavy`: ≥2,000 tree nodes, ≥100 leaves;
- `unicode`: RTL, emoji, combining marks, invalid/partial UTF-8 boundaries;
- `images`: common formats, large dimensions, corrupt images, SVG;
- `partial-jsonl`: incomplete last line and chunk boundaries;
- `corrupt-jsonl`: malformed entry, duplicate IDs, orphan/cycle projection;
- `extensions`: backend-only, declarative, rich view, broken view, shell crash;
- `concurrent-writer`: external appends while PiUI active.

Fixtures must not contain real credentials or user chats.

## 4. Performance budgets

### 4.1 Startup

Измерять cold OS cache и warm cache отдельно. Release gate использует минимум 20 runs, reports p50/p95.

| Метрика | Budget |
|---|---|
| process start → first visible core frame, warm | p50 ≤ 0.8 s, p95 ≤ 1.5 s |
| process start → usable sidebar with cached registry | p50 ≤ 1.5 s, p95 ≤ 2.5 s |
| open normal project → session list interactive | p95 ≤ 1.0 s |
| open cached long session → first viewport | p95 ≤ 0.8 s |
| network/provider/model lookup on critical first-paint path | 0 blocking calls |

Cold cache target may be up to 2× warm budget but is tracked separately. Splash screen не считается usable frame.

### 4.2 Memory

Resident set измеряется после 60 seconds idle, окно visible, no Pi runtime, normal project loaded.

| Метрика | Budget |
|---|---|
| Windows/macOS core app RSS | target ≤ 120 MiB, hard gate ≤ 160 MiB |
| Linux core app RSS | target ≤ 150 MiB, hard gate ≤ 190 MiB |
| growth после 50 open/close session cycles | ≤ 15 MiB retained после GC/settle |
| hidden rich view после dispose | ≤ 2 MiB unexplained retained per cycle |
| attachment/image previews after close | no unbounded growth |

Pi process, provider SDK caches и child tools измеряются отдельными рядами. Итоговый user-visible report показывает **Total = PiUI + live Pi runtimes + child processes**, чтобы не скрывать реальное потребление.

### 4.3 CPU и responsiveness

| Метрика | Budget |
|---|---|
| idle CPU, averaged 60 s | < 0.5% одного core target; <1% hard gate |
| composer keystroke input latency | p95 < 16 ms |
| token/event received → painted | p95 < 75 ms, p99 < 150 ms |
| stream scheduler backlog under 50 events/s | p95 < 100 ms |
| long-session scroll frame time | p95 < 20 ms; no >200 ms main-thread stall |
| sidebar search response on 500 sessions | p95 < 100 ms after index ready |
| menu/dialog open | p95 < 100 ms |

Animation disabled/reduced-motion path also тестируется.

### 4.4 Indexing/I/O

| Метрика | Budget |
|---|---|
| startup header scan, 500 unchanged sessions | p95 ≤ 1.5 s and non-blocking UI |
| incremental append visible in sidebar/timeline | p95 ≤ 500 ms after filesystem event |
| full FTS rebuild 50,000 entries | completes without UI stalls >100 ms |
| idle indexer CPU | throttled; no sustained >25% one core without visible progress/control |
| database size | tracked vs source text; no raw binary attachment duplication |

Absolute FTS duration зависит от storage; release regression gate uses ±15% against baseline plus responsiveness limits.

### 4.5 Package

- compressed PiUI application payload target ≤35 MiB, excluding optional WebView bootstrap and managed Pi runtime;
- runtime and UI artifact sizes reported separately;
- no dependency may add >5 MiB compressed without ADR;
- duplicate JS libraries detected in bundle report;
- source maps not shipped publicly unless access-controlled policy exists.

## 5. Unit tests

### Rust

- LF-only RPC codec and chunking;
- typed command serialization/response parsing;
- runtime state machine transitions;
- process exit/timeout/escalation;
- path canonicalization/policy per platform;
- session scanner incremental parser;
- tree projection with orphan/cycle cases;
- SQLite repositories/migrations;
- attachment hash/copy/cleanup;
- manifest/schema/permission decisions;
- redaction.

### TypeScript/Svelte

- normalized reducer and revision handling;
- composer mode semantics;
- capability-based action states;
- timeline block renderers/fallback;
- context expression parser;
- UiNode validation/rendering;
- keyboard navigation/focus restoration;
- stores do not retain disposed sessions/views;
- settings validation.

Coverage percentage не заменяет scenario coverage. Critical parsers/state machines require branch-oriented tests and mutation/fuzz where practical.

Для изменений в correctness-sensitive Rust paths (identity/revision checks, LF framing, parser limits, generation/CAS/sweep, trust admission) обязателен targeted mutation-test run через `cargo mutants` до merge. В PR фиксируются examined functions, killed/survived/unviable mutants и обоснование каждого допустимого survivor; mutation tool не добавляется в production dependencies. Репозиторий предоставляет `pnpm mutation:test` для index/catalog-reconciler gate, включая path-free persisted Appearance preference codec, и `pnpm mutation:catalog-state` для freshness/coalescing state machine; более узкий или расширенный `cargo mutants` invocation фиксируется рядом с изменением.

## 6. Contract tests

Fixtures pin:

- representative Pi RPC requests/responses/events;
- unknown future event fields/types;
- session JSONL format examples;
- Extension UI requests;
- PiUI manifest v1 valid/invalid cases;
- host API request/response errors;
- rich view handshake;
- UiNode limits;
- diagnostics redaction.

CI checks:

- Rust DTO ↔ TypeScript DTO compatibility;
- JSON Schema examples;
- no breaking change without protocol version bump;
- old extension fixture works on new host within supported major;
- new optional fields ignored by old parser fixture where required.

## 7. Integration tests с Pi

Use a real pinned Pi runtime in integration CI plus a deterministic fake RPC runtime.

### Fake runtime

Supports scripted:

- slow/fragmented JSONL output;
- streaming deltas;
- UI requests;
- malformed frames;
- crash/EOF/hang;
- model/capability variants;
- unknown events;
- delayed abort;
- large payload.

Fake runtime делает tests быстрыми и воспроизводимыми.

### Real Pi matrix

- managed pinned version;
- latest compatible system version in scheduled CI;
- oldest supported version;
- optional development/nightly signal, non-blocking until intentionally supported.

Real tests verify CLI↔PiUI session round-trip, extensions and actual startup/shutdown semantics.

## 8. E2E flows

Обязательные Playwright/Tauri harness scenarios:

1. add folder → restricted view → trust → create chat;
2. open existing CLI session → continue → reopen in CLI fixture;
3. stream response → steer → follow-up → stop;
4. switch model/thinking and verify state;
5. paste/drop image → preview → send → reopen timeline;
6. attach project file as path reference;
7. external file reference vs managed copy;
8. tool call success/error/large output;
9. standard extension select/confirm/input/editor;
10. backend-only extension generic renderer;
11. declarative extension command/settings/renderer;
12. rich view permission deny/allow/revoke;
13. shell crash → core recovery;
14. Pi process crash → read-only history → reopen;
15. concurrent writer conflict;
16. rename/export/trash;
17. missing project locate flow;
18. safe mode;
19. keyboard-only complete chat flow;
20. WebView reload while runtime continues.

Tests should assert host state/data, not only screenshots.

## 9. Platform matrix

### Windows mandatory

- installer/update/signature;
- WebView2 absent/bootstrap behavior;
- spaces/non-ASCII/long paths;
- drive letters, UNC, junctions, reserved names;
- Job Object process tree cleanup;
- clipboard/file dialogs/notifications;
- high DPI/multiple monitors;
- antivirus-sensitive startup and locked files.

### Linux mandatory

- AppImage/deb or chosen formats;
- WebKitGTK dependency checks;
- Wayland/X11;
- GNOME/KDE smoke;
- symlink/case-sensitive paths;
- process groups/signals/zombies;
- trash spec behavior;
- file watcher limits;
- sandboxed iframe/WebView behavior.

### macOS candidate

- signing/notarization;
- arm64/x64 as supported;
- WKWebView;
- process groups;
- quarantine/path permissions;
- file dialogs/trash/keychain;
- Retina/multiple spaces.

Windows and Linux release blockers имеют одинаковый приоритет.

## 10. Accessibility tests

- automated axe-like checks where supported;
- keyboard traversal and no focus traps;
- focus return after dialogs/menus;
- screen-reader labels for icon buttons;
- streamed assistant content announced in throttled meaningful chunks, not token-by-token;
- status changes use appropriate live regions;
- color contrast core themes and contributed themes;
- 200% zoom/reflow;
- reduced motion;
- high contrast/system theme behavior;
- tool card/raw JSON navigability;
- rich view accessibility responsibility documented and auditable.

Manual matrix includes NVDA on Windows and Orca on Linux; VoiceOver for macOS release.

## 11. Security tests

Использовать checklist из `07_SECURITY.md` плюс:

- Tauri capabilities snapshot test;
- no extension origin can invoke core IPC;
- forged `postMessage` source/token rejected;
- CSP test build;
- malicious Markdown corpus;
- path traversal corpus including encoded separators;
- package symlink escape;
- secrets absent from logs/crash report;
- update tamper failure;
- permission grant invalidation after package change;
- network redirect revalidation;
- safe mode independent of shell DOM.

Public release требует targeted external security review extension broker/update boundary.

## 12. Fuzz и property-based testing

Targets:

- `rpc_codec(bytes)` never panics/OOM within configured limits;
- `session_jsonl_decoder(line)`;
- `manifest_parser(json)`;
- `ui_node_validator(json)`;
- `context_expression_parser(text)`;
- `resource_ref_parser(text)`;
- tree projection invariant: no infinite traversal;
- event reducer invariant: revision monotonicity/idempotence.

Fuzz corpus пополняется каждым production-like parser incident.

## 13. Chaos/recovery tests

Во время каждого этапа случайно:

- kill Pi parent/child;
- freeze stdout;
- close stdin;
- truncate only fixture copy of session file;
- append from external writer;
- reload WebView;
- revoke project/extension permission;
- remove project path;
- fill attachment quota/disk;
- lock SQLite/session file;
- crash rich view/worker;
- interrupt update.

Assertions: no silent data mutation, shell remains usable or safe recovery appears, diagnostics gives stable error code.

## 14. Performance harness

Repository provides:

```bash
pnpm perf:startup --runs 20 --profile normal-project
pnpm perf:memory --duration 60s
pnpm perf:stream --rate 50 --duration 120s
pnpm perf:scroll --fixture long-session
pnpm perf:index --fixture large-project
pnpm perf:extensions --fixture extensions
```

Harness records:

- commit/build/runtime versions;
- OS/WebView/hardware profile;
- p50/p95/p99;
- PiUI RSS and process-tree RSS separately;
- CPU, main-thread long tasks, dropped frames;
- artifact/bundle sizes;
- raw result JSON and human report.

CI comments regression; release branch blocks on hard budgets or >15% regression without approved ADR.

## 15. Profiling rules

- measure packaged release build, not only dev server;
- warmup runs excluded according to fixed method;
- no unrelated apps/update tasks on physical benchmark machine;
- GC cannot be manually forced unless same procedure used for baseline and clearly reported;
- system WebView version recorded;
- memory sampled long enough to detect delayed cleanup;
- active Pi/provider network latency excluded from UI render metric but separately reported;
- screenshot/video recording overhead disabled for performance numbers.

## 16. Visual regression

Snapshot only stable surfaces:

- core shell light/dark/system;
- empty/loading/error/running states;
- common timeline blocks;
- trust/permission dialogs;
- compact/narrow layout;
- 100/150/200% scale.

Do not snapshot dynamic timestamps/tokens without normalization. Visual diff complements semantic assertions, not replaces them.

## 17. Upgrade/rollback tests

- previous stable PiUI DB → current;
- current update failure → previous app opens backup metadata;
- managed Pi runtime upgrade and rollback;
- extension manifest/API previous minor;
- package fingerprint/grant invalidation;
- disabled/incompatible renderer fallback;
- sessions created in old Pi remain readable;
- no Pi JSONL migration performed by PiUI update.

## 18. Release gates

### Internal alpha

- core E2E happy paths Windows/Linux;
- real Pi chat round-trip;
- no direct JSONL writes;
- process crash recovery;
- trust flow;
- measured startup/RSS baseline, even if target not yet met.

### Public beta

- all mandatory E2E;
- declarative SDK stable candidate;
- rich views isolated;
- signed update candidate;
- accessibility critical flows;
- no hard performance budget violation;
- known gaps clearly surfaced.

### Public 1.0

- Windows/Linux release matrix green;
- safe mode and shell recovery;
- contract compatibility suite;
- external security review findings resolved/accepted;
- measured budgets published internally with reproducible command;
- no P0/P1 data-loss/security bugs;
- Pi runtime compatibility matrix fixed;
- documentation and examples match shipped API.

## 19. Severity model

- **P0:** data loss, secret exposure, update compromise, sandbox/IPC escape, inability to recover shell.
- **P1:** incorrect prompt/tool action, orphan process with effects, session corruption/conflict hidden, app unusable on mandatory platform.
- **P2:** major feature broken with workaround, substantial performance/accessibility regression.
- **P3:** localized UX/visual defect.

P0/P1 block release. Performance hard-gate failure is at least P1 for release, not cosmetic debt.
