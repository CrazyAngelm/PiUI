import {
  nanoRemoteError,
  nanoRemoteHost,
  type NanoRemoteClient,
  type NanoRemoteDecisionV1,
  type NanoRemoteEventV1,
  type NanoRemotePairingV1,
  type NanoRemoteStatusV1,
  type NanoRemoteViewerV1,
} from '../../host-api/nanoRemoteClient';
import { remoteMode } from './remoteMode';

export type NanoRemoteAction = 'toggle' | 'decide' | 'kick' | 'forget';

/** Waits after first paint before the (local, network-free) status read. */
const START_DELAY_MS = 300;

/**
 * Remote access (ADR-062) as the desktop's screens see it: the host's last
 * status and the person's actions. The Rust host owns the link, every pairing
 * and every grant; this state mirrors its answers and events and never
 * contacts a server. Nothing loads until `start()`: the window paints first,
 * then the shell asks once for the (local) status and subscribes. A remote
 * browser never runs it: there the store stays empty and calls nothing.
 */
export class NanoRemote {
  status = $state.raw<NanoRemoteStatusV1 | undefined>();
  action = $state<NanoRemoteAction | undefined>();
  /** English source copy of the last failed action; the view translates it. */
  error = $state<string | undefined>();
  private stop: (() => void) | undefined;
  private started = false;
  private disposed = false;

  constructor(private readonly client: NanoRemoteClient) {}

  /** Follows the host's events, then reads the status once; calling it again does nothing. */
  async start(): Promise<void> {
    if (this.started || remoteMode) return;
    this.started = true;
    try {
      // Subscribe first: an event published while the status is read is kept
      // (`accept` keeps the newest revision), not lost between the two calls.
      const stop = await this.client.listen((event) => this.apply(event));
      if (this.disposed) {
        stop();
        return;
      }
      this.stop = stop;
      const status = await this.client.status();
      if (!this.disposed) this.accept(status);
    } catch (error) {
      this.stop?.();
      this.stop = undefined;
      this.started = false;
      if (!this.disposed) this.error = message(error);
    }
  }

  /** `start()` after first paint; returns the cancellation for an unmount. */
  startLater(delayMs: number = START_DELAY_MS): () => void {
    if (remoteMode) return () => undefined;
    const timer = setTimeout(() => void this.start(), delayMs);
    return () => clearTimeout(timer);
  }

  dispose(): void {
    this.disposed = true;
    this.stop?.();
    this.stop = undefined;
  }

  apply(event: NanoRemoteEventV1): void {
    this.accept(event.status);
  }

  /** Keeps the newest status: an older answer never replaces a newer event. */
  private accept(next: NanoRemoteStatusV1): void {
    if (this.status !== undefined && next.revision < this.status.revision) return;
    this.status = next;
  }

  // ---- derived state ------------------------------------------------------

  get loaded(): boolean {
    return this.status !== undefined;
  }

  /** The browser waiting for a decision on this computer, if any. */
  get pending(): NanoRemotePairingV1 | undefined {
    return this.status?.pending ?? undefined;
  }

  /** Browsers connected now. */
  get viewers(): readonly NanoRemoteViewerV1[] {
    return this.status?.viewers ?? [];
  }

  // ---- actions (each answers whether it worked) ---------------------------

  setEnabled(enabled: boolean): Promise<boolean> {
    return this.run('toggle', () => this.client.setEnabled(enabled));
  }

  decide(requestId: string, decision: NanoRemoteDecisionV1): Promise<boolean> {
    return this.run('decide', () => this.client.decide(requestId, decision));
  }

  kick(viewerId: string): Promise<boolean> {
    return this.run('kick', () => this.client.kick(viewerId));
  }

  forget(browserId: string): Promise<boolean> {
    return this.run('forget', () => this.client.forget(browserId));
  }

  clearError(): void {
    this.error = undefined;
  }

  private async run(action: NanoRemoteAction, call: () => Promise<NanoRemoteStatusV1>): Promise<boolean> {
    if (this.action !== undefined) return false;
    this.action = action;
    this.error = undefined;
    try {
      const status = await call();
      if (!this.disposed) this.accept(status);
      return true;
    } catch (error) {
      if (!this.disposed) this.error = message(error);
      return false;
    } finally {
      this.action = undefined;
    }
  }
}

/** Fixed English copy for a failure; host text is never forwarded. */
function message(error: unknown): string {
  return nanoRemoteError(error).message;
}

/** The application's remote access state: shared by the sidebar, settings and the pairing prompt. */
export const nanoRemote = new NanoRemote(nanoRemoteHost);
