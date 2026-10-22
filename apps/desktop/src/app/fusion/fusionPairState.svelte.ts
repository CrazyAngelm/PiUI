import { fusionHost, type FusionCommandV1, type FusionStateV1 } from '../../host-api/fusionClient';
import { fusionErrorText } from './fusionPair';

/** The commands the person can give to an existing pair. */
export type FusionAction = Extract<
  FusionCommandV1,
  { type: 'stopPair' | 'stopSidekick' | 'resetSidekick' | 'reconcileRound' | 'abandonRound' }
>;

/**
 * The journal of one Fusion pair as the WebView sees it: `state` of the lead
 * session, refetched whenever `piui://fusion-changed-v1` names that lead.
 * The host stays the source of truth; nothing here is persisted.
 */
export class FusionPairState {
  state = $state.raw<FusionStateV1 | undefined>(undefined);
  /** English locale key of the last failure; empty when none. */
  error = $state('');
  loading = $state(true);
  /** The action in flight (its key), or empty. */
  busy = $state('');

  private disposed = false;
  private refreshing = false;
  private refreshAgain = false;
  private unlisten: (() => void) | undefined;

  constructor(readonly leadSessionId: string) {}

  start(): void {
    void fusionHost
      .onChanged((event) => {
        if (event.leadSessionId !== this.leadSessionId) return;
        if (this.state !== undefined && event.revision <= this.state.revision) return;
        void this.refresh();
      })
      .then((unlisten) => {
        if (this.disposed) unlisten();
        else this.unlisten = unlisten;
      })
      .catch(() => {
        // Without events the panel still refreshes when it is opened.
      });
    void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = undefined;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        try {
          const result = await fusionHost.request({ type: 'state', leadSessionId: this.leadSessionId });
          if (this.disposed) return;
          if (result.type === 'state' && result.state.leadSessionId === this.leadSessionId) {
            if (this.state === undefined || result.state.revision >= this.state.revision) this.state = result.state;
            this.error = '';
          }
        } catch (cause) {
          if (!this.disposed) this.error = fusionErrorText(cause);
        }
      } while (this.refreshAgain && !this.disposed);
    } finally {
      this.refreshing = false;
      if (!this.disposed) this.loading = false;
    }
  }

  /** Runs one command; the state is refetched afterwards whatever the host answered. */
  async act(key: string, command: FusionAction): Promise<boolean> {
    if (this.busy) return false;
    this.busy = key;
    this.error = '';
    let ok = true;
    let failure = '';
    try {
      await fusionHost.request(command);
    } catch (cause) {
      ok = false;
      failure = fusionErrorText(cause);
    }
    if (!this.disposed) {
      this.busy = '';
      await this.refresh();
      // A refresh that succeeds must not hide why the action failed.
      if (!ok) this.error = failure;
    }
    return ok;
  }
}
