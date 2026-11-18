import { renderFormula } from './formula';

/** The TeX of a Markdown math node: its text without the `\(`..`\)` or `\[`..`\]` marks. */
export function mathSource(text: string): string {
  return text.slice(2, -2);
}

type Typeset = (element: HTMLElement, tex: string, display: boolean) => unknown;

/**
 * Typesets the formulas a rendered Markdown message shows as TeX source (`.math[data-tex]`, ADR-075 and
 * ADR-077). The element keeps its source text as the fallback until, and unless, KaTeX replaces it,
 * and each element is handed over once. While the text is still arriving (`streaming`) the last
 * top-level block is its unfinished end, where a formula can still change or stop being one (`$a$`
 * followed by a digit is a price), so only the blocks before it are typeset.
 */
export function typesetMath(root: HTMLElement, streaming: boolean, typeset: Typeset = (element, tex, display) => void renderFormula(element, tex, display)): void {
  const pending = root.querySelectorAll<HTMLElement>('.math[data-tex]:not([data-typeset])');
  if (pending.length === 0) return;
  const tail = streaming ? root.lastElementChild : null;
  for (const element of pending) {
    let block: Element = element;
    while (block.parentElement !== null && block.parentElement !== root) block = block.parentElement;
    if (block === tail) continue;
    element.setAttribute('data-typeset', '');
    typeset(element, element.getAttribute('data-tex') ?? '', element.classList.contains('math--display'));
  }
}
