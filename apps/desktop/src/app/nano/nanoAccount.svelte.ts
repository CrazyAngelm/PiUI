import { forgetHarnessCatalogs } from '../../host-api/harnessModels';
import {
  NANO_ACCOUNT_ERROR_COPY,
  NANO_HARNESS,
  nanoAccountError,
  nanoAccountHost,
  type NanoAccountClient,
  type NanoAccountEventV1,
  type NanoAccountStateV1,
  type NanoAccountStatusV1,
  type NanoCreditsV1,
  type NanoLinkV1,
  type NanoModeV1,
} from '../../host-api/nanoAccountClient';
import { NANO_SOURCE_HARNESSES } from './nanoView';

export type NanoAccountAction = 'sign-in' | 'cancel' | 'sign-out' | 'workspace' | 'refresh' | 'link' | 'cloud';

/** Waits after first paint before the (local, network-free) status read. */
const START_DELAY_MS = 300;

/**
 * What the Nano model catalog depends on, as the host builds it from the
 * entitlements: a signed-in account, its workspace and which modes are open.
 * Credit balances and plan dates are not part of it.
 */
function catalogFingerprint(status: NanoAccountStatusV1): string {
  const signedIn = status.state === 'signed-in';
  const modes = signedIn ? (status.entitlements?.modes ?? []) : [];
  return JSON.stringify([
    signedIn,
    status.selectedWorkspaceId,
    signedIn && status.capabilities?.gateway,
    signedIn && status.entitlements?.features.localAgent,
    modes.map((mode) => [mode.id, mode.name, mode.available]),
  ]);
}

/**
 * The optional Nano account as every screen sees it: the host's last status and
 * the person's actions (ADR-047). The host owns each credential and rule; this
 * state mirrors its answers and events and never contacts a server itself.
 * Nothing loads until `start()`: the window paints first, then the shell asks
 * once for the status and subscribes. A signed-out application does nothing
 * more.
 */
export class NanoAccount {
  status = $state.raw<NanoAccountStatusV1 | undefined>();
  loading = $state(false);
  action = $state<NanoAccountAction | undefined>();
  /** English source copy of the last failed action; the view translates it. */
  error = $state<string | undefined>();
  /**
   * Bumped whenever the Nano model catalog can differ (sign-in, sign-out, workspace,
   * modes opened or locked). Pickers read it so they load the catalog again.
   */
  catalogRevision = $state(0);
  private catalogKey: string | undefined;
  private stop: (() => void) | undefined;
  private started = false;
  private disposed = false;

  constructor(private readonly client: NanoAccountClient) {}

  /** Follows the host's events, then reads the status once; calling it again does nothing. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.loading = true;
    try {
      // Subscribe first: an event published while the status is being read is kept
      // (`accept` keeps the newest revision), not lost between the two calls.
      const stop = await this.client.subscribe((event) => this.apply(event));
      if (this.disposed) {
        stop();
        return;
      }
      this.stop = stop;
      const status = await this.client.status();
      if (this.disposed) return;
      this.accept(status);
    } catch (error) {
      this.stop?.();
      this.stop = undefined;
      this.started = false;
      if (!this.disposed) this.error = message(error);
    } finally {
      this.loading = false;
    }
  }

  /** `start()` after first paint; returns the cancellation for an unmount. */
  startLater(delayMs: number = START_DELAY_MS): () => void {
    const timer = setTimeout(() => void this.start(), delayMs);
    return () => clearTimeout(timer);
  }

  dispose(): void {
    this.disposed = true;
    this.stop?.();
    this.stop = undefined;
  }

  apply(event: NanoAccountEventV1): void {
    this.accept(event.status);
  }

  /** Keeps the newest status: an older answer never replaces a newer event. */
  private accept(next: NanoAccountStatusV1): void {
    if (this.status !== undefined && next.revision < this.status.revision) return;
    this.status = next;
    // The model catalog is account state, not a slow native probe: when it can differ,
    // drop what was remembered first, then tell the pickers to ask again.
    const key = catalogFingerprint(next);
    if (key === this.catalogKey) return;
    this.catalogKey = key;
    forgetHarnessCatalogs(NANO_HARNESS);
    // Agents with a Nano model source list the same modes as a separate group.
    for (const harness of NANO_SOURCE_HARNESSES) forgetHarnessCatalogs(harness);
    this.catalogRevision += 1;
  }

