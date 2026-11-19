import { describe, expect, it } from 'vitest';
import { stripSubtitleCredit } from './dictationTransport';

describe('stripSubtitleCredit', () => {
  it('drops a lone invented credit', () => {
    expect(stripSubtitleCredit('Субтитры сделал DimaTorzok')).toBe('');
  });
  it('drops a trailing credit and keeps the speech', () => {
    expect(stripSubtitleCredit('Привет, как дела. Субтитры сделал DimaTorzok')).toBe('Привет, как дела');
  });
  it('keeps ordinary text', () => {
    expect(stripSubtitleCredit('Сделай субтитры для видео')).toBe('Сделай субтитры для видео');
  });
});
