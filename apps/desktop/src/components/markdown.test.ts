import { describe, expect, it } from 'vitest';
import { createMarkdownParser, parseInline, parseMarkdown, type InlineNode, type MarkdownBlock } from './markdown';
import { decodeEntities } from './markdownEntities';

const text = (value: string): InlineNode => ({ kind: 'text', text: value });
const para = (...inline: InlineNode[]): MarkdownBlock => ({ kind: 'paragraph', inline });
const tight = (...inline: InlineNode[]): MarkdownBlock => ({ kind: 'paragraph', inline, tight: true });
const BACKSLASH = String.fromCharCode(92);

/** Every node of every block, depth first: used to prove nothing but the known kinds can appear. */
function walkInline(nodes: readonly InlineNode[], visit: (node: InlineNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === 'strong' || node.kind === 'emphasis' || node.kind === 'delete') walkInline(node.children, visit);
    if (node.kind === 'link') walkInline(node.label, visit);
  }
}

function walkBlocks(blocks: readonly MarkdownBlock[], visit: (node: InlineNode) => void): void {
  for (const block of blocks) {
    if (block.kind === 'paragraph' || block.kind === 'heading') walkInline(block.inline, visit);
    if (block.kind === 'quote') walkBlocks(block.children, visit);
    if (block.kind === 'list') for (const item of block.items) walkBlocks(item.children, visit);
    if (block.kind === 'table') for (const row of [block.head, ...block.rows]) for (const cell of row) walkInline(cell, visit);
  }
}

