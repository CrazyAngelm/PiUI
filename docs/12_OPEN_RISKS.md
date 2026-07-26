# 12. Открытые риски, неизвестные и обязательные проверки

## 1. Статус документа

Риски ниже не замаскированы под реализованные возможности. До выполнения Phase 0 многие технические детали являются обоснованным проектным решением, но не подтверждённым поведением конкретной версии Pi/OS.

Шкала:

- **Вероятность:** Low / Medium / High.
- **Влияние:** Medium / High / Critical.
- **Gate:** этап, до которого риск обязан быть закрыт или формально принят.

## 2. Критический риск-регистр

| ID | Риск | Вероятность | Влияние | Gate |
|---|---|---:|---:|---|
| R-01 | RPC startup создаёт ghost session при открытии existing chat | Medium | High | G0 |
| R-02 | Нет корректного graceful shutdown, остаются child tools | Medium | Critical | G0/G2 |
| R-03 | Нельзя перейти на arbitrary branch node через RPC | High | Medium/High | G0/G4 |
| R-04 | Provider OAuth/login требует полноценного TTY | High | High | G0/G3 |
| R-05 | RPC/TUI extension UI parity ограничена сильнее ожидаемого | High | High | G0/G3 |
| R-06 | Одновременный CLI/PiUI writer повреждает/рассинхронизирует session | Medium | Critical | G0/G2 |
| R-07 | Session format/root меняется между Pi versions | Medium | High | G1/G4 |
| R-08 | System WebView footprint/behavior нарушает budgets на Linux/Windows | Medium | High | G0/G6 |
| R-09 | Tauri sidecar Pi packaging сложен/нестабилен на mandatory platforms | Medium | High | G0/G6 |
| R-10 | Rich view isolation имеет platform-specific escape/IPC exposure | Medium | Critical | G5 |
| R-11 | Trusted shell делает recovery недоступным | Low/Medium | Critical | G5 |
| R-12 | Full-feature UI extension SDK раздувает core и задерживает stable v1 | High | High | G4/G5 |
| R-13 | Pi executable/backend extensions имеют user permissions; пользователи принимают это за sandbox | High | Critical | G1/G6 |
| R-14 | Large sessions/tool outputs вызывают memory leak/jank | High | High | G2/G6 |
| R-15 | Windows process/path semantics дают orphan/traversal bugs | Medium | Critical | G2/G6 |
| R-16 | Linux WebKitGTK/distro matrix слишком фрагментирована | High | High | G6 |
| R-17 | Reused external code приносит license/security/architecture debt | Medium | High | До merge |
| R-18 | Managed runtime и system Pi расходятся по packages/config behavior | Medium | High | G2/G6 |
| R-19 | Generic file references недостаточно понятны модели/tools | Medium | Medium | G3 |
| R-20 | Scope creep превращает PiUI в IDE/dashboard | High | High | Все gates |

## 3. Детализация и exit criteria

### R-01 — Ghost sessions

**Сигнал:** запуск RPC без явного selector создаёт новый JSONL до `switch_session`.

**Mitigation:** supported launch option; deferred session creation; minimal bridge.

**Запрещённый workaround:** удалить ghost file после запуска без подтверждения ownership.

**Exit:** automated test proves zero extra files across new/open/crash paths.

### R-02 — Shutdown/process tree

**Сигнал:** EOF/abort не завершает Pi или descendants; Windows leaves process.

**Mitigation:** graceful command/EOF, timeout escalation, Unix process groups, Windows Job Object.

**Residual:** descendants daemonized outside group may survive; document limits.

**Exit:** child-process fixture leaves zero owned descendants on Windows/Linux.

### R-03 — Branch navigation

**Сигнал:** `get_tree` есть, command navigate отсутствует.

**Mitigation:** read-only tree; only fork/clone; upstream/bridge capability.

**Exit:** official/bridge operation with round-trip CLI test, либо explicit 1.0 product limitation accepted.

### R-04 — Authentication

