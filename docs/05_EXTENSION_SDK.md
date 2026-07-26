# 05. PiUI Extension SDK

## 1. Цель

PiUI должен продолжать философию Pi: минимальное ядро, расширение через пакеты. При этом нельзя считать, что TUI-компоненты автоматически переносимы в desktop GUI. Поэтому один package может содержать две независимые, совместимые части:

- `pi` — backend extension/resources, которые загружает Pi;
- `piui` — необязательное описание GUI contributions, которое загружает PiUI.

Отсутствие `piui` никогда не мешает backend extension работать.

## 2. Уровни расширяемости

### Tier 0 — Backend-only compatibility

Пакет содержит только обычный Pi extension.

PiUI обязан:

- позволить Pi загрузить extension по обычным правилам;
- показать зарегистрированные tools и commands, если Pi сообщает их через RPC;
- обработать стандартный Extension UI Protocol;
- отрисовать tool/custom entries универсальной карточкой;
- не требовать изменений package.

Это уровень совместимости по умолчанию.

### Tier 1 — Declarative contributions

Пакет содержит `piui.manifest.json`, но не исполняет собственный UI JavaScript. Manifest может добавить:

- команды и command palette entries;
- composer actions;
- status items;
- settings schema;
- project/session context menu actions;
- sidebar или right-panel views из безопасного UI node tree;
- tool/message/custom-entry renderers из UI node tree;
- preview providers, возвращающие безопасную модель preview;
- themes/design tokens в ограниченной схеме;
- keybinding defaults.

PiUI создаёт все элементы своими компонентами. Это основной и рекомендуемый extension path.

### Tier 2 — Sandboxed rich views

Пакет предоставляет статический web bundle для сложного представления. Он запускается:

- в sandboxed iframe/WebView без прямого Tauri API;
- с отдельным origin или opaque origin;
- без network по умолчанию;
- через versioned `postMessage` broker;
- с capability-based host API;
- с CSP, запрещающим inline/eval, кроме явно согласованной dev policy;
- с ограничениями размера bundle, памяти, message rate и payload size.

Rich view подходит для графов, специализированных inspectors, canvas-based previews и сложных interactive tools.

### Tier 3 — Trusted shell replacement

Пакет может полностью заменить обычный layout PiUI, если пользователь явно доверил **глобально установленный** пакет как shell.

Ограничения:

- project-local package не может стать shell;
- shell запускается в отдельной изолированной surface и общается через тот же broker;
- он не получает raw Tauri `invoke`, shell или filesystem API;
- выбор shell требует restart и отдельного предупреждения;
- immutable recovery layer остаётся у host: safe-mode shortcut/menu, crash screen, permission dialogs и update integrity prompts;
- при crash loop PiUI автоматически возвращается к core shell;
- одновременно активен только один shell;
- shell не меняет формат сессий и не заменяет Pi runtime.

Так сохраняется требование полного изменения интерфейса без передачи extension неограниченных прав desktop host.

## 3. Package layout

```text
my-package/
  package.json
  pi/
    extension.ts
  piui.manifest.json
  piui/
    worker.js              # необязательно
    views/
      graph/index.html     # Tier 2, необязательно
      graph/assets/*
    icons/*
```

Пример `package.json`:

```json
{
  "name": "@example/pi-project-health",
  "version": "1.2.0",
  "type": "module",
  "pi": {
    "extensions": ["./pi/extension.ts"]
  },
  "piui": {
    "manifest": "./piui.manifest.json"
  }
}
```

PiUI сначала применяет правила discovery Pi packages, затем ищет необязательный `piui.manifest.json`. Он не запускает `postinstall` и не выполняет package code для чтения manifest.

## 4. Manifest

Минимальный manifest:

```json
{
  "$schema": "https://schemas.piui.dev/extension-manifest/v1.json",
  "schemaVersion": 1,
  "id": "example.project-health",
  "name": "Project Health",
  "version": "1.2.0",
  "engines": {
    "piui": ">=1.0.0 <2",
    "pi": ">=0.0.0"
  },
  "contributes": {
    "commands": [
      {
        "id": "example.project-health.refresh",
        "title": "Refresh project health",
        "handler": "worker:refresh"
      }
    ],
    "composerActions": [
      {
        "id": "example.project-health.attachSummary",
        "title": "Attach health summary",
        "icon": "pulse",
        "command": "example.project-health.refresh",
        "when": "project.trusted && runtime.ready"
      }
    ]
  },
  "permissions": ["session.read", "project.read"]
}
```

