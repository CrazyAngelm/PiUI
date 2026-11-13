import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STYLE_STORAGE_KEY, StylePreference } from './stylePreference.svelte';

describe('built-in visual style', () => {
  const saved = new Map<string, string>();
  let dataset: Record<string, string>;

  beforeEach(() => {
    saved.clear();
    dataset = { theme: 'light', pluginTheme: 'my-palette' };
    vi.stubGlobal('document', { documentElement: { dataset } });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to Nano, including unknown or inaccessible stored values', () => {
    expect(new StylePreference().value).toBe('nano');
    saved.set(STYLE_STORAGE_KEY, 'remote-theme');
    expect(new StylePreference().value).toBe('nano');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('storage blocked'); } });
    const preference = new StylePreference();
    preference.apply();
    expect(dataset.style).toBe('nano');
  });

  it('restores an explicit Chaos choice and leaves appearance and plugin selection intact', () => {
    saved.set(STYLE_STORAGE_KEY, 'chaos');
    const preference = new StylePreference();
    preference.apply();
    expect(dataset).toEqual({ style: 'chaos', theme: 'light', pluginTheme: 'my-palette' });
    preference.set('nano');
    expect(dataset).toEqual({ style: 'nano', theme: 'light', pluginTheme: 'my-palette' });
    expect(saved.get(STYLE_STORAGE_KEY)).toBe('nano');
    expect(new StylePreference().value).toBe('nano');
    expect(preference.sessionOnly).toBe(false);
  });

  it('keeps a usable session choice and reports a failed save, then recovers', () => {
    const preference = new StylePreference();
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota exceeded'); } });
    preference.set('chaos');
    expect(preference.value).toBe('chaos');
    expect(dataset.style).toBe('chaos');
    expect(preference.sessionOnly).toBe(true);
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => saved.set(key, value) });
    preference.set('nano');
    expect(preference.sessionOnly).toBe(false);
    expect(saved.get(STYLE_STORAGE_KEY)).toBe('nano');
  });

  it('does not need a document or a native host to restore a preference', () => {
    vi.stubGlobal('document', undefined);
    const preference = new StylePreference();
    expect(() => preference.set('chaos')).not.toThrow();
    expect(saved.get(STYLE_STORAGE_KEY)).toBe('chaos');
  });
});
