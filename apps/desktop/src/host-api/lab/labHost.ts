import type { HostTransport } from '../transport';

/**
 * UI Lab host: an in-memory stand-in for the Rust host used when the UI runs
 * in a plain browser (`pnpm dev`). It never executes agents or touches files;
 * it exists so every screen and state can be designed and tested without Tauri.
 */
type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export class LabEventBus {
  private readonly channels = new Map<string, Set<(payload: unknown) => void>>();
  on(channel: string, handler: (payload: unknown) => void): () => void {
    const set = this.channels.get(channel) ?? new Set();
    set.add(handler);
    this.channels.set(channel, set);
    return () => set.delete(handler);
  }
  emit(channel: string, payload: unknown): void {
    for (const handler of this.channels.get(channel) ?? []) handler(payload);
  }
}

export function labError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function createLabHost(extra: Record<string, Handler> = {}): HostTransport {
  const bus = new LabEventBus();
  const handlers: Record<string, Handler> = {
    workspace_command_v15: (args) => {
      const command = args.command as { type: string };
      if (command.type === 'catalog') {
        return {
          type: 'catalog',
          catalog: {
            protocol: 15, safeMode: false, workspaces: [], sessions: [],
            harnesses: [
              { kind: 'pi', name: 'Pi', installed: false, status: 'unavailable', reason: 'Desktop host required' },
              { kind: 'prime-agent', name: 'Prime Agent', installed: false, status: 'unavailable', reason: 'Desktop host required' },
              { kind: 'codex', name: 'Codex', installed: false, status: 'unavailable', reason: 'Desktop host required' },
              { kind: 'hermes', name: 'Hermes', installed: false, status: 'unavailable', reason: 'Desktop host required' },
            ],
          },
        };
      }
      throw labError('UNAVAILABLE');
    },
    ...extra,
  };
  return {
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      const handler = handlers[command];
      if (handler === undefined) {
        if (command.startsWith('orchestration_')) throw labError('desktop-unavailable');
        throw labError('UNAVAILABLE');
      }
      return (await handler(args)) as T;
    },
    async listen<T>(channel: string, handler: (payload: T) => void): Promise<() => void> {
      return bus.on(channel, handler as (payload: unknown) => void);
    },
  };
}