describe('block structure', () => {
  it('nests a list inside a list item instead of ending the list', () => {
    const blocks = parseMarkdown('1. parent\n   - child\n2. next');

    expect(blocks).toEqual([
      {
        kind: 'list',
        ordered: true,
        start: 1,
        items: [
          { children: [tight(text('parent')), { kind: 'list', ordered: false, items: [{ children: [tight(text('child'))] }] }] },
          { children: [tight(text('next'))] },
        ],
      },
    ]);
  });

  it('keeps a continuation paragraph and a fenced block inside their list item', () => {
    const loose = parseMarkdown('- a\n\n  continuation\n- b');
    expect(loose).toHaveLength(1);
    expect(loose[0]).toMatchObject({ kind: 'list', items: [{ children: [para(text('a')), para(text('continuation'))] }, { children: [para(text('b'))] }] });

    const code = parseMarkdown('- a\n  ```js\n  x\n  ```\n- b');
    expect(code[0]).toMatchObject({ kind: 'list', items: [{ children: [tight(text('a')), { kind: 'code', language: 'js', text: 'x' }] }, { children: [tight(text('b'))] }] });
  });

  it('keeps ordered list numbering and task items', () => {
    expect(parseMarkdown('3. three\n4. four')[0]).toMatchObject({ kind: 'list', ordered: true, start: 3 });
    const tasks = parseMarkdown('- [ ] todo\n- [x] done\n- plain');
    expect(tasks[0]).toMatchObject({ kind: 'list', items: [{ checked: false }, { checked: true }, {}] });
    expect((tasks[0] as { items: { checked?: boolean }[] }).items[2]).not.toHaveProperty('checked');
  });

  it('closes a fence only with a fence as long as the opener, of any length', () => {
    const blocks = parseMarkdown('````\nx\n```\nstill code\n````\nDone');

    expect(blocks).toEqual([{ kind: 'code', text: 'x\n```\nstill code' }, para(text('Done'))]);
  });

  it('knows ~~~ fences, an info string and the indent of an opener', () => {
    expect(parseMarkdown('~~~js title="a"\ncode\n~~~')).toEqual([{ kind: 'code', language: 'js', text: 'code' }]);
    expect(parseMarkdown('   ```ts\n   const a = 1;\n   ```\nafter')).toEqual([{ kind: 'code', language: 'ts', text: 'const a = 1;' }, para(text('after'))]);
    expect(parseMarkdown('```\nplain\n```')).toEqual([{ kind: 'code', text: 'plain' }]);
  });

  it('ends a table at a new block and keeps the text of the next block', () => {
    const blocks = parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n# Heading | X | Y');

    expect(blocks.map((block) => block.kind)).toEqual(['table', 'heading']);
    expect(blocks[1]).toEqual({ kind: 'heading', depth: 1, inline: [text('Heading | X | Y')] });
    expect(blocks[0]).toMatchObject({ rows: [[[text('1')], [text('2')]]] });
  });

  it('parses GitHub pipe tables with alignment, code, escaped pipes, padding and truncation', () => {
    const blocks = parseMarkdown(
      ['Before the table', '', '| Check | Status | Time |', '|:---|:---:|---:|', '| `a\\|b` | **ok** | 1 ms |', '| x \\| y | fail |', '| too | many | cells | here |', '', 'After'].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'table', 'paragraph']);
    const table = blocks[1];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.align).toEqual(['left', 'center', 'right']);
    expect(table.head).toEqual([[text('Check')], [text('Status')], [text('Time')]]);
    expect(table.rows[0]?.[0]).toEqual([{ kind: 'code', text: 'a|b' }]);
    expect(table.rows[0]?.[1]).toEqual([{ kind: 'strong', children: [text('ok')] }]);
    expect(table.rows[1]).toEqual([[text('x | y')], [text('fail')], []]);
    expect(table.rows[2]).toEqual([[text('too')], [text('many')], [text('cells')]]);
  });

  it('keeps pipe text without a delimiter row as a paragraph, and a very wide table as prose', () => {
    expect(parseMarkdown('a | b\nc | d').map((block) => block.kind)).toEqual(['paragraph']);
    expect(parseMarkdown('| a | b |\n|---|').map((block) => block.kind)).toEqual(['paragraph']);
    const wide = Array.from({ length: 30 }, (_, index) => `c${index}`);
    const source = [`| ${wide.join(' | ')} |`, `|${wide.map(() => '---').join('|')}|`, `| ${wide.join(' | ')} |`].join('\n');
    expect(parseMarkdown(source).map((block) => block.kind)).toEqual(['paragraph']);
  });

  it('reads headings 1 to 6, setext headings, rules and quotes with blocks inside', () => {
    expect(parseMarkdown('# a\n## b\n### c\n#### d\n##### e\n###### f').map((block) => (block.kind === 'heading' ? block.depth : 0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseMarkdown('Title\n=====')[0]).toEqual({ kind: 'heading', depth: 1, inline: [text('Title')] });
    expect(parseMarkdown('a\n\n---\n\nb').map((block) => block.kind)).toEqual(['paragraph', 'rule', 'paragraph']);
    expect(parseMarkdown('> quote\n> more\n>\n> - item')[0]).toMatchObject({ kind: 'quote', children: [para(text('quote\nmore')), { kind: 'list' }] });
  });

  it('keeps single line breaks inside a paragraph', () => {
    expect(parseMarkdown('one\ntwo')).toEqual([para(text('one\ntwo'))]);
    expect(parseMarkdown('one  \ntwo')).toEqual([para(text('one\ntwo'))]);
  });
});

