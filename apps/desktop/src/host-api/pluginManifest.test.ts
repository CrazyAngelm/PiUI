import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_PERMISSIONS as PLUGIN_PERMISSIONS_V1 } from '../../../../contracts/piui-plugin-v1';
import { PLUGIN_PERMISSIONS, PLUGIN_THEME_TOKENS, type PluginFieldV1 } from '../../../../contracts/piui-plugin-v2';
import validateSchemaV1 from '../../../../contracts/piui-plugin-v1-validator.mjs';
import validateSchemaV2 from '../../../../contracts/piui-plugin-v2-validator.mjs';
import {
  checkPluginManifest,
  checkPluginManifestText,
  contrastRatio,
  parseColor,
  rangeMatches,
  reservedKeybindings,
  resolvePluginValues,
  safePackagePath,
  v2Contributions,
} from './pluginManifest';

/** The schema of the version a fixture declares (the host picks it the same way). */
const validateSchema = (value: unknown): boolean =>
  (value as { schemaVersion?: unknown }).schemaVersion === 2 ? validateSchemaV2(value) : validateSchemaV1(value);

const repository = new URL('../../../../', import.meta.url);
const fixtures = new URL('contracts/fixtures/plugins/', repository);
const read = (url: URL): string => readFileSync(url, 'utf8');
const PIUI = '0.1.1';

