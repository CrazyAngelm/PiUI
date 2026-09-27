import { PLUGIN_RESERVED_SHORTCUTS, PLUGIN_SHORTCUT_PATTERN } from '../../../../../contracts/piui-plugin-v2';
import type { PluginCommandV1, PluginEntryV1 } from '../../../../../contracts/plugins-v1';

/**
 * Plugin keybindings (plugins v2). PiUI's own shortcuts always win: a
 * binding on a reserved shortcut never runs, and two active plugins that
 * bind the same key both lose it. Conflicts are shown in Settings → Plugins
 * instead of being resolved silently in someone's favor.
 */
export type KeybindingConflict = { kind: 'piui' } | { kind: 'plugin'; with: string[] };

export interface ResolvedKeybinding {
  readonly key: string;
  readonly plugin: PluginEntryV1;
  readonly command: PluginCommandV1;
  /** Absent: the binding runs its command. */
  readonly conflict?: KeybindingConflict;
}

const RESERVED: ReadonlySet<string> = new Set(PLUGIN_RESERVED_SHORTCUTS);

/** Every keybinding of the active plugins that may run commands, with its conflict. */
export function resolveKeybindings(active: readonly PluginEntryV1[]): ResolvedKeybinding[] {
  const bindings = active
    .filter((plugin) => plugin.permissions.includes('commands'))
    .flatMap((plugin) =>
      (plugin.contributes.keybindings ?? []).flatMap((binding) => {
        const command = plugin.contributes.commands.find((item) => item.id === binding.command);
        return command && PLUGIN_SHORTCUT_PATTERN.test(binding.key) ? [{ key: binding.key, plugin, command }] : [];
      }),
    );
  return bindings.map((binding) => {
    if (RESERVED.has(binding.key)) return { ...binding, conflict: { kind: 'piui' } };
    const others = [...new Set(bindings.filter((other) => other.key === binding.key && other.plugin.id !== binding.plugin.id).map((other) => other.plugin.name))];
    return others.length ? { ...binding, conflict: { kind: 'plugin', with: others } } : binding;
  });
}

type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/**
 * Whether `event` is the shortcut `key` (`Mod(+Alt)?(+Shift)?+<key>`). Keys
 * are matched by physical code, so Shift and Alt (which change `event.key`,
 * for example on macOS) do not break a binding.
 */
export function matchesPluginShortcut(event: KeyEvent, key: string, mac: boolean): boolean {
  if (!PLUGIN_SHORTCUT_PATTERN.test(key)) return false;
  const parts = key.split('+');
  const main = parts.at(-1) ?? '';
  const alt = parts.includes('Alt');
  const shift = parts.includes('Shift');
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey !== alt || event.shiftKey !== shift) return false;
  if (/^[A-Z]$/.test(main)) return event.code === `Key${main}`;
  if (/^[0-9]$/.test(main)) return event.code === `Digit${main}`;
  return event.key === main || event.code === main;
}