Полная JSON Schema находится в `contracts/piui-extension-manifest.schema.json`. Проверка manifest состоит из двух обязательных проходов:

1. JSON Schema проверяет форму, типы, ограничения размеров и structural security invariants: явный массив `permissions`, соответствие `ui.shell` shell-entrypoint, `network` origin allowlist и `ui.richView` views-entrypoint.
2. Host semantic validator проверяет принадлежность contribution ID namespace расширения, уникальность ID, существование command/handler/view targets, dependency cycles, допустимость slot, trust scope и соответствие фактических Host API вызовов выданным capabilities.

Прохождение одной JSON Schema не означает, что пакет разрешён к активации. Ошибка второго прохода переводит UI-часть в disabled/backend-only state с диагностикой, но не даёт ей частичный доступ.

### Обязательные поля

- `schemaVersion`: целое major schema number;
- `id`: стабильный reverse-domain-like ID, не меняется между версиями;
- `name`: user-facing label;
- `version`: SemVer package version;
- `engines.piui`: совместимый диапазон PiUI;
- `contributes`: декларативные contributions;
- `permissions`: минимально необходимые capabilities.

### Entry points

```json
{
  "entrypoints": {
    "worker": "./piui/worker.js",
    "views": {
      "graph": "./piui/views/graph/index.html"
    },
    "shell": "./piui/shell/index.html"
  }
}
```

Entry points resolve только внутри package root после canonicalization. `..`, symlink escape и remote URL запрещены.

## 5. Semantic slots

Extensions указывают **смысл**, а не пиксельные координаты. Поддерживаемые slots v1:

- `sidebar.project.beforeSessions`
- `sidebar.project.afterSessions`
- `sidebar.footer`
- `header.session.leading`
- `header.session.trailing`
- `timeline.block.actions`
- `composer.leading`
- `composer.actions`
- `composer.footer`
- `rightPanel.primary`
- `settings.extensions`
- `status.runtime`

Manifest не задаёт `top: 12px` или прямой selector core DOM. Host решает responsive layout, accessibility и compact mode.

Ordering:

```json
{
  "slot": "composer.actions",
  "order": 200,
  "group": "attachments"
}
```

- меньший `order` идёт раньше;
- core резервирует диапазон `0–99`;
- extensions обычно используют `100–999`;
- одинаковый order сортируется по extension ID;
- extension не может скрывать contribution другого extension.

## 6. Declarative UI node vocabulary

Tier 1 renderer возвращает сериализуемое дерево из allowlisted узлов:

```ts
type UiNode =
  | { type: 'text'; value: string; tone?: Tone; selectable?: boolean }
  | { type: 'markdown'; value: string; trusted: false }
  | { type: 'code'; value: string; language?: string; maxLines?: number }
  | { type: 'icon'; name: BuiltInIconName; label?: string }
  | { type: 'badge'; label: string; tone?: Tone }
  | { type: 'image'; source: ResourceRef; alt: string; fit?: 'contain' | 'cover' }
  | { type: 'row'; children: UiNode[]; gap?: 'xs' | 'sm' | 'md'; wrap?: boolean }
  | { type: 'column'; children: UiNode[]; gap?: 'xs' | 'sm' | 'md' }
  | { type: 'separator' }
  | { type: 'button'; label: string; command: string; args?: JsonValue; disabled?: boolean }
  | { type: 'link'; label: string; target: ResourceRef }
  | { type: 'progress'; value?: number; label: string }
  | { type: 'table'; columns: TableColumn[]; rows: JsonValue[][]; maxRows?: number }
  | { type: 'tree'; items: TreeItem[] }
  | { type: 'details'; summary: UiNode[]; children: UiNode[]; open?: boolean }
  | { type: 'empty'; title: string; description?: string; action?: UiAction };
```

