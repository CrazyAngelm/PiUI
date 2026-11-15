import {
  dictationError,
  dictationHost,
  type DictationClient,
  type DictationErrorCode,
  type DictationProviderIdV1,
  type DictationSettingsRequestV1,
  type DictationSettingsUpdateV1,
  type DictationSettingsV1,
} from '../../host-api/dictationClient';
import { nanoAccount } from './nanoAccount.svelte';

/** What a clip recorded now would be sent to. */
export type ActiveDictation = 'nano' | DictationProviderIdV1;

/** Waits after first paint before the (local, network-free) settings read. */
const START_DELAY_MS = 300;

/**
 * Where composer dictation goes (ADR-061): the Nano account or a provider the
 * person set up. The host owns the settings and every key; this mirrors its
 * answers. Until the settings are read, and when they cannot be read, the
 * source is the Nano account, as before.
 */
export class DictationSource {
  settings = $state.raw<DictationSettingsV1 | undefined>();
  /** Code of the last failed settings action; the view shows its copy. */
  error = $state<DictationErrorCode | undefined>();
  busy = $state(false);
  private started = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Pick<DictationClient, 'settings'>,
    private readonly account: { readonly canDictate: boolean; readonly dictationMaxBytes: number | undefined } = nanoAccount,
  ) {}

  /** Reads the settings once; a failure keeps the Nano default and may be retried. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.settings = await this.client.settings({ type: 'get' });
    } catch {
      this.started = false;
    }
  }

  /** `start()` after first paint; returns the cancellation for an unmount. */
  startLater(delayMs: number = START_DELAY_MS): () => void {
    const timer = setTimeout(() => void this.start(), delayMs);
    return () => clearTimeout(timer);
  }

  /** The source a recording would go to now, or undefined when none can transcribe. */
  get active(): ActiveDictation | undefined {
    const settings = this.settings;
    const source = settings?.source ?? 'nano';
    if (source === 'nano') return this.account.canDictate ? 'nano' : undefined;
    if (source === 'off' || settings === undefined || settings.safeMode) return undefined;
    return settings.providers.some((provider) => provider.id === source && provider.ready) ? source : undefined;
  }

  /** The composer may show the dictation button. */
  get available(): boolean {
    return this.active !== undefined;
  }

  /** Size limit of a clip for the active source. */
  get maxBytes(): number | undefined {
    return this.active === 'nano' ? this.account.dictationMaxBytes : this.settings?.maxBytes;
  }

  /**
   * Saves the preferences. A function builds the update when its turn comes, from the settings
   * the host last answered, so a change to one field never carries a stale value of another;
   * it may return nothing to send nothing.
   */
  save(settings: DictationSettingsUpdateV1 | ((current: DictationSettingsV1 | undefined) => DictationSettingsUpdateV1 | undefined)): Promise<boolean> {
    return this.run(() => {
      const update = typeof settings === 'function' ? settings(this.settings) : settings;
      return update === undefined ? undefined : { type: 'save', settings: update };
    });
  }

  setKey(provider: DictationProviderIdV1, language: 'en' | 'ru'): Promise<boolean> {
    return this.run(() => ({ type: 'set-key', provider, language }));
  }

  clearKey(provider: DictationProviderIdV1): Promise<boolean> {
    return this.run(() => ({ type: 'clear-key', provider }));
  }

  /** One host call at a time, in the order asked: a field's save always lands before the key dialog. */
  private run(build: () => DictationSettingsRequestV1 | undefined): Promise<boolean> {
    const next = this.queue.then(async () => {
      const request = build();
      if (request === undefined) return false;
      this.busy = true;
      this.error = undefined;
      try {
        this.settings = await this.client.settings(request);
        return true;
      } catch (cause) {
        this.error = dictationError(cause).code;
        return false;
      } finally {
        this.busy = false;
      }
    });
    this.queue = next;
    return next;
  }
}

export const dictationSource = new DictationSource(dictationHost);
