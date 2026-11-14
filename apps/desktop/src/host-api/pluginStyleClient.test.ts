import { describe, expect, it, vi } from 'vitest';
import { isPluginStyleSnapshot, isPluginVisualStyle, readPluginStyle } from './pluginStyleClient';
import type { HostInvoke } from './transport';

describe('plugin style versioned read', () => {
  it('validates enumerated styles and unchanged palette-only snapshots', async () => {
    const snapshot = { protocol: 1, revision: 7, theme: { pluginId: 'paper', themeId: 'round' }, style: { corners: 'round', ornaments: 'plain', font: 'mono' } };
    const invoke = vi.fn(async () => snapshot) as unknown as HostInvoke;
    expect(await readPluginStyle(invoke)).toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith('plugin_style_v1', { request: {} });
    expect(isPluginStyleSnapshot({ protocol: 1, revision: 0 })).toBe(true);
    expect(isPluginStyleSnapshot({ ...snapshot, style: undefined })).toBe(true);
    for (const style of [{}, { corners: 'url(https://example.org)' }, { css: 'body{}' }, { font: '14px' }, { ornaments: 'script' }, { corners: null }]) {
      expect(isPluginVisualStyle(style)).toBe(false);
      expect(isPluginStyleSnapshot({ ...snapshot, style })).toBe(false);
    }
    for (const invalid of [{ ...snapshot, protocol: 2 }, { ...snapshot, revision: -1 }, { ...snapshot, theme: undefined }, { ...snapshot, theme: { pluginId: 'paper', themeId: 'round', css: '' } }]) {
      expect(isPluginStyleSnapshot(invalid)).toBe(false);
    }
    await expect(readPluginStyle((async () => ({ protocol: 2 })) as HostInvoke)).rejects.toThrow('Invalid plugin style snapshot.');
  });
});
