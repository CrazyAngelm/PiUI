import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { createRawSnippet, getAllContexts } from 'svelte';
import { Tooltip } from 'bits-ui';
import type { Route, WorkspaceStore } from '../workspaceStore.svelte';
import { lookupRussian } from '../../features/locale/ruCatalog';
import NavRail from './NavRail.svelte';
import { WORKSPACE_CONTEXT } from './context';

function html(route: Route, approvals = 0, running = false): string {
  const store = {
    route,
    inboxApprovals: Array.from({ length: approvals }, () => ({})),
    runningSessions: running ? [{ runId: 'run-1' }] : [],
    selectedWorkspaceId: '',
    catalog: { workspaces: [] },
    goHome: () => {},
    navigate: () => {},
  } as unknown as WorkspaceStore;
  const children = createRawSnippet(() => ({
    render: () =>
      `<div>${render(NavRail, { props: { onSearch: () => {} }, context: new Map([...getAllContexts(), [WORKSPACE_CONTEXT, store]]) }).body}</div>`,
  }));
  return render(Tooltip.Provider, { props: { children } }).body;
}
const bare = (markup: string): string => markup.replace(/<!--[\s\S]*?-->/g, '');
const buttons = (markup: string): string[] => [...bare(markup).matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
const label = (tag: string): string | undefined => /aria-label="([^"]*)"/.exec(tag)?.[1];
const text = (markup: string): string => bare(markup).replace(/<[^>]*>/g, '').trim();

describe('NavRail', () => {
  it('is its own landmark with the entries in tab order', () => {
    const body = html({ name: 'home' });
    expect(bare(body).match(/<nav\b[^>]*aria-label="Main navigation"/g)).toHaveLength(1);
    expect(buttons(body).map(label)).toEqual(['New chat', 'Search', 'Inbox', 'Pipelines', 'Runs', 'Automations', 'More']);
  });

  it('shows icons only, without captions', () => {
    expect(text(html({ name: 'home' }))).toBe('');
    expect(text(html({ name: 'home' }, 0, true))).toBe('');
  });

  it('marks exactly one button as the current page', () => {
    const cases: [Route, string][] = [
      [{ name: 'home' }, 'New chat'],
      [{ name: 'inbox' }, 'Inbox'],
      [{ name: 'pipelines', section: 'systems' }, 'Pipelines'],
      [{ name: 'pipelines', section: 'agents' }, 'Pipelines'],
      [{ name: 'pipelines', section: 'runs' }, 'Runs'],
      [{ name: 'pipelines', section: 'schedules' }, 'Automations'],
    ];
    for (const [route, expected] of cases) {
      const current = buttons(html(route)).filter((tag) => tag.includes('aria-current="page"'));
      expect(current.map(label), `${route.name} ${'section' in route ? route.section : ''}`).toEqual([expected]);
    }
    for (const route of [{ name: 'chat', sessionId: 's' }, { name: 'settings', section: 'general' }] satisfies Route[]) {
      expect(html(route), route.name).not.toContain('aria-current');
    }
  });

  it('keeps the inbox name with its count and hides the visible badge from assistive technology', () => {
    const body = html({ name: 'home' }, 2);
    expect(buttons(body).map(label)).toContain('Inbox 2 waiting');
    expect(text(body)).toBe('2');
    const badge = /<span\b[^>]*rail__count[^>]*>/.exec(bare(body))?.[0];
    expect(badge).toContain('aria-hidden="true"');
  });

  it('marks a running pipeline with a decorative dot on Runs', () => {
    const body = bare(html({ name: 'home' }, 0, true));
    expect(body).toContain('rail__dot');
    expect(body).not.toContain('rail__count');
    expect(bare(html({ name: 'home' }))).not.toContain('rail__dot');
  });

  it('offers no work location while signed out', () => {
    const body = html({ name: 'home' });
    expect(body).not.toContain('Work location');
    expect(body).not.toContain('Open Nano Cloud');
  });

  it('is navigation, not a toggle', () => {
    expect(html({ name: 'home' })).not.toContain('aria-pressed');
  });

  it('has Russian copy for every string', () => {
    const source = readFileSync(new URL('./NavRail.svelte', import.meta.url), 'utf8');
    const keys = new Set([...source.matchAll(/\$t\('((?:[^'\\]|\\.)*)'/gu)].map((match) => (match[1] ?? '').replace(/\\'/gu, "'")));
    expect(keys).toContain('Main navigation');
    expect(keys).toContain('More');
    for (const key of keys) expect(lookupRussian(key), key).toBeDefined();
  });
});
