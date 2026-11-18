import { describe, expect, it } from 'vitest';
import { createMarkdownParser, parseMarkdown } from './markdown';

/** A small seeded generator, so a failing split can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random cut points: pieces of 1 to `most` characters. */
function chunks(text: string, next: () => number, most: number): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length;) {
    const size = 1 + Math.floor(next() * most);
    pieces.push(text.slice(at, at + size));
    at += size;
  }
  return pieces;
}

const fixtures: Record<string, string> = {
  'a line that becomes a tag after a heading start': 'Text\n#tag and more text\n\nNext paragraph.\n',
  'a heading that really starts': 'Text\n# Heading\nAfter.\n\nEnd.',
  'a setext heading being typed': 'Title\n===\n\nSub\n---\n\nBody',
  'a table that takes a row': '| A | B |\n|---|---|\n| 1 | 2 |\nnot a row? yes, a row\n\nAfter the table.',
  'a list that takes a lazy line': '- first\n#tag lazy line\n- second\n\nAfter.',
  'a quote that takes a lazy line': '> quoted\nlazy\n\n> second quote\n\nAfter.',
  'an html block': '<div>\ntext\n</div>\n\nAfter html.\n\n<b>inline</b> text',
  'a fence with a fence inside': 'Before.\n\n````md\n```js\ninner\n```\n````\n\nAfter.\n',
  'a link definition after its use': 'See [docs][d] and [other][o].\n\nMiddle paragraph.\n\n[d]: https://example.invalid/d\n\nLast [d].\n\n[o]: https://example.invalid/o',
  'a definition inside a quote': '> [q]: https://example.invalid/q\n> quoted [q]\n\nUse [q] here.\n\nAnd [q] again.\n',
  'a definition inside a list': '- item\n\n  [l]: https://example.invalid/l\n\nThen [l] outside.\n\nMore.',
  'nested lists and a continuation': '1. one\n   - nested *a*\n   - nested b\n2. two\n\n   continued\n\n- [ ] task\n- [x] done\n\nTail.',
  'emphasis and code spans': 'A **bold** and *it* and `code` and ~~gone~~ and **unfinished\n\nNext `span\nacross` lines.',
};

describe('a streamed message equals its one-shot parse, whatever the chunking', () => {
  for (const [name, source] of Object.entries(fixtures)) {
    it(name, () => {
      const expected = parseMarkdown(source);
      const expectedStreaming = parseMarkdown(source, false, false, true);
      for (let seed = 1; seed <= 60; seed += 1) {
        const next = random(seed * 7919);
        const most = [2, 5, 12, 40][seed % 4]!;
        const parser = createMarkdownParser();
        let seen = '';
        for (const piece of chunks(source, next, most)) {
          seen += piece;
          const state = parser.parse(seen, true);
          if (seen !== source) continue;
          expect(state.map((entry) => entry.block), `streaming, seed ${seed}`).toEqual(expectedStreaming);
        }
        const done = parser.parse(source, false);
        expect(done.map((entry) => entry.block), `complete, seed ${seed}`).toEqual(expected);
      }
    });
  }

  it('also at every step: the streamed prefix shows what the same text shows in one parse', () => {
    for (const [name, source] of Object.entries(fixtures)) {
      for (const size of [1, 2, 3, 7]) {
        const parser = createMarkdownParser();
        for (let end = size; end <= source.length; end += size) {
          const prefix = source.slice(0, end);
          expect(parser.parse(prefix, true).map((entry) => entry.block), `${name}, ${size} at a time, ${JSON.stringify(prefix.slice(-12))}`)
            .toEqual(parseMarkdown(prefix, false, false, true));
        }
      }
    }
  });
});

describe('what the parser has committed cannot change', () => {
  it('re-reads a line that a following character turns into a different block', () => {
    const parser = createMarkdownParser();
    parser.parse('Text\n#', true);
    const grown = parser.parse('Text\n#tag', true);
    expect(grown.map((entry) => entry.block)).toEqual(parseMarkdown('Text\n#tag', false, false, true));
    expect(grown).toHaveLength(1);
  });

  it('commits a paragraph once a blank line follows it, and keeps that entry', () => {
    const parser = createMarkdownParser();
    const first = parser.parse('One.\n\nTwo', true);
    const second = parser.parse('One.\n\nTwo and more', true);
    expect(second[0]).toBe(first[0]);
  });

  it('commits a closed fence and a heading line without a blank line after them', () => {
    const parser = createMarkdownParser();
    const first = parser.parse('```js\ncode\n```\n# Title\nbody', true);
    const second = parser.parse('```js\ncode\n```\n# Title\nbody more', true);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('parses everything again when a definition appears nested in a quote or a list', () => {
    for (const nested of ['> [d]: https://example.invalid/d', '- item\n\n  [d]: https://example.invalid/d']) {
      const parser = createMarkdownParser();
      parser.parse('See [docs][d].\n\nMiddle.\n\nLast', true);
      const source = `See [docs][d].\n\nMiddle.\n\nLast\n\n${nested}\n\nEnd.`;
      const done = parser.parse(source, false);
      expect(done.map((entry) => entry.block)).toEqual(parseMarkdown(source));
      expect(JSON.stringify(done[0]?.block)).toContain('https://example.invalid/d');
    }
  });
});