**Сигнал:** `/login` требует terminal interaction not exposed via RPC/get_commands.

**Mitigation:** dedicated allowlisted auth subprocess or external terminal instructions; never generic terminal.

**Exit:** provider matrix flow works without secret logs and refreshes models.

### R-05 — Extension parity

**Сигнал:** `ctx.ui.custom`, header/footer/editor/theme no-op; custom entries lack renderer metadata.

**Mitigation:** Tier 0 generic fallback + PiUI manifest/SDK; extension UI fixture corpus.

**Exit:** documented compatibility matrix and dual-package example; no claim of full automatic TUI parity.

### R-06 — Concurrent writers

**Сигнал:** CLI and PiUI append divergent turns to same session/current leaf.

**Mitigation:** external-write revision detection, conflict state, read-only/fork choice.

**Exit:** stress fixture never silently merges or loses entries.

### R-07 — Session format drift

**Сигнал:** unknown headers/entry types/root paths break scanner.

**Mitigation:** tolerant decoder, raw preservation, version/capability probe, pinned managed runtime, fixtures.

**Exit:** oldest/current supported Pi corpus and unknown-event tests pass.

### R-08 — WebView performance/variance

**Сигнал:** baseline RSS/startup over hard gate; long timeline differs across WebKitGTK/WebView2.

**Mitigation:** early SPIKE-08, minimal dependencies, virtualization, platform-specific fixes.

**Fallback:** reconsider Qt/other stack before product coupling, not after 1.0.

**Exit:** physical reference measurements within hard budgets.

### R-09 — Managed runtime packaging

**Сигнал:** executable naming, architecture, permissions, updates or package assets fail.

**Mitigation:** сначала использовать official standalone Pi release artifacts; проверять upstream checksum/provenance; хранить отдельные sidecar artifacts/manifests; system/custom modes remain fallback; никогда не выполнять npm install/update при startup.

**Exit:** signed/tested install-update-rollback on Windows/Linux.

### R-10 — Rich view isolation

**Сигнал:** iframe/view can call core Tauri IPC, navigate, fetch secrets or spoof host prompt.

**Mitigation:** separate capability/origin, broker tokens, immutable prompts, CSP, adversarial tests.

**Exit:** security review and platform tests; otherwise ship declarative SDK only and defer Tier 2.

### R-11 — Shell recovery

**Сигнал:** broken shell blocks settings/safe mode.

**Mitigation:** native startup modifier/menu, crash-loop counter, core fallback outside shell.

**Exit:** malicious/broken reference shell cannot suppress recovery.

### R-12 — SDK scope

**Сигнал:** v1 tries to support arbitrary layout/CSS/DOM in declarative tier.

**Mitigation:** frozen small node vocabulary/slots; complex cases go Tier 2/3; usage-driven additions.

**Exit:** schema v1 implementable/testable, unknown contributions degrade gracefully.

### R-13 — False sandbox perception

**Сигнал:** users trust project because desktop app looks managed/safe.

**Mitigation:** literal trust wording, restricted mode, extension source visibility, no misleading shields.

**Exit:** security/UX review validates comprehension; docs repeat limitation.

### R-14 — Long-session performance

**Сигнал:** entire timeline/Markdown/tool output stays in DOM/memory.

**Mitigation:** virtualization, paging, lazy parse, output truncation/collapse, leak tests.

**Exit:** 10k-block fixture meets hard budgets after repeated open/close.

### R-15 — Windows semantics

**Сигнал:** UNC/junction/ADS/long path/process cleanup bugs.

**Mitigation:** Rust platform adapter and Windows-specific corpus/physical CI.

**Exit:** mandatory tests, no POSIX-only assumptions.

### R-16 — Linux distribution variance

**Сигнал:** WebKitGTK missing/incompatible; Wayland dialogs/tray; AppImage issues.

**Mitigation:** narrow declared support matrix, dependency preflight, deb/AppImage choice based on tests.

**Exit:** two distro families and Wayland/X11 smoke; unsupported cases stated.

### R-17 — External reuse

