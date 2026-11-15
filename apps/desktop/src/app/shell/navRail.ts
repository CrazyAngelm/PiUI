import type { Route } from '../workspaceStore.svelte';

/** Rail entries in display and tab order. */
export const RAIL_ITEMS = ['home', 'search', 'inbox', 'pipelines', 'runs', 'automations'] as const;
export type RailItem = (typeof RAIL_ITEMS)[number];

/**
 * The rail entry that owns a route. Runs and Automations have their own entries;
 * the editor and the library sections belong to Pipelines. Search is an action.
 */
export function railCurrent(route: Route): RailItem | undefined {
  if (route.name === 'home') return 'home';
  if (route.name === 'inbox') return 'inbox';
  if (route.name !== 'pipelines') return undefined;
  if (route.section === 'runs') return 'runs';
  return route.section === 'schedules' ? 'automations' : 'pipelines';
}
