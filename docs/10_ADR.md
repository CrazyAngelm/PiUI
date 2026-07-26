# 10. Architecture Decision Records

Дата базовой фиксации: 23 июля 2026 года. Все решения имеют статус **Accepted**, если явно не указано иное. Изменение требует нового ADR, а не тихого отклонения в коде.

---

## ADR-001 — PiUI является оболочкой над Pi, а не новым harness

**Контекст:** Pi уже владеет providers, agent loop, tools, extensions, compaction и sessions.

**Решение:** PiUI делегирует всё agent behavior Pi и добавляет GUI/process/data adapters.

**Отклонено:** собственный model/provider layer; импорт Pi sessions в новый формат; fork Pi core внутри UI.

**Последствия:** зависимость от RPC/SDK capabilities и необходимость честных fallbacks. Зато CLI/PiUI используют одну историю и ecosystem.

**Пересмотр:** только если Pi перестанет предоставлять пригодный embedding/API и upstream collaboration невозможна.

---

## ADR-002 — Tauri 2 + Rust + Svelte 5

**Контекст:** обязательны Windows/Linux, низкий footprint, TypeScript-friendly extension UI и надёжное управление процессами.

**Решение:** Tauri host на Rust, Svelte 5 frontend, Vite static build.

**Отклонено:** Electron (bundled Chromium/Node footprint), Flutter/Qt (хуже web-extension fit), browser-only localhost app (lifecycle/security/distribution), native per-platform UIs (стоимость parity).

**Последствия:** platform WebView differences становятся частью test matrix; Rust boundary требует typed contracts.

**Пересмотр:** если SPIKE-08 показывает hard budget/platform blocker, который нельзя устранить.

---

## ADR-003 — Pi RPC является основным runtime adapter

**Контекст:** RPC официально предназначен для custom UIs и даёт process isolation.

**Решение:** запускать `pi --mode rpc`, читать/писать JSONL через Rust supervisor.

**Отклонено:** embed SDK in desktop host by default; screen-scraping TUI; pseudo-terminal automation.

**Последствия:** несколько TUI APIs недоступны; нужны PiUI SDK/bridge gaps. Crash Pi не обязан падать вместе с shell.

**Пересмотр:** если G0 обнаружит нерешаемые startup/shutdown/session selection проблемы. SDK adapter допускается за тем же interface после отдельного ADR.

---

## ADR-004 — Один process на live session, dormant history без process

**Контекст:** project может иметь сотни sessions; параллельные turns требуют независимого state.

**Решение:** process slot только для active/running sessions, capped pool и idle eviction.

**Отклонено:** один глобальный Pi process для всего app; один process на каждую session в sidebar; process per turn.

**Последствия:** supervisor complexity и resource budgets; хорошая fault isolation и multi-session readiness.

**Пересмотр:** если Pi предлагает официальный multi-session server с эквивалентной isolation/semantics.

---

## ADR-005 — Pi JSONL является source of truth

**Контекст:** CLI и PiUI должны продолжать одни sessions.

**Решение:** читать JSONL для discovery/index, изменять active state только через Pi.

**Отклонено:** импорт/экспорт в PiUI chat DB; прямое редактирование entries; копии sessions как authoritative.

**Последствия:** scanner должен выдерживать external writes/format evolution. Удаление PiUI DB безопасно для истории.

**Пересмотр:** не планируется без изменения философии продукта.

---

## ADR-006 — SQLite только для registry/UI metadata/rebuildable index

**Контекст:** быстрый sidebar/search/drafts не должны требовать запуска Pi или полного parse каждый раз.

**Решение:** локальная SQLite, FTS optional; session projection rebuildable.

**Отклонено:** JSON settings-only для всех индексов; storing full authoritative conversation; remote DB.

**Последствия:** migrations и reindex flow, но fast queries и corruption isolation.

**Пересмотр:** если измерения показывают, что scanner без DB удовлетворяет все масштабы; metadata DB всё равно вероятно остаётся.

---

## ADR-007 — Managed, system и custom Pi runtime profiles

**Контекст:** public app нуждается в reproducibility, разработчики — в текущем/fork Pi.

**Решение:** единый adapter с тремя runtime modes; managed рекомендуется public release. Managed runtime в первую очередь использует официальный standalone Pi release artifact с проверенным checksum либо воспроизводимую сборку из versioned upstream source; приложение не запускает npm install/update.

**Отклонено:** только bundled runtime; только PATH; npm install mutation by PiUI.

**Последствия:** compatibility probe, separate update/rollback, clear diagnostics.

**Пересмотр:** если Pi распространяется как stable embeddable library/server с лучшим lifecycle.

---

## ADR-008 — Frontend не получает shell/filesystem напрямую

**Контекст:** WebView отображает untrusted model/tool/extension content.

**Решение:** only allowlisted typed Tauri IPC; Rust validates paths/permissions.

