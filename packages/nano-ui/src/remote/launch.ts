/**
 * What the Nano Web host page tells the bundle (only a device id and display
 * preferences, in the URL fragment so they never reach a server log) and how
 * the page retries after a connection ends.
 */
import { nanoRemoteViewerSocketPath } from '../../../../contracts/nano-remote-v1';
import type { ClosedReason } from './connection';

export type GateLanguage = 'en' | 'ru';
export type GateTheme = 'light' | 'dark' | 'system';

export interface Launch {
  readonly device: string;
  readonly language: GateLanguage;
  readonly theme: GateTheme;
}

const DEVICE = /^dev_[A-Za-z0-9_-]{1,36}$/;

/** `#device=dev_...&lang=ru&theme=dark`; `undefined` when the device id is missing or malformed. */
export function parseLaunch(hash: string): Launch | undefined {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const device = params.get('device') ?? '';
  if (!DEVICE.test(device)) return undefined;
  const theme = params.get('theme');
  return {
    device,
    language: params.get('lang') === 'en' ? 'en' : 'ru',
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
  };
}

/** Same origin as the page: the cookie session authorizes the socket, the bundle holds no token. */
export function viewerSocketUrl(origin: { readonly protocol: string; readonly host: string }, device: string): string {
  return (origin.protocol === 'https:' ? 'wss://' : 'ws://') + origin.host + nanoRemoteViewerSocketPath(device);
}

/** Reloads after 2, 5, 15 and 30 seconds, then waits for the button. */
export const RETRY_SECONDS: readonly number[] = [2, 5, 15, 30];

const RETRYING: readonly ClosedReason[] = ['restart', 'network', 'device-offline', 'idle', 'replaced'];

/** Seconds until an automatic reload, or `undefined` when the person must act. */
export function retryDelay(reason: ClosedReason, attempt: number): number | undefined {
  return RETRYING.includes(reason) ? RETRY_SECONDS[attempt] : undefined;
}

export interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const ATTEMPT_KEY = 'nano-remote.retry';

/** Retry count kept for the tab, so a reload does not restart the schedule. Storage failures count as zero. */
export function createAttemptCounter(storage: AttemptStorage | undefined): { read(): number; increment(): void; reset(): void } {
  return {
    read() {
      try {
        const value = Number(storage?.getItem(ATTEMPT_KEY));
        return Number.isInteger(value) && value > 0 ? value : 0;
      } catch {
        return 0;
      }
    },
    increment() {
      try {
        storage?.setItem(ATTEMPT_KEY, String(this.read() + 1));
      } catch {
        // Without storage the schedule restarts on every reload, which only retries sooner.
      }
    },
    reset() {
      try {
        storage?.removeItem(ATTEMPT_KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}
