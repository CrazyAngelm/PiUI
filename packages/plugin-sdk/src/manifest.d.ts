/**
 * `piui-plugin.json` types for schema versions 1 and 2; the normative
 * schemas are contracts/piui-plugin-v1.schema.json and
 * contracts/piui-plugin-v2.schema.json. New plugins use version 2.
 */
export type {
  PluginCommandContributionV1,
  PluginFieldV1,
  PluginKeybindingContributionV2,
  PluginManifest,
  PluginManifestV1,
  PluginManifestV2,
  PluginNodeTypeContributionV1,
  PluginPanelContributionV1,
  PluginPermission,
  PluginRendererContributionV2,
  PluginStatusItemContributionV2,
  PluginTemplateContributionV1,
  PluginThemeContributionV1,
  PluginThemeToken,
  PluginValue,
} from '../../../contracts/piui-plugin-v2';
export {
  PLUGIN_LIMITS,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_PERMISSIONS,
  PLUGIN_RESERVED_SHORTCUTS,
  PLUGIN_SCHEMA_VERSIONS,
  PLUGIN_SHORTCUT_PATTERN,
  PLUGIN_THEME_TOKENS,
} from '../../../contracts/piui-plugin-v2';