Запрещены raw HTML, arbitrary CSS, inline scripts, DOM event strings и external image URLs без permission. Markdown проходит PiUI sanitizer; `trusted: true` в v1 отсутствует.

Limits v1:

- depth ≤ 20;
- nodes ≤ 2,000 на render result;
- text ≤ 2 MiB суммарно;
- table ≤ 1,000 rows до pagination;
- update rate ≤ 30 messages/s на view;
- payload > limit отклоняется и заменяется fallback.

## 7. Contributions

### 7.1 Commands

```json
{
  "id": "example.explainSelection",
  "title": "Explain selected text",
  "category": "Example",
  "icon": "sparkles",
  "handler": "worker:explainSelection",
  "when": "selection.text && runtime.ready",
  "enablement": "project.trusted",
  "defaultKeybinding": "CtrlOrMeta+Shift+E"
}
```

Handler types:

- `pi-command:<name>` — вызывает command, который уже зарегистрирован backend extension;
- `host:<allowlisted-action>` — только действия, явно открытые SDK;
- `worker:<handler>` — вызывает sandboxed extension worker;
- `view:<viewId>:<message>` — посылает событие rich view.

Command не может содержать shell command string.

### 7.2 Composer actions

Action может:

- вставить текст;
- добавить structured attachment reference;
- открыть dialog/view;
- вызвать command;
- преобразовать draft через worker после разрешения `composer.read/write`.

Он не получает содержимое draft без permission.

### 7.3 Status items

Status item имеет короткий label, tooltip и command. Host ограничивает ширину и переносит overflow в меню. Extension не может создавать persistent animation без running state.

### 7.4 Settings

Extension объявляет JSON-like schema с поддержанными controls:

- boolean;
- string/password reference;
- number с min/max;
- enum;
- path picker с конкретным access mode;
- keybinding;
- secret reference.

Секреты хранятся в platform credential store и передаются worker только через opaque token/approved request. Они не попадают в обычный settings JSON.

### 7.5 Tool renderers

Matcher:

```json
{
  "id": "example.build-renderer",
  "for": {
    "toolName": "build_project",
    "extensionId": "example.backend"
  },
  "kind": "declarative",
  "handler": "worker:renderBuild",
  "priority": 100
}
```

Rules:

- exact extension ID + tool name сильнее wildcard;
- пользователь может отключить renderer отдельно от backend extension;
- generic raw view доступен всегда;
- renderer получает redacted payload в соответствии с permissions;
- renderer не меняет результат tool execution.

### 7.6 Message/custom-entry renderers

Matcher использует stable type/namespace, а не произвольную эвристику текста. Если два renderer имеют одинаковый priority, PiUI выбирает точнейший matcher и показывает диагностируемый conflict при равенстве.

### 7.7 Sidebar/right-panel views

Tier 1 view возвращает UiNode и обновляется по явным subscriptions. Tier 2 view указывается через `viewId`. Правую панель можно открыть по команде; extension не должен принудительно держать её открытой после каждого запуска без user preference.

### 7.8 Preview providers

Provider объявляет поддерживаемые URI/MIME и возвращает:

- text/code preview;
- image resource;
- declarative nodes;
- sandboxed rich view.

Он не ассоциирует executable previewer без отдельной permission и user action.

### 7.9 Themes

Theme contribution может переопределять только documented semantic tokens:

```json
{
  "id": "example.dim",
  "label": "Example Dim",
  "tokens": {
    "surface.canvas": "#101114",
    "text.primary": "#f2f3f5",
    "accent.primary": "#8ba7ff"
  }
}
```

Перед публикацией PiUI проверяет contrast критических пар. Theme не может встраивать CSS/JS в Tier 1. Пользователь всегда может вернуться к System/Light/Dark в safe mode.

## 8. Context keys и `when`

PiUI предоставляет ограниченный expression language без `eval`:

```text
project.trusted && runtime.ready && editor.hasText
session.running || session.queuedCount > 0
resource.mime == "image/png"
```

Поддерживаются `&&`, `||`, `!`, `==`, `!=`, `<`, `>`, parentheses и membership в literal list. Unknown key evaluates false.

Основные keys:

