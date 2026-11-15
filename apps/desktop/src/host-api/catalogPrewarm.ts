import type { HarnessKind } from '../../../../contracts/workspace-v15';
import { harnessModels, hasCatalogSnapshot } from './harnessModels';

const asked = new Set<string>();
let queue: Promise<void> = Promise.resolve();

/**
 * Loads this project's catalogs of the given harnesses in the background, one
 * at a time, so their pickers open with the project's own list instead of
 * waiting for a native start. Each project, harness and native version is
 * asked once per app session; a pair the project already remembers is left to
 * its picker, which shows the snapshot and asks again itself. Failures are the
 * picker's to report when it is opened.
 */
export function prewarmHarnessCatalogs(workspaceId: string, harnesses: readonly { kind: HarnessKind; version?: string }[]): void {
  for (const { kind, version } of harnesses) {
    const key = JSON.stringify([workspaceId, kind, version ?? '']);
    if (asked.has(key)) continue;
    asked.add(key);
    const request = { workspaceId, harness: kind };
    if (hasCatalogSnapshot(request)) continue;
    // The full catalog, so the next harness starts only after this one's native process is gone.
    queue = queue.then(() => harnessModels(request, false, version).then(() => undefined, () => undefined));
  }
}
