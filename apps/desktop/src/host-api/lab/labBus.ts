import type { LabTimers } from './labClock';

type Listener = (payload: unknown) => void;

/**
 * Host event channels. Tauri delivers events asynchronously and independently
 * of command responses, so the bus queues payloads and flushes them on a later
 * macrotask in emission order. Payloads are serialized at emission time: later
 * lab mutations can never leak into an already-sent event.
 */
export class LabEventBus {
  private readonly channels = new Map<string, Set<Listener>>();
  private queue: { channel: string; payload: unknown }[] = [];
  private scheduled = false;

  constructor(private readonly timers: LabTimers) {}

  on(channel: string, listener: Listener): () => void {
    const listeners = this.channels.get(channel) ?? new Set<Listener>();
    listeners.add(listener);
    this.channels.set(channel, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  emit(channel: string, payload: unknown): void {
    this.queue.push({ channel, payload: JSON.parse(JSON.stringify(payload)) as unknown });
    if (this.scheduled) return;
    this.scheduled = true;
    this.timers.setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    this.scheduled = false;
    const batch = this.queue;
    this.queue = [];
    for (const { channel, payload } of batch) {
      for (const listener of [...(this.channels.get(channel) ?? [])]) {
        try {
          listener(payload);
        } catch (error) {
          // One failing listener must not starve the others, as with Tauri.
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }
  }
}
