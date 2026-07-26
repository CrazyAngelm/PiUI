# 05. PiUI Extension SDK

## 1. Goal

PiUI must continue Pi's philosophy: a minimal core, extended through packages. At the same time, TUI components must not be assumed to transfer automatically to a desktop GUI. Therefore, one package may contain two independent, compatible parts:

- `pi` — backend extensions/resources loaded by Pi;
- `piui` — an optional description of GUI contributions loaded by PiUI.

The absence of `piui` must never prevent a backend extension from working.

## 2. Extensibility tiers

### Tier 0 — Backend-only compatibility

The package contains only a standard Pi extension.

PiUI must:

- allow Pi to load the extension under its standard rules;
- display registered tools and commands if Pi reports them through RPC;
- handle the standard Extension UI Protocol;
- render tool/custom entries using a generic card;
- require no package changes.

This is the default compatibility tier.

### Tier 1 — Declarative contributions

The package contains `piui.manifest.json` but does not execute its own UI JavaScript. The manifest may add:

- commands and command palette entries;
- composer actions;
- status items;
- settings schema;
- project/session context menu actions;
- sidebar or right-panel views from a safe UI node tree;
- tool/message/custom-entry renderers from a UI node tree;
- preview providers returning a safe preview model;
- themes/design tokens in a restricted schema;
- default keybindings.

PiUI creates all elements using its own components. This is the primary and recommended extension path.

### Tier 2 — Sandboxed rich views

The package provides a static web bundle for a complex view. It runs:

- in a sandboxed iframe/WebView without direct Tauri API access;
- with a separate origin or opaque origin;
- without network access by default;
- through a versioned `postMessage` broker;
- with a capability-based host API;
- with a CSP that prohibits inline/eval, except under an explicitly agreed development policy;
- with limits on bundle size, memory, message rate, and payload size.

A rich view is suitable for graphs, specialized inspectors, canvas-based previews, and complex interactive tools.

### Tier 3 — Trusted shell replacement

A package may fully replace the standard PiUI layout if the user explicitly trusts a **globally installed** package as a shell.

Constraints:

- a project-local package cannot become a shell;
- the shell runs in a separate isolated surface and communicates through the same broker;
- it receives no raw Tauri `invoke`, shell, or filesystem API;
- selecting a shell requires a restart and a separate warning;
- an immutable recovery layer remains with the host: safe-mode shortcut/menu, crash screen, permission dialogs, and update integrity prompts;
- on a crash loop, PiUI automatically returns to the core shell;
- only one shell can be active at a time;
- the shell does not change the session format or replace the Pi runtime.

This preserves the requirement for a completely changed interface without granting the extension unrestricted desktop-host privileges.

## 3. Package layout

```text
my-package/
  package.json
  pi/
    extension.ts
  piui.manifest.json
  piui/
    worker.js              # optional
    views/
      graph/index.html     # Tier 2, optional
      graph/assets/*
    icons/*
```

Example `package.json`:

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

PiUI first applies Pi package discovery rules, then looks for the optional `piui.manifest.json`. It does not run `postinstall` or execute package code to read the manifest.

## 4. Manifest

Minimal manifest:

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

The complete JSON Schema is in `contracts/piui-extension-manifest.schema.json`. Manifest validation consists of two mandatory passes:

1. JSON Schema validates shape, types, size constraints, and structural security invariants: an explicit `permissions` array, `ui.shell` matching its shell entrypoint, the `network` origin allowlist, and the `ui.richView` views entrypoint.
2. The host semantic validator validates that contribution IDs belong to the extension namespace, IDs are unique, command/handler/view targets exist, dependency cycles, permitted slots, trust scope, and that actual Host API calls match granted capabilities.

Passing JSON Schema alone does not mean that a package is permitted to activate. A failure in the second pass moves the UI portion to a disabled/backend-only state with diagnostics, without granting it partial access.

### Required fields

- `schemaVersion`: integer major schema number;
- `id`: stable reverse-domain-like ID that does not change between versions;
- `name`: user-facing label;
- `version`: SemVer package version;
- `engines.piui`: compatible PiUI range;
- `contributes`: declarative contributions;
- `permissions`: minimum required capabilities.

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

Entry points resolve only within the package root after canonicalization. `..`, symlink escapes, and remote URLs are prohibited.

## 5. Semantic slots

Extensions specify **meaning**, not pixel coordinates. Supported v1 slots:

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

A manifest does not specify `top: 12px` or a direct selector for the core DOM. The host determines responsive layout, accessibility, and compact mode.

Ordering:

```json
{
  "slot": "composer.actions",
  "order": 200,
  "group": "attachments"
}
```

- lower `order` comes first;
- core reserves the `0–99` range;
- extensions normally use `100–999`;
- equal order is sorted by extension ID;
- an extension cannot hide another extension's contribution.

## 6. Declarative UI node vocabulary

A Tier 1 renderer returns a serializable tree of allowlisted nodes:

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

Raw HTML, arbitrary CSS, inline scripts, DOM event strings, and external image URLs without permission are prohibited. Markdown passes through the PiUI sanitizer; `trusted: true` does not exist in v1.

