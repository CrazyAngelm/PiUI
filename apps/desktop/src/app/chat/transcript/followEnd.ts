const AT_END = 8;

/**
 * Keeps a scrollable box at its end while `active` and the reader has not
 * scrolled it away from the end; scrolling back to the end follows again.
 * It is for an output box that grows while a command runs: the box stops
 * growing at its height cap, so the transcript's own follow, which watches
 * layout size, never moves it. The text changes are watched instead.
 */
export function followEnd(node: HTMLElement, active: boolean) {
  let enabled = active;
  let pinned = true;
  const pin = (): void => {
    if (enabled && pinned) node.scrollTop = node.scrollHeight;
  };
  const onScroll = (): void => {
    pinned = node.scrollHeight - node.clientHeight - node.scrollTop <= AT_END;
  };
  node.addEventListener('scroll', onScroll, { passive: true });
  const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(pin);
  observer?.observe(node, { childList: true, characterData: true, subtree: true });
  pin();
  return {
    update(next: boolean): void {
      enabled = next;
      pin();
    },
    destroy(): void {
      observer?.disconnect();
      node.removeEventListener('scroll', onScroll);
    },
  };
}