**Отклонено:** Tauri shell plugin exposed to UI; generic read/write/exec commands; Node integration.

**Последствия:** больше host API work, существенно меньшая attack surface.

**Пересмотр:** не планируется; новые возможности добавляются узкими APIs.

---

## ADR-009 — Четыре tiers расширяемости

**Контекст:** нужно одновременно поддержать существующие Pi extensions, простой GUI extension path и полную замену интерфейса.

**Решение:** Tier 0 backend-only; Tier 1 declarative; Tier 2 sandboxed rich views; Tier 3 trusted global shell.

**Отклонено:** произвольный JS в core DOM; требовать UI manifest от каждого Pi extension; запрет полного customization.

**Последствия:** capability broker, schema/versioning и safe mode обязательны.

**Пересмотр:** расширение tiers возможно в major SDK, но isolation principles сохраняются.

---

## ADR-010 — Semantic slots вместо координат/DOM selectors

**Контекст:** extensions должны переживать responsive layout и redesign.

**Решение:** manifest указывает semantic contribution slot/order/when.

**Отклонено:** CSS selectors, pixel coordinates, React/Svelte component injection в core tree.

**Последствия:** не каждый экспериментальный layout возможен в Tier 1; Tier 2/3 покрывают сложные случаи.

**Пересмотр:** slots добавляются совместимо по usage, не раскрывая internal DOM.

---

## ADR-011 — Generic fallback и raw inspectability обязательны

**Контекст:** session может содержать entries от отключённого/несовместимого extension.

**Решение:** every custom tool/message/view renderer falls back to safe generic card; raw payload available by action.

**Отклонено:** скрывать unknown entries; error whole timeline; hard dependency on renderer package.

**Последствия:** session remains readable; нужно защищать raw inspector и redact sensitive content.

**Пересмотр:** не планируется.

---

## ADR-012 — Generic files передаются как references, images — через RPC

**Контекст:** Pi RPC directly supports image input, но не общий binary attachment abstraction.

**Решение:** images encoded through Pi RPC; project/external docs represented as explicit path/resource references, optional managed copy.

**Отклонено:** читать каждый файл в prompt; обещать native PDF understanding; автоматически копировать в repository.

**Последствия:** честный UX и малые payloads; tools/extensions отвечают за чтение/обработку документов.

**Пересмотр:** когда Pi предоставляет typed general attachment API.

---

## ADR-013 — Capability negotiation важнее version checks

**Контекст:** Pi RPC развивается; forks/custom builds могут иметь разные функции.

**Решение:** probe runtime and expose named capabilities; version используется для diagnostics/known compatibility, не для единственного branch logic.

**Отклонено:** `if version >= x` повсюду; optimistic UI с runtime errors.

**Последствия:** initial probe complexity, зато forward/fork compatibility.

**Пересмотр:** если Pi вводит стабильный formal capability endpoint — adapter упрощается, принцип остаётся.

---

## ADR-014 — Svelte/Vite без SvelteKit и без Tailwind в core

**Контекст:** нет SSR/web routes; требуется маленькая и контролируемая design system.

**Решение:** Svelte 5 + Vite, CSS custom properties/scoped CSS, выборочные headless primitives.

**Отклонено:** SvelteKit adapter-static без нужды; full component kit; utility DSL как public extension contract.

**Последствия:** больше собственных component styles, меньше framework surface и stable semantic tokens.

**Пересмотр:** только если реальная routing/build need оправдывает framework layer.

---

## ADR-015 — Git, terminal, worktrees и IDE features не входят в 1.0 core

**Контекст:** вдохновение Codex App легко превращает PiUI в тяжёлую IDE.

**Решение:** core ограничен projects/sessions/chat/runtime/extensions. Остальное — packages.

**Отклонено:** встроить diff/file explorer/terminal «сразу, раз это coding app».

**Последствия:** минимальный продукт; Extension SDK должен иметь достаточно slots/APIs для будущих функций.

**Пересмотр:** после 1.0 на основании usage, через отдельный ADR и performance budget.

---

## ADR-016 — Safe mode и immutable recovery layer

**Контекст:** trusted shell способен полностью изменить UI и может сломаться/быть malicious.

**Решение:** host-owned startup shortcut/menu, core shell fallback, permission/integrity dialogs вне extension control.

**Отклонено:** shell extension replaces entire trusted app; recovery only through settings inside shell.

**Последствия:** небольшая immutable host surface обязательна даже при «полной» замене UI.

**Пересмотр:** не планируется.

---

## ADR-017 — Нет remote telemetry/account/cloud backend в 1.0

**Контекст:** local-first tool, sensitive prompts/code/secrets, минимальность.

**Решение:** local structured logs and user-exported diagnostic bundle; no automatic telemetry.

