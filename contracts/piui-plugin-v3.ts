/** Manifest v3 adds declarative visual style to a theme. v1/v2 keep their exact schemas. */
import type { PluginManifest as EarlierManifest, PluginManifestV2 } from './piui-plugin-v2';
import type { PluginThemeContributionV1 } from './piui-plugin-v1';
export * from './piui-plugin-v2';

export const PLUGIN_SCHEMA_VERSIONS = [1, 2, 3] as const;
export type PluginSchemaVersion = (typeof PLUGIN_SCHEMA_VERSIONS)[number];

/** Finite choices from the shipped token scales, never executable CSS or arbitrary lengths. */
export interface PluginVisualStyleV1 {
  corners?: 'square' | 'soft' | 'round';
  ornaments?: 'plain' | 'slanted';
  font?: 'system' | 'mono';
}
export interface PluginThemeContributionV3 extends PluginThemeContributionV1 {
  style?: PluginVisualStyleV1;
}
export interface PluginManifestV3 extends Omit<PluginManifestV2, 'schemaVersion' | 'contributes'> {
  schemaVersion: 3;
  contributes: Omit<PluginManifestV2['contributes'], 'themes'> & { themes?: PluginThemeContributionV3[] };
}
export type PluginManifest = EarlierManifest | PluginManifestV3;
