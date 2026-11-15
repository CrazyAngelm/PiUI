import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARK_COLORS } from './marks.svelte';

const css = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8');
const marks = css.slice(css.indexOf('/* Marks:'));
function tokens(selector: string, source = css): Record<string, string> {
  const start = source.indexOf(selector);
  const block = source.slice(start, source.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/(--piui-[\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1], match[2]]));
}
function luminance(hex: string): number {
  const linear = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function ratio(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

describe('mark colors', () => {
  const nano = ':root:not([data-style="chaos"]):not([data-plugin-theme])';
  const themed = (selector: string): Record<string, string> => ({ ...tokens(selector), ...tokens(selector, marks) });
  const palettes = {
    'Chaos dark': themed(':root {'),
    'Chaos light': themed(':root[data-theme="light"]'),
    'Chaos system light': themed(':root[data-theme="system"]'),
    'Nano dark': { ...themed(':root {'), ...tokens(`${nano} {`) },
    'Nano light': { ...themed(':root[data-theme="light"]'), ...tokens(`${nano}[data-theme="light"]`) },
    'Nano system light': { ...themed(':root[data-theme="system"]'), ...tokens(`${nano}[data-theme="system"]`) },
  };
  for (const [name, values] of Object.entries(palettes)) {
    it(`is defined and visible on the sidebar and panels in ${name}`, () => {
      for (const color of MARK_COLORS) {
        const mark = values[`--piui-mark-${color}`];
        expect(mark, `${name}: ${color}`).toBeDefined();
        // WCAG 2.2 SC 1.4.11, graphical objects.
        for (const surface of ['bg', 'bg-raised', 'surface-1']) {
          expect(ratio(mark, values[`--piui-${surface}`]), `${name}: ${color}/${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }
});