**Отклонено:** default analytics/crash upload; required PiUI account; cloud sync.

**Последствия:** меньше production observability; важны high-quality local diagnostics и opt-in future ADR.

**Пересмотр:** только с explicit privacy model, user control и отдельным product decision.

---

## ADR-018 — Signed UI/runtime updates разделены

**Контекст:** PiUI и Pi могут обновляться с разным cadence; runtime compatibility критична.

**Решение:** signed desktop updater и отдельный signed managed Pi manifest/artifact with rollback; manifest фиксирует upstream origin/version/hash, target и compatibility range.

**Отклонено:** silently run latest PATH Pi; bundle runtime forever with app; npm update on startup.

**Последствия:** release infrastructure сложнее, но reproducibility и rollback лучше.

**Пересмотр:** если upstream предоставляет подписанный stable runtime channel/API, который можно безопасно делегировать.

---

## ADR-019 — Performance budgets являются release gates

**Контекст:** «лёгкий» невозможно гарантировать архитектурным лозунгом.

**Решение:** измерять packaged builds на fixed hardware; hard budgets block release; PiUI и Pi memory separated and totaled.

**Отклонено:** только bundle size; dev-mode impressions; скрывать child processes.

**Последствия:** performance harness развивается с ранних phases; dependency additions требуют cost awareness.

**Пересмотр:** budgets калибруются только по documented evidence/reference hardware, не ради прохождения текущего build.

---

## ADR-020 — Не делать прямой fork существующего desktop agent UI

**Контекст:** OpenCovibe/Hermes дают полезные patterns, но имеют другую session/runtime semantics и feature scope.

**Решение:** чистый PiUI repository; selectively port small licensed patterns/components with attribution and tests.

**Отклонено:** fork Electron Hermes; relabel Codex UI; reuse another app’s session DB/protocol as core.

**Последствия:** больше первоначальной работы, меньше inherited complexity и semantic mismatch.

**Пересмотр:** если найден проект, уже использующий Pi RPC, совместимый license/architecture и подтверждённые quality budgets.

---

## ADR-021 — Внешние ecosystem evidence наблюдательны до выбора PiUI-signed release policy

**Контекст:** публичный npm registry может предоставить SRI, registry signature и SLSA source facts, но эти факты относятся к конкретному upstream tarball и не определяют PiUI runtime/channel policy.

**Решение:** PiUI может хранить ограниченный exact-byte locally authored observed summary и offline проверять его внутреннюю согласованность. Пока raw registry signature/key, Sigstore DSSE/certificate и Rekor inclusion material не retained, такая проверка структурная, а не криптографическая upstream verification. Такой packet всегда non-authorizing: npm identity/key не добавляется в production keyring и не конвертируется в bundle, supervisor или launch capability. Только будущая PiUI-signed policy с ролями signer, key roll/revocation, channel/sequence, acquisition, SBOM и rollback может выбрать independently authenticated external evidence как один из входов.

**Отклонено:** использовать npm key как PiUI production key; считать `npm audit signatures` trust root; авторизовать global install, archive или executable по version/SRI/attestation; запускать npm из runtime.

**Последствия:** packet полезен как durable review input и regression fixture, но не закрывает ни один Phase 0 или managed-runtime activation gate.

**Пересмотр:** только вместе с утверждённым signed release policy и handle-bound installation/launch design.

---

## ADR-022 — Cache-first каталог с инкрементальной сверкой JSONL

**Контекст:** synchronous full discovery блокировал sidebar на десятки секунд и повторно создавал parser/tree/timeline allocations для уже известных sessions. При этом Pi JSONL обязан остаться source of truth, а stale catalog не должен разрешать mutation.

**Решение:** sidebar получает last-indexed SQLite catalog сразу через versioned v7 snapshot. Host запускает bounded per-project reconciliation отдельно: no-follow identity, metadata/prefix-tail evidence позволяют пропустить unchanged source; changed source проходит streaming LF metadata parse и strong full revision hash. Scanner commits one generation-stamped batch; deletion разрешено только после complete sweep. Watcher передаёт UI лишь opaque lossy hint, а не path/event payload. Selected timeline и runtime admission используют отдельную strong identity-bound observation, не catalog freshness.

**Отклонено:** блокировать list API полным scan; считать mtime/tail hash доказательством revision; хранить authoritative transcript в SQLite; выдавать raw filesystem watcher events WebView; global refresh lock для всех projects.

**Последствия:** SQLite migration хранит host-private fingerprint evidence; legacy rows показываются cache-first и backfillятся при следующей сверке. Cold rebuild остаётся read-only и bounded; same-stat rewrite требует full integrity reconciliation/strong observation. IPC v7 имеет snapshot watermark для восстановления после missed/reordered events.

**Пересмотр:** если Pi предоставит официальные session-change/revision/lock capabilities с эквивалентной cross-platform semantics.
