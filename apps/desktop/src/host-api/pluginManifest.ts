import validateSchema from '../../../../contracts/piui-plugin-v1-validator.mjs';
import type { PluginProblemV1 } from '../../../../contracts/plugins-v1';
import type {
  PluginFieldV1,
  PluginManifestV1,
  PluginPermission,
  PluginProblemCode,
  PluginValue,
} from '../../../../contracts/piui-plugin-v1';
import { PLUGIN_LIMITS } from '../../../../contracts/piui-plugin-v1';
import { ACP_DESCRIPTOR_PROBLEMS, checkAcpDescriptor } from './acpDescriptor';

/**
 * Plugin package format v1 rules mirrored from the host
 * (`crates/piui-plugins`), so the UI Lab host rejects what the desktop host
 * rejects, the settings and node forms check values exactly like the host,
 * and `pnpm plugin:check` explains problems before a package is loaded. The
 * host stays authoritative and validates everything again. Messages are the
 * host's fixed English locale keys; `pluginManifest.test.ts` runs the shared
 * fixtures in `contracts/fixtures/plugins/` through both.
 */

export type PluginProblem = PluginProblemV1;

const problem = (code: PluginProblemCode, message: string, subject: string | undefined = undefined, detail: string | undefined = undefined): PluginProblem => ({
  code,
  message,
  ...(subject === undefined ? {} : { subject }),
  ...(detail === undefined ? {} : { detail }),
});

// ---- versions ---------------------------------------------------------------

interface Version {
  core: [number, number, number];
  pre: string[];
}

export function parseVersion(text: string): Version | undefined {
  const [core, ...rest] = text.split('-');
  const pre = rest.length ? rest.join('-') : undefined;
  const parts = (core ?? '').split('.');
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const identifiers = pre === undefined ? [] : pre.split('.');
  if (identifiers.some((identifier) => !/^[0-9A-Za-z-]+$/.test(identifier))) return undefined;
  return { core: parts.map(Number) as [number, number, number], pre: identifiers };
}

function compareCore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function compareVersions(left: Version, right: Version): number {
  const core = compareCore(left.core, right.core);
  if (core !== 0) return core;
  if (left.pre.length === 0 || right.pre.length === 0) return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.min(left.pre.length, right.pre.length); index += 1) {
    const [a, b] = [left.pre[index] ?? '', right.pre[index] ?? ''];
    const [numericA, numericB] = [/^\d+$/.test(a), /^\d+$/.test(b)];
    const order = numericA && numericB ? Math.sign(Number(a) - Number(b)) : numericA ? -1 : numericB ? 1 : a < b ? -1 : a > b ? 1 : 0;
    if (order !== 0) return order;
  }
  return Math.sign(left.pre.length - right.pre.length);
}

/** `engines.piui`: one to four space-separated comparators that must all match. */
export function rangeMatches(range: string, current: string): boolean | undefined {
  const version = parseVersion(current);
  if (range === '' || range !== range.trim() || range.includes('  ') || version === undefined) return undefined;
  const tokens = range.split(' ');
  if (tokens.length > 4) return undefined;
  let matches = true;
  for (const token of tokens) {
    const operator = ['>=', '<=', '>', '<', '=', '^', '~'].find((prefix) => token.startsWith(prefix)) ?? '';
    const bound = parseVersion(token.slice(operator.length));
    if (bound === undefined) return undefined;
    const order = compareVersions(version, bound);
    const [major, minor, patch] = bound.core;
    switch (operator) {
      case '>=': matches &&= order >= 0; break;
      case '>': matches &&= order > 0; break;
      case '<=': matches &&= order <= 0; break;
      case '<': matches &&= order < 0; break;
      case '^': {
        const ceiling: [number, number, number] = major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
        matches &&= order >= 0 && compareCore(version.core, ceiling) < 0;
        break;
      }
      case '~': matches &&= order >= 0 && compareCore(version.core, [major, minor + 1, 0]) < 0; break;
      default: matches &&= order === 0;
    }
  }
  return matches;
}

// ---- colors ------------------------------------------------------------------

