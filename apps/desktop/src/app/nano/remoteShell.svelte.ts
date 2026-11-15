import { remoteMode } from './remoteMode';

/** Waits after first paint before the remote access screens are fetched. */
const LOAD_DELAY_MS = 300;

/**
 * The shell's remote access surfaces (ADR-062): the pairing prompt's owner and
 * the connected-viewer indicator. They are not needed for first paint, so the
 * shell holds only this small holder and the components arrive in their own
 * chunks after it, the same way plugin contributions do. A remote browser
 * (Nano Web) never loads them.
 */
class RemoteShell {
  /** Starts the remote access state and shows the pairing prompt while a browser waits. */
  Controller = $state.raw<typeof import('./RemoteController.svelte').default | undefined>();
  /** The sidebar and narrow-bar button that shows a browser is connected. */
  Indicator = $state.raw<typeof import('./RemoteViewerIndicator.svelte').default | undefined>();
  private loading = false;

  /** Loads the surfaces after first paint; returns the cancellation for an unmount. */
  loadLater(delayMs: number = LOAD_DELAY_MS): () => void {
    if (remoteMode) return () => undefined;
    const timer = setTimeout(() => void this.load(), delayMs);
    return () => clearTimeout(timer);
  }

  private async load(): Promise<void> {
    if (this.loading || this.Controller !== undefined) return;
    this.loading = true;
    try {
      const [controller, indicator] = await Promise.all([import('./RemoteController.svelte'), import('./RemoteViewerIndicator.svelte')]);
      this.Controller = controller.default;
      this.Indicator = indicator.default;
    } catch {
      // Remote access is optional: the shell works without these chunks, and the settings block still loads its own.
      this.loading = false;
    }
  }
}

export const remoteShell = new RemoteShell();
