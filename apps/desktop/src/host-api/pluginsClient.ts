import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import {
  PLUGINS_EVENT_V1,
  PLUGINS_PROTOCOL,
  type PluginCommandRequestV1,
  type PluginCommandResultV1,
  type PluginProblemV1,
  type PluginsChangedV1,
  type PluginsCommandV1,
  type PluginsErrorCode,
  type PluginsRegistryV1,
  type PluginsResponseV1,
  type PluginTemplateRequestV1,
  type PluginTemplateResultV1,
} from '../../../../contracts/plugins-v1';

/**
 * Typed client for plugins v1 (`contracts/plugins-v1.ts`, ADR-032). The
 * WebView never sends a path: `pick` asks the host to open its native
 * picker. Host messages are fixed English locale keys; anything unexpected
 * becomes a generic, translatable failure. A plugin's own error text only
 * arrives as `detail` of `BACKEND_FAILED`, bounded and without control
 * characters.
 */
const CODES: ReadonlySet<string> = new Set<PluginsErrorCode>([
  'SAFE_MODE', 'CONFLICT', 'INVALID_PACKAGE', 'INCOMPATIBLE', 'DUPLICATE', 'NOT_FOUND', 'REVIEW_EXPIRED',
  'TRUST_CHANGED', 'INACTIVE', 'PERMISSION_DENIED', 'INVALID_SETTINGS', 'BACKEND_UNAVAILABLE', 'BACKEND_FAILED',
  'BACKEND_TIMEOUT', 'LIMIT', 'IO_ERROR',
]);

const UNAVAILABLE_MESSAGE = 'PiUI could not read the plugin list.';
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type PluginsFailureCode = PluginsErrorCode | 'UNAVAILABLE';

export class PluginsError extends Error {
  constructor(
    readonly code: PluginsFailureCode,
    message: string,
    readonly problems: readonly PluginProblemV1[] = [],
    readonly detail: string | undefined = undefined,
  ) {
    super(message);
    this.name = 'PluginsError';
  }
}

const plainText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length <= limit && !CONTROL.test(value);

function problems(value: unknown): PluginProblemV1[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is PluginProblemV1 => typeof item === 'object' && item !== null && typeof item.code === 'string' && plainText(item.message, 300))
    .slice(0, 20);
}

export function pluginsError(cause: unknown): PluginsError {
  if (cause instanceof PluginsError) return cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' && CODES.has(cause.code)) {
    const record = cause as { code: PluginsErrorCode; message?: unknown; problems?: unknown; detail?: unknown };
    const message = plainText(record.message, 300) ? record.message : UNAVAILABLE_MESSAGE;
    const detail = typeof record.detail === 'string' ? record.detail.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 2048) : undefined;
    return new PluginsError(record.code, message, problems(record.problems), detail);
  }
  return new PluginsError('UNAVAILABLE', UNAVAILABLE_MESSAGE);
}

function isRegistry(value: unknown): value is PluginsRegistryV1 {
  if (typeof value !== 'object' || value === null) return false;
  const registry = value as Partial<PluginsRegistryV1>;
  return registry.protocol === PLUGINS_PROTOCOL
    && typeof registry.revision === 'number' && Number.isSafeInteger(registry.revision) && registry.revision >= 0
    && typeof registry.safeMode === 'boolean'
    && typeof registry.checked === 'boolean'
    && typeof registry.piuiVersion === 'string'
    && Array.isArray(registry.plugins);
}

function isResponse(value: unknown): value is PluginsResponseV1 {
  return typeof value === 'object' && value !== null && isRegistry((value as PluginsResponseV1).registry);
}

function isChange(value: unknown): value is PluginsChangedV1 {
  if (typeof value !== 'object' || value === null) return false;
  const change = value as Partial<PluginsChangedV1>;
  return change.protocol === PLUGINS_PROTOCOL && typeof change.revision === 'number' && Number.isSafeInteger(change.revision);
}

export interface PluginsClient {
  run(command: PluginsCommandV1): Promise<PluginsResponseV1>;
  runCommand(request: PluginCommandRequestV1): Promise<PluginCommandResultV1>;
  template(request: PluginTemplateRequestV1): Promise<string>;
  /** The registry, verification or a backend changed: list again. */
  listen(handler: (change: PluginsChangedV1) => void): Promise<() => void>;
}

export function createPluginsClient(invoke: HostInvoke, listen: HostListen): PluginsClient {
  return {
    async run(command) {
      let result: unknown;
      try {
        result = await invoke<unknown>('plugins_v1', { command });
      } catch (error) {
        throw pluginsError(error);
      }
      if (!isResponse(result)) throw new PluginsError('UNAVAILABLE', UNAVAILABLE_MESSAGE);
      return result;
    },
    async runCommand(request) {
      let result: unknown;
      try {
        result = await invoke<unknown>('plugin_command_v1', { request });
      } catch (error) {
        throw pluginsError(error);
      }
      const value = result as Partial<PluginCommandResultV1> | null;
      if (!value || value.protocol !== PLUGINS_PROTOCOL) throw new PluginsError('UNAVAILABLE', UNAVAILABLE_MESSAGE);
      return {
        protocol: 1,
        ...(typeof value.text === 'string' ? { text: value.text } : {}),
        ...(typeof value.notice === 'string' ? { notice: value.notice } : {}),
      };
    },
    async template(request) {
      let result: unknown;
      try {
        result = await invoke<unknown>('plugin_template_v1', { request });
      } catch (error) {
        throw pluginsError(error);
      }
      const value = result as Partial<PluginTemplateResultV1> | null;
      if (!value || value.protocol !== PLUGINS_PROTOCOL || typeof value.text !== 'string') throw new PluginsError('UNAVAILABLE', UNAVAILABLE_MESSAGE);
      return value.text;
    },
    listen(handler) {
      return listen<unknown>(PLUGINS_EVENT_V1, (payload) => {
        if (isChange(payload)) handler(payload);
      });
    },
  };
}

export const pluginsHost: PluginsClient = createPluginsClient(hostInvoke, hostListen);
