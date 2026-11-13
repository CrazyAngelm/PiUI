import { getContext, setContext } from 'svelte';

const portalTarget = Symbol('piui-portal-target');

/** Embedded surfaces keep portals inside their own styled DOM boundary. */
export function providePortalTarget(target: () => HTMLElement): void {
  setContext(portalTarget, target);
}

export function usePortalTarget(): (() => HTMLElement) | undefined {
  return getContext<(() => HTMLElement) | undefined>(portalTarget);
}
