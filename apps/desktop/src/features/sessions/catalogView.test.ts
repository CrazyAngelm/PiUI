import { describe, expect, it } from 'vitest';
import { acceptsCatalogSnapshot } from './catalogView';
import type { SessionCatalogSnapshot } from '../../host-api/types';

function snapshot(sequence: number): SessionCatalogSnapshot {
  return {
    protocol: 7,
    scope: 'project',
    projectId: 'project',
    sequence,
    freshness: 'current',
    sessions: [],
  };
}

describe('catalog event watermarks', () => {
  it('accepts an initial or same-watermark snapshot', () => {
    expect(acceptsCatalogSnapshot(undefined, snapshot(1))).toBe(true);
    expect(acceptsCatalogSnapshot(snapshot(1), snapshot(1))).toBe(true);
  });

  it('rejects a delayed snapshot after a newer refresh', () => {
    expect(acceptsCatalogSnapshot(snapshot(8), snapshot(7))).toBe(false);
  });
});
