import type { SessionCatalogSnapshot } from '../../host-api/types';

/**
 * Catalog responses and events can arrive after a WebView reload or a later
 * refresh. Keep the newest opaque host watermark; freshness is intentionally
 * not a JSONL revision and must never be used for mutation authorization.
 */
export function acceptsCatalogSnapshot(
  current: SessionCatalogSnapshot | undefined,
  incoming: SessionCatalogSnapshot,
): boolean {
  return current === undefined || incoming.sequence >= current.sequence;
}
