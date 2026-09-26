import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Single boundary between the WebView and the host. Every typed client calls
 * these two functions instead of importing Tauri directly, so the whole UI can
 * run in a plain browser against the in-memory UI Lab host during development.
 * The UI Lab host is loaded lazily and never reaches the desktop bundle's
 * initial chunk; inside Tauri it is never imported.
 */
export type HostInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type HostListen = <T>(channel: string, handler: (payload: T) => void) => Promise<() => void>;

export interface HostTransport {
  invoke: HostInvoke;
  listen: HostListen;
}

export const desktopAvailable = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const desktopTransport: HostTransport = {
  invoke: (command, args) => invoke(command, args),
  listen: async (channel, handler) => listen(channel, (event) => handler(event.payload as never)),
};

let labTransport: Promise<HostTransport> | undefined;
function lab(): Promise<HostTransport> {
  labTransport ??= import('./lab/labHost').then((module) => module.createLabHost());
  return labTransport;
}

export const hostInvoke: HostInvoke = async (command, args) =>
  desktopAvailable ? desktopTransport.invoke(command, args) : (await lab()).invoke(command, args);

export const hostListen: HostListen = async (channel, handler) =>
  desktopAvailable ? desktopTransport.listen(channel, handler) : (await lab()).listen(channel, handler);
