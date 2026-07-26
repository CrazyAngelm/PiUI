import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('safe chat Markdown projection', () => {
  it('keeps prose, lists, and fenced code as typed nodes', () => {
    const blocks = parseMarkdown('# Result\n\n- first\n- **second**\n\n```ts\nconst ready = true;\n```');

    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'list', 'code']);
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[2]).toMatchObject({ kind: 'code', language: 'ts', text: 'const ready = true;' });
  });

  it('never creates an executable HTML node', () => {
    const source = '<img src=x onerror="globalThis.pwned=true">';
    const blocks = parseMarkdown(source);

    expect(blocks).toEqual([{ kind: 'paragraph', inline: [{ kind: 'text', text: source }] }]);
  });

  it('parses a long streaming-style inline response within the render budget', () => {
    const source = '*x*'.repeat(8_000);
    const started = performance.now();
    const nodes = parseInline(source);

    expect(nodes).toHaveLength(8_000);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('keeps malformed link-heavy streaming text within the render budget', () => {
    const source = '['.repeat(128 * 1_024);
    const started = performance.now();
    const nodes = parseInline(source);

    expect(nodes).toEqual([{ kind: 'text', text: source }]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('projects links as inert typed labels and preserves their destination only as text metadata', () => {
    expect(parseInline('[docs](https://example.com)')).toEqual([
      { kind: 'link', label: [{ kind: 'text', text: 'docs' }], href: 'https://example.com' },
    ]);
  });
});
