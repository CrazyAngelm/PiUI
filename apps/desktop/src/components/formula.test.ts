import { beforeEach, describe, expect, it, vi } from 'vitest';

const katex = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('katex', () => ({ default: katex }));
vi.mock('katex/dist/katex.min.css', () => ({}));

interface Holder { childNodes: unknown[] }
function target() {
  const holder: Holder = { childNodes: [] };
  const element = {
    ownerDocument: { createElement: vi.fn(() => holder) },
    replaceChildren: vi.fn(),
  };
  return { element: element as unknown as HTMLElement, raw: element, holder };
}

beforeEach(() => {
  vi.resetModules();
  katex.render.mockReset();
  katex.render.mockImplementation((tex: string, holder: Holder) => { holder.childNodes = [{ typeset: tex }]; });
});

describe('formula typesetting', () => {
  it('renders through the KaTeX DOM API with the safe options and swaps the source for the result', async () => {
    const { renderFormula } = await import('./formula');
    const { element, raw } = target();
    expect(await renderFormula(element, 'x^2 + y^2 = z^2', true)).toBe(true);
    expect(katex.render).toHaveBeenCalledOnce();
    const [tex, , options] = katex.render.mock.calls[0]!;
    expect(tex).toBe('x^2 + y^2 = z^2');
    expect(options).toMatchObject({ displayMode: true, output: 'htmlAndMathml', throwOnError: false, trust: false, strict: 'ignore' });
    expect(options.maxSize).toBeGreaterThan(0);
    expect(options.maxExpand).toBeGreaterThan(0);
    expect(raw.replaceChildren).toHaveBeenCalledWith({ typeset: 'x^2 + y^2 = z^2' });
    expect(await renderFormula(element, 'a', false)).toBe(true);
    expect(katex.render.mock.calls[1]![2]).toMatchObject({ displayMode: false });
  });

  it('leaves the element untouched for an empty or oversized formula', async () => {
    const { renderFormula, MAX_FORMULA_LENGTH } = await import('./formula');
    const { element, raw } = target();
    expect(await renderFormula(element, '   ', true)).toBe(false);
    expect(await renderFormula(element, 'x'.repeat(MAX_FORMULA_LENGTH + 1), true)).toBe(false);
    expect(katex.render).not.toHaveBeenCalled();
    expect(raw.replaceChildren).not.toHaveBeenCalled();
  });

  it('lets only the newest formula of an element win', async () => {
    const { renderFormula } = await import('./formula');
    const { element, raw } = target();
    const [older, newer] = await Promise.all([renderFormula(element, 'old', true), renderFormula(element, 'new', true)]);
    expect(older).toBe(false);
    expect(newer).toBe(true);
    expect(raw.replaceChildren).toHaveBeenCalledOnce();
    expect(raw.replaceChildren).toHaveBeenCalledWith({ typeset: 'new' });
  });

  it('keeps the source readable when KaTeX throws', async () => {
    const { renderFormula } = await import('./formula');
    katex.render.mockImplementation(() => { throw new Error('parse'); });
    const { element, raw } = target();
    expect(await renderFormula(element, '\\bad', true)).toBe(false);
    expect(raw.replaceChildren).not.toHaveBeenCalled();
  });

  it('keeps the source readable when the library cannot load, and tries again later', async () => {
    vi.doMock('katex', () => { throw new Error('chunk unavailable'); });
    const { renderFormula } = await import('./formula');
    const { element } = target();
    try {
      expect(await renderFormula(element, 'x', true)).toBe(false);
      vi.resetModules();
      vi.doMock('katex', () => ({ default: katex }));
      expect(await renderFormula(element, 'x', true)).toBe(true);
    } finally {
      vi.doUnmock('katex');
    }
  });
});
