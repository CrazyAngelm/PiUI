import { describe, expect, it } from 'vitest';
import { answerText } from './answerSource';
import { stripServiceMarkup } from './serviceMarkup';

const citation = [
  '<oai-mem-citation>',
  '<citation_entries>',
  'MEMORY.md:1-4|note=[user prefers short answers]',
  '</citation_entries>',
  '<rollout_ids>',
  '019e1a01-1234-7000-8000-000000000000',
  '</rollout_ids>',
  '</oai-mem-citation>',
].join('\n');

describe('the memory citation Codex adds to an answer', () => {
  it('is removed from the end of the answer, with the blank line before it', () => {
    expect(stripServiceMarkup(`The answer.\n\n${citation}`)).toBe('The answer.');
    expect(stripServiceMarkup(`${citation}\n`)).toBe('');
  });

  it('is removed from the middle without touching the text around it', () => {
    expect(stripServiceMarkup(`First.\n${citation}\nSecond.`)).toBe('First.\nSecond.');
  });

  it('is removed when it is written on one line, keeping the text beside it', () => {
    expect(stripServiceMarkup('Done <oai-mem-citation><citation_entries>x</citation_entries></oai-mem-citation>')).toBe('Done');
    expect(stripServiceMarkup('<oai-mem-citation>x</oai-mem-citation> after')).toBe(' after');
  });

  it('is removed while still unfinished, because the closing tag has not arrived', () => {
    expect(stripServiceMarkup('Answer.\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1', true)).toBe('Answer.');
  });

  it('does not flash the opening tag while it is being typed', () => {
    expect(stripServiceMarkup('Answer.\n<oai-m', true)).toBe('Answer.');
    expect(stripServiceMarkup('Answer.\n<', true)).toBe('Answer.');
    // A finished answer ending in the same characters is the author's text.
    expect(stripServiceMarkup('Answer.\n<oai-m', false)).toBe('Answer.\n<oai-m');
    // Something that cannot become the tag is kept.
    expect(stripServiceMarkup('a < b and <div', true)).toBe('a < b and <div');
  });

  it('is kept when the answer shows it as code', () => {
    const fenced = ['Example:', '', '```xml', citation, '```', '', 'End.'].join('\n');
    const tilde = ['~~~', citation, '~~~'].join('\n');

    expect(stripServiceMarkup(fenced)).toBe(fenced);
    expect(stripServiceMarkup(tilde)).toBe(tilde);
    // A fence ends only with a fence as long as the opener: the citation after it is service data.
    expect(stripServiceMarkup(['````', '```', 'x', '````', citation].join('\n'))).toBe(['````', '```', 'x', '````'].join('\n'));
  });

  it('leaves other tags, other text and unrelated angle brackets alone', () => {
    const text = 'Use <b>bold</b>, `<oai-mem-citation-like>` and a < b > c.';

    expect(stripServiceMarkup(text)).toBe(text);
    expect(stripServiceMarkup('plain text')).toBe('plain text');
    expect(stripServiceMarkup('')).toBe('');
  });
});

describe('the text of an answer as the chat shows it', () => {
  it('prefers the loaded full answer, then the block text, and removes service markup from either', () => {
    expect(answerText({ text: 'short', status: 'complete' }, 'the full answer')).toBe('the full answer');
    expect(answerText({ text: 'short', status: 'complete' })).toBe('short');
    expect(answerText({ status: 'complete' })).toBe('');
    expect(answerText({ text: `Reply\n${citation}`, status: 'complete' })).toBe('Reply');
    expect(answerText({ text: 'short', status: 'complete' }, `Full\n${citation}`)).toBe('Full');
  });

  it('hides a half-typed tag only while the answer is streaming', () => {
    expect(answerText({ text: 'Reply\n<oai-mem', status: 'streaming' })).toBe('Reply');
    expect(answerText({ text: 'Reply\n<oai-mem', status: 'complete' })).toBe('Reply\n<oai-mem');
  });
});
