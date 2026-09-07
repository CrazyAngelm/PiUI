import { describe, expect, it } from 'vitest';
import { sessionForProject, shortcutModifier } from './workspaceUx';
import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';

describe('workspace navigation context', () => {
  const sessions: WorkspaceSession[] = [{ id: 'a', workspaceId: 'project-a', harness: 'pi', title: 'Work', status: 'running', updatedAt: '2026-09-06T00:00:00Z' }];
  it('retains the session only in its own project', () => {
    expect(sessionForProject(sessions, 'project-a', 'a')).toBe('a');
    expect(sessionForProject(sessions, 'project-b', 'a')).toBe('');
    expect(sessionForProject(sessions, 'project-a', 'missing')).toBe('');
    expect(sessions[0]?.status).toBe('running');
  });
  it('shows the modifier accepted by Windows and Linux, and the Mac symbol on Mac', () => {
    expect(shortcutModifier('Win32')).toBe('Ctrl+');
    expect(shortcutModifier('Linux x86_64')).toBe('Ctrl+');
    expect(shortcutModifier('MacIntel')).toBe('⌘');
  });
});
