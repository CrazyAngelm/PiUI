// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderFormula = vi.hoisted(() => vi.fn());
vi.mock('./formula', () => ({ renderFormula }));
import { mathSource, typesetMath } from './mathTypeset';

const BACKSLASH = String.fromCharCode(92);
const source = (tex: string, display: boolean): string => (display ? `${BACKSLASH}[${tex}${BACKSLASH}]` : `${BACKSLASH}(${tex}${BACKSLASH})`);

function message(...blocks: string[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'markdown-content';
  root.innerHTML = blocks.join('');
  return root;
}
const formula = (tex: string, display = false): string => `<span class="math${display ? ' math--display' : ''}" data-tex="${tex}">${source(tex, display)}</span>`;

beforeEach(() => {
  renderFormula.mockReset();
});

describe('typesetting the math of a Markdown message', () => {
  it('cuts the marks off a math node', () => {
    expect(mathSource(source('a*b', false))).toBe('a*b');
    expect(mathSource(source('x^2', true))).toBe('x^2');
  });

  it('calls the KaTeX typesetter for a math node and keeps the source text until it replaces it', () => {
    const root = message(`<p>A ${formula('a^2')}</p>`);
    typesetMath(root, false);
    const [element] = root.querySelectorAll('.math');
    expect(renderFormula).toHaveBeenCalledOnce();
    expect(renderFormula).toHaveBeenCalledWith(element, 'a^2', false);
    // The mock typesets nothing: the element still shows its TeX source.
    expect(element?.textContent).toBe(source('a^2', false));
  });

  it('hands each formula over once, with its TeX and its display mode', () => {
    const typeset = vi.fn();
    const root = message(`<p>A ${formula('a^2')}</p>`, `<blockquote><p>B ${formula('b^2', true)}</p></blockquote>`);
    typesetMath(root, false, typeset);
    typesetMath(root, false, typeset);
    const [a, b] = root.querySelectorAll('.math');
    expect(typeset.mock.calls).toEqual([[a, 'a^2', false], [b, 'b^2', true]]);
  });

  it('keeps the unfinished end of a streaming text as source until the text is complete', () => {
    const typeset = vi.fn();
    const root = message(`<p>${formula('a')}</p>`, `<ul><li>${formula('b')}</li></ul>`);
    typesetMath(root, true, typeset);
    expect(typeset).toHaveBeenCalledTimes(1);
    expect(typeset.mock.calls[0]?.[1]).toBe('a');
    root.insertAdjacentHTML('beforeend', `<p>${formula('c')}</p>`);
    typesetMath(root, true, typeset);
    expect(typeset.mock.calls.map((call) => call[1])).toEqual(['a', 'b']);
    typesetMath(root, false, typeset);
    expect(typeset.mock.calls.map((call) => call[1])).toEqual(['a', 'b', 'c']);
  });

  it('does nothing for a message without formulas', () => {
    const typeset = vi.fn();
    typesetMath(message('<p>plain</p>'), false, typeset);
    expect(typeset).not.toHaveBeenCalled();
  });
});
