import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent.svelte';

const BACKSLASH = String.fromCharCode(92);
const html = (source: string, props: { rich?: boolean; streaming?: boolean } = {}): string => render(MarkdownContent, { props: { source, rich: true, ...props } }).body;

describe('math in chat Markdown', () => {
  it('renders a formula as its TeX source with the TeX and display mode where the typesetter finds them', () => {
    const markup = html(`Euler: $e^{i${BACKSLASH}pi}+1=0$ and $$x^2$$`);
    expect(markup).toContain(`data-tex="e^{i${BACKSLASH}pi}+1=0">${BACKSLASH}(e^{i${BACKSLASH}pi}+1=0${BACKSLASH})</span>`);
    expect(markup).toMatch(/class="math [^"]*math--display[^"]*" data-tex="x\^2">/);
  });

  it('leaves math as plain text where the owner is not rich', () => {
    const markup = render(MarkdownContent, { props: { source: 'A $a^2$ formula' } }).body;
    expect(markup).not.toContain('data-tex');
    expect(markup).toContain('$a^2$');
  });

  it('typesets from an effect that follows the parsed text and the streaming state', () => {
    const component = readFileSync(new URL('./MarkdownContent.svelte', import.meta.url), 'utf8');
    expect(component).toMatch(/\$effect\(\(\) => \{\s*void parsed;\s*if \(root !== undefined && rich\) typesetMath\(root, streaming\);/);
    expect(component).toContain('bind:this={root}');
  });
});
