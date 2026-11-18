import { describe, expect, it } from 'vitest';
import { describeInteractiveBlock, hasInteractiveBlock, summarizeInteractiveBlocks } from './summaries';

const BLOCK = '```hermes-ui\n{"title":"Rent calculator","body":[{"type":"text","text":"x"}]}\n```';
const options = { label: 'Interactive block' };

describe('interactive block summaries', () => {
  it('puts the title in place of the JSON and keeps the text around it', () => {
    expect(summarizeInteractiveBlocks(`Here you go:\n${BLOCK}\nPick one.`, options)).toBe('Here you go:\nInteractive block: Rent calculator\nPick one.');
  });

  it('wraps each summary when asked', () => {
    expect(summarizeInteractiveBlocks(BLOCK, { ...options, format: summary => `*${summary}*` })).toBe('*Interactive block: Rent calculator*');
  });

  it('handles an unfinished block, reading the title that has already arrived', () => {
    expect(summarizeInteractiveBlocks('Start\n```hermes-ui\n{"title":"Plan","body":[{"type":"te', options)).toBe('Start\nInteractive block: Plan');
  });

  it('names a block without a title by the label alone', () => {
    expect(summarizeInteractiveBlocks('```hermes-ui\n{"body":[]}\n```', options)).toBe('Interactive block');
    expect(summarizeInteractiveBlocks('```hermes-ui\n[1,2]\n```', options)).toBe('Interactive block');
    expect(summarizeInteractiveBlocks('```hermes-ui\n{"title":42}\n```', options)).toBe('Interactive block');
  });

  it('keeps a title with an escape JSON does not know', () => {
    expect(describeInteractiveBlock('{"title":"Step \\d of 3","body":[{', 'Interactive block')).toBe('Interactive block: Step \\d of 3');
    expect(describeInteractiveBlock('{"title":"Plan \\"A\\"","body":[{', 'Interactive block')).toBe('Interactive block: Plan "A"');
  });

  it('shortens a very long title and collapses its whitespace', () => {
    const summary = describeInteractiveBlock(JSON.stringify({ title: `A  \n  ${'b'.repeat(400)}` }), 'Interactive block');
    expect(summary.startsWith('Interactive block: A b')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual('Interactive block: '.length + 120);
  });

  it('replaces every block and leaves other code fences and plain text alone', () => {
    const ordinary = 'Text\n```json\n{"title":"x"}\n```\n';
    expect(summarizeInteractiveBlocks(ordinary, options)).toBe(ordinary);
    const two = `${BLOCK}\nmiddle\n${BLOCK.replace('Rent calculator', 'Second')}`;
    expect(summarizeInteractiveBlocks(two, options)).toBe('Interactive block: Rent calculator\nmiddle\nInteractive block: Second');
  });

  it('closes on a longer fence and ignores the language case', () => {
    expect(summarizeInteractiveBlocks('```HERMES-UI\n{"title":"Up"}\n````\nafter', options)).toBe('Interactive block: Up\nafter');
  });

  it('detects blocks cheaply', () => {
    expect(hasInteractiveBlock(BLOCK)).toBe(true);
    expect(hasInteractiveBlock('plain')).toBe(false);
    expect(hasInteractiveBlock(undefined)).toBe(false);
  });

  it('uses the app label by default', () => {
    expect(summarizeInteractiveBlocks(BLOCK)).toBe('Interactive block: Rent calculator');
  });
});
