import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/(--piui-[\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1], match[2]]));
}
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function ratio(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}
describe('workspace semantic palette', () => {
  for (const selector of [':root {', ':root[data-theme="light"]', ':root[data-theme="system"]']) {
    it(`meets WCAG AA normal-text and control contrast for ${selector}`, () => {
      const values = tokens(selector);
      for (const surface of ['bg', 'bg-raised', 'surface-1', 'surface-2', 'surface-3']) {
        for (const text of ['text', 'text-muted', 'text-faint', 'accent', 'danger', 'warning', 'success']) {
          // WCAG 2.2 SC 1.4.3, normal text. Not an application-specific threshold.
          expect(ratio(values[`--piui-${text}`], values[`--piui-${surface}`]), `${selector}: ${text}/${surface}`).toBeGreaterThanOrEqual(4.5);
        }
        // WCAG 2.2 SC 1.4.11, required control boundaries and focus indicators.
        for (const control of ['border-strong', 'focus']) {
          expect(ratio(values[`--piui-${control}`], values[`--piui-${surface}`])).toBeGreaterThanOrEqual(3);
        }
      }
      expect(ratio(values['--piui-action-ink'], values['--piui-action'])).toBeGreaterThanOrEqual(4.5);
      expect(ratio(values['--piui-accent-ink'], values['--piui-accent'])).toBeGreaterThanOrEqual(4.5);
    });
    it(`keeps highlighted code readable on the code surface for ${selector}`, () => {
      const values = tokens(selector);
      for (const token of ['keyword', 'string', 'number', 'comment', 'function', 'type', 'property', 'punctuation']) {
        expect(ratio(values[`--piui-syntax-${token}`], values['--piui-code-surface']), `${selector}: ${token}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  it('keeps system light identical to explicit light', () => {
    expect(tokens(':root[data-theme="system"]')).toEqual(tokens(':root[data-theme="light"]'));
  });
});