describe('inline structure', () => {
  it('honours escapes and decodes character references', () => {
    expect(parseInline(`${BACKSLASH}*text${BACKSLASH}* and ${BACKSLASH}_x${BACKSLASH}_`)).toEqual([text('*text* and _x_')]);
    expect(parseInline('&lt;中文&gt; &amp; &copy; &#65; &#x1F600; &nbsp;|')).toEqual([text('<中文> & © A \u{1F600} \u00a0|')]);
    // An escaped ampersand is not the start of a reference, and an unknown name stays as typed.
    expect(parseInline(`${BACKSLASH}&amp; &nope; &constructor; &#0;`)).toEqual([text('&amp; &nope; &constructor; \ufffd')]);
    expect(decodeEntities('no references here')).toBe('no references here');
  });

  it('reads a code span across a line break and keeps its content literal', () => {
    expect(parseInline('a `code\nspan` b')).toEqual([text('a '), { kind: 'code', text: 'code span' }, text(' b')]);
    expect(parseInline('`**not bold** &amp; <b>`')).toEqual([{ kind: 'code', text: '**not bold** &amp; <b>' }]);
    expect(parseInline('`` a ` b ``')).toEqual([{ kind: 'code', text: 'a ` b' }]);
  });

  it('reads emphasis, strong, strikethrough and nests them', () => {
    expect(parseInline('**bold _and italic_** ~~gone~~ *em*')).toEqual([
      { kind: 'strong', children: [text('bold '), { kind: 'emphasis', children: [text('and italic')] }] },
      text(' '),
      { kind: 'delete', children: [text('gone')] },
      text(' '),
      { kind: 'emphasis', children: [text('em')] },
    ]);
    // Intraword underscores are not emphasis.
    expect(parseInline('snake_case_name')).toEqual([text('snake_case_name')]);
  });

  it('reads Cyrillic and CJK text, with and without spaces around emphasis', () => {
    expect(parseMarkdown('# Привет 世界\n\n**жирный** и 中文**粗体**文字')).toEqual([
      { kind: 'heading', depth: 1, inline: [text('Привет 世界')] },
      para({ kind: 'strong', children: [text('жирный')] }, text(' и 中文'), { kind: 'strong', children: [text('粗体')] }, text('文字')),
    ]);
  });

  it('projects links with their destination and title, and every autolink form', () => {
    expect(parseInline('[docs](https://example.com "Title")')).toEqual([{ kind: 'link', label: [text('docs')], href: 'https://example.com', title: 'Title' }]);
    expect(parseInline('See https://example.invalid/a_(b).')).toEqual([
      text('See '),
      { kind: 'link', href: 'https://example.invalid/a_(b)', label: [text('https://example.invalid/a_(b)')] },
      text('.'),
    ]);
    expect(parseInline('<https://example.invalid/a>')[0]).toMatchObject({ kind: 'link', href: 'https://example.invalid/a' });
    expect(parseInline('www.example.invalid')[0]).toMatchObject({ kind: 'link', href: 'http://www.example.invalid' });
    expect(parseInline('[https://label.invalid](https://target.invalid)')).toEqual([{ kind: 'link', href: 'https://target.invalid', label: [text('https://label.invalid')] }]);
    expect(parseInline('[Paper](https://example.invalid/Function_(math))')[0]).toMatchObject({ href: 'https://example.invalid/Function_(math)' });
    expect(parseInline('[**bold** label](https://example.invalid)')[0]).toMatchObject({ kind: 'link', label: [{ kind: 'strong' }, text(' label')] });
    // The destination is data: whether it may be opened is decided where the link is activated.
    expect(parseInline('[x](javascript:alert(1))')[0]).toMatchObject({ kind: 'link', href: 'javascript:alert(1)' });
    expect(parseInline('[file](./src/lib.rs)')[0]).toMatchObject({ kind: 'link', href: './src/lib.rs' });
  });

  it('resolves a reference link even when its definition comes after the paragraph', () => {
    const blocks = parseMarkdown('See [the docs][1].\n\n[1]: https://example.invalid/docs');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual(para(text('See '), { kind: 'link', label: [text('the docs')], href: 'https://example.invalid/docs' }, text('.')));
  });

  it('keeps images inert: a link to the picture for everyone, an image slot only for a rich owner', () => {
    const source = '![A **diagram**](https://example.invalid/chart.png "Diagram")';

    expect(parseInline(source)).toEqual([{ kind: 'link', label: [text('A diagram')], href: 'https://example.invalid/chart.png' }]);
    expect(parseInline(source, true)).toEqual([{ kind: 'image', alt: 'A diagram', href: 'https://example.invalid/chart.png' }]);
    expect(parseInline('![blocked](javascript:alert(1))', true)).toEqual([{ kind: 'image', alt: 'blocked', href: 'javascript:alert(1)' }]);
    expect(parseInline('`![code](https://example.invalid/chart.png)`', true)[0]?.kind).toBe('code');
    expect(parseInline(`${BACKSLASH}![escaped](https://example.invalid/chart.png)`, true).some((node) => node.kind === 'image')).toBe(false);
  });
});

