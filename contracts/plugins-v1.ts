/**
 * PiUI plugins host protocol v1 (ADR-032): Settings → Plugins and every
 * surface plugins contribute to.
 *
 * Commands (all reject unknown fields):
 * - `plugins_v1` — list, pick a package (native picker on the host: a folder,
 *   a `.zip`, or an unpacked development folder), install after the trust
 *   review, discard a review, enable/disable, remove, reload a development
 *   plugin, restart a backend, store settings values and the active plugin
 *   theme. Every change names the registry `expectedRevision`.
 * - `plugin_command_v1` — runs one of a plugin's backend commands.
 * - `plugin_template_v1` — reads one pipeline template (a portable system
 *   file v4 the UI validates with the existing parser before import).
 *
 * The WebView never sends a filesystem path: the host opens the picker,
 * validates the package, and returns a review with an opaque `stagingId`.
 * Installing copies the package into PiUI's application data (never into a
 * project). Safe mode lists plugins read-only: nothing is active, nothing
 * runs and every change is refused. Credentials, environment values, plugin
 * output and file contents never cross this boundary except the template
 * text the UI asked for and a command's own result.
 *
 * v1.1 (additive, ADR-032 plugins v2): a backend runs under Node's
 * permission model. `PluginBackendV1.limits` and the review's
 * `backend.limits` say what the Node.js PiUI found enforces, the command
 * line carries the permission flags, and the backend state `unsupported`
 * means that Node.js has no permission model, so PiUI does not start the
 * backend. Older payloads without `limits` stay valid.
 */
import type { CommandLineV1 } from './harness-registry-v1';
import type { PluginFieldV1, PluginPermission, PluginProblemCode, PluginValue } from './piui-plugin-v1';

export const PLUGINS_PROTOCOL = 1 as const;
/** Emitted after any registry, verification or backend change; payload `PluginsChangedV1`. */
export const PLUGINS_EVENT_V1 = 'piui://plugins-v1' as const;

export interface PluginsChangedV1 {
  protocol: 1;
  revision: number;
}

export type PluginSource = 'installed' | 'development';

/**
 * `stopped`: starts on first use. `crashed`: stopped unexpectedly; the next
 * use restarts it after a backoff. `crash-loop`: five crashes within ten
 * minutes; it stays stopped until restarted from Settings. `unavailable`:
 * Node.js was not found. `unsupported` (v1.1): Node.js has no permission
 * model (older than 22.13), so the backend is not started. A plugin without
 * a backend has no `backend` entry.
 */
export type PluginBackendState = 'stopped' | 'starting' | 'running' | 'crashed' | 'crash-loop' | 'unavailable' | 'unsupported';

/**
 * What Node's permission model enforces for a backend with the Node.js PiUI
 * found (v1.1). A backend reads its package, reads and writes its own data
 * folder and, with `project.read` / `project.write`, the project folders of
 * the requests it gets; it never starts other programs, worker threads,
 * native add-ons or WASI. Node documents that its permission model is not a
 * security boundary against deliberately malicious code: this is a limit on
 * trusted code, not a sandbox.
 */
export interface PluginBackendLimitsV1 {
  /** `node --version`, for example `v24.13.0`. */
  nodeVersion: string;
  /** Files, other programs and worker threads are limited. False: PiUI does not start the backend. */
  enforced: boolean;
  /** Network access is blocked unless the plugin asks for `network`. False: this Node.js cannot block it. */
  network: boolean;
}

/** A fixed English locale key; `{0}` is replaced with `subject`. */
export interface PluginProblemV1 {
  code: PluginProblemCode;
  message: string;
  subject?: string;
  /** A second fixed locale key with the specific rule, when there is one. */
  detail?: string;
}

export interface PluginCommandV1 {
  id: string;
  title: string;
  description?: string;
  surfaces: ('palette' | 'composer')[];
  /** Declarative command text; absent: the backend runs it (`plugin_command_v1`). */
  insertText?: string;
}

export interface PluginPanelV1 {
  id: string;
  title: string;
  location: 'chat-details';
  /** The sandboxed frame source on the plugin protocol origin; absent while the plugin is inactive. */
  url?: string;
}

export interface PluginThemeV1 {
  id: string;
  label: string;
  appearance: 'dark' | 'light';
  /** Validated color token overrides (`--piui-<name>`). */
  tokens: Record<string, string>;
}

export interface PluginTemplateV1 {
  id: string;
  title: string;
  description?: string;
}

export interface PluginNodeTypeV1 {
  id: string;
  title: string;
  description?: string;
  config: PluginFieldV1[];
  timeoutSeconds: number;
  resultFields: { name: string; kind: 'text' | 'number' | 'boolean' | 'text-list' }[];
}

export interface PluginAcpAgentV1 {
  id: string;
  displayName: string;
  /** False when another agent already uses the id; the plugin's agent is not added. */
  registered: boolean;
}

export type PluginLogEvent =
  | 'installed'
  | 'updated'
  | 'enabled'
  | 'disabled'
  | 'reloaded'
  | 'verification-failed'
  | 'backend-started'
  | 'backend-stopped'
  | 'backend-crashed'
  | 'backend-timeout'
  | 'backend-protocol'
  | 'backend-start-failed'
  | 'crash-loop';

/** Metadata only: never plugin output, arguments or file contents. */
export interface PluginLogEntryV1 {
  at: string;
  event: PluginLogEvent;
}