export interface Rgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or `rgba(r, g, b, a)`. */
export function parseColor(text: string): Rgba | undefined {
  if (text.length > 40) return undefined;
  const hex = /^#([0-9A-Fa-f]+)$/.exec(text)?.[1];
  if (hex !== undefined) {
    const digit = (index: number) => parseInt(hex[index] ?? '0', 16) * 17;
    const pair = (index: number) => parseInt(hex.slice(index, index + 2), 16);
    if (hex.length === 3 || hex.length === 4) return { red: digit(0), green: digit(1), blue: digit(2), alpha: hex.length === 4 ? digit(3) / 255 : 1 };
    if (hex.length === 6 || hex.length === 8) return { red: pair(0), green: pair(2), blue: pair(4), alpha: hex.length === 8 ? pair(6) / 255 : 1 };
    return undefined;
  }
  const match = /^(rgba?)\((.*)\)$/.exec(text);
  if (!match) return undefined;
  const parts = (match[2] ?? '').split(',').map((part) => part.trim());
  if (match[1] === 'rgb' ? parts.length !== 3 : parts.length !== 3 && parts.length !== 4) return undefined;
  const channels = parts.slice(0, 3).map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (channels.some((value) => !(value >= 0 && value <= 255))) return undefined;
  let alpha = 1;
  if (parts[3] !== undefined) {
    if (!/^(?:0|1|0?\.\d{1,3})$/.test(parts[3])) return undefined;
    alpha = Number(parts[3]);
  }
  return { red: channels[0] ?? 0, green: channels[1] ?? 0, blue: channels[2] ?? 0, alpha };
}

const linear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (color: Rgba): number => 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const mix = (upper: number, lower: number) => Math.min(255, Math.max(0, Math.round(upper * top.alpha + lower * (1 - top.alpha))));
  return { red: mix(top.red, bottom.red), green: mix(top.green, bottom.green), blue: mix(top.blue, bottom.blue), alpha: 1 };
};

/** WCAG contrast; a translucent background is judged over black and white. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const backdrops = background.alpha < 1
    ? [over(background, { red: 0, green: 0, blue: 0, alpha: 1 }), over(background, { red: 255, green: 255, blue: 255, alpha: 1 })]
    : [background];
  return Math.min(
    ...backdrops.map((backdrop) => {
      const [a, b] = [luminance(over(foreground, backdrop)), luminance(backdrop)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }),
  );
}

export const CONTRAST_PAIRS: readonly (readonly [string, string, number])[] = [
  ['text', 'bg', 4.5],
  ['text', 'surface-1', 4.5],
  ['text-muted', 'bg', 4.5],
  ['action-ink', 'action', 4.5],
  ['accent-ink', 'accent', 4.5],
];

// ---- fields ------------------------------------------------------------------

export const DEFAULT_TEXT_CHARS = 1000;
export const MAX_TEXT_CHARS = 4000;

export const FIELD_RULES = {
  duplicateKey: 'Two fields use the key “{0}”.',
  optionsNotAllowed: 'Field “{0}” has options, but only choice fields can.',
  optionsRequired: 'Choice field “{0}” needs options.',
  duplicateOption: 'Choice field “{0}” repeats an option value.',
  rangeNotAllowed: 'Field “{0}” has a minimum or maximum, but only number fields can.',
  range: 'Field “{0}” has a minimum above its maximum.',
  lengthNotAllowed: 'Field “{0}” has maxLength, but only text fields can.',
  defaultType: 'The default of field “{0}” does not match its type.',
  defaultOutOfRange: 'The default of field “{0}” is not an allowed value.',
} as const;

export const VALUE_ISSUES = {
  unknown: '“{0}” is not a declared field.',
  type: '“{0}” has a value of the wrong type.',
  required: '“{0}” is required.',
  tooLong: '“{0}” is too long.',
  range: '“{0}” is outside its allowed range.',
  choice: '“{0}” is not one of its options.',
  characters: '“{0}” contains control characters.',
  tooLarge: 'The values are larger than 64 KiB.',
} as const;
export type ValueIssue = keyof typeof VALUE_ISSUES;

const chars = (text: string): number => [...text].length;

function textLimit(field: PluginFieldV1): number {
  return Math.min(field.maxLength ?? (field.type === 'long-text' ? MAX_TEXT_CHARS : DEFAULT_TEXT_CHARS), MAX_TEXT_CHARS);
}

/** Why `value` does not fit `field`, or undefined. */
export function valueIssue(field: PluginFieldV1, value: unknown): Exclude<ValueIssue, 'unknown' | 'required' | 'tooLarge'> | undefined {
  switch (field.type) {
    case 'text':
    case 'long-text': {
      if (typeof value !== 'string') return 'type';
      const multiline = field.type === 'long-text';
      if ([...value].some((character) => /[\u0000-\u001f\u007f-\u009f]/u.test(character) && !(multiline && (character === '\n' || character === '\t')))) return 'characters';
      return chars(value) > textLimit(field) ? 'tooLong' : undefined;
    }
    case 'number':
      if (typeof value !== 'number') return 'type';
      return !Number.isFinite(value) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum) ? 'range' : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'type';
    case 'choice':
      if (typeof value !== 'string') return 'type';
      return (field.options ?? []).some((option) => option.value === value) ? undefined : 'choice';
    default: {
      const exhaustive: never = field.type;
      return exhaustive;
    }
  }
}