  // ---- derived state ------------------------------------------------------

  get loaded(): boolean {
    return this.status !== undefined;
  }

  get state(): NanoAccountStateV1 | undefined {
    return this.status?.state;
  }

  get signedIn(): boolean {
    return this.status?.state === 'signed-in';
  }

  /** Signed out or revoked: the person has to sign in to use Nano. */
  get needsSignIn(): boolean {
    return this.status?.state === 'signed-out' || this.status?.state === 'expired';
  }

  get entitlements(): NanoAccountStatusV1['entitlements'] {
    return this.signedIn ? (this.status?.entitlements ?? null) : null;
  }

  get credits(): NanoCreditsV1 | undefined {
    return this.entitlements?.credits;
  }

  get modes(): readonly NanoModeV1[] {
    return this.entitlements?.modes ?? [];
  }

  get availableModes(): readonly NanoModeV1[] {
    return this.modes.filter((mode) => mode.available);
  }

  get lockedModes(): readonly NanoModeV1[] {
    return this.modes.filter((mode) => !mode.available);
  }

  /** The server agent can be opened in the Nano Cloud window. */
  get canUseCloud(): boolean {
    // A one-time launch code (`capabilities.cloudLaunch`) is optional: without
    // it the cloud window opens the Nano site and the person signs in there.
    return this.signedIn && this.entitlements?.features.cloud === true;
  }

  /** The composer may show the dictation button. */
  get canDictate(): boolean {
    return this.signedIn && this.entitlements?.features.dictation === true && this.status?.capabilities?.dictation === true;
  }

  get canUseAvatars(): boolean {
    return this.signedIn && this.status?.selectedWorkspaceId != null && this.entitlements?.features.avatars === true && this.status?.capabilities?.avatars === true;
  }

  get dictationMaxBytes(): number | undefined {
    return this.entitlements?.limits.dictationMaxBytes;
  }

  /** What went wrong last, as English source copy: a failed action, else the host's last error. */
  get problem(): string | undefined {
    if (this.error !== undefined) return this.error;
    const code = this.status?.lastError;
    return code ? NANO_ACCOUNT_ERROR_COPY[code] : undefined;
  }

  // ---- actions (each answers whether it worked) ---------------------------

  signIn(): Promise<boolean> {
    return this.run('sign-in', () => this.client.signIn());
  }

  cancelSignIn(): Promise<boolean> {
    return this.run('cancel', () => this.client.cancelSignIn());
  }

  signOut(): Promise<boolean> {
    return this.run('sign-out', () => this.client.signOut());
  }

  selectWorkspace(workspaceId: string): Promise<boolean> {
    return this.run('workspace', () => this.client.selectWorkspace(workspaceId));
  }

  refresh(): Promise<boolean> {
    return this.run('refresh', () => this.client.refresh());
  }

  openLink(link: NanoLinkV1): Promise<boolean> {
    return this.run('link', () => this.client.openLink(link));
  }

  async openCloud(): Promise<boolean> {
    if (!this.canUseCloud) return false;
    return this.run('cloud', async () => {
      await this.client.openCloud();
      return undefined;
    });
  }

  clearError(): void {
    this.error = undefined;
  }

  private async run(action: NanoAccountAction, call: () => Promise<NanoAccountStatusV1 | undefined>): Promise<boolean> {
    if (this.action !== undefined) return false;
    this.action = action;
    this.error = undefined;
    try {
      const status = await call();
      if (status !== undefined && !this.disposed) this.accept(status);
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
  return nanoAccountError(error).message;
}

/** The application's account: shared by the sidebar, settings, model picker and composers. */
export const nanoAccount = new NanoAccount(nanoAccountHost);
