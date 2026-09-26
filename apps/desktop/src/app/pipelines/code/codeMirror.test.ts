import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, getIndentUnit } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import type { ScriptRuntime } from '../../../host-api/orchestrationClient';
import { codeHighlight, codeTheme, INDENT, languageFor } from './codeMirror';

/** One line of each kind per runtime, with the text each token should color. */
const SAMPLES: Readonly<Record<ScriptRuntime, { source: string; keyword: string; string: string; comment: string; number: string }>> = {
  node: { source: "const answer = 'yes'; // done\nconsole.log(answer, 42);\n", keyword: 'const', string: "'yes'", comment: '// done', number: '42' },
  python: { source: "def main():\n    return 'yes'  # done\nprint(42)\n", keyword: 'def', string: "'yes'", comment: '# done', number: '42' },
  powershell: { source: "$answer = 'yes' # done\nif ($answer) { Write-Output 42 }\n", keyword: 'if', string: "'yes'", comment: '# done', number: '42' },
};

async function colors(runtime: ScriptRuntime): Promise<{ color: (text: string) => string | undefined; state: EditorState }> {
  const sample = SAMPLES[runtime];
  const state = EditorState.create({ doc: sample.source, extensions: [await languageFor(runtime)] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5_000);
  if (tree === null) throw new Error('The parser did not finish.');
  const spans = new Map<string, string>();
  highlightTree(tree, codeHighlight, (from, to, classes) => spans.set(state.doc.sliceString(from, to), classes));
  const rules = codeHighlight.module?.getRules() ?? '';
  const color = (text: string): string | undefined => {
    for (const name of (spans.get(text) ?? '').split(' ').filter(Boolean)) {
      const match = new RegExp(`\\.${name} \\{color: (var\\(--piui-syntax-[a-z]+\\))`).exec(rules);
      if (match) return match[1];
    }
    return undefined;
  };
  return { color, state };
}

describe('script code highlighting', () => {
  for (const runtime of ['node', 'python', 'powershell'] as const) {
    it(`parses ${runtime} and colors tokens with the design tokens`, async () => {
      const sample = SAMPLES[runtime];
      const { color, state } = await colors(runtime);
      expect(color(sample.keyword)).toBe('var(--piui-syntax-keyword)');
      expect(color(sample.string)).toBe('var(--piui-syntax-string)');
      expect(color(sample.comment)).toBe('var(--piui-syntax-comment)');
      expect(color(sample.number)).toBe('var(--piui-syntax-number)');
      expect(getIndentUnit(state)).toBe(INDENT[runtime].length);
    });
  }

  it('takes every color, surface and focus ring from the design tokens', () => {
    const source = readFileSync(new URL('./codeMirror.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(codeHighlight.module?.getRules()).toContain('var(--piui-syntax-keyword)');
    expect(codeTheme).toBeDefined();
  });
});

describe('bundle isolation', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
    });
  }

  it('keeps CodeMirror out of every chunk but the lazily imported editor module', () => {
    const files = sources(root).map((path) => ({ path: relative(root, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }));
    const users = files.filter((file) => /from ['"]@codemirror\/|from ['"]@lezer\/|import\(['"]@codemirror\//.test(file.text)).map((file) => file.path);
    expect(users).toEqual(['app/pipelines/code/codeMirror.ts']);
    const importers = files.filter((file) => /codeMirror['"]/.test(file.text) && file.path !== 'app/pipelines/code/codeMirror.ts');
    expect(importers.map((file) => file.path)).toEqual(['app/pipelines/code/ScriptEditor.svelte']);
    const editor = importers[0]?.text ?? '';
    // Only a type import and one dynamic import: nothing is loaded before a script is shown.
    expect(editor).toContain("import type { CodeEditorHandle, CodeEditorSize } from './codeMirror';");
    expect(editor).toContain("import('./codeMirror')");
    expect(editor.match(/from '\.\/codeMirror'/g)).toHaveLength(1);
  });
});
