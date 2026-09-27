/**
 * Plugin panel bridge v1 (ADR-032): `postMessage` between PiUI and a plugin
 * panel.
 *
 * A panel is the plugin's static `ui.entry` page, served by the host on the
 * plugin protocol origin (`http://piui-plugin.localhost/<plugin id>/…` on
 * Windows, `piui-plugin://localhost/<plugin id>/…` elsewhere) and framed with
 * `sandbox="allow-scripts"`: an opaque origin with no same-origin access, top
 * navigation, forms, popups or downloads. Its response CSP allows scripts,
 * styles, images and fonts only from the plugin's own folder and no
 * connections, frames or workers. It has no Tauri API: every capability is a
 * request PiUI answers after checking the plugin's permissions.
 *
 * Handshake: the panel posts `ready`; PiUI answers `init` with a fresh
 * `channel` id, then accepts `request`s carrying that channel from exactly
 * that frame's window and answers each with one `response`. PiUI pushes
 * `event`s for theme and chat changes. Messages over `messageBytes`, unknown
 * types or methods, missing permissions and bursts over `requestsPerSecond`
 * get an error response (or are ignored before `ready`). A panel that sends
 * no `ready` within `readyTimeoutMs` is replaced with a generic fallback.
 */
import type { PluginPermission, PluginValue } from './piui-plugin-v2';

export const PLUGIN_PANEL_PROTOCOL = 1 as const;
/** The `piui` marker every bridge message carries. */
export const PLUGIN_PANEL_MARKER = 'piui-panel' as const;

export const PLUGIN_PANEL_LIMITS = {
  messageBytes: 64 * 1024,
  requestsPerSecond: 20,
  idChars: 64,
  noticeChars: 500,
  readyTimeoutMs: 10_000,
} as const;

/** Each method and the permission it needs. */
export const PLUGIN_PANEL_METHODS = {
  'context.get': 'chat.read',
  'commands.run': 'commands',
  'settings.get': 'ui.settings',
  'settings.set': 'ui.settings',
  'notice.show': 'notifications',
} as const satisfies Record<string, PluginPermission>;
export type PanelMethod = keyof typeof PLUGIN_PANEL_METHODS;

export type PanelErrorCode = 'permission-denied' | 'unknown-method' | 'invalid-params' | 'rate-limited' | 'too-large' | 'failed';

export interface PanelTheme {
  appearance: 'dark' | 'light';
  /** Computed design tokens by name without the `--piui-` prefix (colors, fonts, radii). */
  tokens: Record<string, string>;
}

export interface PanelChatContext {
  chat: { id: string; title: string } | null;
}

interface Envelope {
  piui: typeof PLUGIN_PANEL_MARKER;
  version: 1;
}

/** Panel → PiUI. */
export type PanelToHostMessage =
  | (Envelope & { type: 'ready' })
  | (Envelope & { type: 'request'; channel: string; id: string; method: PanelMethod; params?: unknown });

/** PiUI → panel. */
export type HostToPanelMessage =
  | (Envelope & {
      type: 'init';
      channel: string;
      plugin: { id: string; name: string };
      panel: { id: string; title: string };
      permissions: PluginPermission[];
      theme: PanelTheme;
      locale: 'en' | 'ru';
    })
  | (Envelope & { type: 'response'; channel: string; id: string; result: unknown })
  | (Envelope & { type: 'response'; channel: string; id: string; error: { code: PanelErrorCode; message: string } })
  | (Envelope & { type: 'event'; channel: string; event: 'theme'; data: PanelTheme })
  | (Envelope & { type: 'event'; channel: string; event: 'context'; data: PanelChatContext });

/** Request parameters and results per method. */
export interface PanelMethodsV1 {
  'context.get': { params: undefined; result: PanelChatContext };
  /** The plugin's own command; its text is prepared in the chat's message box for review. */
  'commands.run': { params: { commandId: string }; result: { text?: string; notice?: string } };
  'settings.get': { params: undefined; result: Record<string, PluginValue> };
  /** Replaces the values it names; validated like the Settings form. */
  'settings.set': { params: { values: Record<string, PluginValue> }; result: Record<string, PluginValue> };
  'notice.show': { params: { message: string; level?: 'info' | 'warning' | 'error' }; result: null };
}
