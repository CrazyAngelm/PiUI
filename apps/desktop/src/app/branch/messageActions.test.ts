import { describe, expect, it } from 'vitest';
import type { DesktopTimelineBlock } from '../../../../../contracts/runtime-protocol';
import { branchCutAfter, buildMessageControls, editDraft, messageText } from './messageActions';

const block = (id: string, kind: DesktopTimelineBlock['kind'], text = '', status: DesktopTimelineBlock['status'] = 'complete'): DesktopTimelineBlock => ({
  id,
  kind,
  label: kind,
  ...(text ? { text } : {}),
  status,
});
const kinds = (blocks: readonly DesktopTimelineBlock[], options = {}) =>
  buildMessageControls(blocks, options).map((item) => `${item.id}:${item.actions.map((action) => action.kind).join('+')}`);

const CHAT = [
  block('u1', 'user', 'Question one'),
  block('t1', 'tool'),
  block('a1', 'assistant', 'Narration'),
  block('t2', 'tool'),
  block('a2', 'assistant', 'Answer one'),
  block('u2', 'user', 'Question two'),
  block('a3', 'assistant', 'Answer two'),
];

describe('message controls', () => {
  it('offers copy and edit on messages and copy and branch on the answer that ends a turn', () => {
    expect(kinds(CHAT)).toEqual(['u1:copy+edit', 'a2:copy+branch', 'u2:copy+edit', 'a3:copy+branch']);
  });

  it('gives a running chat no controls on its unfinished last answer', () => {
    expect(kinds(CHAT, { running: true })).toEqual(['u1:copy+edit', 'a2:copy+branch', 'u2:copy+edit']);
    const streaming = [...CHAT.slice(0, 6), block('a3', 'assistant', 'Partial', 'streaming')];
    expect(kinds(streaming)).toEqual(['u1:copy+edit', 'a2:copy+branch', 'u2:copy+edit']);
  });

  it('skips blocks without text and a message still waiting for the agent edits nothing', () => {
    expect(kinds([block('u1', 'user'), block('a1', 'assistant'), block('u2', 'user', 'Pending', 'streaming')])).toEqual(['u2:copy']);
  });

  it('disables edit and branch when locked, and offers copy only when read only', () => {
    const locked = buildMessageControls(CHAT, { locked: true });
    expect(locked.flatMap((item) => item.actions.filter((action) => action.disabled).map((action) => action.kind))).toEqual(['edit', 'branch', 'edit', 'branch']);
    expect(locked.flatMap((item) => item.actions.filter((action) => action.kind === 'copy' && action.disabled))).toEqual([]);
    expect(kinds(CHAT, { readOnly: true })).toEqual(['u1:copy', 'a2:copy', 'u2:copy', 'a3:copy']);
  });

  it('keeps ids stable per block and marks the copied one', () => {
    const first = buildMessageControls(CHAT, { copiedId: 'a2' });
    const second = buildMessageControls([...CHAT, block('u3', 'user', 'More')], { copiedId: 'a2' });
    expect(first.map((item) => item.id)).toEqual(first.map((item) => item.blockId));
    expect(second.slice(0, first.length).map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(first.filter((item) => item.copied).map((item) => item.id)).toEqual(['a2']);
    expect(buildMessageControls(CHAT).some((item) => 'copied' in item)).toBe(false);
  });
});

describe('branch cuts', () => {
  it('cuts before the next user message after an answer, or at the end', () => {
    expect(branchCutAfter(CHAT, 'a2')).toEqual({ at: 'before', blockId: 'u2' });
    expect(branchCutAfter(CHAT, 'a3')).toEqual({ at: 'end' });
    expect(branchCutAfter(CHAT, 'missing')).toBeUndefined();
  });
});

describe('message text', () => {
  it('copies the shown text, and reads a cut-short answer in full', async () => {
    expect(await messageText({ id: 'a', kind: 'assistant', text: 'short' })).toBe('short');
    const short = { id: 'a', kind: 'assistant' as const, text: 'sho', truncated: true };
    expect(await messageText(short, async () => [{ id: 'a', kind: 'assistant', text: 'short and full' }])).toBe('short and full');
    await expect(messageText(short, async () => [short])).rejects.toThrow();
    expect(await messageText(short)).toBe('sho');
  });
});

describe('edit draft', () => {
  const shown = { id: 'u1', kind: 'user' as const, text: 'The first part of a long prom', truncated: true };

  it('is the whole prompt, read from the saved history when it is shown cut short', async () => {
    expect(await editDraft({ id: 'u1', kind: 'user', text: 'short' })).toBe('short');
    expect(await editDraft(shown, async () => [{ ...shown, text: 'The first part of a long prompt, and the rest', truncated: false }])).toBe('The first part of a long prompt, and the rest');
  });

  it('is undefined when the full prompt cannot be read, so no branch starts from the cut text', async () => {
    expect(await editDraft(shown, async () => [shown])).toBeUndefined();
    expect(await editDraft(shown, async () => [])).toBeUndefined();
    expect(
      await editDraft(shown, async () => {
        throw new Error('unreadable');
      }),
    ).toBeUndefined();
  });
});
