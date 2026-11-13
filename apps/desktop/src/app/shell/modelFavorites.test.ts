import { describe, expect, it } from 'vitest';
import { MAX_FAVORITES_PER_SCOPE, modelFavorites, parseFavorites } from './modelFavorites.svelte';

describe('parseFavorites', () => {
  it('reads a valid map', () => {
    expect(parseFavorites(JSON.stringify({ codex: ['a', 'b'], pi: ['c'] }))).toEqual({ codex: ['a', 'b'], pi: ['c'] });
  });

  it('survives missing, broken and wrongly shaped storage', () => {
    expect(parseFavorites(null)).toEqual({});
    expect(parseFavorites('')).toEqual({});
    expect(parseFavorites('{oops')).toEqual({});
    expect(parseFavorites('[1,2]')).toEqual({});
    expect(parseFavorites('"text"')).toEqual({});
    expect(parseFavorites(JSON.stringify({ codex: 'a', pi: { x: 1 } }))).toEqual({});
  });

  it('keeps only non-empty distinct string entries', () => {
    expect(parseFavorites(JSON.stringify({ codex: ['a', 3, null, '', 'a', 'b'], pi: [1] }))).toEqual({ codex: ['a', 'b'] });
  });

  it('caps a scope at the limit', () => {
    const many = Array.from({ length: MAX_FAVORITES_PER_SCOPE + 40 }, (_, index) => `m${index}`);
    const parsed = parseFavorites(JSON.stringify({ codex: many }));
    expect(parsed.codex).toHaveLength(MAX_FAVORITES_PER_SCOPE);
    expect(parsed.codex?.[0]).toBe('m0');
  });

  it('ignores a prototype scope', () => {
    const parsed = parseFavorites('{"__proto__":["x"],"codex":["a"]}');
    expect(Object.keys(parsed)).toEqual(['codex']);
  });
});

describe('modelFavorites', () => {
  it('toggles per scope without touching another scope', () => {
    const scope = 'toggle-scope';
    expect(modelFavorites.has(scope, 'a')).toBe(false);
    expect(modelFavorites.toggle(scope, 'a')).toBe(true);
    expect(modelFavorites.has(scope, 'a')).toBe(true);
    expect(modelFavorites.has('other-scope', 'a')).toBe(false);
    expect(modelFavorites.list(scope)).toEqual(['a']);
    expect(modelFavorites.toggle(scope, 'a')).toBe(false);
    expect(modelFavorites.list(scope)).toEqual([]);
  });

  it('drops the oldest favorite when a scope is full', () => {
    const scope = 'cap-scope';
    for (let index = 0; index <= MAX_FAVORITES_PER_SCOPE; index += 1) modelFavorites.toggle(scope, `m${index}`);
    const list = modelFavorites.list(scope);
    expect(list).toHaveLength(MAX_FAVORITES_PER_SCOPE);
    expect(list).not.toContain('m0');
    expect(list.at(-1)).toBe(`m${MAX_FAVORITES_PER_SCOPE}`);
  });

  it('works when storage is unavailable', () => {
    // No localStorage in the unit environment: the toggle still updates the in-memory state.
    expect(modelFavorites.toggle('no-storage', 'k')).toBe(true);
    expect(modelFavorites.has('no-storage', 'k')).toBe(true);
  });
});
