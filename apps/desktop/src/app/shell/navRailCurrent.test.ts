import { describe, expect, it } from 'vitest';
import type { Route } from '../workspaceStore.svelte';
import { RAIL_ITEMS, railCurrent } from './navRail';

const routes: Route[] = [
  { name: 'home' },
  { name: 'inbox' },
  { name: 'pipelines', section: 'systems' },
  { name: 'pipelines', section: 'agents' },
  { name: 'pipelines', section: 'teams' },
  { name: 'pipelines', section: 'pipelines' },
  { name: 'pipelines', section: 'runs' },
  { name: 'pipelines', section: 'runs', runId: 'run-1' },
  { name: 'pipelines', section: 'schedules' },
  { name: 'chat', sessionId: 's' },
  { name: 'settings', section: 'general' },
  { name: 'history', workspaceId: 'w' },
  { name: 'board', workspaceId: 'w' },
  { name: 'team', workspaceId: 'w' },
];

describe('rail entries', () => {
  it('keep their display and tab order', () => {
    expect([...RAIL_ITEMS]).toEqual(['home', 'search', 'inbox', 'pipelines', 'runs', 'automations']);
  });

  it('mark New chat and Inbox for their own routes', () => {
    expect(railCurrent({ name: 'home' })).toBe('home');
    expect(railCurrent({ name: 'inbox' })).toBe('inbox');
  });

  it('give the editor and the library sections to Pipelines', () => {
    for (const section of ['systems', 'agents', 'teams', 'pipelines'] as const) {
      expect(railCurrent({ name: 'pipelines', section }), section).toBe('pipelines');
    }
  });

  it('give Runs (with or without an open run) and schedules their own entries', () => {
    expect(railCurrent({ name: 'pipelines', section: 'runs' })).toBe('runs');
    expect(railCurrent({ name: 'pipelines', section: 'runs', runId: 'run-1' })).toBe('runs');
    expect(railCurrent({ name: 'pipelines', section: 'schedules' })).toBe('automations');
  });

  it('mark nothing for chats, settings, history, boards and teams', () => {
    for (const route of [
      { name: 'chat', sessionId: 's' },
      { name: 'settings', section: 'general' },
      { name: 'history', workspaceId: 'w' },
      { name: 'board', workspaceId: 'w' },
      { name: 'team', workspaceId: 'w' },
    ] satisfies Route[]) {
      expect(railCurrent(route), route.name).toBeUndefined();
    }
  });

  it('treat Search as an action, never as the current view', () => {
    for (const route of routes) expect(railCurrent(route)).not.toBe('search');
  });
});
