/**
 * TeX typesetting for formulas (ADR-077): the `formula` node of an interactive answer, and the
 * chat's Markdown for `$...$` / `$$...$$` when it adopts it (see `renderFormula`).
 *
 * KaTeX is loaded on first use, never at startup. It builds the formula through the DOM API
 * (`katex.render` makes elements and sets their styles through the CSSOM), so no markup string
 * from an answer reaches `innerHTML` and the page's style policy needs no `unsafe-inline`. Its own
 * output is library-generated structure; the TeX source is data. `trust: false` turns off its
 * links, images and HTML-attribute macros, `maxSize` and `maxExpand` bound what one formula can
 * ask for, and a formula that cannot be typeset leaves the element showing its TeX source.
 */
import type { KatexOptions } from 'katex';

type Katex = typeof import('katex').default;

export const MAX_FORMULA_LENGTH = 2000;

const OPTIONS: Readonly<KatexOptions> = Object.freeze({
  output: 'htmlAndMathml',
  throwOnError: false,
  trust: false,
  strict: 'ignore',
  maxSize: 30,
  maxExpand: 1000,
  errorColor: 'var(--piui-danger)',
});

let loading: Promise<Katex | undefined> | undefined;
const latest = new WeakMap<HTMLElement, number>();

function load(): Promise<Katex | undefined> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([module]) => module.default)
    .catch(() => {
      // A failed lazy load leaves the TeX source readable; the next formula tries again.
      loading = undefined;
      return undefined;
    });
  return loading;
}

/**
 * Typesets `tex` into `element`, replacing what it shows now. Resolves to whether it was
 * typeset; on `false` the element is untouched. A newer call for the same element wins:
 * an older, slower one never overwrites it.
 */
export async function renderFormula(element: HTMLElement, tex: string, display: boolean): Promise<boolean> {
  const token = (latest.get(element) ?? 0) + 1;
  latest.set(element, token);
  if (tex.trim() === '' || tex.length > MAX_FORMULA_LENGTH) return false;
  const katex = await load();
  if (katex === undefined || latest.get(element) !== token) return false;
  const holder = element.ownerDocument.createElement('span');
  try {
    katex.render(tex, holder, { ...OPTIONS, displayMode: display });
  } catch {
    return false;
  }
  if (latest.get(element) !== token) return false;
  element.replaceChildren(...Array.from(holder.childNodes));
  return true;
}
