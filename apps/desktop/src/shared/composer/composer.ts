import type { ComposerHandle, ComposerOptions, ComposerRows } from '../../../../../contracts/composer-presentation-v1';
export type { ComposerHandle, ComposerOptions, ComposerRows } from '../../../../../contracts/composer-presentation-v1';

const editors = new WeakMap<HTMLTextAreaElement, ComposerHandle>();
const pixels = (value: string): number => Number.parseFloat(value) || 0;

/** Size only: the editor value and selection always belong to the hosting UI. */
export function resizeComposer(input: HTMLTextAreaElement, rows?: ComposerRows): void {
  const view = input.ownerDocument.defaultView;
  if (!view || !input.isConnected) return;
  const style = view.getComputedStyle(input);
  const padding = pixels(style.paddingTop) + pixels(style.paddingBottom);
  const borders = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
  const borderBox = style.boxSizing === 'border-box';
  input.style.height = 'auto';
  let height = input.scrollHeight + (borderBox ? borders : -padding);
  if (rows) {
    // Same normal-line-height fallback used by the existing native Textarea.
    const line = pixels(style.lineHeight) || 20;
    const extra = borderBox ? padding + borders : 0;
    height = Math.min(Math.max(height, rows.minRows * line + extra), rows.maxRows * line + extra);
  }
  input.style.height = `${height}px`;
  // Preserve the existing web rounding tolerance for fractional CSS pixels.
  input.style.overflowY = input.scrollHeight > input.clientHeight + 1 ? 'auto' : 'hidden';
}

function validate(options: ComposerOptions): void {
  if (options.contractVersion !== 1 || typeof options.onSubmit !== 'function') throw new Error('Unsupported composer presentation contract.');
  const rows = options.autoGrow;
  if (rows && (!Number.isFinite(rows.minRows) || !Number.isFinite(rows.maxRows) || rows.minRows <= 0 || rows.maxRows < rows.minRows)) {
    throw new Error('Invalid composer row bounds.');
  }
}

/** Attaches keyboard/geometry behavior without replacing or moving owner DOM. */
export function attachComposer(input: HTMLTextAreaElement, initial: ComposerOptions): ComposerHandle {
  validate(initial);
  const view = input.ownerDocument.defaultView;
  if (!view) throw new Error('The composer needs a document window.');
  editors.get(input)?.dispose();
  let options = initial;
  let disposed = false;
  const height = input.style.height;
  const overflow = input.style.overflowY;
  const resize = () => { if (!disposed) resizeComposer(input, options.autoGrow); };
  const keydown = (event: KeyboardEvent) => {
    if (disposed || !input.isConnected || input.disabled || event.isComposing || event.keyCode === 229) return;
    options.beforeKeyDown?.(event);
    if (disposed || event.defaultPrevented || input.disabled || event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    const touchOnly = options.touchOnly?.() ?? (view.matchMedia('(pointer: coarse)').matches && !view.matchMedia('(any-pointer: fine)').matches);
    if (touchOnly && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    options.onSubmit(event);
  };
  // Observe width, not height, to avoid feeding the auto-grow write back into itself.
  let width = input.getBoundingClientRect().width;
  const observer = new ResizeObserver(() => {
    const next = input.getBoundingClientRect().width;
    if (next !== width) { width = next; resize(); }
  });
  const handle: ComposerHandle = {
    update(next) { validate(next); if (!disposed) { options = next; resize(); } },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      input.removeEventListener('input', resize);
      input.removeEventListener('keydown', keydown);
      view.removeEventListener('resize', resize);
      input.style.height = height;
      input.style.overflowY = overflow;
      if (editors.get(input) === handle) editors.delete(input);
    },
  };
  input.addEventListener('input', resize);
  input.addEventListener('keydown', keydown);
  view.addEventListener('resize', resize);
  observer.observe(input);
  editors.set(input, handle);
  resize();
  return handle;
}
