/**
 * The previous interfaces stay reachable for release 0.2.0 and are removed in
 * the next release: `?view=legacy` (the earlier workspace shell) and
 * `?view=classic` (the Pi-only view). Switching reloads the same document
 * with the `view` parameter changed and keeps every other parameter, such as
 * the UI Lab scenario. It never touches host state.
 */
export type PreviousView = 'legacy' | 'classic';

export function viewUrl(href: string, view: PreviousView | undefined): string {
  const url = new URL(href);
  if (view === undefined) url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  return url.toString();
}

export function openView(view: PreviousView | undefined): void {
  if (typeof window === 'undefined') return;
  window.location.assign(viewUrl(window.location.href, view));
}
