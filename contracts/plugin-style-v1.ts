import type { PluginVisualStyleV1 } from './piui-plugin-v3';
import type { PluginThemeRefV1 } from './plugins-v1';

/** Read-only `plugin_style_v1({ request: {} })`; no change to the plugins_v1 payload. */
export interface PluginStyleSnapshotV1 {
  protocol: 1;
  revision: number;
  /** Present only when the selected theme's plugin is active, including safe-mode checks. */
  theme?: PluginThemeRefV1;
  style?: PluginVisualStyleV1;
}
