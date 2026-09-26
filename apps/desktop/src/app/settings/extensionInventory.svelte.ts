import type { ExtensionHarness, ExtensionsClient } from '../../host-api/extensionsClient';
import type { ExtensionSummary } from '../../host-api/types';

/**
 * Settings → Extensions: one harness inventory at a time, with one change in
 * flight. The host's answer is authoritative; a failed change keeps the
 * previous list and reports locally. Requests carry an epoch so switching
 * harness never shows a late list for the other one.
 */
export class ExtensionInventory {
  harness = $state<ExtensionHarness>('pi');
  items = $state.raw<ExtensionSummary[]>([]);
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | undefined>();
  busyId = $state<string | undefined>();
  private epoch = 0;

  constructor(private readonly client: ExtensionsClient) {}

  async load(): Promise<void> {
    const harness = this.harness;
    const epoch = ++this.epoch;
    this.loading = true;
    this.error = undefined;
    try {
      const items = await this.client.list(harness);
      if (epoch !== this.epoch) return;
      this.items = items;
      this.loaded = true;
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.error = error instanceof Error ? error.message : 'Could not read the installed extensions. Try again.';
    } finally {
      if (epoch === this.epoch) this.loading = false;
    }
  }

  select(harness: ExtensionHarness): void {
    if (harness === this.harness || this.busyId !== undefined) return;
    this.harness = harness;
    this.items = [];
    this.loaded = false;
    void this.load();
  }

  async toggle(extension: ExtensionSummary, enabled: boolean): Promise<boolean> {
    if (this.busyId !== undefined || extension.agentKind !== this.harness) return false;
    const epoch = this.epoch;
    this.busyId = extension.id;
    this.error = undefined;
    try {
      const items = await this.client.setEnabled(this.harness, extension.id, enabled);
      if (epoch === this.epoch) this.items = items;
      return true;
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = error instanceof Error ? error.message : 'Could not change the extension. Its previous state is kept.';
        // Fresh rows make a switch that the user flipped show the kept state again.
        this.items = this.items.map((item) => ({ ...item }));
      }
      return false;
    } finally {
      this.busyId = undefined;
    }
  }
}