describe('math', () => {
  it('keeps a formula opaque, with no emphasis inside, with or without the rich owner', () => {
    const source = `$a*b*c$ and ${BACKSLASH}(x_y*z*${BACKSLASH}) and ${BACKSLASH}[q*r*s${BACKSLASH}] and $$m*n*o$$`;

    expect(parseInline(source, true)).toEqual([
      { kind: 'math', text: `${BACKSLASH}(a*b*c${BACKSLASH})`, display: false },
      text(' and '),
      { kind: 'math', text: `${BACKSLASH}(x_y*z*${BACKSLASH})`, display: false },
      text(' and '),
      { kind: 'math', text: `${BACKSLASH}[q*r*s${BACKSLASH}]`, display: true },
      text(' and '),
      { kind: 'math', text: `${BACKSLASH}[m*n*o${BACKSLASH}]`, display: true },
    ]);
    // Not rich: the formula is still cut out before emphasis, and shown as typed.
    expect(parseInline(source)).toEqual([text(source)]);
  });

  it('leaves prices, shell variables, escaped dollars and code alone', () => {
    expect(parseInline('costs $5 and $10, $HOME and $PATH', true)).toEqual([text('costs $5 and $10, $HOME and $PATH')]);
    expect(parseInline(`${BACKSLASH}$5 and $20`, true)).toEqual([text('$5 and $20')]);
    expect(parseInline('`$x$`', true)).toEqual([{ kind: 'code', text: '$x$' }]);
    expect(parseInline('$x$')).toEqual([text('$x$')]);
    // No closing mark: the backslash is an ordinary CommonMark escape and nothing is swallowed.
    expect(parseInline(`${BACKSLASH}(unfinished *em* text`, true)).toEqual([text('(unfinished '), { kind: 'emphasis', children: [text('em')] }, text(' text')]);
  });
});

describe('raw HTML', () => {
  it('never produces anything but text for HTML, block or inline', () => {
    const source = '<img src=x onerror="globalThis.pwned=true">\n\n<div onclick="x()">\nblock\n</div>\n\nA <b>bold</b> <script>alert(1)</script> word';
    const blocks = parseMarkdown(source);

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(blocks[0]).toEqual(para(text('<img src=x onerror="globalThis.pwned=true">')));
    expect(blocks[1]).toEqual(para(text('<div onclick="x()">\nblock\n</div>')));
    const kinds = new Set<string>();
    walkBlocks(blocks, (node) => kinds.add(node.kind));
    expect([...kinds]).toEqual(['text']);
    expect(JSON.stringify(blocks)).toContain('<script>alert(1)</script>');
  });

  it('turns only a line break tag into a line break', () => {
    expect(parseInline('one<br>two<BR/>three')).toEqual([text('one\ntwo\nthree')]);
  });
});

describe('hermes-ui widgets', () => {
  const body = '{"title":"Choice","body":[]}';

  it('keeps the widget body stable across supported fences and closing deltas', () => {
    for (const opening of ['```hermes-ui', '   ```HERMES-UI', '```hermes-ui options', '~~~hermes-ui']) {
      const open = parseMarkdown(`${opening}\n${body}\n`, true);
      const closed = parseMarkdown([opening, body, '', opening.trimStart().startsWith('~') ? '~~~~' : '   ````', 'After'].join('\n'), true);
      expect(open).toEqual([{ kind: 'code', language: 'hermes-ui', text: body }]);
      expect(closed[0]).toEqual(open[0]);
      expect(closed[1]).toEqual(para(text('After')));
    }
  });

  it('enables widget fences independently of rich Markdown, and leaves them ordinary code without it', () => {
    const source = ['$a$ and $HOME and $PATH', '   ```HERMES-UI', body, '```'].join('\n');

    expect(parseMarkdown(source, false, true)).toEqual([para(text('$a$ and $HOME and $PATH')), { kind: 'code', language: 'hermes-ui', text: body }]);
    expect(parseMarkdown('```hermes-ui\n{}\n```', false, false)).toEqual([{ kind: 'code', language: 'hermes-ui', text: '{}' }]);
    expect(parseMarkdown('```HERMES-UI\n{}\n```', false, false)).toEqual([{ kind: 'code', language: 'HERMES-UI', text: '{}' }]);
  });

  it('numbers widgets by ordinal so prose before one cannot move its DOM', () => {
    const parser = createMarkdownParser({ widgets: true });
    const widget = `\`\`\`hermes-ui\n${body}\n\`\`\``;

    expect(parser.parse(`Intro\n\n${widget}\n\nTail`).map((entry) => entry.key)).toEqual(['block:0', 'widget:0', 'block:2']);
    expect(createMarkdownParser({ widgets: true }).parse(`${widget}\n\nmore\n\n${widget}`).map((entry) => entry.key)).toEqual(['widget:0', 'block:1', 'widget:1']);
  });
});

