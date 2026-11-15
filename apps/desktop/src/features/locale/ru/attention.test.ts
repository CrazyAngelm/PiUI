import { describe, expect, it } from 'vitest';
import { lookupRussian } from '../ruCatalog';
import { attentionRu } from './attention';

describe('attention Russian copy', () => {
  it.each(Object.keys(attentionRu))('translates %s through the catalog', (source) => {
    expect(lookupRussian(source), source).toBe(attentionRu[source]);
    expect(lookupRussian(source), source).not.toBe(source);
  });
});
