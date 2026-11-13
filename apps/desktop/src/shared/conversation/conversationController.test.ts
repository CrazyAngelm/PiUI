import { describe, expect, it, vi } from 'vitest';
import { ConversationController } from './conversationController.svelte';
import type { ConversationOwner, ConversationSnapshot } from '../../../../../contracts/conversation-presentation-v1';

function snapshot(sessionId = 'chat'): ConversationSnapshot {
  return {
    blocks: [{ id: 'user', kind: 'user', text: 'Read this', status: 'complete' }, { id: 'answer', kind: 'assistant', text: 'Starting', status: 'streaming' }],
    approvals: [{ id: 'approval', sessionId, kind: 'command', title: 'Run tests', description: 'Run the project test command', decisions: ['approve-once', 'deny'] }],
    attachments: [{ id: 'file', blockId: 'user', label: 'notes.txt' }],
    connection: 'connected', loading: false,
  };
}
const identity = { location: 'native' as const, scopeId: 'workspace', sessionId: 'chat' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('explicit conversation owner boundary', () => {
  it.each(['native', 'cloud'] as const)('routes history, attachments and approvals only to its %s owner', async location => {
    const view = snapshot();
    const owner: ConversationOwner = { identity: { ...identity, location }, readHistory: vi.fn(async () => view.blocks), openAttachment: vi.fn(async () => {}), respond: vi.fn(async () => {}) };
    const controller = new ConversationController(owner, view);
    expect(await controller.readHistory()).toBe(view.blocks);
    await controller.openAttachment('file');
    await controller.respond('approval', 'approve-once', undefined);
    expect(owner.openAttachment).toHaveBeenCalledWith('file', expect.any(AbortSignal));
    expect(owner.respond).toHaveBeenCalledWith('approval', 'approve-once', undefined, expect.any(AbortSignal));
    expect(controller.snapshot?.approvals).toHaveLength(1);
    controller.update(owner.identity, { ...view, approvals: [], blocks: [...view.blocks.slice(0, 1), { ...view.blocks[1]!, text: 'Finished', status: 'complete' }] });
    expect(controller.snapshot?.blocks[1]?.text).toBe('Finished');
    expect(controller.snapshot?.approvals).toHaveLength(0);
  });

  it('refuses cross-owner snapshots and approvals, and unsupported operations without a fallback', async () => {
    const controller = new ConversationController({ identity }, snapshot());
    expect(() => controller.update({ ...identity, scopeId: 'another-workspace' }, snapshot())).toThrow('another conversation');
    await expect(controller.readHistory()).rejects.toThrow('not available');
    await expect(controller.openAttachment('file')).rejects.toThrow('not available');
    await expect(controller.openAttachment('foreign-file')).rejects.toThrow('Unknown attachment');
    expect(() => controller.setOwner({ identity }, snapshot('another-session'))).toThrow('approval belongs');
    expect(controller.retired).toBe(true);
    await expect(controller.readHistory()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts history, attachment and approval work on owner change even when a transport ignores cancellation', async () => {
    const history = deferred<ConversationSnapshot['blocks']>();
    const attachment = deferred<void>();
    const approval = deferred<void>();
    const signals: AbortSignal[] = [];
    const controller = new ConversationController({ identity, readHistory: signal => { signals.push(signal); return history.promise; }, openAttachment: (_id, signal) => { signals.push(signal); return attachment.promise; }, respond: (_id, _decision, _answer, signal) => { signals.push(signal); return approval.promise; } }, snapshot());
    const pendingHistory = expect(controller.readHistory()).rejects.toMatchObject({ name: 'AbortError' });
    const pendingAttachment = expect(controller.openAttachment('file')).rejects.toMatchObject({ name: 'AbortError' });
    const pendingApproval = controller.respond('approval', 'approve-once', undefined);
    controller.setOwner({ identity: { location: 'cloud', scopeId: 'account', sessionId: 'other' } }, snapshot('other'));
    expect(signals.every(signal => signal.aborted)).toBe(true);
    // Presentation waits settle before an owner that ignores AbortSignal does.
    await Promise.all([pendingHistory, pendingAttachment, pendingApproval]);
    history.resolve([{ id: 'old', kind: 'assistant', status: 'complete', text: 'Old private history' }]);
    attachment.resolve();
    approval.reject(new Error('Old response failed'));
    await Promise.resolve();
    expect(controller.snapshot?.blocks.map(block => block.id)).toEqual(['user', 'answer']);
    expect(controller.approvalErrors).toEqual({});
    expect(controller.busyApproval).toBe('');
  });

  it('keeps the displayed history after reconnect failure, accepts owner recovery and ignores stale recovery', async () => {
    const recovery = deferred<ConversationSnapshot>();
    const reconnect = vi.fn(async () => { throw new Error('offline'); });
    const view = { ...snapshot(), connection: 'disconnected' as const };
    const controller = new ConversationController({ identity, reconnect }, view);
    await controller.reconnect();
    expect(controller.snapshot).toBe(view);
    expect(controller.error).toBe('Could not reconnect.');
    controller.setOwner({ identity, reconnect: () => recovery.promise }, view);
    const pending = controller.reconnect();
    const newest = { ...snapshot(), blocks: [{ id: 'new', kind: 'assistant' as const, text: 'Newest stream', status: 'streaming' as const }], attachments: [] };
    controller.update(identity, newest);
    recovery.resolve(snapshot());
    await pending;
    expect(controller.snapshot).toBe(newest);
    controller.setOwner({ identity, reconnect: async () => snapshot() }, view);
    await controller.reconnect();
    expect(controller.snapshot?.connection).toBe('connected');
  });

  it('blocks unsupported and duplicate approval submissions and keeps a failure retryable', async () => {
    const pending = deferred<void>();
    const respond = vi.fn(() => pending.promise);
    const controller = new ConversationController({ identity, respond }, snapshot());
    await controller.respond('approval', 'approve-session', undefined);
    const first = controller.respond('approval', 'approve-once', undefined);
    await controller.respond('approval', 'deny', undefined);
    expect(respond).toHaveBeenCalledTimes(1);
    pending.reject(new Error('offline'));
    await first;
    expect(controller.approvalErrors.approval).toBe('Could not send the decision');
    expect(controller.busyApproval).toBe('');
    controller.dispose();
    await expect(controller.readHistory()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
