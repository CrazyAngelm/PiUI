import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('safe chat Markdown projection', () => {
  it('keeps images inert unless rich presentation and a trusted owner both participate', () => {
    const source = '![A **diagram**](https://example.invalid/chart.png "Diagram")';
    expect(parseInline(source).some(node => node.kind === 'image')).toBe(false);
    expect(parseInline(source, true)).toEqual([{ kind: 'image', alt: 'A diagram', href: 'https://example.invalid/chart.png' }]);
    expect(parseInline('![blocked](javascript:alert(1))', true)).toEqual([{ kind: 'image', alt: 'blocked', href: 'javascript:alert(1)' }]);
    expect(parseInline('`![code](https://example.invalid/chart.png)`', true)[0]?.kind).toBe('code');
    expect(parseInline('\\![escaped](https://example.invalid/chart.png)', true).some(node => node.kind === 'image')).toBe(false);
  });

  it('projects rich HTTP autolinks without punctuation or nested link labels', () => {
    expect(parseInline('See https://example.invalid/a_(b).', true)).toEqual([
      { kind: 'text', text: 'See ' }, { kind: 'link', href: 'https://example.invalid/a_(b)', label: [{ kind: 'text', text: 'https://example.invalid/a_(b)' }] }, { kind: 'text', text: '.' },
    ]);
    expect(parseInline('<https://example.invalid/a>', true)[0]).toMatchObject({ kind: 'link', href: 'https://example.invalid/a' });
    expect(parseInline('[https://label.invalid](https://target.invalid)', true)[0]).toEqual({ kind: 'link', href: 'https://target.invalid', label: [{ kind: 'text', text: 'https://label.invalid' }] });
    expect(parseInline('https://example.invalid')).toEqual([{ kind: 'text', text: 'https://example.invalid' }]);
  });

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

  it('parses GitHub pipe tables with alignment, inline code and escaped pipes', () => {
    const blocks = parseMarkdown(
      ['Before the table', '| Check | Status | Time |', '|:---|:---:|---:|', '| `a|b` | **ok** | 1 ms |', '| x \\| y | fail |', '', 'After'].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'table', 'paragraph']);
    const table = blocks[1];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.align).toEqual(['left', 'center', 'right']);
    expect(table.head).toEqual([[{ kind: 'text', text: 'Check' }], [{ kind: 'text', text: 'Status' }], [{ kind: 'text', text: 'Time' }]]);
    expect(table.rows[0]?.[0]).toEqual([{ kind: 'code', text: 'a|b' }]);
    expect(table.rows[0]?.[1]).toEqual([{ kind: 'strong', children: [{ kind: 'text', text: 'ok' }] }]);
    // Short rows are padded to the header width; escaped pipes stay text.
    expect(table.rows[1]).toEqual([[{ kind: 'text', text: 'x | y' }], [{ kind: 'text', text: 'fail' }], []]);
  });

  it('keeps pipe text without a delimiter row as a paragraph', () => {
    expect(parseMarkdown('a | b\nc | d').map((block) => block.kind)).toEqual(['paragraph']);
    expect(parseMarkdown('| a | b |\n|---|').map((block) => block.kind)).toEqual(['paragraph']);
  });

  it('keeps the web owner widget body stable across supported fences and closing deltas', () => {
    const body = '{"title":"Choice","body":[]}';
    for (const opening of ['```hermes-ui', '   ```HERMES-UI', '\t```hermes-ui options']) {
      const open = parseMarkdown(`${opening}\n${body}\n`, true);
      const closed = parseMarkdown([opening, body, '   ````', 'After'].join('\n'), true);
      expect(open).toEqual([{ kind: 'code', language: 'hermes-ui', text: body }]);
      expect(closed[0]).toEqual(open[0]);
      expect(closed[1]).toEqual({ kind: 'paragraph', inline: [{ kind: 'text', text: 'After' }] });
    }
  });

  it('recognizes rich math before emphasis while keeping code and ordinary owners literal', () => {
    expect(parseInline('$a * b * c$ and \\(x_y\\)', true)).toEqual([
      { kind: 'math', text: '\\(a * b * c\\)', display: false },
      { kind: 'text', text: ' and ' },
      { kind: 'math', text: '\\(x_y\\)', display: false },
    ]);
    expect(parseInline('$$a*b$$', true)).toEqual([{ kind: 'math', text: '\\[a*b\\]', display: true }]);
    expect(parseInline('`$x$`', true)).toEqual([{ kind: 'code', text: '$x$' }]);
    expect(parseInline('$x$')).toEqual([{ kind: 'text', text: '$x$' }]);
    expect(parseInline('\\$5 and $20', true)).toEqual([{ kind: 'text', text: '\\$5 and $20' }]);
  });

  it('retains balanced and escaped parentheses in an inert link destination', () => {
    expect(parseInline('[Paper](https://example.invalid/Function_(math))')).toEqual([
      { kind: 'link', label: [{ kind: 'text', text: 'Paper' }], href: 'https://example.invalid/Function_(math)' },
    ]);
    expect(parseInline('[Paper](https://example.invalid/a\\)b)')).toEqual([
      { kind: 'link', label: [{ kind: 'text', text: 'Paper' }], href: 'https://example.invalid/a)b' },
    ]);
  });

  it('keeps unfinished rich math within the existing malformed-stream render budget', () => {
    const source = '\\('.repeat(64 * 1_024);
    const started = performance.now();
    expect(parseInline(source, true)).toEqual([{ kind: 'text', text: source }]);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
