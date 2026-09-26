import { hostInvoke } from './transport';
import type {
  BackgroundErrorCode,
  BackgroundHostCommandsV1,
  BackgroundSettingsV1,
  BackgroundUpdateRequest,
  TrayLabelsV1,
} from '../../../../contracts/background-v1';

export type * from '../../../../contracts/background-v1';

/**
 * Background mode (contract background-v1): keep running in the tray and
 * start at sign-in. The host applies every change; the WebView holds no
 * tray, autostart or OS permission.
 */
export interface BackgroundClient {
  settings(): Promise<BackgroundSettingsV1>;
  update(change: BackgroundUpdateRequest): Promise<BackgroundSettingsV1>;
  trayLabels(labels: TrayLabelsV1): Promise<void>;
}

export type BackgroundRoute = keyof BackgroundHostCommandsV1;
export type BackgroundRequest = Parameters<BackgroundHostCommandsV1[BackgroundRoute]>[0];
export type BackgroundInvoke = <T>(route: BackgroundRoute, args: { request: BackgroundRequest }) => Promise<T>;
export type BackgroundErrorKind = BackgroundErrorCode | 'unknown';

const ERROR_COPY: Readonly<Record<BackgroundErrorKind, string>> = {
  invalid: 'This change could not be applied. Nothing was changed.',
  'read-only': 'Safe mode keeps background settings read-only.',
  unavailable: 'This option is not available on this computer right now.',
  io: 'The setting could not be saved. Nothing was changed.',
  unknown: 'The setting could not be changed. Nothing was changed.',
};

export class BackgroundOperationError extends Error {
  constructor(readonly code: BackgroundErrorKind) {
    super(ERROR_COPY[code]);
    this.name = 'BackgroundOperationError';
  }
}

/** Known codes only; host details never reach the UI. */
export function backgroundError(cause: unknown): BackgroundOperationError {
  if (cause instanceof BackgroundOperationError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { value = undefined; }
  }
  const code = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    && Object.hasOwn(ERROR_COPY, value.code) ? value.code as BackgroundErrorKind : 'unknown';
  return new BackgroundOperationError(code);
}

function settingsOf(value: unknown): BackgroundSettingsV1 {
  if (typeof value !== 'object' || value === null) throw new BackgroundOperationError('io');
  const record = value as Record<string, unknown>;
  const flags = ['keepInTray', 'launchAtLogin', 'trayAvailable', 'launchAtLoginAvailable', 'readOnly'] as const;
  if (record.protocol !== 1 || flags.some((flag) => typeof record[flag] !== 'boolean')) {
    throw new BackgroundOperationError('io');
  }
  return {
    protocol: 1,
    keepInTray: record.keepInTray as boolean,
    launchAtLogin: record.launchAtLogin as boolean,
    trayAvailable: record.trayAvailable as boolean,
    launchAtLoginAvailable: record.launchAtLoginAvailable as boolean,
    readOnly: record.readOnly as boolean,
  };
}

export function createBackgroundClient(invoke: BackgroundInvoke): BackgroundClient {
  async function call<T>(route: BackgroundRoute, request: BackgroundRequest): Promise<T> {
    try { return await invoke<T>(route, { request }); }
    catch (error) { throw backgroundError(error); }
  }
  return {
    settings: async () => settingsOf(await call<unknown>('background_settings_v1', {})),
    update: async (change) => {
      if (change.keepInTray === undefined && change.launchAtLogin === undefined) throw new BackgroundOperationError('invalid');
      return settingsOf(await call<unknown>('background_update_v1', change));
    },
    trayLabels: (labels) => call<void>('background_tray_labels_v1', labels),
  };
}

export const backgroundHost: BackgroundClient = createBackgroundClient((route, args) => hostInvoke(route, args));