/** `validate_fields`: the first declaration rule a form breaks. */
export function fieldsIssue(fields: readonly PluginFieldV1[]): { message: string; key: string } | undefined {
  for (const [index, field] of fields.entries()) {
    const fail = (message: string) => ({ message, key: field.key });
    if (fields.slice(0, index).some((other) => other.key === field.key)) return fail(FIELD_RULES.duplicateKey);
    if (field.type === 'choice') {
      if (field.options === undefined) return fail(FIELD_RULES.optionsRequired);
      if (new Set(field.options.map((option) => option.value)).size !== field.options.length) return fail(FIELD_RULES.duplicateOption);
    } else if (field.options !== undefined) return fail(FIELD_RULES.optionsNotAllowed);
    if (field.type !== 'number' && (field.minimum !== undefined || field.maximum !== undefined)) return fail(FIELD_RULES.rangeNotAllowed);
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) return fail(FIELD_RULES.range);
    if (field.type !== 'text' && field.type !== 'long-text' && field.maxLength !== undefined) return fail(FIELD_RULES.lengthNotAllowed);
    if (field.default !== undefined) {
      const issue = valueIssue(field, field.default);
      if (issue === 'type') return fail(FIELD_RULES.defaultType);
      if (issue !== undefined) return fail(FIELD_RULES.defaultOutOfRange);
    }
  }
  return undefined;
}

export type ResolvedValues =
  | { ok: true; values: Record<string, PluginValue> }
  | { ok: false; issue: ValueIssue; key: string; message: string };

const blank = (value: unknown): boolean => typeof value === 'string' && value.trim() === '';

/** `resolve_values`: checked values with defaults for absent keys; unknown keys are refused. */
export function resolvePluginValues(fields: readonly PluginFieldV1[], values: Readonly<Record<string, unknown>>): ResolvedValues {
  const fail = (issue: ValueIssue, key: string): ResolvedValues => ({ ok: false, issue, key, message: VALUE_ISSUES[issue] });
  for (const key of Object.keys(values)) if (!fields.some((field) => field.key === key)) return fail('unknown', key);
  const resolved: Record<string, PluginValue> = {};
  for (const field of fields) {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : field.default;
    if (value === undefined) {
      if (field.required === true) return fail('required', field.key);
      continue;
    }
    const issue = valueIssue(field, value);
    if (issue !== undefined) return fail(issue, field.key);
    if (field.required === true && blank(value)) return fail('required', field.key);
    resolved[field.key] = value as PluginValue;
  }
  if (new TextEncoder().encode(JSON.stringify(resolved)).length > PLUGIN_LIMITS.valuesBytes) return fail('tooLarge', '');
  return { ok: true, values: resolved };
}

// ---- manifest ----------------------------------------------------------------

