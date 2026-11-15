import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../../host-api/types';
import { groupTranscriptBlocks, type TimelineActivityGroup } from '../../../features/sessions/timelineView';
import ActivityGroupView from './ActivityGroupView.svelte';

const command = (id: string, patch: Partial<TimelineBlock> = {}): TimelineBlock => ({
  id,
  kind: 'tool',
  status: 'complete',
  toolName: 'bash',
  ...patch,
});

function groupOf(blocks: readonly TimelineBlock[]): TimelineActivityGroup {
  const item = groupTranscriptBlocks(blocks)[0];
  if (item?.type !== 'activity-group') throw new Error('Expected an activity group.');
  return item;
}

function view(blocks: readonly TimelineBlock[], language: 'en' | 'ru' = 'en'): string {
  return render(ActivityGroupView, {
    props: { group: groupOf(blocks), language, openState: {}, onOpenChange: () => {} },
  }).body;
}

/** Markup without the hydration comments the server render adds. */
const bare = (markup: string): string => markup.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string): string => bare(markup).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

describe('ActivityGroupView', () => {
  it('shows only the summary when every call succeeded', () => {
    const markup = view([command('a'), command('b'), command('c')]);
    expect(text(markup)).toContain('Ran 3 commands');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('group__status');
  });

  it('counts failed calls in words, not only with an icon', () => {
    const markup = view([command('a'), command('b', { status: 'failed' }), command('c')]);
    expect(text(markup)).toContain('1 failed');
  });

  it('shows the running call next to earlier failures', () => {
    const markup = view([
      command('a', { status: 'failed' }),
      command('b', { status: 'streaming', title: 'Bash: npm test' }),
    ]);
    expect(text(markup)).toContain('working…');
    expect(text(markup)).toContain('Bash: npm test');
    expect(text(markup)).toContain('1 failed');
  });

  it('calls a stopped call stopped, not failed', () => {
    const markup = view([command('a'), command('b', { status: 'interrupted' })]);
    expect(text(markup)).toContain('Stopped');
    expect(text(markup)).not.toContain('failed');
  });

  it('prefers the running state over a stopped call', () => {
    const markup = view([command('a', { status: 'interrupted' }), command('b', { status: 'streaming', title: 'Bash: pnpm check' })]);
    expect(text(markup)).toContain('working…');
    expect(text(markup)).not.toContain('Stopped');
  });

  it('summarizes in Russian', () => {
    expect(text(view([command('a'), command('b')], 'ru'))).toContain('Выполнил 2 команды');
  });
});
