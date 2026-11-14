import { describe, expect, it, vi } from 'vitest';
import { ConversationController, messageActionKey } from './conversationController.svelte';
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
  const actionable = (): ConversationSnapshot => ({ ...snapshot(), messageControls: [{
    id: '__proto__', blockId: 'answer', actions: [{ kind: 'copy' }, { kind: 'branch' }, { kind: 'repeat', disabled: true }],
    usage: { label: '7 credits', description: 'Owner supplied' },
  }] });

  it('routes only offered and currently enabled message actions through their owner', async () => {
    const actOnMessage = vi.fn(async () => undefined);
    const controller = new ConversationController({ identity, actOnMessage }, actionable());
    await controller.actOnMessage('__proto__', 'copy');
    expect(actOnMessage).toHaveBeenCalledWith('__proto__', 'copy', expect.any(AbortSignal));
    await expect(controller.actOnMessage('__proto__', 'repeat')).rejects.toThrow('not available');
    await expect(controller.actOnMessage('__proto__', 'edit')).rejects.toThrow('not available');
    await expect(controller.actOnMessage('other-message', 'branch')).rejects.toThrow('not available');
    controller.update(identity, snapshot());
    await expect(controller.actOnMessage('__proto__', 'branch')).rejects.toThrow('not available');
    expect(actOnMessage).toHaveBeenCalledTimes(1);
    const withoutPort = new ConversationController({ identity }, actionable());
    await expect(withoutPort.actOnMessage('__proto__', 'copy')).rejects.toThrow('not available');
  });

  it('admits a single pending message action and permits explicit retry after its failure', async () => {
    const held = deferred<void>();
    const actOnMessage = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(undefined);
    const controller = new ConversationController({ identity, actOnMessage }, actionable());
    const first = controller.actOnMessage('__proto__', 'branch');
    expect(controller.busyMessageActions[messageActionKey('__proto__', 'branch')]).toBe(true);
    await expect(controller.actOnMessage('__proto__', 'branch')).rejects.toThrow('not available');
    expect(actOnMessage).toHaveBeenCalledTimes(1);
    held.reject(new Error('native owner refused'));
    await first;
    expect(controller.messageActionErrors[JSON.stringify('__proto__')]).toBe('Could not complete the message action.');
    expect(controller.busyMessageActions).toEqual({});
    await controller.actOnMessage('__proto__', 'branch');
    expect(actOnMessage).toHaveBeenCalledTimes(2);
    expect(controller.messageActionErrors[JSON.stringify('__proto__')]).toBe('');
  });

  it('retires held action failures across owner changes even when target IDs are reused', async () => {
    const held = deferred<void>();
    let signal: AbortSignal | undefined;
    const controller = new ConversationController({ identity, actOnMessage: async (_id, _action, value) => { signal = value; await held.promise; } }, actionable());
    const pending = controller.actOnMessage('__proto__', 'copy');
    const other = { ...identity, scopeId: 'another-account' };
    controller.setOwner({ identity: other, actOnMessage: async () => undefined }, actionable());
    await pending;
    expect(signal?.aborted).toBe(true);
    held.reject(new Error('old clipboard failed'));
    await Promise.resolve();
    expect(controller.messageActionErrors).toEqual({});
    expect(controller.busyMessageActions).toEqual({});
  });

  it('does not attach a failed action to replacement message contents in the same owner', async () => {
    const held = deferred<void>();
    const controller = new ConversationController({ identity, actOnMessage: () => held.promise }, actionable());
    const pending = controller.actOnMessage('__proto__', 'branch');
    const updated = actionable(); updated.messageControls![0]!.id = 'replacement-content';
    controller.update(identity, updated);
    await expect(controller.actOnMessage('__proto__', 'copy')).rejects.toThrow('not available');
    held.reject(new Error('old target failed')); await pending;
    expect(controller.messageActionErrors[JSON.stringify('replacement-content')]).toBeUndefined();
    expect(controller.busyMessageActions).toEqual({});
  });

  it('binds rendered actions to their original owner even after returning to identical IDs', async () => {
    const actOnMessage = vi.fn(async () => undefined);
    const controller = new ConversationController({ identity, actOnMessage }, actionable());
    const oldAction = controller.bindMessageActions();
    controller.setOwner({ identity: { ...identity, scopeId: 'another-account' }, actOnMessage }, actionable());
    controller.setOwner({ identity, actOnMessage }, actionable());
    await expect(oldAction('__proto__', 'copy')).rejects.toMatchObject({ name: 'AbortError' });
    expect(actOnMessage).not.toHaveBeenCalled();
    await controller.bindMessageActions()('__proto__', 'copy');
    expect(actOnMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects ambiguous message capability projections while preserving optional old-owner compatibility', () => {
    expect(() => new ConversationController({ identity }, snapshot())).not.toThrow();
    const duplicate = actionable(); duplicate.messageControls!.push({ ...duplicate.messageControls![0]!, id: 'other' });
    expect(() => new ConversationController({ identity }, duplicate)).toThrow('Message controls');
    const unknownBlock = actionable(); unknownBlock.messageControls![0]!.blockId = 'missing';
    expect(() => new ConversationController({ identity }, unknownBlock)).toThrow('Message controls');
  });

  it('binds media and download authority to the displayed owner and current resource', async () => {
    const media = deferred<{ src: string }>();
    const downloadAttachment = vi.fn(async () => {});
    const view = snapshot(); view.attachments[0] = { ...view.attachments[0]!, downloadable: true };
    const controller = new ConversationController({ identity, resolveAttachment: () => media.promise, downloadAttachment }, view);
    const ports = controller.bindAttachments();
    await ports.download('file');
    expect(downloadAttachment).toHaveBeenCalledOnce();
    const resolution = expect(ports.resolve('file')).rejects.toMatchObject({ name: 'AbortError' });
    controller.setOwner({ identity, downloadAttachment }, view);
    await resolution;
    await expect(ports.download('file')).rejects.toMatchObject({ name: 'AbortError' });
    media.resolve({ src: 'https://example.invalid/old.png' });
    expect(downloadAttachment).toHaveBeenCalledOnce();
    const fresh = controller.bindAttachments();
    controller.update(identity, { ...view, attachments: [{ ...view.attachments[0]!, openable: false }] });
    await expect(fresh.open('file')).rejects.toThrow('cannot be opened yet');
    controller.update(identity, { ...view, attachments: [] });
    await expect(fresh.resolve('file')).rejects.toThrow('no longer available');
  });

  it('shares pending paging admission and refuses an old rendered pager after ABA', async () => {
    const page = deferred<void>();
    const loadOlder = vi.fn(() => page.promise);
    const view = { ...snapshot(), olderAvailable: true };
    const controller = new ConversationController({ identity, loadOlder }, view);
    const old = controller.bindLoadOlder();
    const first = old(); await old();
    expect(loadOlder).toHaveBeenCalledOnce();
    controller.setOwner({ identity, loadOlder }, view);
    await first; await old();
    expect(loadOlder).toHaveBeenCalledOnce();
    page.resolve();
    await controller.bindLoadOlder()();
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it.each(['message', 'header'] as const)('disposes trusted %s decorations immediately on owner retirement', kind => {
    const dispose = vi.fn(); const update = vi.fn();
    const decorateMessage = vi.fn(() => ({ dispose, update }));
    const view = snapshot();
    const owner = { identity, [kind === 'header' ? 'decorateMessageHeader' : 'decorateMessage']: decorateMessage };
    const controller = new ConversationController(owner, view);
    const port = controller.bindMessageDecoration(kind);
    const abort = new AbortController();
    const decoration = port({} as HTMLElement, view.blocks[1]!, abort.signal);
    decoration?.update({ ...view.blocks[1]!, text: 'new stream' });
    expect(update).toHaveBeenCalledOnce();
    controller.setOwner(owner, view);
    expect(dispose).toHaveBeenCalledOnce();
    decoration?.update(view.blocks[1]!); decoration?.dispose();
    port({} as HTMLElement, view.blocks[1]!, abort.signal);
    expect(update).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    expect(decorateMessage).toHaveBeenCalledOnce();
  });

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
