/**
 * Replacement for apps/desktop/src/host-api/transport.ts in the Nano Web remote
 * bundle (packages/nano-ui/vite.remote.config.ts swaps it at build time).
 *
 * The desktop shell calls `hostInvoke` and `hostListen` exactly as it does in
 * the app. Here they go through one welcomed remote session instead of Tauri,
 * and only for the commands and channels the desktop advertised in `welcome`.
 * Neither Tauri nor the UI Lab host can reach this bundle.
 */
import type { RemoteLink } from './connection';

export type HostInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type HostListen = <T>(channel: string, handler: (payload: T) => void) => Promise<() => void>;

export interface HostTransport {
  invoke: HostInvoke;
  listen: HostListen;
}

export const desktopAvailable = true;
/** True only in the Nano Web remote bundle: the shell hides what a remote viewer may not use. */
export const hostRemote: boolean = true;

interface Registration {
  readonly handler: (payload: unknown) => void;
}

let link: RemoteLink | undefined;

export function hostSupports(...commands: string[]): boolean {
  return commands.every((command) => link?.commands.includes(command));
}
let unsubscribe: (() => void) | undefined;
const registrations = new Map<string, Set<Registration>>();

function dispatch(channel: string, payload: unknown): void {
  if (link === undefined || !link.channels.includes(channel)) return;
  for (const registration of [...(registrations.get(channel) ?? [])]) {
    try {
      registration.handler(payload);
    } catch {
      // A faulty listener never stops the others; payloads are never logged.
    }
  }
}

/** Connects the shell to a welcomed session, or disconnects it with `undefined`. */
export function installRemoteConnection(next: RemoteLink | undefined): void {
  unsubscribe?.();
  unsubscribe = undefined;
  link = next;
  if (next !== undefined) unsubscribe = next.onEvent(dispatch);
}

export const hostInvoke: HostInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const current = link;
  if (current === undefined) return Promise.reject({ code: 'remote-not-connected' });
  if (!current.commands.includes(command)) return Promise.reject({ code: 'remote-not-allowed' });
  return (await current.request(command, args ?? {})) as T;
};

export const hostListen: HostListen = async <T>(channel: string, handler: (payload: T) => void): Promise<() => void> => {
  const registration: Registration = { handler: handler as (payload: unknown) => void };
  const set = registrations.get(channel) ?? new Set<Registration>();
  registrations.set(channel, set);
  set.add(registration);
  return () => {
    set.delete(registration);
    if (set.size === 0 && registrations.get(channel) === set) registrations.delete(channel);
  };
};
