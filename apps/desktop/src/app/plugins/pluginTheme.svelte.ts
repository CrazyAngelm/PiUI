import { PLUGIN_THEME_TOKENS } from '../../../../../contracts/piui-plugin-v1';
import type { PluginThemeV1 } from '../../../../../contracts/plugins-v1';
import { currentAppearance } from '../../host-api/pluginBridge';
import { parseColor } from '../../host-api/pluginColor';
import { pluginRegistry } from './pluginRegistry.svelte';
import { readPluginStyle } from '../../host-api/pluginStyleClient';
import { followPluginVisualStyle } from './pluginVisualStyle';

/**
 * Plugin themes (ADR-032): validated colors and declarative style presets applied as `--piui-*`
 * custom properties on the root element (CSSOM, allowed by the app CSP).
 * A theme applies only while PiUI shows its appearance, so choosing Light,
 * Dark or System always wins, and safe mode (no active plugin) applies none.
 * Started after first paint.
 */
const applied = new Set<string>();

export function applyPluginTheme(theme: PluginThemeV1 | undefined, root: HTMLElement): void {
  for (const name of applied) root.style.removeProperty(name);
  applied.clear();
  delete root.dataset.pluginTheme;
  if (theme === undefined) return;
  for (const [token, value] of Object.entries(theme.tokens)) {
    // The host validated the theme; check again before touching the document.
    if (!(PLUGIN_THEME_TOKENS as readonly string[]).includes(token) || parseColor(value) === undefined) continue;
    const name = `--piui-${token}`;
    root.style.setProperty(name, value);
    applied.add(name);
  }
  root.dataset.pluginTheme = theme.id;
}

let started = false;

export function startPluginTheme(): void {
  if (started || typeof document === 'undefined' || typeof window === 'undefined') return;
  started = true;
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let appearance = $state(currentAppearance(root, media.matches));
  const update = () => {
    appearance = currentAppearance(root, media.matches);
  };
  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  media.addEventListener('change', update);
  $effect.root(() => {
    $effect(() => {
      const theme = pluginRegistry.activeTheme();
      const visible = theme !== undefined && theme.appearance === appearance;
      applyPluginTheme(visible ? theme : undefined, root);
      const selected = pluginRegistry.registry?.activeTheme;
      return followPluginVisualStyle(root, visible && selected ? { revision: pluginRegistry.revision, theme: selected } : undefined, readPluginStyle);
    });
  });
  void pluginRegistry.start();
}
