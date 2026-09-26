import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSession } from '../../../../../contracts/workspace-v15';
import { labHost, rejection } from '../../host-api/lab/labTestKit';
import type { ProjectSummary } from '../../host-api/types';
import { WorkspaceStore } from '../workspaceStore.svelte';
import { isPinned, projectRemoval } from './projectActions';

const session = (id: string, status: WorkspaceSession['status'], runId: string | undefined = undefined): WorkspaceSession => ({
  id, workspaceId: 'w', harness: 'pi', title: id, status, updatedAt: '2026-09-26T09:00:00Z', ...(runId ? { runId } : {}),
});

describe('project folder actions', () => {
  it('counts hidden chats and blocks removal while an agent runs', () => {
    expect(projectRemoval('w', [session('a', 'idle'), session('b', 'closed'), session('r', 'idle', 'run')])).toEqual({ chats: 2, running: 0, blocked: false });
    expect(projectRemoval('w', [session('a', 'running'), session('b', 'stopping')])).toMatchObject({ running: 2, blocked: true });
    expect(projectRemoval('other', [session('a', 'running')])).toEqual({ chats: 0, running: 0, blocked: false });
    const projects = [{ id: 'w', pinned: true }] as ProjectSummary[];
    expect(isPinned(projects, 'w')).toBe(true);
    expect(isPinned(projects, 'x')).toBe(false);
  });

  it('refuses registry changes for the personal workspace and unknown folders in the lab host', async () => {
    const host = labHost();
    const personal = host.state.projects.find((project) => project.personal)?.id;
    expect(await rejection(host.invoke('rename_project', { projectId: personal, name: 'x' }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await rejection(host.invoke('set_project_pinned', { projectId: 'nope', pinned: true }))).toMatchObject({ code: 'NOT_FOUND' });
    const piui = host.state.projects.find((project) => project.name === 'piui')?.id;
    expect(await rejection(host.invoke('rename_project', { projectId: piui, name: '\u0007  ' }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('WorkspaceStore project registry actions over the transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renames, pins and removes a folder without touching its chats elsewhere', async () => {
    const store = new WorkspaceStore();
    await store.loadCatalog();
    await store.loadProjects();
    const legacy = store.catalog.workspaces.find((workspace) => workspace.name === 'legacy-repo');
    expect(legacy).toBeDefined();
    const id = legacy?.id ?? '';

    await store.renameProject(id, '  Legacy auth  ');
    expect(store.catalog.workspaces.find((workspace) => workspace.id === id)?.name).toBe('Legacy auth');

    await store.setProjectPinned(id, true);
    expect(isPinned(store.projectSummaries, id)).toBe(true);
    const order = store.catalog.workspaces.filter((workspace) => !workspace.personal).map((workspace) => workspace.name);
    expect(order.slice(0, 2).sort()).toEqual(['Legacy auth', 'piui']);

    store.navigate({ name: 'history', workspaceId: id });
    const before = store.catalog.sessions.filter((item) => item.workspaceId !== id).length;
    await store.removeProject(id);
    expect(store.catalog.workspaces.some((workspace) => workspace.id === id)).toBe(false);
    expect(store.route).toEqual({ name: 'home' });
    expect(store.catalog.sessions.filter((item) => item.workspaceId !== id)).toHaveLength(before);
    store.dispose();
  });
});
