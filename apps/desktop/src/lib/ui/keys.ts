/** Platform-aware keyboard shortcut labels. Windows/Linux show Ctrl, macOS shows ⌘. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Escape: 'Esc' };

export function shortcutParts(shortcut: string, mac = isMac): string[] {
  return shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part === 'Mod') return mac ? MAC_SYMBOLS.Mod : 'Ctrl';
      return mac ? (MAC_SYMBOLS[part] ?? part) : part;
    });
}

/** True when a keyboard event matches a shortcut string like "Mod+K" or "Shift+Escape". */
export function matchesShortcut(event: KeyboardEvent, shortcut: string, mac = isMac): boolean {
  const parts = shortcut.split('+').map((part) => part.trim().toLowerCase());
  const key = parts.pop() ?? '';
  const wantMod = parts.includes('mod');
  const wantCtrl = parts.includes('ctrl') || (wantMod && !mac);
  const wantMeta = parts.includes('meta') || (wantMod && mac);
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt');
  if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta) return false;
  if (event.shiftKey !== wantShift || event.altKey !== wantAlt) return false;
  const pressed = event.key.toLowerCase();
  return pressed === key || (key === 'escape' && pressed === 'esc') || event.code.toLowerCase() === `key${key}`;
}
