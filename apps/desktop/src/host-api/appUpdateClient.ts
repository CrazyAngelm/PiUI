import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import {
  APP_UPDATE_EVENT,
  APP_UPDATE_PROTOCOL,
  type AppUpdateAvailableV1,
  type AppUpdateErrorCodeV1,
  type AppUpdateEventV1,
  type AppUpdateLastCheckV1,
  type AppUpdateStatusV1,
} from '../../../../contracts/app-update-v1';

export type * from '../../../../contracts/app-update-v1';
export { APP_UPDATE_EVENT, APP_UPDATE_PROTOCOL } from '../../../../contracts/app-update-v1';

/**
 * Client of app update v1. The host owns every rule (configuration gate,
 * signature verification, which version may install, automatic checks); this
 * client validates answers and maps typed failures to safe copy. It never
 * forwards host or network details.
 */
export type AppUpdateErrorCode = AppUpdateErrorCodeV1 | 'unknown';

/** English source strings of the locale catalog. */
export const APP_UPDATE_ERROR_COPY: Readonly<Record<AppUpdateErrorCode, string>> = {
  invalid: 'The update request was not valid.',
  'not-configured': 'Updates are not set up in this build.',
  busy: 'An update check or install is already running.',
  'shutting-down': 'PiUI is closing.',
  'not-available': 'This update is no longer offered. Check for updates again.',
  network: 'Could not reach the update server. Check your connection and try again.',
  'feed-invalid': 'The update information could not be read. Try again later.',
  'platform-missing': 'This update has no package for this system.',
  'check-failed': 'Could not check for updates. Try again later.',
  'download-failed': 'The update could not be downloaded. Nothing was installed.',
  'signature-invalid': 'The update’s signature did not match PiUI’s signing key, so it was not installed.',
  'install-failed': 'The update could not be installed.',
  'settings-failed': 'Could not save this preference. The previous choice is kept.',
  unknown: 'The update action could not be completed.',
};

export class AppUpdateOperationError extends Error {
  constructor(readonly code: AppUpdateErrorCode, message: string = APP_UPDATE_ERROR_COPY[code]) {
    super(message);
    this.name = 'AppUpdateOperationError';
  }
}

/** Maps a rejected invoke to a typed error; host details are never forwarded. */
export function appUpdateError(cause: unknown): AppUpdateOperationError {
  if (cause instanceof AppUpdateOperationError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const code =
    isRecord(value) && typeof value.code === 'string' && value.code !== 'unknown' && Object.hasOwn(APP_UPDATE_ERROR_COPY, value.code)
      ? (value.code as AppUpdateErrorCode)
      : 'unknown';
  return new AppUpdateOperationError(code);
}

const PHASES: readonly AppUpdateStatusV1['phase'][] = ['idle', 'checking', 'downloading', 'installing', 'restarting', 'restart-required'];
const OUTCOMES: readonly AppUpdateLastCheckV1['outcome'][] = ['up-to-date', 'available', 'failed'];
const ERROR_CODES = Object.keys(APP_UPDATE_ERROR_COPY).filter((code) => code !== 'unknown');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const optionalString = (value: unknown): boolean => value === null || typeof value === 'string';

function isLastCheck(value: unknown): value is AppUpdateLastCheckV1 {
  return (
    isRecord(value) &&
    typeof value.at === 'string' &&
    typeof value.automatic === 'boolean' &&
    OUTCOMES.includes(value.outcome as AppUpdateLastCheckV1['outcome']) &&
    (value.error === null || ERROR_CODES.includes(value.error as string))
  );
}

function isAvailable(value: unknown): value is AppUpdateAvailableV1 {
  return isRecord(value) && typeof value.version === 'string' && value.version.length > 0 && optionalString(value.date) && optionalString(value.notes);
}

/** The status exactly as the contract describes it, or undefined. */
export function decodeAppUpdateStatus(value: unknown): AppUpdateStatusV1 | undefined {
  if (
    !isRecord(value) ||
    value.protocol !== APP_UPDATE_PROTOCOL ||
    typeof value.configured !== 'boolean' ||
    typeof value.currentVersion !== 'string' ||
    !optionalString(value.feedHost) ||
    typeof value.autoCheck !== 'boolean' ||
    !PHASES.includes(value.phase as AppUpdateStatusV1['phase']) ||
    !(value.lastCheck === null || isLastCheck(value.lastCheck)) ||
    !(value.available === null || isAvailable(value.available))
  ) {
    return undefined;
  }
  return value as unknown as AppUpdateStatusV1;
}

const byteCount = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function decodeAppUpdateEvent(value: unknown): AppUpdateEventV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'status') {
    const status = decodeAppUpdateStatus(value.status);
    return status ? { type: 'status', status } : undefined;
  }
  if (value.type === 'progress' && byteCount(value.downloadedBytes) && (value.totalBytes === null || byteCount(value.totalBytes))) {
    return { type: 'progress', downloadedBytes: value.downloadedBytes as number, totalBytes: value.totalBytes as number | null };
  }
  return undefined;
}

export interface AppUpdateClient {
  status(): Promise<AppUpdateStatusV1>;
  check(): Promise<AppUpdateStatusV1>;
  /** Resolves only when the install did not end PiUI (Linux/macOS restarting). */
  install(version: string): Promise<AppUpdateStatusV1>;
  setAutoCheck(enabled: boolean): Promise<AppUpdateStatusV1>;
  restart(): Promise<void>;
  subscribe(handler: (event: AppUpdateEventV1) => void): Promise<() => void>;
}

export function createAppUpdateClient(invoke: HostInvoke, listen: HostListen): AppUpdateClient {
  async function status(command: string, args?: Record<string, unknown>): Promise<AppUpdateStatusV1> {
    let result: unknown;
    try {
      result = await invoke<unknown>(command, args);
    } catch (error) {
      throw appUpdateError(error);
    }
    const decoded = decodeAppUpdateStatus(result);
    if (!decoded) throw new AppUpdateOperationError('unknown');
    return decoded;
  }
  return {
    status: () => status('app_update_status_v1'),
    check: () => status('app_update_check_v1'),
    install: (version) => status('app_update_install_v1', { request: { version } }),
    setAutoCheck: (enabled) => status('app_update_set_auto_check_v1', { request: { enabled } }),
    restart: async () => {
      try {
        await invoke<unknown>('app_update_restart_v1');
      } catch (error) {
        throw appUpdateError(error);
      }
    },
    subscribe: (handler) =>
      listen<unknown>(APP_UPDATE_EVENT, (payload) => {
        const event = decodeAppUpdateEvent(payload);
        if (event) handler(event);
      }),
  };
}

export const appUpdateHost: AppUpdateClient = createAppUpdateClient(hostInvoke, hostListen);