- `platform`: `windows|linux|macos`;
- `project.open`, `project.trusted`, `project.hasGit`;
- `session.open`, `session.running`, `session.hasBranches`;
- `runtime.ready`, `runtime.capability.<name>`;
- `composer.hasText`, `composer.hasAttachments`;
- `selection.text` как boolean, не само содержимое;
- `view.<id>.visible`;
- `safeMode`.

Extension не может создавать глобальный key с чужим namespace.

## 9. Host API и permissions

Полный TypeScript contract — `contracts/piui-host-api.d.ts`.

### Permission groups

| Permission | Возможности |
|---|---|
| `session.read` | metadata/timeline blocks текущей сессии |
| `session.command` | отправка allowlisted Pi/PiUI commands |
| `session.prompt` | отправка/steer/follow-up после user-visible action |
| `composer.read` | чтение draft |
| `composer.write` | изменение draft/attachments |
| `project.read` | чтение файлов через scoped API |
| `project.write` | запись через scoped API и conflict checks |
| `externalFiles.read` | user-picked external handles |
| `network` | fetch через host proxy для approved origins |
| `clipboard.read` | только после user gesture |
| `clipboard.write` | запись clipboard |
| `notifications` | system notifications |
| `storage` | namespaced extension storage |
| `secrets` | opaque credential references |
| `ui.richView` | запуск Tier 2 view |
| `ui.shell` | request trusted shell activation |

### Permission decisions

Decision scope:

- deny;
- allow once;
- allow for this project;
- allow globally.

Не все permissions допускают все scopes. `ui.shell` — только global; `externalFiles.read` обычно per handle; `clipboard.read` — per gesture.

Prompt должен объяснять конкретное действие и extension source. Нельзя просить «полный доступ» одним неразделимым grant.

### Host API principles

- structured inputs/outputs;
- cancellable requests;
- resource handles вместо произвольных paths;
- origin allowlist для network;
- max payload и rate limits;
- permissions проверяются host при каждом вызове, а не только UI;
- view/worker не видит grants других extensions;
- API version передаётся при handshake.

## 10. Worker model

Tier 1 dynamic handlers исполняются не в main UI realm. Extension worker:

- загружается как module worker в изолированном context;
- не имеет Tauri globals;
- получает `initialize(apiVersion, extensionId, grantedCapabilities)`;
- регистрирует named handlers;
- возвращает JSON-serializable results;
- может быть завершён host при timeout/crash loop;
- не должен хранить authoritative state только в памяти.

Recommended handler lifecycle:

```ts
export function activate(ctx: PiUiExtensionContext) {
  ctx.commands.register('refresh', async (args, signal) => { /* ... */ });
  ctx.renderers.register('renderBuild', async (input, signal) => { /* ... */ });
}
```

Фактическая загрузка может быть реализована через bootstrap worker, но public semantics остаётся такой.

## 11. Rich view protocol

Handshake:

```text
view -> host: piui.view.ready { apiVersion, viewId }
host -> view: piui.view.initialize { theme, locale, capabilities, state }
view -> host: piui.request { id, method, params }
host -> view: piui.response { id, result|error }
host -> view: piui.event { subscriptionId, event }
```

Security:

- exact `event.source`/channel token validation;
- opaque per-instance channel secret;
- no wildcard `postMessage` target where avoidable;
- iframe sandbox without `allow-same-origin` unless isolated custom scheme demands and security review approves;
- navigation blocked; external link requests go to host confirmation/policy;
- downloads blocked by default;
- popups blocked;
- CSP generated host-side;
- clipboard, fullscreen, camera, microphone, geolocation запрещены без future ADR.

Lifecycle:

- `mount`, `visibilityChanged`, `themeChanged`, `dispose`;
- hidden views могут быть suspended;
- crash/timeout заменяется diagnostic fallback;
- state persistence идёт через extension storage API.

## 12. Full shell contract

Shell получает high-level application model и commands:

- project/session listing and selection;
- timeline paging and subscriptions;
- composer state/actions;
- settings navigation;
- extension surfaces;
- window-safe commands.

Shell **не получает**:

- raw process handles;
- unrestricted filesystem;
- secret material;
- updater signing controls;
- permission dialog suppression;
- ability to disable safe mode;
- direct session JSONL write.

