/**
 * PiUI plugin package format v2 (ADR-032, plugins v2): the `piui-plugin.json`
 * manifest with `schemaVersion: 2`.
 *
 * Version 2 only adds contributions — status-bar items, keybindings, chat
 * renderers and MCP servers — and the permissions they need (`ui.status`,
 * `ui.renderer`, `mcp.tools`).
 * A version 1 manifest stays valid with its exact v1 meaning
 * (`piui-plugin-v1.schema.json`); a v1 manifest cannot use the v2 fields or
 * permissions. Normative shape: `piui-plugin-v2.schema.json` (generated
 * standalone validator `piui-plugin-v2-validator.mjs`). The Rust host
 * (`crates/piui-plugins`) is the authority; the UI mirror and the SDK check
 * share the fixtures in `fixtures/plugins/`.
 */
import type { AcpAgentDescriptorV1 } from './harness-registry-v1';
import type {
  PluginCommandContributionV1,
  PluginFieldV1,
  PluginManifestV1,
  PluginNodeTypeContributionV1,
  PluginPanelContributionV1,
  PluginProblemCode as PluginProblemCodeV1,
  PluginTemplateContributionV1,
  PluginThemeContributionV1,
} from './piui-plugin-v1';

export * from './piui-plugin-v1';

/** Every manifest schema version PiUI accepts. */
export const PLUGIN_SCHEMA_VERSIONS = [1, 2] as const;
export type PluginSchemaVersion = (typeof PLUGIN_SCHEMA_VERSIONS)[number];

/**
 * Every permission a plugin can ask for, in the order the trust review lists
 * them. `ui.status`, `ui.renderer` and `mcp.tools` exist only in schema
 * version 2.
 */
export const PLUGIN_PERMISSIONS = [
  'commands',
  'ui.panel',
  'ui.settings',
  'ui.status',
  'ui.renderer',
  'node.run',
  'acp.agents',
  'mcp.tools',
  'chat.read',
  'notifications',
  'project.read',
  'project.write',
  'network',
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** Host rule codes of both versions (`ProblemCode` in `crates/piui-plugins`). */
export type PluginProblemCode = PluginProblemCodeV1 | 'unknown-command';

/**
 * A keyboard shortcut: `Mod` (Ctrl on Windows and Linux, ⌘ on macOS), then
 * optionally `Alt` and `Shift` in this order, then A-Z, 0-9 or F1-F12.
 */
export const PLUGIN_SHORTCUT_PATTERN = /^Mod(?:\+Alt)?(?:\+Shift)?\+(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/;

/**
 * Shortcuts PiUI keeps for itself: its own shortcuts and the text-editing
 * and window keys of the web view. A plugin keybinding on one of them never
 * runs and is shown as a conflict (PiUI always wins). Kept in step with the
 * app by `pluginShortcuts.test.ts`.
 */
export const PLUGIN_RESERVED_SHORTCUTS = [
  'Mod+N', 'Mod+K', 'Mod+,', 'Mod+.', 'Mod+Shift+I', 'Mod+Alt+B', 'Mod+F', 'Mod+Shift+G', 'Mod+Shift+M',
  'Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+S', 'Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Shift+V',
  'Mod+W', 'Mod+Q', 'Mod+R', 'Mod+Shift+R', 'Mod+P', 'Mod+T', 'Mod+Shift+T', 'Mod+0',
] as const;

export interface PluginStatusItemContributionV2 {
  id: string;
  /** 1-24 characters. */
  text: string;
  tooltip?: string;
  /** One of the plugin's own commands, run when the item is clicked. */
  command?: string;
  /** Default `end`. */
  alignment?: 'start' | 'end';
}

export interface PluginKeybindingContributionV2 {
  /** One of the plugin's own commands. */
  command: string;
  /** Matches `PLUGIN_SHORTCUT_PATTERN`. */
  key: string;
}

export interface PluginRendererContributionV2 {
  id: string;
  title: string;
  /** Native tool names, compared without letter case. */
  toolNames: string[];
}

/**
 * An MCP server in the package: `node <entry> <args>` under Node's permission
 * model, started by a harness for new chats once the person offers it
 * (Settings → Plugins), and only by harnesses that accept an MCP server for
 * one session. The person's own harness configuration is never changed.
 */
export interface PluginMcpServerContributionV2 {
  id: string;
  title: string;
  description?: string;
  /** A .mjs, .cjs or .js file in the package. */
  entry: string;
  /** Fixed arguments after the entry. */
  args?: string[];
}

export interface PluginManifestV2 {
  $schema?: string;
  schemaVersion: 2;
  id: string;
  name: string;
  version: string;
  publisher: string;
  description?: string;
  engines: { piui: string };
  permissions: PluginPermission[];
  backend?: { entry: string };
  ui?: { entry: string };
  contributes: {
    commands?: PluginCommandContributionV1[];
    settings?: PluginFieldV1[];
    panels?: PluginPanelContributionV1[];
    themes?: PluginThemeContributionV1[];
    templates?: PluginTemplateContributionV1[];
    acpAgents?: AcpAgentDescriptorV1[];
    nodeTypes?: PluginNodeTypeContributionV1[];
    statusItems?: PluginStatusItemContributionV2[];
    keybindings?: PluginKeybindingContributionV2[];
    renderers?: PluginRendererContributionV2[];
    mcpServers?: PluginMcpServerContributionV2[];
  };
}

/** A manifest of any supported version. */
export type PluginManifest = PluginManifestV1 | PluginManifestV2;
