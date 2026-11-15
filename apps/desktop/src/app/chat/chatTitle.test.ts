import { describe, expect, it } from 'vitest';
import { CHAT_TITLE_LIMIT, chatTitle } from './chatTitle';

describe('chatTitle', () => {
  it('takes the first line that has words, as one line', () => {
    expect(chatTitle('Fix the parser')).toBe('Fix the parser');
    expect(chatTitle('\n  \n  Fix   the\tparser  \nand the tests')).toBe('Fix the parser');
    expect(chatTitle('Почини парсер\r\nи тесты')).toBe('Почини парсер');
  });

  it('keeps what was typed, a macro or a command included', () => {
    expect(chatTitle('//review the upload flow')).toBe('//review the upload flow');
    expect(chatTitle('/compact')).toBe('/compact');
  });

  it('cuts a long line to the limit and says so', () => {
    expect(chatTitle('a'.repeat(CHAT_TITLE_LIMIT))).toBe('a'.repeat(CHAT_TITLE_LIMIT));
    const cut = chatTitle('a'.repeat(CHAT_TITLE_LIMIT + 1));
    expect(cut).toBe(`${'a'.repeat(CHAT_TITLE_LIMIT - 1)}…`);
    expect([...cut]).toHaveLength(CHAT_TITLE_LIMIT);
    // No space is left before the mark.
    expect(chatTitle(`${'a'.repeat(CHAT_TITLE_LIMIT - 2)} tail and more`)).toBe(`${'a'.repeat(CHAT_TITLE_LIMIT - 2)}…`);
  });

  it('counts characters, not UTF-16 units', () => {
    const faces = '😀'.repeat(CHAT_TITLE_LIMIT);
    expect(chatTitle(faces)).toBe(faces);
    expect([...chatTitle(`${faces}😀`)]).toHaveLength(CHAT_TITLE_LIMIT);
  });

  it('has no control character, which the host refuses in a title', () => {
    expect(chatTitle(`Fix${String.fromCharCode(7)}the${String.fromCharCode(0)} parser`)).toBe('Fix the parser');
  });

  it('is empty when the message has no words', () => {
    expect(chatTitle('')).toBe('');
    expect(chatTitle(' \n\t\r\n')).toBe('');
  });
});
