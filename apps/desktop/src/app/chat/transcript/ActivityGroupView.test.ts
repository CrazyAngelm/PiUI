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

const thought = (id: string, patch: Partial<TimelineBlock> = {}): TimelineBlock => ({
  id,
  kind: 'thinking',
  status: 'complete',
  ...patch,
});

function groupOf(blocks: readonly TimelineBlock[], running = false): TimelineActivityGroup {
  const item = groupTranscriptBlocks(blocks, running)[0];
  if (item?.type !== 'activity-group') throw new Error('Expected an activity group.');
  return item;
}

function view(blocks: readonly TimelineBlock[], language: 'en' | 'ru' = 'en', running = false, open = false): string {
  const group = groupOf(blocks, running);
  return render(ActivityGroupView, {
    props: { group, language, openState: open ? { [group.id]: true } : {}, onOpenChange: () => {} },
  }).body;
}

/** Markup without the hydration comments the server render adds. */
const bare = (markup: string): string => markup.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string): string => bare(markup).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** The text of the group's header button alone. */
function head(markup: string): string {
  const match = /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(bare(markup));
  if (!match) throw new Error('No button was rendered.');
  return text(match[1] ?? '');
}

describe('ActivityGroupView', () => {
  it('shows only the summary when every call succeeded', () => {
    const markup = view([command('a'), command('b'), command('c')]);
    expect(head(markup)).toBe('Ran 3 commands');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('group__status');
  });

  it('counts failed calls in words, not only with an icon', () => {
    const markup = view([command('a'), command('b', { status: 'failed' }), command('c')]);
    expect(text(markup)).toContain('1 failed');
  });

  it('names what a working group does now, in place of its counts', () => {
    const markup = view([
      command('a', { status: 'failed' }),
      command('b', { status: 'streaming', title: 'Bash: npm test' }),
    ]);
    expect(head(markup)).toMatch(/^Running a command · Bash: npm test/);
    expect(head(markup)).not.toContain('Ran 2 commands');
    expect(text(markup)).toContain('1 failed');
    expect(markup).toContain('spinner');
  });

  it('works without a running call while the chat still works', () => {
    const markup = view([command('a'), command('b')], 'en', true);
    expect(head(markup)).toBe('Working');
    expect(markup).toContain('spinner');
  });

  it('follows streaming reasoning when no call runs', () => {
    const markup = view([thought('t', { status: 'streaming', text: 'Plan\n\nChecking the scheduler tests' })], 'en', true);
    expect(head(markup)).toBe('Thinking · Checking the scheduler tests');
  });

  it('puts the icon of the leading kind in front of a finished group', () => {
    const edits = view([command('a'), command('b', { toolName: 'edit' })]);
    expect(edits).not.toContain('spinner');
    expect(edits).toContain('<svg');
    expect(bare(edits)).toMatch(/<button[^>]*>\s*<span class="group__lead[^"]*">\s*<svg/);
  });

  it('calls a stopped call stopped, not failed', () => {
    const markup = view([command('a'), command('b', { status: 'interrupted' })]);
    expect(text(markup)).toContain('Stopped');
    expect(text(markup)).not.toContain('failed');
  });

  it('prefers the running state over a stopped call', () => {
    const markup = view([command('a', { status: 'interrupted' }), command('b', { status: 'streaming', title: 'Bash: pnpm check' })]);
    expect(head(markup)).toMatch(/^Running a command · Bash: pnpm check/);
    expect(text(markup)).not.toContain('Stopped');
  });

  it('keeps showing the diff totals of a working group', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,2 @@', ' keep', '+new'].join('\n');
    const markup = view([command('e', { toolName: 'edit', text: diff }), command('b', { status: 'streaming', title: 'Bash: pnpm check' })]);
    expect(markup).toContain('aria-label="1 lines added, 0 removed"');
  });

  it('summarizes in Russian', () => {
    expect(head(view([command('a'), command('b')], 'ru'))).toBe('Выполнил 2 команды');
    expect(head(view([command('a', { status: 'streaming', title: 'Bash: ls' })], 'ru'))).toMatch(/^Выполняет команду · Bash: ls/);
    expect(head(view([command('a')], 'ru', true))).toBe('Работает');
  });

  it('keeps a group of reasoning only titled "Thought"', () => {
    expect(head(view([thought('t', { text: 'Checking' })]))).toBe('Thought');
    expect(head(view([thought('t', { text: 'Checking' }), thought('u')]))).toBe('Thought');
  });

  describe('open', () => {
    it('shows each block as a row, reasoning with a one-line preview', () => {
      const markup = view(
        [thought('t', { text: 'Weigh the options\nthen decide' }), command('a', { title: 'pnpm test', text: 'out' }), command('b', { title: 'pnpm check', text: 'out' })],
        'en',
        false,
        true,
      );
      expect(bare(markup).match(/class="row /g)).toHaveLength(3);
      expect(text(markup)).toContain('Reasoning');
      expect(text(markup)).toContain('Weigh the options');
      expect(text(markup)).not.toContain('then decide');
      expect(markup).toContain('aria-expanded="true"');
    });

    it('names a plan and streaming reasoning in their rows', () => {
      const markup = view(
        [thought('p', { label: 'Plan', text: '1. Fix it' }), thought('s', { status: 'streaming', text: 'Reading' }), command('a')],
        'en',
        true,
        true,
      );
      expect(text(markup)).toContain('Work plan');
      expect(text(markup)).toContain('Thinking…');
    });

    it('shows a lone reasoning block as soon as the group opens', () => {
      const markup = view([thought('t', { text: 'First line\n\nThe full reasoning text' })], 'en', false, true);
      expect(text(markup)).toContain('The full reasoning text');
    });

    it('keeps reasoning closed beside other blocks', () => {
      const markup = view([thought('t', { text: 'First line\n\nThe full reasoning text' }), command('a')], 'en', false, true);
      expect(text(markup)).toContain('First line');
      expect(text(markup)).not.toContain('The full reasoning text');
    });

    it('caps its rows in a region that scrolls', () => {
      const markup = view([command('a', { text: 'out' }), command('b', { text: 'out' })], 'en', false, true);
      expect(bare(markup)).toContain('group__rows');
    });
  });
});
