# PiUI plugins

Plugins add commands, chat panels, settings, themes, pipeline templates,
pipeline node types and ACP agents to PiUI. This guide is for plugin authors;
the design and its limits are ADR-032 (`docs/10_ADR.md`), and the normative
contracts are in `contracts/`:

| Contract | What it defines |
|---|---|
| `piui-plugin-v1.schema.json`, `piui-plugin-v1.ts` | The `piui-plugin.json` manifest |
| `plugin-backend-v1.ts` | JSON-RPC between PiUI and a plugin backend |
| `plugin-panel-v1.ts` | `postMessage` bridge between PiUI and a panel |
| `plugins-v1.ts` | What Settings → Plugins and the other screens receive from the host |

**A plugin is not a sandbox.** A backend runs on your computer with your
account's access to files and the network. PiUI shows every permission before
install, starts only the exact command line it shows, contains the whole
process tree, passes no API keys or tokens and stops the backend when the
plugin is disabled, removed or PiUI quits — but it does not restrict what the
backend reads, writes or connects to. Panels are different: they run
isolated (see [Panels](#panels)).

## Quick start

```bash
pnpm create-plugin ../my-plugin --id acme.my-plugin --panel   # a manifest, a backend and a panel
pnpm plugin:check ../my-plugin                               # the app's own rules, and the code hash
```

Then in PiUI: Settings → Plugins → **Load unpacked…**, choose the folder,
read the review and choose **Load for development**. Edit your code and click
**Reload**; a change to the permissions or the backend entry asks for a new
review. When it is ready, zip the folder (or share it) and install it with
**Install from folder…** or **Install from .zip…**, which copies it into
PiUI's application data.

`create-plugin` options: `--id <id>`, `--name <name>`, `--panel` (adds a
panel), `--no-backend` (declarative commands only). Nothing is installed or
run by either command.

Examples in `examples/plugins/`:

- `hello-command` — a backend command, a declared composer action, settings
  and a sandboxed chat panel;
- `midnight-theme` — two color themes, no code and no permissions;
- `pipeline-pack` — two pipeline templates and a JSON transform node;
- `acp-agent` — adds OpenCode as an ACP agent.

## Package

```
my-plugin/
  piui-plugin.json        required, at the top of the package
  backend/main.mjs        optional: backend.entry (.mjs, .cjs or .js)
  ui/index.html           optional: ui.entry; its folder is all a panel can load
  templates/*.piui.json   optional: pipeline templates (system files, version 4)
```

Limits: 20 MiB in total, 8 MiB per file, 2000 files, 16 folder levels.
Links, junctions, reserved Windows names and paths that differ only in letter
case are rejected. A `.zip` may wrap everything in one top folder; it must
not be encrypted, split, ZIP64 or use compression other than deflate.
`.git`, `.hg` and `.svn` folders are skipped. PiUI computes a code hash over
every file; the review shows it and PiUI checks it again at every start.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "acme.word-count",
  "name": "Word count",
  "version": "1.2.0",
  "publisher": "Acme",
  "description": "Counts words in the open chat.",
  "engines": { "piui": ">=0.1.0 <1.0.0" },
  "permissions": ["commands", "chat.read"],
  "backend": { "entry": "backend/main.mjs" },
  "contributes": {
    "commands": [{ "id": "count", "title": "Count words", "surfaces": ["palette", "composer"] }]
  }
}
```

| Field | Rules |
|---|---|
| `schemaVersion` | `1` |
| `id` | Lowercase segments of letters, digits and inner hyphens joined by dots (`acme.word-count`), at most 100 characters. It never changes between versions. |
| `name`, `publisher` | 1–64 characters, no control characters |
| `version` | `MAJOR.MINOR.PATCH` with an optional pre-release |
| `engines.piui` | Space-separated comparators that must all match: `>=`, `>`, `<=`, `<`, `=`, `^`, `~` |
| `permissions` | See below. A contribution without its permission is an error. |
| `backend.entry`, `ui.entry` | A file inside the package, forward slashes, no `.` or `..` |
| `contributes` | `commands`, `settings`, `panels`, `themes`, `templates`, `nodeTypes`, `acpAgents` |

Unknown fields are errors, never ignored. The `$schema` field may point at
`piui-plugin-v1.schema.json` for editor completion.

### Permissions

| Permission | Allows | Enforced by PiUI |
|---|---|---|
| `commands` | Commands in Ctrl+K and above the message box | Yes |
| `ui.panel` | Panels in the chat details | Yes (panels without it are not shown) |
| `ui.settings` | A settings form; panels may read and store the values | Yes |
| `node.run` | Pipeline node types | Yes |
| `acp.agents` | ACP agents in Settings → Harnesses | Yes |
| `chat.read` | The open chat's id and title (never its messages) | Yes |
| `notifications` | Short notices from a panel | Yes |
| `project.read` | The backend receives the chat's or run's project path | Declared only |
| `project.write` | The same path, stating that files may change | Declared only |
| `network` | States that the backend uses the network | Declared only |

"Declared only" means the permission is shown in the review and changes what
PiUI passes to the backend, but PiUI does not stop a backend from reading
files or opening connections. Ask only for what you need.

## Contributions

### Commands

```json
{ "id": "count", "title": "Count words", "description": "…", "surfaces": ["palette", "composer"] }
{ "id": "thanks", "title": "Thank the agent", "surfaces": ["composer"], "insertText": "Thanks!" }
```

`surfaces` defaults to `["palette"]`. A command with `insertText` needs no
backend. Otherwise PiUI calls the backend's `command/execute`; its `text` is
put in the chat's message box (an empty box takes it, a draft is kept) for
the person to review, and its `notice` is shown once. Nothing is ever sent
automatically.

### Settings

A list of fields PiUI renders as a form and validates on every change, in the
UI and again in the host:

| `type` | Value | Options |
|---|---|---|
| `text`, `long-text` | string | `maxLength` 1–4000 (default 1000 / 4000) |
| `number` | number | `minimum`, `maximum` |
| `boolean` | boolean | — |
| `choice` | string | `options: [{ value, label }]` |

Every field has `key` (`^[a-z][A-Za-z0-9_]{0,63}$`), `label`, and optional
`description`, `required` and `default`. Values are at most 64 KiB in total.
PiUI stores them and passes them to the backend (`initialize` and
`settings/changed`); do not ask for passwords or API keys.

### Themes

```json
{ "id": "midnight", "label": "Midnight", "appearance": "dark", "tokens": { "bg": "#0f1420", "text": "#e6ecf5" } }
```

Only the color tokens listed in `PLUGIN_THEME_TOKENS`
(`contracts/piui-plugin-v1.ts`) can be set, with `#rgb`, `#rgba`,
`#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` values. When a theme sets both colors of
one of the pairs text/bg, text/surface-1, text-muted/bg, action-ink/action
or accent-ink/accent, they must keep a contrast of at least 4.5:1. A theme
is chosen in Settings → General and applies only while PiUI shows its
appearance; Light, Dark and System always win.

### Pipeline templates

```json
{ "id": "review", "title": "Draft and critique", "description": "…", "file": "templates/review.piui.json" }
```

A template is a portable system file, version 4 (`docs/SYSTEM_FILES.md`),
at most 1 MiB, checked against the schema at install. It appears next to the
built-in templates of an empty pipeline and opens through the normal import
as a new unsaved draft: nothing runs until the person saves and starts it.

### Pipeline node types

```json
{
  "id": "json-transform",
  "title": "JSON transform",
  "config": [{ "key": "pick", "label": "Keep fields", "type": "text" }],
  "timeoutSeconds": 10,
  "resultFields": [{ "name": "summary", "kind": "text" }]
}
```

Requires `node.run` and a backend. The pipeline editor lists the node type in
its Add menu and builds the inspector form from `config` (the same field
rules as settings, at most 30 fields). `resultFields` are the fields a new
node starts with; the person can change them. When a run reaches the node,
PiUI admits it only in a trusted project outside safe mode, while the plugin
is active and still declares the node type, and after the configuration
passes the fields. The backend's `node/run` receives the same document a
script step reads on stdin plus the configuration (see
[Backend](#backend)) and returns text or one JSON object, checked against
the node's result fields exactly like a script's output. `timeoutSeconds`
is 1–3600 (default 60); a timeout stops the backend.

A plugin node is host work: it is not a team member, takes no input
mappings (it receives every dependency result) and cannot be a router or
the orchestrator. Failure codes: `plugin-unavailable`,
`plugin-config-invalid`, `plugin-input-unavailable`, `plugin-start-failed`
(nothing ran), `plugin-node-failed` (your error message is the detail) and
`plugin-node-timeout`. If the backend stops while a node runs, the step
becomes uncertain and is never repeated automatically.

### ACP agents

`acpAgents` holds ACP descriptors in the format of Settings → Harnesses
(`contracts/harness-registry-v1.ts`, ADR-034). With `acp.agents` they appear
there as coming from your plugin, and each one still needs the person's
trust in its exact command line before it runs. An id another agent already
uses is not added. The agent is removed with the plugin.

### Panels

```json
"ui": { "entry": "ui/index.html" },
"contributes": { "panels": [{ "id": "main", "title": "My panel", "location": "chat-details" }] }
```

Requires `ui.panel`. The page is shown in the chat details inside a frame
with `sandbox="allow-scripts"`, served from
`http://piui-plugin.localhost/<plugin id>/…` (Windows) or
`piui-plugin://localhost/<plugin id>/…`. It has an opaque origin and this
policy:

```
default-src 'none'; script-src <ui folder>; style-src <ui folder>; img-src <ui folder> data:;
font-src <ui folder>; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none';
worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts
```

So: code and styles live in files in the entry's folder (no inline scripts or
`style` attributes), no network, no storage shared with PiUI, no Tauri API,
no navigation, forms or popups. Everything goes through `piui-panel.js`
(`create-plugin --panel` copies it):

```js
const panel = window.piuiPanel;
const init = await panel.ready;           // plugin, panel, permissions, theme, locale
const { chat } = await panel.getContext();   // chat.read
await panel.runCommand('count');             // commands: your own commands only
const values = await panel.getSettings();    // ui.settings
await panel.setSettings({ greeting: 'Hi' }); // ui.settings, validated by PiUI
await panel.showNotice('Saved');             // notifications
panel.on('theme', (theme) => {});            // tokens also arrive as --piui-* CSS variables
panel.on('context', (context) => {});        // the open chat changed (chat.read)
```

A request without its permission, over 64 KiB, beyond 20 per second or with
wrong parameters is answered with an error. A panel that does not announce
itself within 10 seconds is replaced with a message and a Reload button; the
chat is not affected.

## Backend

PiUI starts `node <backend.entry>` from the package folder the first time a
command or node needs it, with a minimal environment (`PATH`, temp folders,
home and locale variables; no API keys, tokens, `NODE_OPTIONS` or PiUI
variables). Use the helper `create-plugin` copies:

```js
import { PluginError, startPluginBackend } from './piui-plugin-backend.mjs';

startPluginBackend({
  commands: {
    count: ({ context, settings }) => ({ notice: `Open chat: ${context.chat?.title ?? 'none'}` }),
  },
  nodes: {
    'json-transform': ({ config, inputs, dependencies, step, run, project }) => ({ summary: '…' }),
  },
  onSettingsChanged: (settings) => {},
});
```

The protocol (`contracts/plugin-backend-v1.ts`) is JSON-RPC 2.0 over stdio,
one JSON object per line delimited only by LF, at most 1 MiB per line.
**stdout is the protocol**: log to stderr (the helper redirects
`console.log`); PiUI discards stderr and never logs plugin output.

| Method | When | Result |
|---|---|---|
| `initialize` | First, within 15 s: plugin id and version, trusted permissions, settings, a private `dataDir` | `{ protocol: 1 }` |
| `command/execute` | A command without `insertText`, within 30 s; `context.chat` with `chat.read`, `context.project` with a project permission | `{ text?, notice? }` (text ≤ 16 KiB, notice ≤ 500 characters) |
| `node/run` | A node step, within the node type's timeout: `nodeType`, `config`, `inputs`, `dependencies` (`{ text, data }` per step), `step`, `run`, `project?` | `{ output: string \| object }` (≤ 256 KiB) |
| `settings/changed` | Notification after the values change | — |
| `shutdown` | Before PiUI stops the backend; then the process tree is killed after 2 s | `{}` |

Throw `PluginError` (or answer a JSON-RPC error) to fail a command or node;
its message (at most 2 KiB) is shown to the person. A backend does not send
requests in v1: any other message stops it. A timeout stops it. A crash
restarts it on the next use after 1, 2, 4 … 60 seconds; after five crashes in
ten minutes it stays stopped until the person clicks **Restart backend**.
Disable, remove, reload and quit stop the whole process tree.

Keep your own files in `dataDir`. With `project.read`/`project.write` you
receive the project path for chats and runs in project folders.

## Install, trust and updates

1. **Pick.** PiUI's own file dialog chooses the folder or `.zip`; the web
   view never sees or sends a path.
2. **Review.** PiUI validates the package without running it and shows the
   publisher, version, every permission in plain words, the exact backend
   command line, what it adds and its code hash. For an update it marks new
   permissions, lists removed ones and says whether the code changed.
3. **Install.** Only after **Install and enable** does PiUI copy exactly the
   reviewed package into its application data (never into a project).
4. **Start-up.** PiUI checks every installed package against the code hash
   you trusted, the permissions and the `engines.piui` range. A plugin that
   fails stays listed with its problem and does nothing.

Removing a plugin deletes its installed copy and settings (a development
folder is left untouched). In safe mode plugins are listed but none is
active and nothing can be changed.

## Troubleshooting

- `pnpm plugin:check <dir>` reports the same problems as the review.
- Settings → Plugins → a plugin → **Permissions and backend** shows the
  backend state, the command line, the code hash and recent events (metadata
  only).
- "Node.js was not found": install Node.js; PiUI finds it like the harness
  bridges do (`PIUI_NODE`, then `PATH`).
- A panel that stays blank or is replaced by the fallback usually uses an
  inline script, a `style` attribute or a file outside its UI folder, or
  loads `piui-panel.js` after its own script: its policy blocks the first
  three, and PiUI waits 10 seconds for the panel to announce itself.