describe('a message that is still arriving', () => {
  const blocksOf = (source: string): MarkdownBlock[] => parseMarkdown(source, false, false, true);

  it('shows an open fence as code, and does not show the closing fence being typed as code', () => {
    expect(blocksOf('Intro\n\n```js\nconst a')).toEqual([para(text('Intro')), { kind: 'code', language: 'js', text: 'const a' }]);
    expect(blocksOf('```js\nconst a = 1;\n``')).toEqual([{ kind: 'code', language: 'js', text: 'const a = 1;' }]);
    expect(blocksOf('````\nx\n```')).toEqual([{ kind: 'code', text: 'x' }]);
    // A fence as long as the opener is the closing fence.
    expect(blocksOf('```js\nconst a = 1;\n```\nDone')).toEqual([{ kind: 'code', language: 'js', text: 'const a = 1;' }, para(text('Done'))]);
    // Inside code, a delimiter at the end is code.
    expect(blocksOf('```\na **')).toEqual([{ kind: 'code', text: 'a **' }]);
  });

  it('does not flash italics for an unfinished bold', () => {
    expect(blocksOf('Hello **bold')).toEqual([para(text('Hello **bold'))]);
    expect(blocksOf('Hello **bold*')).toEqual([para(text('Hello **bold*'))]);
    // The space before the waiting delimiters stays, so the line does not shift when the next character arrives.
    expect(blocksOf('Hello **')).toEqual([para(text('Hello **'))]);
    expect(blocksOf('Hello **bold**')).toEqual([para(text('Hello **bold**'))]);
    // The next character settles it.
    expect(blocksOf('Hello **bold** w')).toEqual([para(text('Hello '), { kind: 'strong', children: [text('bold')] }, text(' w'))]);
  });

  it('holds the delimiters of the last paragraph, list item, quote and table cell, wherever the text ends', () => {
    expect(blocksOf('- item **')).toEqual([{ kind: 'list', ordered: false, items: [{ children: [tight(text('item **'))] }] }]);
    expect(blocksOf('> quoted *')).toEqual([{ kind: 'quote', children: [para(text('quoted *'))] }]);
    expect(blocksOf('# Title ~~')).toEqual([{ kind: 'heading', depth: 1, inline: [text('Title ~~')] }]);
    expect(blocksOf('| a | b |\n|---|---|\n| x | y **')).toMatchObject([{ kind: 'table', rows: [[[text('x')], [text('y **')]]] }]);
    expect(blocksOf('**')).toEqual([para(text('**'))]);
  });

  it('shows the finished text with everything closed once streaming stops', () => {
    expect(parseMarkdown('Hello **bold**')).toEqual([para(text('Hello '), { kind: 'strong', children: [text('bold')] })]);
    expect(parseMarkdown('```js\nconst a = 1;\n``')).toEqual([{ kind: 'code', language: 'js', text: 'const a = 1;\n``' }]);
  });

  it('leaves unfinished math, links and code spans as the text typed so far', () => {
    expect(blocksOf(`price ${BACKSLASH}(x_1`)).toEqual([para(text('price (x_1'))]);
    // The half-typed address is only a bare URL until the closing parenthesis arrives: the label is not a link yet.
    expect(blocksOf('see [the docs](https://exa')).toEqual([para(text('see [the docs]('), { kind: 'link', label: [text('https://exa')], href: 'https://exa' })]);
    expect(blocksOf('see [the docs](https://exa)')).toEqual([para(text('see '), { kind: 'link', label: [text('the docs')], href: 'https://exa' })]);
    expect(blocksOf('call `render(')).toEqual([para(text('call `render('))]);
  });
});

