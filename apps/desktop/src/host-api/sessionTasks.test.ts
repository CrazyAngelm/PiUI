import { describe, expect, it, vi } from 'vitest';
import { stopSessionTask } from './sessionTasks';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./transport', () => ({ hostInvoke: invoke, hostListen: vi.fn(), desktopAvailable: true }));

describe('session task stop v1 client', () => {
  it('uses the versioned route and returns the echoed result', async () => {
    const result = { protocol: 1, sessionId: 'session' };
    invoke.mockResolvedValueOnce(result);
    expect(await stopSessionTask({ sessionId: 'session', taskId: 'task-1' })).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith('workspace_task_stop_v1', { request: { sessionId: 'session', taskId: 'task-1' } });
  });

  it('refuses an answer for another session or protocol', async () => {
    invoke.mockResolvedValueOnce({ protocol: 1, sessionId: 'other' });
    await expect(stopSessionTask({ sessionId: 'session', taskId: 'task-1' })).rejects.toThrow('The workspace operation could not be completed.');
    invoke.mockResolvedValueOnce({ protocol: 2, sessionId: 'session' });
    await expect(stopSessionTask({ sessionId: 'session', taskId: 'task-1' })).rejects.toThrow('The workspace operation could not be completed.');
  });

  it('maps host errors to the fixed workspace messages', async () => {
    invoke.mockRejectedValueOnce({ code: 'NOT_SUPPORTED' });
    await expect(stopSessionTask({ sessionId: 'session', taskId: 'task-1' })).rejects.toThrow('This operation is not supported by the selected harness or current mode.');
    invoke.mockRejectedValueOnce('Command workspace_task_stop_v1 not found');
    await expect(stopSessionTask({ sessionId: 'session', taskId: 'task-1' })).rejects.toThrow('The workspace operation could not be completed.');
  });
});