Host overlays/shortcuts:

- launch safe mode;
- return to core shell;
- crash recovery;
- permission prompt;
- app quit/force runtime stop;
- critical update integrity error.

Activation flow:

1. package installed globally;
2. manifest validates `ui.shell` and shell entrypoint;
3. user opens Settings → Appearance → Application shell;
4. warning names publisher/source/permissions;
5. host writes trusted shell selection;
6. restart;
7. shell handshake within timeout;
8. on failure, core shell opens with incident banner.

## 13. Discovery и precedence

Sources:

1. Pi global packages/extensions;
2. Pi project-local packages/extensions, only after trust;
3. PiUI built-in packages;
4. optional user-added development package paths.

Precedence не означает silent override. Duplicate extension IDs:

- exact same resolved package/version is deduplicated;
- разные packages с одним ID создают conflict state;
- пользователь выбирает источник или отключает один;
- project package не может подменить trusted global shell по ID.

Manifest parse никогда не исполняет JavaScript. Icons/resources проверяются как files inside package root.

## 14. Enablement и dependency

Extension может указать optional dependencies:

```json
{
  "extensionDependencies": {
    "example.backend": ">=2 <3"
  }
}
```

PiUI проверяет presence/version, но не устанавливает автоматически. В v1 нет marketplace resolver. Backend и UI enablement показываются отдельно:

- Backend enabled by Pi;
- PiUI contributions enabled;
- Rich views permission granted;
- Renderer enabled;
- Shell selected.

Отключение UI renderer не обязано отключать backend tool.

## 15. Versioning

- Manifest `schemaVersion` — major integer; host поддерживает ограниченный набор.
- Host API использует SemVer-like `apiVersion` и capability negotiation.
- Unknown optional contribution игнорируется с warning.
- Unknown required feature в `requires` отключает UI part целиком, backend остаётся доступен.
- Contracts backwards-compatible внутри PiUI major.
- Deprecated API минимум один minor release сообщает warning до удаления в следующем major.
- Extension должен проверять capabilities, а не парсить PiUI version для поведения.

## 16. Development experience

Команды будущего SDK:

```bash
piui extension init
piui extension validate ./piui.manifest.json
piui extension dev ./
piui extension pack
piui extension inspect-permissions
```

Dev mode:

- требует явного включения в Advanced settings;
- показывает persistent banner;
- допускает local package path и hot reload declarative manifest;
- rich view reload не должен перезапускать Pi runtime;
- shell hot reload доступен только в отдельном development window;
- production permission rules по умолчанию сохраняются.

## 17. Generic fallback

Для каждого contribution/render type PiUI имеет fallback:

- tool invocation → имя, args, status, text/JSON result;
- custom entry → namespace/type + JSON inspector;
- missing sidebar view → disabled placeholder в extension diagnostics;
- rich view crash → error card + Open raw data;
- unsupported UiNode → omitted node + validation notice, не весь timeline crash;
- missing command handler → disabled action;
- incompatible manifest → backend-only mode.

Raw payload может содержать чувствительные данные, поэтому inspector открывается по действию и использует redaction/notice.

## 18. Accessibility и localization

- extension label/description должны иметь plain-text fallback;
- icon-only action требует label;
- declarative nodes автоматически получают core focus/navigation semantics;
- rich view отвечает за внутреннюю accessibility и проходит audit для featured packages;
- extension strings могут указывать locale bundles, но default locale обязателен;
- host permission prompts не локализуются extension HTML — только structured strings;
- directionality и reduced motion передаются в view initialization.

## 19. Acceptance criteria SDK

- Backend-only Pi extension работает без manifest.
- Один package одновременно регистрирует Pi tool и PiUI renderer.
- Project-local rich view не исполняется до trust.
- Tier 1 manifest не выполняет JavaScript при discovery.
- Rich view не может вызвать Tauri API напрямую.
- Network request блокируется без grant и approved origin.
- Отключение renderer возвращает generic readable card.
- Duplicate IDs дают conflict, а не silent precedence.
- Shell crash возвращает core shell.
- Safe mode запускается даже при сломанном shell/theme.
- API/schema compatibility проверяется fixtures в CI.