describe('the incremental parser', () => {
  const document = [
    '# Report',
    '',
    'Intro with **bold**, `code`, a [link](https://example.invalid) and $x*y$.',
    '',
    '1. first',
    '   - nested *one*',
    '   - nested two',
    '2. second',
    '',
    '   continued paragraph of the second item',
    '',
    '- [ ] open task',
    '- [x] done task',
    '',
    '> quoted',
    '> text',
    '',
    '| A | B |',
    '|---|--:|',
    '| 1 | 2 |',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '````md',
    '```js',
    'inner',
    '```',
    '````',
    '',
    'Closing words.',
  ].join('\n');

  it('returns the same entries for completed blocks while the text grows', () => {
    const parser = createMarkdownParser();
    const first = parser.parse('First paragraph.\n\nSecond paragraph.\n\nThird, still wri', true);
    const second = parser.parse('First paragraph.\n\nSecond paragraph.\n\nThird, still writing more', true);
    const done = parser.parse('First paragraph.\n\nSecond paragraph.\n\nThird, still writing more.', false);

    expect(first.map((entry) => entry.key)).toEqual(['block:0', 'block:1', 'block:2']);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(done[0]).toBe(first[0]);
    expect(done[1]).toBe(first[1]);
    expect(done[2]?.block).toEqual(para(text('Third, still writing more.')));
  });

  it('ends up with exactly what a one-shot parse gives, whatever the chunking', () => {
    const expected = parseMarkdown(document);
    for (const size of [1, 3, 7, 40, 200]) {
      const parser = createMarkdownParser();
      for (let end = size; end < document.length; end += size) parser.parse(document.slice(0, end), true);
      const done = parser.parse(document, false);
      expect(done.map((entry) => entry.block)).toEqual(expected);
      expect(done.map((entry) => entry.key)).toEqual(expected.map((_, index) => `block:${index}`));
    }
  });

  it('lets a list or quote still take in a later indented line', () => {
    const parser = createMarkdownParser();
    parser.parse('- a\n\n', true);
    const grown = parser.parse('- a\n\n  more', true);

    expect(grown).toHaveLength(1);
    expect(grown[0]?.block).toMatchObject({ kind: 'list', items: [{ children: [para(text('a')), para(text('more'))] }] });
  });

  it('starts over when the text is replaced rather than extended', () => {
    const parser = createMarkdownParser();
    parser.parse('Alpha.\n\nBeta.\n\nGamma', true);
    const replaced = parser.parse('Other.\n\nText.', false);

    expect(replaced.map((entry) => entry.block)).toEqual([para(text('Other.')), para(text('Text.'))]);
  });

  it('parses the whole text again once a reference definition appears, so earlier links resolve', () => {
    const parser = createMarkdownParser();
    parser.parse('See [docs][d].\n\nMiddle paragraph.\n\nLast', true);
    const done = parser.parse('See [docs][d].\n\nMiddle paragraph.\n\nLast\n\n[d]: https://example.invalid/d', false);

    expect(done[0]?.block).toEqual(para(text('See '), { kind: 'link', label: [text('docs')], href: 'https://example.invalid/d' }, text('.')));
    expect(done.map((entry) => entry.block.kind)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('normalizes Windows line breaks', () => {
    expect(parseMarkdown('a\r\n\r\nb')).toEqual([para(text('a')), para(text('b'))]);
  });
});

describe('long and hostile input', () => {
  it('parses a long run of emphasis within the render budget', () => {
    const source = '*x* '.repeat(400);
    const started = performance.now();
    const nodes = parseInline(source);

    expect(nodes.filter((node) => node.kind === 'emphasis')).toHaveLength(400);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('shows text that is mostly delimiters as plain text instead of stalling', () => {
    for (const source of ['_a'.repeat(32 * 1_024), '['.repeat(128 * 1_024), `${BACKSLASH}(`.repeat(64 * 1_024), '**a'.repeat(16 * 1_024)]) {
      const started = performance.now();
      const nodes = parseInline(source, true);

      expect(nodes.map((node) => (node.kind === 'text' ? node.text : '')).join('')).toBe(source);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it('keeps parsing a long answer as it streams without re-reading what is finished', () => {
    const parser = createMarkdownParser();
    let source = '';
    const started = performance.now();
    for (let index = 0; index < 300; index += 1) {
      source += index % 10 === 0 ? `\n\n## Section ${index}\n\n` : `Some **bold** words with \`code\` and a [link](https://example.invalid/${index}). `;
      parser.parse(source, true);
    }
    const done = parser.parse(source, false);

    expect(done.length).toBeGreaterThan(50);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('never throws on deeply nested or odd input', () => {
    expect(() => parseMarkdown('>'.repeat(2_000) + ' deep')).not.toThrow();
    expect(() => parseMarkdown('- a\n'.repeat(5_000))).not.toThrow();
    expect(() => parseMarkdown('\u0000\u2028\ud800 weird')).not.toThrow();
    expect(parseMarkdown('')).toEqual([]);
  });
});