describe('plugin manifest v1 and v2 fixtures (shared with crates/piui-plugins)', () => {
  it('accepts the valid fixtures', () => {
    for (const name of ['valid-minimal.json', 'valid-full.json', 'valid-v2.json']) {
      const checked = checkPluginManifestText(read(new URL(name, fixtures)), PIUI);
      expect(checked.ok, name).toBe(true);
      if (checked.ok) expect(checked.compatible).toBe(true);
    }
    const later = checkPluginManifestText(read(new URL('valid-minimal.json', fixtures)), '1.0.0');
    expect(later.ok && later.compatible).toBe(false);
  });

  it('rejects every invalid fixture with the same first code as the host', () => {
    const expected = JSON.parse(read(new URL('expected.json', fixtures))) as { codes: Record<string, string> };
    const listed = readdirSync(fixtures).filter((name) => name.startsWith('invalid-'));
    expect(listed.sort()).toEqual(Object.keys(expected.codes).sort());
    for (const [name, code] of Object.entries(expected.codes)) {
      const value: unknown = JSON.parse(read(new URL(name, fixtures)));
      const checked = checkPluginManifest(value, PIUI);
      expect(checked.ok, name).toBe(false);
      if (!checked.ok) expect(checked.problems[0]?.code, `${name}: ${JSON.stringify(checked.problems)}`).toBe(code);
      // invalid-* fail the JSON Schema; invalid-semantic-* pass it and fail a host rule.
      expect(validateSchema(value), name).toBe(name.startsWith('invalid-semantic-'));
    }
  });

  it('reads the v2 contributions and warns about keybindings on PiUI shortcuts', () => {
    const checked = checkPluginManifestText(read(new URL('valid-v2.json', fixtures)), '0.2.2');
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const added = v2Contributions(checked.manifest);
    expect(added.statusItems.map((item) => item.id)).toEqual(['words', 'badge']);
    expect(added.renderers[0]?.toolNames).toEqual(['get_weather', 'mcp__weather__forecast']);
    expect(reservedKeybindings(checked.manifest)).toEqual([]);
    const shadowing = { ...checked.manifest, contributes: { ...checked.manifest.contributes, keybindings: [{ command: 'count', key: 'Mod+K' }] } };
    expect(checkPluginManifest(shadowing, '0.2.2').ok).toBe(true);
    expect(reservedKeybindings(shadowing)).toEqual(['Mod+K']);
    const v1 = checkPluginManifestText(read(new URL('valid-full.json', fixtures)), PIUI);
    expect(v1.ok && v2Contributions(v1.manifest)).toEqual({ statusItems: [], keybindings: [], renderers: [] });
  });

  it('keeps permissions and theme tokens equal to the schema and the stylesheet', () => {
    type Schema = {
      properties: { permissions: { items: { enum: string[] } } };
      definitions: { themeToken: { enum: string[] } };
    };
    const schema = JSON.parse(read(new URL('contracts/piui-plugin-v1.schema.json', repository))) as Schema;
    const v2 = JSON.parse(read(new URL('contracts/piui-plugin-v2.schema.json', repository))) as Schema;
    expect(schema.properties.permissions.items.enum).toEqual([...PLUGIN_PERMISSIONS_V1]);
    expect(v2.properties.permissions.items.enum).toEqual([...PLUGIN_PERMISSIONS]);
    expect(PLUGIN_PERMISSIONS.filter((permission) => !(PLUGIN_PERMISSIONS_V1 as readonly string[]).includes(permission))).toEqual(['ui.status', 'ui.renderer']);
    expect(schema.definitions.themeToken.enum).toEqual([...PLUGIN_THEME_TOKENS]);
    expect(v2.definitions.themeToken.enum).toEqual([...PLUGIN_THEME_TOKENS]);
    const stylesheet = read(new URL('apps/desktop/src/styles/tokens.css', repository));
    const colorTokens = [...(stylesheet.split(':root[data-theme="light"]')[0] ?? '').matchAll(/--piui-([a-z0-9-]+):\s*(?:#|rgba?\()/g)].map((match) => match[1]);
    expect([...PLUGIN_THEME_TOKENS]).toEqual(colorTokens);
  });
});

describe('plugin values, versions and colors', () => {
  const fields: PluginFieldV1[] = [
    { key: 'greeting', label: 'Greeting', type: 'text', default: 'Hello', maxLength: 10 },
    { key: 'count', label: 'Count', type: 'number', minimum: 1, maximum: 10 },
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'tone', label: 'Tone', type: 'choice', options: [{ value: 'warm', label: 'Warm' }] },
  ];

  it('resolves values like the host and refuses unknown keys', () => {
    expect(resolvePluginValues(fields, { name: 'Ada' })).toEqual({ ok: true, values: { greeting: 'Hello', name: 'Ada' } });
    const issue = (values: Record<string, unknown>) => {
      const resolved = resolvePluginValues(fields, values);
      return resolved.ok ? undefined : [resolved.issue, resolved.key];
    };
    expect(issue({ name: 'Ada', extra: 1 })).toEqual(['unknown', 'extra']);
    expect(issue({})).toEqual(['required', 'name']);
    expect(issue({ name: 'Ada', count: 11 })).toEqual(['range', 'count']);
    expect(issue({ name: 'Ada', greeting: 'Hello there!' })).toEqual(['tooLong', 'greeting']);
    expect(issue({ name: 'A\nda' })).toEqual(['characters', 'name']);
    expect(issue({ name: 'Ada', tone: 'cold' })).toEqual(['choice', 'tone']);
  });

  it('matches engine ranges and colors like the host', () => {
    expect(rangeMatches('>=0.1.0 <1.0.0', '0.2.0')).toBe(true);
    expect(rangeMatches('^0.1.1', '0.2.0')).toBe(false);
    expect(rangeMatches('~1.2.3', '1.2.9')).toBe(true);
    expect(rangeMatches('>=1.0', '1.0.0')).toBeUndefined();
    expect(parseColor('rgb(256, 0, 0)')).toBeUndefined();
    expect(parseColor('var(--piui-bg)')).toBeUndefined();
    const black = parseColor('#000');
    const white = parseColor('#ffffff');
    expect(black && white && contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(safePackagePath('ui/index.html')).toBe(true);
    for (const path of ['../x', 'a\\b', 'con.txt', 'a//b', '/abs']) expect(safePackagePath(path), path).toBe(false);
  });
});

describe('plugin SDK and examples', () => {
  const examples = new URL('examples/plugins/', repository);

  it('validates every example manifest and its templates with the app parser', async () => {
    const { parseSystemFile } = await import('../features/orchestration/systemFile');
    const names = readdirSync(examples).filter((name) => statSync(new URL(`${name}/piui-plugin.json`, examples), { throwIfNoEntry: false })?.isFile());
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      const checked = checkPluginManifestText(read(new URL(`${name}/piui-plugin.json`, examples)), PIUI);
      expect(checked.ok, `${name}: ${JSON.stringify(checked.ok ? [] : checked.problems)}`).toBe(true);
      if (!checked.ok) continue;
      for (const template of checked.manifest.contributes.templates ?? []) {
        expect(() => parseSystemFile(read(new URL(`${name}/${template.file}`, examples))), template.id).not.toThrow();
      }
    }
  });

  it('vendors identical copies of the SDK helpers', () => {
    const backend = read(new URL('packages/plugin-sdk/src/backend.mjs', repository));
    const panel = read(new URL('packages/plugin-sdk/src/panel.js', repository));
    expect(read(new URL('hello-command/backend/piui-plugin-backend.mjs', examples))).toBe(backend);
    expect(read(new URL('pipeline-pack/backend/piui-plugin-backend.mjs', examples))).toBe(backend);
    expect(read(new URL('status-tools/backend/piui-plugin-backend.mjs', examples))).toBe(backend);
    expect(read(new URL('hello-command/ui/piui-panel.js', examples))).toBe(panel);
    expect(read(new URL('tool-cards/ui/piui-panel.js', examples))).toBe(panel);
  });

  it('the JSON transform node reshapes results without side effects', async () => {
    const transformUrl = new URL('pipeline-pack/backend/transform.mjs', examples).href;
    const { transformJson } = (await import(/* @vite-ignore */ transformUrl)) as {
      transformJson: (request: object) => Record<string, unknown>;
    };
    const dependencies = { collect: { text: null, data: { summary: 's', findings: ['a'], risks: ['b'] } }, notes: { text: '{"extra":1}', data: null } };
    expect(transformJson({ config: { pick: 'findings, risks', rename: 'risks=openRisks' }, dependencies })).toEqual({ findings: ['a'], openRisks: ['b'] });
    expect(transformJson({ config: { source: 'inputs', wrap: 'input' }, inputs: { topic: 'x' } })).toEqual({ input: { topic: 'x' } });
    expect(transformJson({ config: {}, dependencies })).toEqual({ summary: 's', findings: ['a'], risks: ['b'], extra: 1 });
    expect(() => transformJson({ config: { rename: 'not a pair' } })).toThrow('old=new');
  });

  it('create-plugin writes a package that passes the manifest rules', () => {
    const root = mkdtempSync(join(tmpdir(), 'piui-create-plugin-'));
    try {
      const target = join(root, 'word-count');
      execFileSync(process.execPath, [new URL('packages/plugin-sdk/bin/create-plugin.mjs', repository).pathname.replace(/^\/([A-Za-z]:)/, '$1'), target, '--panel'], { stdio: 'pipe' });
      const checked = checkPluginManifestText(readFileSync(join(target, 'piui-plugin.json'), 'utf8'), PIUI);
      expect(checked.ok && checked.manifest.id).toBe('local.word-count');
      expect(checked.ok && checked.manifest.schemaVersion).toBe(2);
      expect(readFileSync(join(target, 'ui', 'piui-panel.js'), 'utf8')).toBe(read(new URL('packages/plugin-sdk/src/panel.js', repository)));
      expect(() => execFileSync(process.execPath, [new URL('packages/plugin-sdk/bin/create-plugin.mjs', repository).pathname.replace(/^\/([A-Za-z]:)/, '$1'), target], { stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
