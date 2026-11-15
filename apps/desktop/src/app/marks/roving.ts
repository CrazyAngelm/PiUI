/** Index to focus after an arrow key in a row (`columns` = count) or a grid; undefined when the key is not a movement. */
export function nextIndex(key: string, index: number, count: number, columns: number): number | undefined {
  if (count <= 0) return undefined;
  const last = count - 1;
  switch (key) {
    case 'ArrowRight':
      return index >= last ? 0 : index + 1;
    case 'ArrowLeft':
      return index <= 0 ? last : index - 1;
    case 'ArrowDown':
      return columns >= count ? undefined : index + columns <= last ? index + columns : index;
    case 'ArrowUp':
      return columns >= count ? undefined : index - columns >= 0 ? index - columns : index;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return undefined;
  }
}

/**
 * One tab stop for a group of buttons: arrows, Home and End move focus (they do not choose),
 * and the checked or pressed button, else the first, is the stop.
 */
export function roving(columns: number) {
  return (node: HTMLElement): (() => void) => {
    const buttons = (): HTMLButtonElement[] => [...node.querySelectorAll<HTMLButtonElement>('button')];
    const stop = (target: HTMLElement | undefined): void => {
      for (const button of buttons()) button.tabIndex = button === target ? 0 : -1;
    };
    stop(buttons().find((button) => button.getAttribute('aria-checked') === 'true' || button.getAttribute('aria-pressed') === 'true') ?? buttons()[0]);
    const keydown = (event: KeyboardEvent): void => {
      const all = buttons();
      const next = nextIndex(event.key, all.indexOf(document.activeElement as HTMLButtonElement), all.length, columns);
      if (next === undefined) return;
      event.preventDefault();
      stop(all[next]);
      all[next]?.focus();
    };
    const focusin = (event: FocusEvent): void => {
      if (event.target instanceof HTMLButtonElement) stop(event.target);
    };
    node.addEventListener('keydown', keydown);
    node.addEventListener('focusin', focusin);
    return () => {
      node.removeEventListener('keydown', keydown);
      node.removeEventListener('focusin', focusin);
    };
  };
}