**Сигнал:** copied OpenCovibe/Hermes code retains unrelated storage/protocol or misses NOTICE.

**Mitigation:** per-module reuse review, exact commit, own tests.

**Exit:** legal/provenance checklist in PR.

### R-18 — Runtime profile divergence

**Сигнал:** managed Pi loads packages/config differently from system Pi.

**Mitigation:** same resolved home/config semantics where intended, visible paths, compatibility tests.

**Exit:** fixture package/session works in all supported profiles or differences documented.

### R-19 — File references

**Сигнал:** model ignores textual attachment convention; tool cannot resolve managed URI.

**Mitigation:** stable human-readable path refs, optional bridge/tool resolver, user-visible semantics.

**Exit:** real workflows validate project/external file use; typed Pi API replaces convention when available.

### R-20 — Scope creep

**Сигнал:** core PRs add Git/terminal/diff/subagents before stable chat/extensions.

**Mitigation:** ADR-015, extension-first review, release gates, explicit non-goals.

**Exit:** ongoing; each new core feature requires ADR.

## 4. Вторичные риски

- system WebView updates can regress rendering between PiUI releases;
- model/provider list can be slow/offline;
- clipboard/image decoder behavior differs by platform;
- FTS may expose sensitive local text to other local processes with same user rights;
- project moved through symlink can invalidate trust identity;
- permission fatigue may lead users to allow everything;
- extension package updates can change behavior without publisher signatures;
- session trash undo differs by OS;
- full diagnostics may accidentally include prompt/path via third-party error strings;
- screen readers may announce streaming too aggressively;
- update signing infrastructure itself becomes critical secret;
- managed attachment cache can grow silently;
- app crash during DB migration can lose UI metadata, though not sessions;
- custom Pi forks may claim version but diverge semantics;
- anti-virus may quarantine sidecar on Windows;
- WSL/project paths bridge Windows/Linux identity ambiguously.

Каждый должен иметь issue/test до соответствующей feature release.

## 5. Upstream requests к Pi

Рекомендуемый минимальный список, без требования превратить Pi в GUI framework:

1. explicit capability/protocol version endpoint;
2. open existing session at RPC startup without creating another;
3. graceful shutdown RPC command/ack;
4. navigate current branch/tree node;
5. headless auth status/start flow or structured interactive channel;
6. typed generic attachment/resource references;
7. richer metadata for custom entries/tool renderers;
8. documented concurrent access/locking semantics;
9. complete list of config operations suitable for external UI.

Каждый request должен быть small, generic and useful to any custom UI, not PiUI-specific pixel behavior.

## 6. Bridge extension fallback

Если upstream API недоступен, `@piui/pi-bridge` может:

- регистрировать минимальные Pi commands/events;
- expose tree navigation/session selection/auth metadata through supported extension/SDK primitives;
- translate typed resource references;
- advertise bridge version/capabilities.

Bridge не должен:

- implement agent loop;
- introduce second session file;
- write JSONL outside Pi APIs;
- render desktop UI;
- become mandatory for basic prompt/streaming;
- hide version incompatibility.

## 7. Go/no-go правила

- **No-go public rich views:** R-10 unresolved.
- **No-go trusted shell:** R-11 unresolved.
- **No-go Windows/Linux release:** R-02/R-08/R-09/R-15/R-16 unresolved.
- **No-go session mutation features:** R-01/R-06/R-07 unresolved.
- **No-go “full extension compatibility” claim:** R-05 unresolved or wording not narrowed.
- **No-go low-memory claim:** physical hard budgets not measured.
- **No-go public auto-update:** signing/rollback not verified.

Частичный релиз допустим только с отключённой/скрытой unsupported feature, а не с optimistic broken action.

## 8. Risk review cadence

На каждом gate:

- обновить probability/impact;
- приложить test/fixture/decision evidence;
- перевести закрытый риск в ADR/known limitation;
- не закрывать риск ссылкой на code review без runtime evidence;
- новые риски добавлять до merge архитектурного изменения.
