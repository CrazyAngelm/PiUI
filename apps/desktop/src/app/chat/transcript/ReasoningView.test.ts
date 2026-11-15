import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../../host-api/types';
import { createReasoningClock, type ReasoningClock } from './reasoningClock';
import ReasoningView from './ReasoningView.svelte';

const unseen: ReasoningClock = { observe: () => undefined };

function thought(patch: Partial<TimelineBlock>): TimelineBlock {
  return { id: 'thought', kind: 'thinking', status: 'complete', ...patch };
}

function view(block: TimelineBlock, open: boolean, clock: ReasoningClock = unseen): string {
  return render(ReasoningView, { props: { block, open, onToggle: () => {}, clock } }).body;
}

/** Markup without the hydration comments the server render adds. */
const bare = (markup: string): string => markup.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string): string => bare(markup).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function head(markup: string): { tag: string; label: string } {
  const match = /<button\b([^>]*)>([\s\S]*?)<\/button>/.exec(bare(markup));
  if (!match) throw new Error('No button was rendered.');
  return { tag: match[1] ?? '', label: text(match[2] ?? '') };
}

function attribute(tag: string, name: string): string | undefined {
  for (const [, key, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) if (key === name) return value;
  return undefined;
}

const flagged = (tag: string, name: string): boolean => tag.split(/\s+/).some((part) => part === name || part.startsWith(`${name}=`));

describe('ReasoningView', () => {
  it('times a block it saw streaming with the real clock', () => {
    const clock = createReasoningClock();
    const realNow = Date.now;
    try {
      Date.now = () => 1_000;
      view(thought({ status: 'streaming', text: 'Working' }), true, clock);
      Date.now = () => 13_000;
      expect(head(view(thought({ text: 'Working' }), false, clock)).label).toBe('Thought for 12s');
    } finally {
      Date.now = realNow;
    }
  });

  it('says when the stored reasoning was shortened', () => {
    const markup = view(thought({ text: 'Long', truncated: true }), true);
    expect(text(markup)).toContain('Output was shortened to keep the chat responsive.');
  });

  it('shows the streamed text under "Thinking…" while the block streams', () => {
    const markup = view(thought({ status: 'streaming', text: 'Checking the scheduler tests' }), true);
    expect(head(markup).label).toBe('Thinking…');
    expect(attribute(head(markup).tag, 'aria-expanded')).toBe('true');
    expect(text(markup)).toContain('Checking the scheduler tests');
  });

  it('closes to a one-line "Thought" when it finishes', () => {
    const markup = view(thought({ text: 'Checking the scheduler tests' }), false);
    expect(head(markup).label).toBe('Thought');
    expect(attribute(head(markup).tag, 'aria-expanded')).toBe('false');
    expect(text(markup)).not.toContain('Checking the scheduler tests');
  });

  it('is a plain, non-expandable line when there is nothing to show', () => {
    const { tag, label } = head(view(thought({}), false));
    expect(label).toBe('Thought');
    expect(flagged(tag, 'disabled')).toBe(true);
    expect(attribute(tag, 'aria-expanded')).toBeUndefined();
  });

  it('names the duration the clock reports', () => {
    const block = thought({ text: 'Done' });
    expect(head(view(block, false, { observe: () => 12 })).label).toBe('Thought for 12s');
    expect(head(view(block, false, { observe: () => 75 })).label).toBe('Thought for 1m 15s');
    expect(head(view(block, false, { observe: () => 0 })).label).toBe('Thought');
  });

  it('calls a Codex plan block the work plan', () => {
    expect(head(view(thought({ label: 'Plan', text: '1. Fix it' }), false)).label).toBe('Work plan');
  });

  it('never renders raw HTML from the reasoning text', () => {
    const markup = view(thought({ text: '<img src=x onerror=alert(1)>' }), true);
    expect(markup).not.toContain('<img');
  });
});
