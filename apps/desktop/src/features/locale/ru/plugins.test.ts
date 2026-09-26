import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { failureText } from '../../../app/runs/runGraph';
import { BACKEND_STATE_TEXT, LOG_TEXT, PERMISSION_TEXT } from '../../../app/plugins/permissions';
import { FIELD_RULES, MANIFEST_MESSAGES, PERMISSION_HINTS, VALUE_ISSUES } from '../../../host-api/pluginManifest';
import { EXECUTOR_ISSUES } from '../../../host-api/stepExecutors';
import { translate } from '../language';
import { pluginsRu } from './plugins';

const quoted = /\$t\((?:'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")/g;

/** Every `$t('…')` literal of the plugin screens (src/app/plugins). */
function screenKeys(): string[] {
  const folder = new URL('../../../app/plugins/', import.meta.url);
  const keys = new Set<string>();
  for (const name of readdirSync(folder).filter((file) => file.endsWith('.svelte'))) {
    for (const match of readFileSync(new URL(name, folder), 'utf8').matchAll(quoted)) keys.add(match[1] ?? match[2] ?? '');
  }
  return [...keys];
}

/**
 * The fixed English messages the host sends (Settings → Plugins errors,
 * package problems and backend failures): every sentence literal in the
 * plugin host modules and the package crate, tests excluded.
 */
function hostKeys(): string[] {
  const files = [
    ...['api.rs', 'mod.rs', 'registry.rs', 'supervisor.rs'].map((name) => new URL(`../../../../src-tauri/src/plugins/${name}`, import.meta.url)),
    new URL('../../../../src-tauri/src/orchestration_plugin_steps.rs', import.meta.url),
    ...['fields.rs', 'lib.rs', 'manifest.rs', 'package.rs', 'theme.rs', 'zip.rs'].map((name) => new URL(`../../../../../../crates/piui-plugins/src/${name}`, import.meta.url)),
  ];
  const keys = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/"([A-Z“][^"\\]*[.…])"/g)) keys.add(match[1] ?? '');
  }
  return [...keys];
}

const translated = (key: string): boolean => translate(key, 'ru') !== key || pluginsRu[key] === key;

describe('Russian copy for plugins', () => {
  it('translates every visible string of the plugin screens', () => {
    const keys = screenKeys();
    expect(keys.length).toBeGreaterThan(90);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates permissions, backend states, the activity log and counts', () => {
    const keys = [
      ...Object.values(PERMISSION_TEXT).flatMap((text) => [text.label, text.detail]),
      ...Object.values(BACKEND_STATE_TEXT),
      ...Object.values(LOG_TEXT),
      '{0} commands', '{0} panels', '{0} themes', '{0} templates', '{0} pipeline nodes', '{0} ACP agents',
      'Plugin removed', 'Plugin reloaded', 'The backend starts again on next use',
      '{0} could not run the command', 'Open a chat to use the prepared text', '{0} prepared text for a message box.',
    ];
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates package, settings and pipeline-node checks', () => {
    const keys = [
      ...Object.values(FIELD_RULES),
      ...Object.values(VALUE_ISSUES),
      ...Object.values(MANIFEST_MESSAGES),
      ...Object.values(PERMISSION_HINTS),
      'Add the matching permission.',
      EXECUTOR_ISSUES.pluginConfig,
      EXECUTOR_ISSUES.pluginBindings,
      EXECUTOR_ISSUES.pluginUnavailable,
      'A plugin node runs on the host and cannot be the orchestrator.',
      ...['plugin-unavailable', 'plugin-config-invalid', 'plugin-input-unavailable', 'plugin-start-failed', 'plugin-node-failed', 'plugin-node-timeout'].map(failureText),
      'PiUI could not read the plugin list.',
    ];
    expect(keys.every((key) => key.length > 0)).toBe(true);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates the plugin strings of shared screens', () => {
    const keys = [
      'Plugin nodes',
      'Plugin node',
      'From plugin {0}',
      'Named fields the node returns as one JSON object. Without fields, its output is passed on as text.',
      'PiUI could not confirm how the plugin node ended. Check what it changed, then record an operator assertion. It reconciles the journal only.',
      'I checked what the plugin node did and understand this is an operator assertion.',
      'This agent comes from a plugin. Disable or remove the plugin in Settings → Plugins.',
    ];
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates every fixed message the host sends', () => {
    const keys = hostKeys();
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('keeps placeholders in the translations', () => {
    for (const [key, value] of Object.entries(pluginsRu)) {
      for (const placeholder of key.match(/\{\d\}/g) ?? []) expect(value, key).toContain(placeholder);
    }
  });
});
