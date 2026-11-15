import { describe, expect, it, vi } from 'vitest';
import { announceBranch } from './branchFeedback';

const translate = (value: string, values: readonly (string | number)[] = []): string => value.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)]));
const created = { ok: true as const, sessionId: 'child', title: 'Cache (branch)', mode: 'native' as const };

function announce(result: Parameters<typeof announceBranch>[0]) {
  const show = vi.fn();
  const open = vi.fn();
  announceBranch(result, translate, open, { show });
  return { show, open };
}

describe('branch announcements', () => {
  it('is silent for a native branch that was opened', () => {
    expect(announce(created).show).not.toHaveBeenCalled();
  });

  it('says a linked branch starts from a summary, or empty when there was nothing to summarise', () => {
    expect(announce({ ...created, mode: 'linked' }).show.mock.calls[0]?.[0].title).toBe('Linked branch: it starts from a summary. The history was not copied.');
    expect(announce({ ...created, mode: 'linked', empty: true }).show.mock.calls[0]?.[0].title).toBe('Linked branch: it starts empty. The history was not copied.');
  });

  it('names a branch that was not opened for lack of room and offers to open it', () => {
    const { show, open } = announce({ ...created, noRoom: true });
    expect(show).toHaveBeenCalledTimes(1);
    const toast = show.mock.calls[0]?.[0];
    expect(toast.title).toBe('Four chats are on screen. The branch "Cache (branch)" was created but not opened.');
    toast.action.run();
    expect(open).toHaveBeenCalledWith('child');
  });
});
