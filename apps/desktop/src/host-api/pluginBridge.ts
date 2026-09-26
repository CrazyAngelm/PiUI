import {
  PLUGIN_PANEL_LIMITS,
  PLUGIN_PANEL_MARKER,
  PLUGIN_PANEL_METHODS,
  type HostToPanelMessage,
  type PanelErrorCode,
  type PanelMethod,
  type PanelTheme,
} from '../../../../contracts/plugin-panel-v1';
import { PLUGIN_THEME_TOKENS, type PluginPermission, type PluginValue } from '../../../../contracts/piui-plugin-v1';

/**
 * The PiUI side of the plugin panel bridge (`contracts/plugin-panel-v1.ts`),
 * as pure functions the panel frame component uses: every message from a
 * panel is untrusted data, checked for its envelope, channel, size, method,
 * parameters and the plugin's permissions before anything happens.
 */

export type PanelInbound =
  | { kind: 'ready' }
  | { kind: 'request'; id: string; method: PanelMethod; params: unknown }
  /** Answer `id` with an error. */
  | { kind: 'refuse'; id: string; code: PanelErrorCode; message: string }
  /** Not for this bridge (another sender, another channel, malformed). */
  | { kind: 'ignore' };

const ID = /^[A-Za-z0-9_-]+$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the parameters of `method`; returns an error message or undefined. */
export function paramsIssue(method: PanelMethod, params: unknown): string | undefined {
  switch (method) {
    case 'context.get':
    case 'settings.get':
      return params === undefined || params === null ? undefined : 'This method takes no parameters.';
    case 'commands.run':
      return isObject(params) && typeof params.commandId === 'string' && SLUG.test(params.commandId) && Object.keys(params).length === 1
        ? undefined
        : 'commands.run needs { commandId }.';
    case 'settings.set': {
      if (!isObject(params) || !isObject(params.values) || Object.keys(params).length !== 1) return 'settings.set needs { values }.';
      const values = Object.values(params.values);
      return values.every((value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        ? undefined
        : 'Setting values are strings, numbers or booleans.';
    }
    case 'notice.show': {
      if (!isObject(params) || typeof params.message !== 'string') return 'notice.show needs { message }.';
      const { message, level } = params;
      if (message.trim() === '' || [...message].length > PLUGIN_PANEL_LIMITS.noticeChars || CONTROL.test(message)) {
        return 'A notice is 1-500 characters of plain text.';
      }
      if (level !== undefined && level !== 'info' && level !== 'warning' && level !== 'error') return 'The level is info, warning or error.';
      return Object.keys(params).every((key) => key === 'message' || key === 'level') ? undefined : 'notice.show takes { message, level }.';
    }
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

/** Classifies one `message` event's data for the bridge on `channel`. */
export function parsePanelMessage(data: unknown, channel: string | undefined): PanelInbound {
  if (!isObject(data) || data.piui !== PLUGIN_PANEL_MARKER || data.version !== 1) return { kind: 'ignore' };
  if (data.type === 'ready') return { kind: 'ready' };
  if (data.type !== 'request' || channel === undefined || data.channel !== channel) return { kind: 'ignore' };
  const id = data.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > PLUGIN_PANEL_LIMITS.idChars || !ID.test(id)) return { kind: 'ignore' };
  if (encodedSize(data) > PLUGIN_PANEL_LIMITS.messageBytes) {
    return { kind: 'refuse', id, code: 'too-large', message: 'The request is larger than 64 KiB.' };
  }
  const method = data.method;
  if (typeof method !== 'string' || !Object.hasOwn(PLUGIN_PANEL_METHODS, method)) {
    return { kind: 'refuse', id, code: 'unknown-method', message: 'Unknown method.' };
  }
  const issue = paramsIssue(method as PanelMethod, data.params);
  if (issue !== undefined) return { kind: 'refuse', id, code: 'invalid-params', message: issue };
  return { kind: 'request', id, method: method as PanelMethod, params: data.params };
}

/** Whether a plugin with `permissions` may call `method`. */
export function methodPermitted(method: PanelMethod, permissions: readonly PluginPermission[]): boolean {
  return permissions.includes(PLUGIN_PANEL_METHODS[method]);
}

/** At most `limit` requests in any one-second window. */
export class RequestBudget {
  private readonly times: number[] = [];

  constructor(
    private readonly limit: number = PLUGIN_PANEL_LIMITS.requestsPerSecond,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(): boolean {
    const now = this.now();
    while (this.times.length > 0 && now - (this.times[0] ?? 0) >= 1000) this.times.shift();
    if (this.times.length >= this.limit) return false;
    this.times.push(now);
    return true;
  }
}

/** Non-color tokens a panel also receives, so it can match PiUI's type. */
const LAYOUT_TOKENS = ['font-ui', 'font-mono', 'text-sm', 'text-md', 'radius-sm', 'radius-md'] as const;

/** The theme a panel receives: computed design tokens and the appearance. */
export function panelTheme(read: (name: string) => string, appearance: 'dark' | 'light'): PanelTheme {
  const tokens: Record<string, string> = {};
  for (const name of [...PLUGIN_THEME_TOKENS, ...LAYOUT_TOKENS]) {
    const value = read(`--piui-${name}`).trim();
    if (value !== '' && value.length <= 200 && !CONTROL.test(value)) tokens[name] = value;
  }
  return { appearance, tokens };
}

/** The appearance PiUI currently shows (`data-theme`, or the system setting). */
export function currentAppearance(root: HTMLElement, prefersDark: boolean): 'dark' | 'light' {
  const theme = root.dataset.theme;
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

export function envelope<T extends object>(message: T): T & { piui: typeof PLUGIN_PANEL_MARKER; version: 1 } {
  return { piui: PLUGIN_PANEL_MARKER, version: 1, ...message };
}

export type OutboundMessage = HostToPanelMessage;

/** Only the settings a plugin declared, as the host resolved them. */
export function settingsValues(values: Readonly<Record<string, PluginValue>>): Record<string, PluginValue> {
  return { ...values };
}
