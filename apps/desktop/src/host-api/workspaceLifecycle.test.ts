import { expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { deleteWorkspaceSession } from './workspaceLifecycle';

it('deletes only the addressed session through the versioned route', async () => {
  invoke.mockResolvedValueOnce({ protocol: 17, sessionId: 'chat' });
  await deleteWorkspaceSession('chat');
  expect(invoke).toHaveBeenLastCalledWith('workspace_lifecycle_v17', { command: { type: 'deleteSession', sessionId: 'chat' } });
});
it('rejects mismatched responses and safely reports failed deletion', async () => {
  invoke.mockResolvedValueOnce({ protocol: 17, sessionId: 'other' });
  await expect(deleteWorkspaceSession('chat')).rejects.toThrow();
  invoke.mockRejectedValueOnce({ code: 'IO_ERROR', detail: 'private' });
  await expect(deleteWorkspaceSession('chat')).rejects.toThrow('Your native session history has not been removed.');
});
