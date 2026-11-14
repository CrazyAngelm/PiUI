import type { PluginVisualStyleV1 } from '../../../../../contracts/piui-plugin-v3';
import type { PluginStyleSnapshotV1 } from '../../../../../contracts/plugin-style-v1';
import type { PluginThemeRefV1 } from '../../../../../contracts/plugins-v1';
import { isPluginVisualStyle } from '../../host-api/pluginStyleClient';

/** Values are the existing tokens.css radius scale, font stacks and Nano/Chaos shapes. */
const CORNERS = {
  square: ['0px', '0px', '0px', '0px'],
  soft: ['4px', '6px', '10px', '16px'],
  round: ['6px', '10px', '16px', '16px'],
} as const;
const SHAPES = {
  line: 'polygon(0 0, 100% 0, 96% 100%, 0 100%)',
  marker: 'polygon(40% 0, 100% 0, 60% 100%, 0 100%)',
  badge: 'polygon(8% 0, 100% 0, 92% 100%, 0 100%)',
  capability: 'polygon(22% 0, 100% 0, 78% 100%, 0 100%)',
  gauge: 'polygon(14% 0, 100% 0, 86% 100%, 0 100%)',
  meter: 'polygon(0 0, 100% 0, 99% 100%, 0 100%)',
} as const;
const SYSTEM_FONT = '"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
const applied = new WeakMap<HTMLElement, Set<string>>();

export function applyPluginVisualStyle(style: PluginVisualStyleV1 | undefined, root: HTMLElement): void {
  for (const name of applied.get(root) ?? []) root.style.removeProperty(name);
  applied.delete(root);
  delete root.dataset.pluginStyle;
  if (!isPluginVisualStyle(style)) return;
  const names = new Set<string>();
  const set = (token: string, value: string) => {
    const name = `--piui-${token}`;
    root.style.setProperty(name, value);
    names.add(name);
  };
  if (style.corners) {
    const radii = CORNERS[style.corners];
    ['xs', 'sm', 'md', 'lg'].forEach((size, index) => set(`radius-${size}`, radii[index]));
  }
  if (style.ornaments) {
    for (const [shape, value] of Object.entries(SHAPES)) set(`decoration-${shape}-shape`, style.ornaments === 'plain' ? 'none' : value);
    set('decoration-gauge-tilt', style.ornaments === 'plain' ? '0deg' : '-12deg');
    set('decoration-gauge-overhang', style.ornaments === 'plain' ? '0px' : '7px');
    set('decoration-radius', style.ornaments === 'plain' ? 'var(--piui-radius-sm)' : '0px');
  }
  if (style.font) set('font-ui', style.font === 'mono' ? 'var(--piui-font-mono)' : SYSTEM_FONT);
  applied.set(root, names);
  root.dataset.pluginStyle = 'true';
}

/** Cleanup invalidates an in-flight response before another theme, appearance or safe-mode state wins. */
export function followPluginVisualStyle(
  root: HTMLElement,
  owner: { revision: number; theme: PluginThemeRefV1 } | undefined,
  read: () => Promise<PluginStyleSnapshotV1>,
): () => void {
  let current = true;
  applyPluginVisualStyle(undefined, root);
  if (owner) void read().then((snapshot) => {
    if (current && snapshot.revision === owner.revision && snapshot.theme?.pluginId === owner.theme.pluginId && snapshot.theme.themeId === owner.theme.themeId) {
      applyPluginVisualStyle(snapshot.style, root);
    }
  }).catch(() => { /* A missing/failed optional contribution keeps the built-in style. */ });
  return () => { current = false; applyPluginVisualStyle(undefined, root); };
}