Limits v1:

- depth ≤ 20;
- nodes ≤ 2,000 per render result;
- total text ≤ 2 MiB;
- table ≤ 1,000 rows before pagination;
- update rate ≤ 30 messages/s per view;
- payloads exceeding the limit are rejected and replaced with a fallback.

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

- `pi-command:<name>` — invokes a command already registered by the backend extension;
- `host:<allowlisted-action>` — only actions explicitly exposed by the SDK;
- `worker:<handler>` — invokes a sandboxed extension worker;
- `view:<viewId>:<message>` — sends an event to a rich view.

A command cannot contain a shell command string.

### 7.2 Composer actions

An action may:

- insert text;
- add a structured attachment reference;
- open a dialog/view;
- invoke a command;
- transform a draft through a worker after `composer.read/write` is granted.

It does not receive draft contents without permission.

### 7.3 Status items

A status item has a short label, tooltip, and command. The host constrains width and moves overflow into a menu. An extension cannot create persistent animation without a running state.

### 7.4 Settings

An extension declares a JSON-like schema with supported controls:

- boolean;
- string/password reference;
- number with min/max;
- enum;
- path picker with a specific access mode;
- keybinding;
- secret reference.

Secrets are stored in the platform credential store and passed to a worker only through an opaque token/approved request. They do not enter regular settings JSON.

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

- exact extension ID + tool name is stronger than a wildcard;
- the user can disable a renderer independently from the backend extension;
- a generic raw view is always available;
- the renderer receives a redacted payload according to permissions;
- the renderer does not change the tool execution result.

### 7.6 Message/custom-entry renderers

The matcher uses a stable type/namespace, not arbitrary text heuristics. If two renderers have the same priority, PiUI chooses the most specific matcher and shows a diagnosable conflict on a tie.

### 7.7 Sidebar/right-panel views

A Tier 1 view returns a UiNode and updates through explicit subscriptions. A Tier 2 view is specified through `viewId`. The right panel may be opened by command; an extension must not force it to remain open after every launch without a user preference.

### 7.8 Preview providers

A provider declares supported URI/MIME and returns:

- text/code preview;
- image resource;
- declarative nodes;
- sandboxed rich view.

It does not associate an executable previewer without separate permission and user action.

### 7.9 Themes

A theme contribution may override only documented semantic tokens:

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

PiUI validates contrast for critical pairs before publication. A theme cannot embed CSS/JS in Tier 1. The user can always return to System/Light/Dark in safe mode.

## 8. Context keys and `when`

PiUI provides a restricted expression language without `eval`:

```text
project.trusted && runtime.ready && editor.hasText
session.running || session.queuedCount > 0
resource.mime == "image/png"
```

`&&`, `||`, `!`, `==`, `!=`, `<`, `>`, parentheses, and membership in a literal list are supported. An unknown key evaluates to false.

Core keys:

- `platform`: `windows|linux|macos`;
- `project.open`, `project.trusted`, `project.hasGit`;
- `session.open`, `session.running`, `session.hasBranches`;
- `runtime.ready`, `runtime.capability.<name>`;
- `composer.hasText`, `composer.hasAttachments`;
- `selection.text` as a boolean, not its contents;
- `view.<id>.visible`;
- `safeMode`.

An extension cannot create a global key under another namespace.

## 9. Host API and permissions

The complete TypeScript contract is `contracts/piui-host-api.d.ts`.

### Permission groups

| Permission | Capabilities |
|---|---|
| `session.read` | metadata/timeline blocks for the current session |
| `session.command` | sending allowlisted Pi/PiUI commands |
| `session.prompt` | send/steer/follow-up after a user-visible action |
| `composer.read` | reading the draft |
| `composer.write` | changing the draft/attachments |
| `project.read` | reading files through a scoped API |
| `project.write` | writing through a scoped API and conflict checks |
| `externalFiles.read` | user-picked external handles |
| `network` | fetch through the host proxy for approved origins |
| `clipboard.read` | only after a user gesture |
| `clipboard.write` | writing to the clipboard |
| `notifications` | system notifications |
| `storage` | namespaced extension storage |
| `secrets` | opaque credential references |
| `ui.richView` | launching a Tier 2 view |
| `ui.shell` | requesting trusted shell activation |

### Permission decisions

Decision scope:

- deny;
- allow once;
- allow for this project;
- allow globally.

Not all permissions allow every scope. `ui.shell` is global only; `externalFiles.read` is normally per handle; `clipboard.read` is per gesture.

A prompt must explain the specific action and extension source. It must not request “full access” as a single indivisible grant.

### Host API principles

- structured inputs/outputs;
- cancellable requests;
- resource handles instead of arbitrary paths;
- origin allowlist for network;
- max payload and rate limits;
- permissions are checked by the host on every call, not only by the UI;
- a view/worker cannot see grants for other extensions;
- the API version is passed during the handshake.

## 10. Worker model

Tier 1 dynamic handlers do not execute in the main UI realm. An extension worker:

- loads as a module worker in an isolated context;
- has no Tauri globals;
- receives `initialize(apiVersion, extensionId, grantedCapabilities)`;
- registers named handlers;
- returns JSON-serializable results;
- may be terminated by the host on timeout/crash loop;
- must not store authoritative state only in memory.

