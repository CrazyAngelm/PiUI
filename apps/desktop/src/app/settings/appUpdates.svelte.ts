import { APP_UPDATE_ERROR_COPY, type AppUpdateClient, type AppUpdateEventV1, type AppUpdateStatusV1 } from '../../host-api/appUpdateClient';

export type AppUpdateAction = 'check' | 'install' | 'auto-check' | 'restart';

export interface AppUpdateProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
}

/**
 * Settings → About: the host's update status and the person's actions. The
 * host decides everything (whether updates are configured, which version may
 * install, signature verification); this state only mirrors its answers and
 * events. A build without updates loads one local status and nothing else:
 * no event subscription, no check and no update controls.
 */
export class AppUpdates {
  status = $state.raw<AppUpdateStatusV1 | undefined>();
  loading = $state(false);
  action = $state<AppUpdateAction | undefined>();
  /** English source copy for the last failed action; the view translates it. */
  error = $state<string | undefined>();
  progress = $state.raw<AppUpdateProgress | undefined>();
  private stop: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly client: AppUpdateClient) {}

  /** True only for a build with a configured updater. */
  get visible(): boolean {
    return this.status?.configured === true;
  }

  get busy(): boolean {
    const phase = this.status?.phase;
    return this.action !== undefined || (phase !== undefined && phase !== 'idle');
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const status = await this.client.status();
      if (this.disposed) return;
      this.status = status;
      if (status.configured && this.stop === undefined) {
        const stop = await this.client.subscribe((event) => this.apply(event));
        if (this.disposed) stop();
        else this.stop = stop;
      }
    } catch (error) {
      if (!this.disposed) this.error = message(error);
    } finally {
      this.loading = false;
    }
  }

  apply(event: AppUpdateEventV1): void {
    switch (event.type) {
      case 'status':
        this.status = event.status;
        if (event.status.phase !== 'downloading') this.progress = undefined;
        break;
      case 'progress':
        this.progress = { downloadedBytes: event.downloadedBytes, totalBytes: event.totalBytes };
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  check(): Promise<boolean> {
    return this.run('check', () => this.client.check());
  }

  /** Installs exactly the version the person confirmed. */
  install(version: string): Promise<boolean> {
    if (this.status?.available?.version !== version) return Promise.resolve(false);
    return this.run('install', () => this.client.install(version));
  }

  setAutoCheck(enabled: boolean): Promise<boolean> {
    return this.run('auto-check', () => this.client.setAutoCheck(enabled));
  }

  async restart(): Promise<boolean> {
    if (this.status?.phase !== 'restart-required' || this.action !== undefined) return false;
    this.action = 'restart';
    this.error = undefined;
    try {
      await this.client.restart();
      return true;
    } catch (error) {
      this.error = message(error);
      return false;
    } finally {
      this.action = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop?.();
    this.stop = undefined;
  }

  private async run(action: AppUpdateAction, operation: () => Promise<AppUpdateStatusV1>): Promise<boolean> {
    if (!this.visible || this.busy) return false;
    this.action = action;
    this.error = undefined;
    try {
      const status = await operation();
      if (!this.disposed) this.status = status;
      return true;
    } catch (error) {
      if (!this.disposed) {
        this.error = message(error);
        // The host's status says what remains (an earlier offer, a restart).
        await this.client.status().then(
          (status) => {
            if (!this.disposed) this.status = status;
          },
          () => undefined,
        );
      }
      return false;
    } finally {
      this.action = undefined;
      if (this.status?.phase !== 'downloading') this.progress = undefined;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error && error.name === 'AppUpdateOperationError' ? error.message : APP_UPDATE_ERROR_COPY.unknown;
}

/** Percent for a progress bar, or undefined when the size is unknown. */
export function progressPercent(progress: AppUpdateProgress | undefined): number | undefined {
  if (!progress || progress.totalBytes === null || progress.totalBytes <= 0) return undefined;
  return Math.min(100, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100));
}

/** Megabytes with one decimal in the interface locale, e.g. `12.4` or `12,4`; the view adds the unit. */
export function megabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / (1024 * 1024));
}
