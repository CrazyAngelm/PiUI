# AGENTS.md — обязательные правила разработки PiUI

Этот файл предназначен для coding agents и инженеров, работающих над репозиторием PiUI. Требования ниже выше локального удобства конкретной задачи.

## Цель

Создать минимальную, быструю и расширяемую desktop-оболочку над Pi. Не создавать ещё один агентный harness.

## Неподлежащие пересмотру правила

- Не реализовывать agent loop, provider clients, compaction, tools или session branching внутри PiUI, когда это уже делает Pi.
- Все команды активной сессии отправлять через типизированный runtime adapter. Не писать в session JSONL напрямую.
- Считать JSONL Pi источником истины. База PiUI — только cache/index/UI metadata и должна полностью перестраиваться.
- Не читать и не изменять `auth.json` во frontend. Не выводить ключи, OAuth tokens, полный environment или prompt content в обычные logs.
- Не давать WebView общий shell/filesystem доступ. Frontend вызывает только allowlisted Tauri commands с валидируемыми аргументами.
- Не загружать project-local PiUI JavaScript до явного trust decision.
- Любой новый core feature сначала проверять на соответствие принципу: «может ли это быть extension contribution?». Если да — держать его вне core.
- Любой custom renderer обязан иметь generic fallback. Сессия должна оставаться читаемой при отключённом расширении.
- Не использовать Electron. Не добавлять SSR, cloud backend, telemetry или account system без отдельного ADR.
- Не вводить второй формат чатов.
- Не блокировать первый paint проверками сети, каталога моделей или package updates.

## Архитектурные слои

1. `ui` — Svelte-компоненты и локальное presentation state.
2. `host-api` — генерируемые TypeScript bindings к Rust commands/events.
3. `application` — use cases: проекты, сессии, attachments, extensions.
4. `runtime` — Pi process supervisor и RPC adapter.
5. `index` — read-only session scanner и rebuildable SQLite index.
6. `platform` — process groups, filesystem watch, trash, notifications, updates.

UI не обращается к слоям `runtime`, `index` или OS напрямую.

## Кодовые соглашения

- Rust: stable toolchain, edition 2024, `cargo fmt`, `clippy -D warnings`, ошибки через typed enums; `unwrap()` запрещён вне tests и доказуемых startup invariants.
- TypeScript: `strict: true`, без `any` в публичных contracts; discriminated unions для событий; exhaustive `switch` с `never`.
- Svelte: локальное состояние в компоненте, межэкранное состояние в небольших domain stores; не создавать глобальный store «на всё приложение».
- CSS: design tokens через custom properties, component-scoped CSS; без utility-class DSL в core UI.
- IPC: schema-first. Изменение event/command contract требует version bump, compatibility test и обновления `contracts/`.
- Логи: structured fields; никаких сообщений вроде `console.log(object)` для RPC payloads в production.

## Definition of Done для каждой задачи

- Реализован happy path и минимум один failure path.
- Добавлены unit tests; для пользовательского потока — integration/E2E test.
- Нет регрессии в safe mode и generic fallback.
- Проверены keyboard-only и screen-reader labels для нового интерактивного элемента.
- Измерено влияние на startup/RSS/rendering, если затронут hot path.
- Обновлена спецификация или ADR, если поведение изменилось.
- На Windows и Linux нет platform-specific assumption без отдельной ветки и теста.

## Запрещённые обходы

- Парсить stdout обычным универсальным line reader, который разделяет Unicode line separators. Pi RPC требует LF-only framing.
- Убивать только родительский PID и оставлять дочерние tool processes.
- Скрывать project trust за общей кнопкой «Continue».
- Автоматически копировать внешние файлы в проект без видимого пользователю решения.
- Рендерить raw HTML из Markdown, tool output или extension payload.
- Загружать extension bundle в основной DOM с полными правами по умолчанию.
- Считать `ctx.hasUI === true` признаком полной TUI-поддержки в RPC.
- Переименовывать или перемещать session files ради UI-сортировки.

## Приоритеты при конфликте требований

1. Сохранность пользовательских файлов и сессий.
2. Явная модель доверия и отсутствие ложного обещания sandbox.
3. Совместимость с Pi CLI.
4. Корректность runtime protocol.
5. Responsiveness интерфейса.
6. Расширяемость.
7. Визуальная полировка.

## Команды качества, которые должен предоставить репозиторий

```bash
pnpm check          # TypeScript/Svelte formatting, lint, typecheck
pnpm test           # unit tests
pnpm test:e2e       # Playwright against packaged/dev Tauri harness
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm contract:test  # schema fixtures and backward compatibility
pnpm perf:smoke     # startup, idle RSS, long-session scroll, stream batching
```

## Перед началом реализации

Первой задачей выполнить spikes из `docs/12_OPEN_RISKS.md`. Не строить UI поверх предположений о завершении RPC-процесса, initial session creation, OAuth и tree navigation.