Recommended handler lifecycle:

```ts
export function activate(ctx: PiUiExtensionContext) {
  ctx.commands.register('refresh', async (args, signal) => { /* ... */ });
  ctx.renderers.register('renderBuild', async (input, signal) => { /* ... */ });
}
```

The actual loading may be implemented through a bootstrap worker, but the public semantics remain the same.

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
- iframe sandbox without `allow-same-origin` unless an isolated custom scheme requires it and a security review approves it;
- navigation blocked; external link requests go to host confirmation/policy;
- downloads blocked by default;
- popups blocked;
- CSP generated host-side;
- clipboard, fullscreen, camera, microphone, and geolocation are prohibited without a future ADR.

Lifecycle:

- `mount`, `visibilityChanged`, `themeChanged`, `dispose`;
- hidden views may be suspended;
- crash/timeout is replaced with a diagnostic fallback;
- state persistence goes through the extension storage API.

## 12. Full shell contract

The shell receives a high-level application model and commands:

- project/session listing and selection;
- timeline paging and subscriptions;
- composer state/actions;
- settings navigation;
- extension surfaces;
- window-safe commands.

The shell **does not receive**:

- raw process handles;
- unrestricted filesystem;
- secret material;
- updater signing controls;
- permission dialog suppression;
- the ability to disable safe mode;
- direct session JSONL writing.

Host overlays/shortcuts:

- launch safe mode;
- return to the core shell;
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
8. on failure, core shell opens with an incident banner.

## 13. Discovery and precedence

Sources:

1. Pi global packages/extensions;
2. Pi project-local packages/extensions, only after trust;
3. PiUI built-in packages;
4. optional user-added development package paths.

Precedence does not mean silent override. Duplicate extension IDs:

- an exact same resolved package/version is deduplicated;
- different packages with the same ID create a conflict state;
- the user selects a source or disables one;
- a project package cannot impersonate a trusted global shell by ID.

Manifest parsing never executes JavaScript. Icons/resources are verified as files inside the package root.

## 14. Enablement and dependency

An extension may specify optional dependencies:

```json
{
  "extensionDependencies": {
    "example.backend": ">=2 <3"
  }
}
```

PiUI verifies presence/version but does not install them automatically. There is no marketplace resolver in v1. Backend and UI enablement are displayed separately:

- Backend enabled by Pi;
- PiUI contributions enabled;
- Rich views permission granted;
- Renderer enabled;
- Shell selected.

Disabling a UI renderer does not have to disable the backend tool.

## 15. Versioning

- Manifest `schemaVersion` is a major integer; the host supports a limited set.
- The Host API uses SemVer-like `apiVersion` and capability negotiation.
- An unknown optional contribution is ignored with a warning.
- An unknown required feature in `requires` disables the UI part entirely; the backend remains available.
- Contracts are backwards-compatible within a PiUI major version.
- A deprecated API reports a warning for at least one minor release before removal in the next major version.
- An extension must check capabilities rather than parse the PiUI version for behavior.

## 16. Development experience

Future SDK commands:

```bash
piui extension init
piui extension validate ./piui.manifest.json
piui extension dev ./
piui extension pack
piui extension inspect-permissions
```

Dev mode:

- requires explicit activation in Advanced settings;
- displays a persistent banner;
- allows a local package path and hot reload of a declarative manifest;
- rich view reload must not restart the Pi runtime;
- shell hot reload is available only in a separate development window;
- production permission rules remain in force by default.

## 17. Generic fallback

PiUI has a fallback for every contribution/render type:

- tool invocation → name, args, status, text/JSON result;
- custom entry → namespace/type + JSON inspector;
- missing sidebar view → disabled placeholder in extension diagnostics;
- rich view crash → error card + Open raw data;
- unsupported UiNode → omitted node + validation notice, not an entire timeline crash;
- missing command handler → disabled action;
- incompatible manifest → backend-only mode.

Raw payload may contain sensitive data, so the inspector opens on action and uses redaction/notice.

## 18. Accessibility and localization

- extension label/description must have a plain-text fallback;
- an icon-only action requires a label;
- declarative nodes automatically receive core focus/navigation semantics;
- a rich view is responsible for internal accessibility and passes an audit for featured packages;
- extension strings may specify locale bundles, but a default locale is mandatory;
- host permission prompts are not localized by extension HTML — only by structured strings;
- directionality and reduced motion are passed during view initialization.

## 19. SDK acceptance criteria

- A backend-only Pi extension works without a manifest.
- One package registers both a Pi tool and a PiUI renderer.
- A project-local rich view does not execute before trust.
- A Tier 1 manifest does not execute JavaScript during discovery.
- A rich view cannot invoke the Tauri API directly.
- A network request is blocked without a grant and approved origin.
- Disabling a renderer restores a generic readable card.
- Duplicate IDs produce a conflict, not silent precedence.
- A shell crash returns to the core shell.
- Safe mode launches even with a broken shell/theme.
- API/schema compatibility is checked by fixtures in CI.
