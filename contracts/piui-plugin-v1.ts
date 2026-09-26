/**
 * PiUI plugin package format v1 (ADR-032): the `piui-plugin.json` manifest.
 *
 * Normative shape: `piui-plugin-v1.schema.json` (generated standalone validator
 * `piui-plugin-v1-validator.mjs`). The Rust host (`crates/piui-plugins`) is the
 * authority; `apps/desktop/src/host-api/pluginManifest.ts` mirrors its semantic
 * rules for the UI Lab, the SDK check script and contract tests. Both share the
 * fixtures in `fixtures/plugins/`. Unknown fields are rejected, never dropped,
 * and validating a manifest never runs plugin code.
 */
import type { AcpAgentDescriptorV1 } from './harness-registry-v1';

export const PLUGIN_MANIFEST_FILE = 'piui-plugin.json' as const;
export const PLUGIN_SCHEMA_VERSION = 1 as const;

/** Every permission a plugin can ask for, in the order the trust review lists them. */
export const PLUGIN_PERMISSIONS = [
  'commands',
  'ui.panel',
  'ui.settings',
  'node.run',
  'acp.agents',
  'chat.read',
  'notifications',
  'project.read',
  'project.write',
  'network',
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/**
 * Semantic color tokens a theme may override (`--piui-<name>`). The list is
 * the color scale of `apps/desktop/src/styles/tokens.css`; spacing, type and
 * layout tokens are not themable.
 */
export const PLUGIN_THEME_TOKENS = [
  'bg', 'bg-raised', 'bg-sunken', 'surface-1', 'surface-2', 'surface-3', 'overlay',
  'hover', 'pressed', 'selected', 'selected-strong',
  'text', 'text-muted', 'text-faint', 'text-disabled',
  'border', 'border-subtle', 'border-strong',
  'accent', 'accent-ink', 'accent-soft', 'action', 'action-hover', 'action-pressed', 'action-ink', 'focus',
  'danger', 'warning', 'success', 'info',
  'danger-surface', 'danger-border', 'danger-text',
  'warning-surface', 'warning-border', 'warning-text',
  'success-surface', 'success-border', 'success-text',
  'info-surface', 'info-border', 'info-text',
  'user-surface', 'user-border', 'code-surface',
  'syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-comment', 'syntax-function', 'syntax-type', 'syntax-property', 'syntax-punctuation',
  'diff-add', 'diff-add-text', 'diff-remove', 'diff-remove-text',
] as const;
export type PluginThemeToken = (typeof PLUGIN_THEME_TOKENS)[number];

/** Package limits the host enforces before anything is copied. */
export const PLUGIN_LIMITS = {
  manifestBytes: 64 * 1024,
  packageBytes: 20 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  files: 2000,
  pathDepth: 16,
  templateBytes: 1024 * 1024,
  /** Largest stored settings document or node configuration, encoded. */
  valuesBytes: 64 * 1024,
  /** Default and range of a node type's timeout, in seconds. */
  nodeTimeoutSeconds: 60,
  minNodeTimeoutSeconds: 1,
  maxNodeTimeoutSeconds: 3600,
} as const;

export type PluginFieldType = 'text' | 'long-text' | 'number' | 'boolean' | 'choice';
export type PluginValue = string | number | boolean;

/** One declarative form field PiUI renders: plugin settings and node configuration. */
export interface PluginFieldV1 {
  key: string;
  label: string;
  description?: string;
  type: PluginFieldType;
  required?: boolean;
  /** Matches `type`: text, long-text and choice take a string, number a number, boolean a boolean. */
  default?: PluginValue;
  /** `number` only. */
  minimum?: number;
  maximum?: number;
  /** `text` and `long-text` only (1-4000). */
  maxLength?: number;
  /** `choice` only: unique values. */
  options?: { value: string; label: string }[];
}

export interface PluginCommandContributionV1 {
  id: string;
  title: string;
  description?: string;
  /** Default `['palette']`. */
  surfaces?: ('palette' | 'composer')[];
  /** Declarative: prepared in the message box for review. Absent: the backend runs `command/execute`. */
  insertText?: string;
}

export interface PluginPanelContributionV1 {
  id: string;
  title: string;
  location: 'chat-details';
}

export interface PluginThemeContributionV1 {
  id: string;
  label: string;
  appearance: 'dark' | 'light';
  tokens: Partial<Record<PluginThemeToken, string>>;
}

export interface PluginTemplateContributionV1 {
  id: string;
  title: string;
  description?: string;
  /** A portable system file (version 4) inside the package. */
  file: string;
}

export interface PluginNodeTypeContributionV1 {
  id: string;
  title: string;
  description?: string;
  config?: PluginFieldV1[];
  /** 1-3600, default 60. */
  timeoutSeconds?: number;
  /** Result fields a new node of this type starts with. */
  resultFields?: { name: string; kind: 'text' | 'number' | 'boolean' | 'text-list' }[];
}

export interface PluginManifestV1 {
  $schema?: string;
  schemaVersion: 1;
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
  };
}

/**
 * Stable codes of the host's manifest and package rules (`PluginManifestError`
 * and `PackageError` in `crates/piui-plugins`), shared by both validators and
 * the fixtures. The messages are English locale keys.
 */
export type PluginProblemCode =
  | 'malformed'
  | 'too-large'
  | 'schema-version'
  | 'shape'
  | 'engine-range'
  | 'engine-mismatch'
  | 'permission-missing'
  | 'backend-missing'
  | 'ui-missing'
  | 'duplicate-contribution'
  | 'field'
  | 'theme-color'
  | 'theme-contrast'
  | 'acp-descriptor'
  | 'text'
  | 'not-a-package'
  | 'file-missing'
  | 'path'
  | 'package-too-large'
  | 'archive'
  | 'template'
  | 'integrity';
