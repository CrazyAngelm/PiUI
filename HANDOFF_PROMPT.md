# PiUI — handoff для coding agents и contributors

PiUI — минимальная desktop-оболочка над Pi agent harness. Она не заменяет Pi agent loop, provider clients, tools, compaction, session storage или authentication.

## Перед любой задачей

Прочитай в таком порядке:

1. `README.md`, `CONTRIBUTING.md` и `AGENTS.md`.
2. `docs/13_FOUNDATION_STATUS.md` и `docs/12_OPEN_RISKS.md`.
3. Документ затрагиваемой подсистемы и связанные ADR в `docs/`.
4. `contracts/README.md` и машиночитаемые contracts, если меняется IPC/UI DTO.

## Неподлежащие пересмотру границы

- Не писать Pi JSONL напрямую и не создавать второй формат чата.
- Не давать WebView общий shell/filesystem/process API.
- Не читать и не передавать `auth.json`, credentials, полный environment или raw prompts.
- Не запускать project-local UI/JavaScript до отдельного trust decision.
- Не выдавать local live-RPC preview за managed runtime, sandbox или release-ready feature.
- Не добавлять cloud backend, telemetry, account system или Electron без ADR.
- Для нового core feature сначала проверить extension-first alternative.

## Текущий статус

Foundation и временный local live-RPC preview реализованы, но public-release gates остаются открытыми. Реальные Pi/runtime/packaging/platform claims должны соответствовать только доказательствам в `docs/13_FOUNDATION_STATUS.md`, `spikes/PHASE0_GATE.md` и `CHECKLIST_RELEASE.md`.

## Формат работы

В начале задачи зафиксируй:

- scope и затронутые acceptance criteria;
- изменяемые public contracts и migration/compatibility impact;
- data/security/performance/platform risks;
- automated и manual validation plan.

В конце укажи:

- реализованное и сознательно не реализованное;
- команды и результаты проверок;
- новые assumptions/open risks;
- нужен ли ADR, schema bump или upstream issue;
- rollback, если изменение затрагивает user-visible state.

## Definition of done

Изменение не готово только потому, что оно визуально работает. Нужны typed boundaries, happy/failure-path tests, сохранность Pi/CLI compatibility, safe-mode/generic fallback coverage, доступные keyboard/screen-reader labels и обновлённая документация.

Никогда не добавляй в репозиторий session JSONL, prompts, tool output, screenshots реальных сессий, credentials, local paths, usernames, `.env`, `.pi/` state или mutation/build artifacts.
