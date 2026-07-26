# Источники и исследовательская база PiUI

**Дата проверки:** 23 июля 2026 года.
**Наблюдаемая версия Pi:** `v0.81.1`; ссылки на `latest` проверялись в тот же день.

Этот перечень фиксирует внешние материалы, на которых основаны фактические утверждения и архитектурные ограничения спецификации. Источники не становятся runtime-зависимостями PiUI. Перед началом реализации команда обязана повторно проверить документы Pi, если установленная версия отличается от проверенной во время исследования.

## Pi: продукт, интеграция и безопасность

- [Pi — главная страница](https://pi.dev/) — философия минимального agent harness, способы встраивания и общая модель расширяемости.
- [Pi quickstart](https://pi.dev/docs/latest/quickstart) — установка, authentication, file references и CLI session selection.
- [Pi extensions](https://pi.dev/docs/latest/extensions) — tools, commands, events, `ctx.ui`, custom renderers и lifecycle расширений.
- [Pi RPC mode](https://pi.dev/docs/latest/rpc) — JSONL-протокол, команды, события, prompt/steer/follow-up, изображения и Extension UI Protocol.
- [Pi session format](https://pi.dev/docs/latest/session-format) — дерево JSONL-сессии, entries и правила восстановления истории.
- [Pi packages](https://pi.dev/docs/latest/packages) — упаковка и распространение расширений, prompts и themes.
- [Pi security](https://pi.dev/docs/latest/security) — project trust и отсутствие встроенной полноценной песочницы для инструментов.
- [Pi SDK](https://pi.dev/docs/latest/sdk) — программное создание agent session, `SessionManager` и методы, отсутствующие или неполные в RPC.
- [Pi providers](https://pi.dev/docs/latest/providers) — модели, credentials и интерактивные сценарии авторизации.
- [Официальный репозиторий Pi](https://github.com/earendil-works/pi) — исходный код, версии, issues, standalone Bun binaries/build path и точка проверки реального API перед интеграцией.

## Desktop-стек

- [Tauri 2](https://v2.tauri.app/) — кроссплатформенная desktop-оболочка на системном WebView.
- [Tauri sidecars](https://v2.tauri.app/develop/sidecar/) — упаковка и управление внешними исполняемыми файлами.
- [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/) — платформенные движки WebView и требования к тестовой матрице.
- [Tauri security](https://v2.tauri.app/security/) — IPC, capabilities, trust boundaries и минимизация доступов frontend.
- [Svelte overview](https://svelte.dev/docs/svelte/overview) — компилируемая UI-модель.
- [Svelte lifecycle](https://svelte.dev/docs/svelte/lifecycle-hooks) — render effects и lifecycle semantics Svelte 5.
- [Bits UI](https://www.bits-ui.com/) — headless accessibility primitives для точечного использования без полного UI-kit.

## Продуктовые и UX-ориентиры

- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/) — организация threads по проектам и совместная история/config с CLI.
- [Официальное руководство Hermes Desktop](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/desktop.md) — chat-first desktop UX, sessions, model controls и общие данные с CLI.
- [OpenCovibe](https://github.com/AnyiWang/OpenCovibe) — Tauri/Svelte-пример desktop coding UI и process/session patterns; годится только для точечного аудита.
- [Community Hermes Desktop](https://github.com/fathah/hermes-desktop) — широкий Electron-клиент; используется как negative/feature-scope reference, а не как база.
- [Alma](https://alma.now/) — desktop AI orchestration как визуальный ориентир; не является архитектурной основой PiUI.

## Правило использования источников

1. Официальные документы и исходный код Pi имеют приоритет над примерами сторонних клиентов.
2. Любое недокументированное поведение подтверждается spike-тестом на минимальной и целевой версиях Pi.
3. Копирование стороннего кода допускается только после проверки лицензии, provenance и необходимости; решение фиксируется отдельным ADR.
4. Ссылки на «latest» не закрепляют API навсегда. Поддерживаемые версии Pi и вычисленные capabilities фиксируются в каждом релизе PiUI.
