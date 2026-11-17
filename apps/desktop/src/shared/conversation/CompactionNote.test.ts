import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import CompactionNote from './CompactionNote.svelte';

const compaction = (patch: Partial<TimelineBlock>): TimelineBlock => ({ id: 'compaction', kind: 'compaction', status: 'complete', ...patch });
const view = (block: TimelineBlock): string => render(CompactionNote, { props: { block } }).body.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string): string => markup.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

describe('CompactionNote', () => {
  it('says compaction is running or done for a compaction that is', () => {
    expect(text(view(compaction({ status: 'streaming' })))).toBe('Compacting context…');
    expect(text(view(compaction({ status: 'complete' })))).toBe('Context compacted');
    expect(view(compaction({ status: 'complete' }))).not.toContain('role="note"');
  });

  it('does not report a failed compaction as done, and shows why when the runtime said', () => {
    const markup = view(compaction({ status: 'failed', safeSummary: 'The summary request was refused.' }));

    expect(text(markup)).toBe('Context compaction failed The summary request was refused.');
    expect(markup).toContain('role="note"');
    expect(text(markup)).not.toContain('Context compacted');
  });

  it('does not report an interrupted compaction as done either', () => {
    expect(text(view(compaction({ status: 'interrupted' })))).toBe('Context compaction stopped');
    expect(text(view(compaction({ status: 'interrupted', safeSummary: 'Stopped by the user.' })))).toBe('Context compaction stopped Stopped by the user.');
  });

  it('never prints the raw text of a compaction block', () => {
    const markup = view(compaction({ status: 'failed', text: 'raw prompt that must stay out of the chat' }));

    expect(markup).not.toContain('raw prompt');
  });
});