export const MANIFEST_MESSAGES = {
  tooLarge: 'The manifest is larger than 64 KiB.',
  malformed: 'piui-plugin.json is not valid JSON.',
  schemaVersion: 'Only plugin manifest schema version 1 is supported.',
  shape: 'The manifest does not match the plugin schema at {0}.',
  engineRange: 'The PiUI version range “{0}” is not valid.',
  permissionMissing: 'The plugin contributes {0} but does not ask for the matching permission.',
  backendCommand: "The command “{0}” runs in the plugin's backend, but the plugin has no backend.",
  backendNodes: "Node types run in the plugin's backend, but the plugin has no backend.",
  uiMissing: 'The plugin contributes panels but has no ui.entry page.',
  duplicate: 'Two contributions of the same kind use the id “{0}”.',
  duplicateResult: 'A node type repeats the result field “{0}”.',
  text: 'The text of command “{0}” is empty or contains control characters.',
  themeColor: 'Theme “{0}” has a color PiUI cannot use.',
  themeContrast: 'Theme text is hard to read: {0} needs a contrast of at least 4.5:1.',
  acpDescriptor: 'ACP agent “{0}” is not a valid descriptor.',
} as const;

export const PERMISSION_HINTS: Readonly<Partial<Record<PluginPermission, string>>> = {
  commands: 'Add the permission “commands”.',
  'ui.panel': 'Add the permission “ui.panel”.',
  'ui.settings': 'Add the permission “ui.settings”.',
  'node.run': 'Add the permission “node.run”.',
  'acp.agents': 'Add the permission “acp.agents”.',
};

export type ManifestCheck =
  | { ok: true; manifest: PluginManifestV1; compatible: boolean }
  | { ok: false; problems: PluginProblem[] };

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const id of ids) {
    if (seen.has(id) && !repeated.includes(id)) repeated.push(id);
    seen.add(id);
  }
  return repeated;
}

