import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PluginStyleSnapshotV1 } from '../../../../../contracts/plugin-style-v1';
import type { PluginVisualStyleV1 } from '../../../../../contracts/piui-plugin-v3';
import { applyPluginVisualStyle, followPluginVisualStyle } from './pluginVisualStyle';

function element() {
  const tokens = new Map<string, string>();
  const root = { style: { setProperty: (key: string, value: string) => tokens.set(key, value), removeProperty: (key: string) => tokens.delete(key) }, dataset: {} } as unknown as HTMLElement;
  return { root, tokens };
}

describe('declarative visual styles', () => {
  it('uses only existing token values and clears only its own properties', () => {
    const { root, tokens } = element();
    const stylesheet = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8');
    tokens.set('--piui-action', '#000000');
    for (const style of [
      { corners: 'square', ornaments: 'slanted', font: 'system' },
      { corners: 'soft', ornaments: 'plain', font: 'mono' },
      { corners: 'round' },
    ] satisfies PluginVisualStyleV1[]) {
      applyPluginVisualStyle(style, root);
      for (const [key, value] of tokens) {
        if (key !== '--piui-action') expect(stylesheet, `${key}: ${value}`).toContain(value === 'var(--piui-font-mono)' ? '--piui-font-mono:' : value);
      }
      expect(root.dataset.pluginStyle).toBe('true');
    }
    expect(tokens.get('--piui-radius-md')).toBe('16px');
    expect(tokens.has('--piui-font-ui')).toBe(false);
    applyPluginVisualStyle(undefined, root);
    expect([...tokens]).toEqual([['--piui-action', '#000000']]);
    expect(root.dataset.pluginStyle).toBeUndefined();
    applyPluginVisualStyle({ font: 'url(https://example.org)' } as unknown as PluginVisualStyleV1, root);
    expect([...tokens]).toEqual([['--piui-action', '#000000']]);
  });

  it('fences late reads on selection, revision, appearance and safe-mode fallback', async () => {
    const { root, tokens } = element();
    const owner = { revision: 8, theme: { pluginId: 'paper', themeId: 'terminal' } };
    let resolve!: (value: PluginStyleSnapshotV1) => void;
    const stop = followPluginVisualStyle(root, owner, () => new Promise((done) => { resolve = done; }));
    stop();
    resolve({ protocol: 1, ...owner, style: { corners: 'square' } });
    await Promise.resolve();
    expect(tokens.size).toBe(0);
    followPluginVisualStyle(root, owner, async () => ({ protocol: 1, ...owner, revision: 7, style: { corners: 'square' } }));
    await Promise.resolve();
    expect(tokens.size).toBe(0);
    followPluginVisualStyle(root, owner, async () => ({ protocol: 1, ...owner, theme: { ...owner.theme, themeId: 'paper' }, style: { corners: 'square' } }));
    await Promise.resolve();
    expect(tokens.size).toBe(0);
    const end = followPluginVisualStyle(root, owner, async () => ({ protocol: 1, ...owner, style: { corners: 'square' } }));
    await Promise.resolve();
    expect(tokens.get('--piui-radius-md')).toBe('0px');
    end();
    const read = vi.fn();
    followPluginVisualStyle(root, undefined, read);
    expect(read).not.toHaveBeenCalled();
    expect(tokens.size).toBe(0);
    followPluginVisualStyle(root, owner, async () => { throw new Error('unavailable'); });
    await Promise.resolve();
    expect(tokens.size).toBe(0);
  });
});