export interface PluginBackendV1 {
  state: PluginBackendState;
  /** Restarts after crashes in this host process. */
  restarts: number;
  /** The exact command line PiUI starts (never a shell). */
  commandLine: CommandLineV1;
  /** False when Node.js was not found; `commandLine.program` is then `node`. */
  nodeFound: boolean;
  /** v1.1: absent until PiUI asked Node.js (never on the first-paint path). */
  limits?: PluginBackendLimitsV1;
}

export interface PluginEntryV1 {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description?: string;
  source: PluginSource;
  /** Development plugins: the folder they run from (display only). */
  folder?: string;
  enabled: boolean;
  /** Enabled, verified, compatible and outside safe mode: its contributions apply. */
  active: boolean;
  /** The permissions the user trusted. */
  permissions: PluginPermission[];
  /** SHA-256 over every file of the package (paths and contents). */
  codeHash: string;
  installedAt: string;
  backend?: PluginBackendV1;
  problems: PluginProblemV1[];
  log: PluginLogEntryV1[];
  contributes: {
    commands: PluginCommandV1[];
    settings: PluginFieldV1[];
    panels: PluginPanelV1[];
    themes: PluginThemeV1[];
    templates: PluginTemplateV1[];
    nodeTypes: PluginNodeTypeV1[];
    acpAgents: PluginAcpAgentV1[];
  };
  /** Current values with declared defaults applied. */
  settings: Record<string, PluginValue>;
}

export interface PluginThemeRefV1 {
  pluginId: string;
  themeId: string;
}

export interface PluginsRegistryV1 {
  protocol: 1;
  /** Registry document revision; every change names it (`expectedRevision`). */
  revision: number;
  safeMode: boolean;
  /** Installed packages were verified against their trusted hashes in this host process. */
  checked: boolean;
  piuiVersion: string;
  activeTheme?: PluginThemeRefV1;
  plugins: PluginEntryV1[];
}

/** What an update changes compared with the installed plugin. */
export interface PluginChangeV1 {
  fromVersion: string;
  permissionsAdded: PluginPermission[];
  permissionsRemoved: PluginPermission[];
  codeChanged: boolean;
}

/** A validated package waiting for the user's trust decision. */
export interface PluginReviewV1 {
  stagingId: string;
  source: 'folder' | 'zip' | 'development';
  /** The chosen folder or archive (display only). */
  location: string;
  id: string;
  name: string;
  version: string;
  publisher: string;
  description?: string;
  permissions: PluginPermission[];
  backend?: { commandLine: CommandLineV1; nodeFound: boolean; limits?: PluginBackendLimitsV1 };
  codeHash: string;
  files: number;
  bytes: number;
  contributes: {
    commands: string[];
    settings: number;
    panels: string[];
    themes: string[];
    templates: string[];
    nodeTypes: string[];
    /** Each still needs its own command-line trust in Settings → Harnesses. */
    acpAgents: { id: string; displayName: string; commandLine: CommandLineV1 }[];
  };
  update?: PluginChangeV1;
  /** The same id, version and code are installed already: nothing to do. */
  alreadyInstalled: boolean;
}

export type PluginsCommandV1 =
  | { type: 'list' }
  | { type: 'pick'; source: 'folder' | 'zip' | 'development' }
  | { type: 'install'; expectedRevision: number; stagingId: string; codeHash: string }
  | { type: 'discard'; stagingId: string }
  | { type: 'setEnabled'; expectedRevision: number; id: string; enabled: boolean }
  | { type: 'remove'; expectedRevision: number; id: string }
  | { type: 'reload'; expectedRevision: number; id: string }
  | { type: 'restartBackend'; id: string }
  | { type: 'setSettings'; expectedRevision: number; id: string; values: Record<string, PluginValue>; origin?: 'settings' | 'panel' }
  | { type: 'setTheme'; expectedRevision: number; theme: PluginThemeRefV1 | null };

export interface PluginsResponseV1 {
  registry: PluginsRegistryV1;
  /** `pick` and `reload`: the review to confirm; null when the picker was cancelled. */
  review?: PluginReviewV1 | null;
}

export interface PluginCommandRequestV1 {
  pluginId: string;
  commandId: string;
  /** The chat the command runs for; its title reaches the backend only with `chat.read`. */
  sessionId?: string;
  origin: 'palette' | 'composer' | 'panel';
}

/** `text` is prepared in the message box for review (never sent); `notice` is shown once. */
export interface PluginCommandResultV1 {
  protocol: 1;
  text?: string;
  notice?: string;
}

export interface PluginTemplateRequestV1 {
  pluginId: string;
  templateId: string;
}

export interface PluginTemplateResultV1 {
  protocol: 1;
  text: string;
}

export type PluginsErrorCode =
  | 'SAFE_MODE'
  | 'CONFLICT'
  | 'INVALID_PACKAGE'
  | 'INCOMPATIBLE'
  | 'DUPLICATE'
  | 'NOT_FOUND'
  | 'REVIEW_EXPIRED'
  | 'TRUST_CHANGED'
  | 'INACTIVE'
  | 'PERMISSION_DENIED'
  | 'INVALID_SETTINGS'
  | 'BACKEND_UNAVAILABLE'
  | 'BACKEND_FAILED'
  | 'BACKEND_TIMEOUT'
  | 'LIMIT'
  | 'IO_ERROR';

export interface PluginsErrorV1 {
  code: PluginsErrorCode;
  /** Fixed English locale key. */
  message: string;
  recoverable: boolean;
  /** `INVALID_PACKAGE`: every rule the package fails. */
  problems?: PluginProblemV1[];
  /** `BACKEND_FAILED`: the plugin's own error message (plain text, at most 2 KiB). */
  detail?: string;
}