function dedupe(problems: PluginProblem[]): PluginProblem[] {
  const seen = new Set<string>();
  return problems.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `parse_manifest` on already parsed JSON. */
export function checkPluginManifest(value: unknown, piuiVersion: string): ManifestCheck {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  if (record === undefined || !('schemaVersion' in record)) return { ok: false, problems: [problem('shape', MANIFEST_MESSAGES.shape, '/schemaVersion')] };
  if (record.schemaVersion !== 1) return { ok: false, problems: [problem('schema-version', MANIFEST_MESSAGES.schemaVersion)] };
  if (!validateSchema(value)) {
    const shape = (validateSchema.errors ?? []).slice(0, 20).map((error) => problem('shape', MANIFEST_MESSAGES.shape, error.instancePath || '/'));
    return { ok: false, problems: dedupe(shape) };
  }
  const manifest = value as PluginManifestV1;
  const contributes = manifest.contributes;
  const problems: PluginProblem[] = [];
  if (rangeMatches(manifest.engines.piui, '0.0.0') === undefined) problems.push(problem('engine-range', MANIFEST_MESSAGES.engineRange, manifest.engines.piui));
  const has = (permission: PluginPermission) => manifest.permissions.includes(permission);
  const require = (permission: PluginPermission, contribution: string) => {
    if (!has(permission)) problems.push(problem('permission-missing', MANIFEST_MESSAGES.permissionMissing, contribution, PERMISSION_HINTS[permission] ?? 'Add the matching permission.'));
  };
  const commands = contributes.commands ?? [];
  if (commands.length) require('commands', 'commands');
  for (const command of commands) {
    if (command.insertText === undefined && manifest.backend === undefined) problems.push(problem('backend-missing', MANIFEST_MESSAGES.backendCommand, command.id));
  }
  if ((contributes.settings ?? []).length) require('ui.settings', 'settings');
  if ((contributes.panels ?? []).length) {
    require('ui.panel', 'panels');
    if (manifest.ui === undefined) problems.push(problem('ui-missing', MANIFEST_MESSAGES.uiMissing));
  }
  const nodeTypes = contributes.nodeTypes ?? [];
  if (nodeTypes.length) {
    require('node.run', 'node types');
    if (manifest.backend === undefined) problems.push(problem('backend-missing', MANIFEST_MESSAGES.backendNodes));
  }
  if ((contributes.acpAgents ?? []).length) require('acp.agents', 'ACP agents');
  for (const list of [commands, contributes.panels ?? [], contributes.themes ?? [], contributes.templates ?? [], nodeTypes]) {
    for (const id of duplicates(list.map((item) => item.id))) problems.push(problem('duplicate-contribution', MANIFEST_MESSAGES.duplicate, id));
  }
  for (const node of nodeTypes) {
    for (const name of duplicates((node.resultFields ?? []).map((field) => field.name))) problems.push(problem('duplicate-contribution', MANIFEST_MESSAGES.duplicateResult, name));
  }
  for (const command of commands) {
    const text = command.insertText;
    if (text !== undefined && (text.trim() === '' || [...text].some((character) => /[\u0000-\u001f\u007f-\u009f]/u.test(character) && character !== '\n' && character !== '\t'))) {
      problems.push(problem('text', MANIFEST_MESSAGES.text, command.id));
    }
  }
  for (const fields of [contributes.settings ?? [], ...nodeTypes.map((node) => node.config ?? [])]) {
    const issue = fieldsIssue(fields);
    if (issue !== undefined) problems.push(problem('field', issue.message, issue.key));
  }
  for (const theme of contributes.themes ?? []) {
    const colors = new Map<string, Rgba>();
    for (const [token, text] of Object.entries(theme.tokens)) {
      const color = typeof text === 'string' ? parseColor(text) : undefined;
      if (color === undefined) problems.push(problem('theme-color', MANIFEST_MESSAGES.themeColor, theme.id));
      else colors.set(token, color);
    }
    for (const [text, background, minimum] of CONTRAST_PAIRS) {
      const [foreground, backdrop] = [colors.get(text), colors.get(background)];
      if (foreground && backdrop && contrastRatio(foreground, backdrop) < minimum) {
        problems.push(problem('theme-contrast', MANIFEST_MESSAGES.themeContrast, `${theme.id} ${text}/${background}`));
      }
    }
  }
  const agentIds: string[] = [];
  for (const [index, descriptor] of (contributes.acpAgents ?? []).entries()) {
    const checked = checkAcpDescriptor(descriptor);
    const label = typeof (descriptor as { id?: unknown }).id === 'string' ? String((descriptor as { id: string }).id) : `#${index + 1}`;
    if (checked.ok) agentIds.push(checked.descriptor.id);
    else problems.push(problem('acp-descriptor', MANIFEST_MESSAGES.acpDescriptor, label, ACP_DESCRIPTOR_PROBLEMS[checked.problem]));
  }
  for (const id of duplicates(agentIds)) problems.push(problem('duplicate-contribution', MANIFEST_MESSAGES.duplicate, id));
  if (problems.length) return { ok: false, problems: dedupe(problems) };
  return { ok: true, manifest, compatible: rangeMatches(manifest.engines.piui, piuiVersion) === true };
}

/** `parse_manifest` on the file's text. */
export function checkPluginManifestText(text: string, piuiVersion: string): ManifestCheck {
  if (new TextEncoder().encode(text).length > PLUGIN_LIMITS.manifestBytes) return { ok: false, problems: [problem('too-large', MANIFEST_MESSAGES.tooLarge)] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: [problem('malformed', MANIFEST_MESSAGES.malformed)] };
  }
  return checkPluginManifest(value, piuiVersion);
}

const WINDOWS_RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)]);

/** `safe_package_path`: a path every platform can store and serve unchanged. */
export function safePackagePath(path: string): boolean {
  if (path === '' || [...path].length > 400 || path.startsWith('/')) return false;
  const segments = path.split('/');
  return segments.length <= PLUGIN_LIMITS.pathDepth && segments.every((segment) =>
    segment !== '' && segment !== '.' && segment !== '..' && new TextEncoder().encode(segment).length <= 255
    && !segment.endsWith('.') && !segment.endsWith(' ')
    && !/[\u0000-\u001f\u007f-\u009f\\:*?"<>|]/u.test(segment)
    && !WINDOWS_RESERVED.has((segment.split('.')[0] ?? '').toLowerCase()));
}
