import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceClient, workspaceError, type WorkspaceListen } from './workspaceClient';
import type { WorkspaceResult } from '../../../../contracts/workspace-v11';

describe('workspace v11 client', () => {
  it('routes a typed native session creation without exposing an executable', async () => {
    const invoke = vi.fn(async (): Promise<WorkspaceResult> => ({ type: 'accepted', sessionId: 'opaque-session' }));
    const client = createWorkspaceClient(invoke, async () => () => {});
    await client.request({ type: 'createSession', workspaceId: 'folder', harness: 'codex', permissionMode: 'workspace-write' });
    expect(invoke).toHaveBeenCalledWith('workspace_command_v11', { command: { type: 'createSession', workspaceId: 'folder', harness: 'codex', permissionMode: 'workspace-write' } });
  });
  it('never reveals untrusted raw host errors', async () => {
    const client = createWorkspaceClient(async () => { throw { code: 'UNKNOWN', message: 'secret-token /private/path' }; }, async () => () => {});
    await expect(client.request({ type: 'catalog' })).rejects.toThrow('The workspace operation could not be completed.');
  });
  it('keeps trust failures actionable without trusting a host message', () => {
    expect(workspaceError({ code: 'NOT_TRUSTED', message: 'private' }).message).toContain('Trust this project');
    expect(workspaceError('{"code":"NOT_SUPPORTED","message":"private"}').message).not.toContain('private');
  });
  it('subscribes to the versioned workspace event channel', async () => {
    const listen = vi.fn<WorkspaceListen>(async () => () => {});
    const client = createWorkspaceClient(async (): Promise<WorkspaceResult> => ({ type: 'accepted', sessionId: 's' }), listen);
    await client.listen(() => {});
    expect(listen.mock.calls[0]?.[0]).toBe('piui://workspace-event');
  });
});
