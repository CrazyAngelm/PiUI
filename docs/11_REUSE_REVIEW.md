# 11. Обзор существующих приложений и стратегия переиспользования

## 1. Вывод

PiUI следует создавать в отдельном чистом репозитории. Не форкать целиком Codex App, Hermes Desktop или OpenCovibe. Переиспользование допустимо точечно: небольшие изолированные модули/паттерны после license и architecture review, с attribution, собственными tests и адаптацией к Pi semantics.

Главная причина — не визуальная уникальность, а несовпадение источника истины, protocol и extension philosophy. PiUI должен разделять sessions/config/extensions с Pi, а не унаследовать чужой storage/runtime abstraction.

## 2. Критерии оценки

Каждый кандидат оценивается по:

1. license и NOTICE obligations;
2. совместимости Tauri/Svelte/Rust;
3. process/session model;
4. возможности сохранить Pi JSONL как source of truth;
5. extension/security boundary;
6. Windows/Linux maturity;
7. performance/accessibility tests;
8. объёму лишнего feature scope;
9. активности/качества кода на момент фактического заимствования;
10. стоимости дальнейшего ownership.

Popularity/stars не являются архитектурным критерием.

## 3. Codex App

Источник: [официальное описание Codex App](https://openai.com/index/introducing-the-codex-app/).

### Что полезно как продуктовый reference

- threads, сгруппированные по projects;
- быстрое переключение между задачами без потери контекста;
- desktop shell поверх существующей CLI history/config;
- фокус на supervision, а не IDE chrome;
- inline progress и действия вокруг текущего thread;
- модель «sidebar projects/threads + main conversation».

### Что не переносить в PiUI core

- worktrees;
- встроенный diff/review;
- orchestration множества agents как обязательную концепцию;
- Codex-specific sandbox/model/account semantics;
- предположение, что task/thread равен Pi session branch.

### Решение

Использовать только как UX/reference behavior. Не считать доступным source base и не воспроизводить визуал 1:1. PiUI должен выглядеть самостоятельным и следовать собственным contracts.

## 4. Официальный Hermes Desktop

Источник: [Hermes Agent Desktop guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/desktop.md).

### Полезные продуктовые паттерны

- CLI и desktop разделяют state: session можно начать в одном интерфейсе и продолжить в другом;
- chat-first layout;
- session list, search и hygiene по мере роста;
- model control рядом с активной chat/session;
- queue editing и visible running state;
- settings GUI поверх agent configuration;
- uninstall app без обязательного удаления agent/config/chats;
- local shell и backend остаются концептуально раздельными.

### Не переносить автоматически

- Hermes-specific profiles, YOLO, gateway, memory, schedules и toolsets;
- remote backend API architecture;
- широкий dashboard scope;
- settings fields, которых Pi не предоставляет;
- безопасность/approval semantics Hermes как замену Pi trust model.

### Решение

Использовать для UX flows и совместимости CLI↔desktop. Код официального Hermes Desktop в рамках этого исследования не выбран как implementation base; сначала нужен отдельный repository/license/code audit.

## 5. OpenCovibe

Источник: [AnyiWang/OpenCovibe](https://github.com/AnyiWang/OpenCovibe).

На дату исследования repository заявляет Tauri v2 + Svelte 5, long-lived per-session process model и Apache License 2.0. Он концептуально близок: локальная desktop-оболочка над coding-agent CLIs.

### Лучший кандидат для точечного code study

Изучить, но не копировать вслепую:

- Tauri process/session actor lifecycle;
- bidirectional stream decoding и event normalization;
- app/window lifecycle;
- drag-and-drop attachments;
- long-session rendering/virtualization;
- platform packaging scripts;
- diagnostics/testing patterns;
- handling multiple transports/capabilities.

### Что не использовать как PiUI основу

- собственную run/event storage model;
- Claude/Codex protocol abstractions как canonical Pi adapter;
- terminal/diff/provider-specific feature scope;
- SvelteKit/Tailwind только потому, что они уже есть;
- assumptions, проверенные преимущественно на macOS;
- весь repository fork с последующим удалением лишних функций.

OpenCovibe прямо отмечает, что Windows/Linux функциональны, но тестировались слабее; PiUI не может унаследовать это как достаточную гарантию.

### License procedure

При копировании Apache-2.0 code:

- сохранить copyright/license headers;
- включить требуемые LICENSE/NOTICE;
- документировать исходный commit/path;
- перечислить изменения;
- не смешивать copied module с PiUI-specific code без понятной provenance;
- провести security/performance review независимо от upstream.

### Решение

**Selectively reuse after audit.** Это единственный рассмотренный кандидат, из которого разумно заимствовать небольшие implementation patterns в выбранном стеке.

## 6. Community Hermes Desktop / Hermes One

Источник: [fathah/hermes-desktop](https://github.com/fathah/hermes-desktop).

Repository использует Electron и охватывает значительно более широкий набор экранов: providers, profiles, memory, skills, schedules, gateways, office и т. д.

### Полезно

- визуальные идеи chat/session/settings;
- examples полнотекстового session search;
- onboarding/provider setup edge cases;
- UX больших configuration surfaces;
- tests вокруг streaming/IPC могут дать checklist ideas.

### Почему не база

- Electron против требования low footprint;
- другой backend protocol и storage;
- очень широкий scope;
- community project не равен официальному Hermes Desktop;
- значительная часть UI не относится к минимальному PiUI.

### Решение

Visual/flow research only. Отдельные framework-independent algorithms можно рассмотреть после MIT attribution review, но fork запрещён ADR-020.

## 7. Alma

Вероятно, в голосовой расшифровке под «Alama» имелась в виду [Alma](https://alma.now/) — desktop-интерфейс для нескольких AI providers. Это предположение, а не установленный факт.

### Полезно

- минимальный polished chat shell;
- model/provider switching;
- local-first positioning;
- аккуратное представление tool use.

### Почему не база

- provider orchestration не равно Pi agent/session harness;
- нет подтверждённой совместимости с Pi JSONL/extensions/RPC;
- extension security и project/session model отличаются;
- код/license не исследовались как пригодный source base.

### Решение

Visual reference only. Не принимать архитектурные решения на основании Alma.

## 8. Tauri, Svelte и Bits UI

Официальные источники:

- [Tauri 2](https://v2.tauri.app/)
- [Tauri sidecars](https://v2.tauri.app/develop/sidecar/)
- [Svelte documentation](https://svelte.dev/docs/svelte/overview)
- [Bits UI](https://www.bits-ui.com/)

### Что использовать

- Tauri native/system WebView host и Rust commands;
- sidecar packaging, но process lifecycle в собственном Rust supervisor;
- Svelte compiler/runtime и TypeScript;
- выборочные headless accessible primitives для dialogs, listboxes, menus и tooltips.

### Что не делать

- exposing Tauri shell plugin to extension/content UI;
- импорт всего component kit/theme;
- превращение Bits UI internals в public PiUI extension contract;
- зависимость core UX от нестабильных private framework APIs.

## 9. Матрица решений

| Кандидат | UX inspiration | Code study | Selective code reuse | Fork/base |
|---|---:|---:|---:|---:|
| Codex App | Да | Нет подтверждённой базы | Нет | Нет |
| Official Hermes Desktop | Да | После отдельного audit | Возможно | Нет |
| OpenCovibe | Да | Да | Да, после audit/NOTICE | Нет |
| Community Hermes Desktop | Да | Ограниченно | Только малые framework-independent части | Нет |
| Alma | Да | Нет | Нет | Нет |
| Tauri/Svelte/Bits UI | Да | Да | Через нормальные dependencies | Да, как платформенный stack, не app fork |

## 10. Процесс заимствования кода

Для каждого candidate module создать `REUSE-REVIEW-<id>.md`:

```text
Upstream repository/commit/path:
License/NOTICE:
Purpose:
Lines/modules proposed:
Why rewrite is worse:
Security review:
Performance review:
Platform assumptions:
Changes required for Pi semantics:
Tests added:
Ongoing update strategy:
Decision: copy/adapt/reimplement/reject
```

Rules:

- pin exact commit, не копировать с moving main без фиксации;
- prefer reimplementing small generic pattern over importing large dependency tree;
- no copied session schema/protocol as source of truth;
- no dependency solely for one trivial helper;
- preserve attribution;
- upstream update не применяется автоматически;
- copied code проходит PiUI lint/tests/security.

## 11. Кандидаты для собственного open-source release

Чтобы ecosystem мог развиваться без fork core, отдельно публикуются:

- `@piui/contracts`;
- `@piui/extension-sdk`;
- manifest JSON Schema;
- UI node schema/rendering reference;
- fake Pi RPC test harness;
- example dual Pi/PiUI packages.

Desktop host можно открыть целиком, но SDK/fixtures важнее для расширяемости. License PiUI следует выбрать до первого external code import; Apache-2.0 упрощает совместимость с OpenCovibe reuse, MIT проще, но не переносит upstream NOTICE obligations. Решение о license — отдельное юридическое/проектное действие, не сделанное этой спецификацией.
