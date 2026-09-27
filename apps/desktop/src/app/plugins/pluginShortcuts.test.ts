import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLUGIN_RESERVED_SHORTCUTS } from '../../../../../contracts/piui-plugin-v2';
import type { PluginEntryV1 } from '../../../../../contracts/plugins-v1';
import { matchesPluginShortcut, resolveKeybindings } from './pluginShortcuts';

function plugin(id: string, keys: string[], permissions: PluginEntryV1['permissions'] = ['commands']): PluginEntryV1 {
  return {
    id,
    name: id,
    version: '1.0.0',
    publisher: 'Test',
    source: 'installed',
    enabled: true,
    active: true,
    permissions,
    codeHash: '0'.repeat(64),
    installedAt: '2026-09-27T00:00:00Z',
    problems: [],
    log: [],
    contributes: {
      commands: [{ id: 'run', title: 'Run', surfaces: ['palette'] }],
      settings: [],
      panels: [],
      themes: [],
      templates: [],
      nodeTypes: [],
      acpAgents: [],
      keybindings: keys.map((key) => ({ command: 'run', key })),
    },
    settings: {},
  };
}

const press = (code: string, key: string, modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe('plugin keybindings (plugins v2)', () => {
  it('lets PiUI win and disables a key two plugins share', () => {
    const resolved = resolveKeybindings([
      plugin('a', ['Mod+Alt+Shift+T', 'Mod+K']),
      plugin('b', ['Mod+Alt+Shift+T', 'Mod+Shift+F9']),
      plugin('no-commands', ['Mod+Shift+F10'], ['ui.status']),
    ]);
    const conflict = (id: string, key: string) => resolved.find((binding) => binding.plugin.id === id && binding.key === key)?.conflict;
    expect(conflict('a', 'Mod+K')).toEqual({ kind: 'piui' });
    expect(conflict('a', 'Mod+Alt+Shift+T')).toEqual({ kind: 'plugin', with: ['b'] });
    expect(conflict('b', 'Mod+Alt+Shift+T')).toEqual({ kind: 'plugin', with: ['a'] });
    expect(resolved.find((binding) => binding.key === 'Mod+Shift+F9')).toMatchObject({ plugin: { id: 'b' } });
    expect(conflict('b', 'Mod+Shift+F9')).toBeUndefined();
    // A plugin without `commands` runs nothing, so its bindings are not listed.
    expect(resolved.some((binding) => binding.plugin.id === 'no-commands')).toBe(false);
  });

  it('matches by physical key with exactly the declared modifiers', () => {
    expect(matchesPluginShortcut(press('KeyT', 'T', { ctrlKey: true, altKey: true, shiftKey: true }), 'Mod+Alt+Shift+T', false)).toBe(true);
    // macOS: ⌘ is Mod, and Alt changes `key` (⌥T is †).
    expect(matchesPluginShortcut(press('KeyT', '†', { metaKey: true, altKey: true, shiftKey: true }), 'Mod+Alt+Shift+T', true)).toBe(true);
    expect(matchesPluginShortcut(press('KeyT', 't', { ctrlKey: true, altKey: true, shiftKey: true }), 'Mod+Alt+Shift+T', true)).toBe(false);
    expect(matchesPluginShortcut(press('KeyT', 't', { ctrlKey: true, altKey: true }), 'Mod+Alt+Shift+T', false)).toBe(false);
    expect(matchesPluginShortcut(press('Digit1', '!', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+1', false)).toBe(true);
    expect(matchesPluginShortcut(press('F9', 'F9', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+F9', false)).toBe(true);
    expect(matchesPluginShortcut(press('KeyT', 't', { ctrlKey: true }), 'Ctrl+T', false)).toBe(false);
  });

  it('reserves every shortcut PiUI itself handles', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const found = new Set<string>();
    const walk = (folder: string) => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts')) {
          const text = readFileSync(path, 'utf8');
          for (const match of text.matchAll(/matchesShortcut\(event, '([^']+)'/g)) found.add(match[1] ?? '');
          for (const match of text.matchAll(/shortcut="(Mod\+[^"]+)"/g)) found.add(match[1] ?? '');
        }
      }
    };
    walk(root);
    expect(found.size).toBeGreaterThan(5);
    const reserved = new Set<string>(PLUGIN_RESERVED_SHORTCUTS);
    expect([...found].filter((shortcut) => shortcut.startsWith('Mod+') && !reserved.has(shortcut))).toEqual([]);
  }, 60_000);
});
