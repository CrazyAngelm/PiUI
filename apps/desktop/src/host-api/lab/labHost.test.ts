import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, Preferences, ProjectSummary, WorkspaceCatalog, WorkspaceResult } from './labContracts';
import { scenarioFromSearch } from './labHost';
import { isUuid } from './labRandom';
import type { LabScenarioName } from './labState';
import { labHost, rejection } from './labTestKit';

async function catalogOf(scenario: LabScenarioName): Promise<WorkspaceCatalog> {
  const result = await labHost(scenario).invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'catalog' } });
  if (result.type !== 'catalog') throw new Error('Expected a catalog result.');
  return result.catalog;
}

describe('UI Lab host scenarios', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds the demo: four projects, twelve chats on all harnesses and linked run sessions', async () => {
    const catalog = await catalogOf('demo');
    expect(catalog.protocol).toBe(15);
    expect(catalog.safeMode).toBe(false);
    expect(catalog.workspaces.map((workspace) => [workspace.name, workspace.trust, workspace.personal])).toEqual([
      ['Chats', 'trusted', true],
      ['piui', 'trusted', false],
      ['video-studio', 'trusted', false],
      ['legacy-repo', 'restricted', false],
    ]);
    const chats = catalog.sessions.filter((session) => session.runId === undefined);
    expect(chats).toHaveLength(12);
    expect(new Set(chats.map((session) => session.harness))).toEqual(new Set(['pi', 'prime-agent', 'codex', 'hermes', 'claude-code']));
    expect(chats.filter((session) => session.status === 'running').map((session) => session.title).sort())
      .toEqual(['File an issue for the broken docs link', 'Fix flaky scheduler test', 'Streaming markdown renderer spike']);
    expect(chats.filter((session) => session.status === 'failed').map((session) => session.harness)).toEqual(['hermes']);
    const linked = catalog.sessions.filter((session) => session.runId !== undefined);
    expect(linked.length).toBeGreaterThanOrEqual(8);
    expect(linked.every((session) => session.memberId !== undefined && session.profileId !== undefined)).toBe(true);
    expect(catalog.harnesses.map((harness) => [harness.kind, harness.status])).toEqual([
      ['pi', 'available'], ['prime-agent', 'available'], ['codex', 'available'], ['hermes', 'available'],
      ['claude-code', 'available'],
    ]);
    const ids = catalog.sessions.map((session) => session.id);
    expect(ids.every(isUuid)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(catalog.sessions.every((session) => !Number.isNaN(Date.parse(session.updatedAt)))).toBe(true);
  });

  it('seeds a first run: only the host-owned Chats workspace and harness setup states', async () => {
    const catalog = await catalogOf('empty');
    expect(catalog.workspaces).toEqual([expect.objectContaining({ name: 'Chats', personal: true, trust: 'trusted' })]);
    expect(catalog.sessions).toEqual([]);
    expect(catalog.harnesses.map((harness) => harness.status)).toEqual(['available', 'unverified', 'available', 'unavailable', 'available']);
    // Claude Code is installed but signed out: still startable, with the host's typed sign-in reason.
    expect(catalog.harnesses.at(-1)).toMatchObject({ kind: 'claude-code', reason: 'Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.' });
    const bootstrap = await labHost('empty').invoke<AppSnapshot>('bootstrap_v10');
    expect(bootstrap.projects).toEqual([]);
  });

  it('seeds safe mode as the demo after a restart: no live runtime and safe mode reported', async () => {
    const catalog = await catalogOf('safe');
    expect(catalog.safeMode).toBe(true);
    expect(catalog.sessions.length).toBeGreaterThan(10);
    expect(catalog.sessions.every((session) => session.status === 'closed')).toBe(true);
  });

  it('seeds one ~3,000-block session for performance work', async () => {
    const host = labHost('long');
    const catalog = await catalogOf('long');
    expect(catalog.sessions).toHaveLength(1);
    const [session] = catalog.sessions;
    const result = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'snapshot', sessionId: session?.id } });
    if (result.type !== 'session') throw new Error('Expected a snapshot.');
    expect(result.snapshot.blocks.length).toBe(3_000);
    expect(new Set(result.snapshot.blocks.map((block) => block.id)).size).toBe(3_000);
  });

  it('is deterministic: seeding never uses Math.random and repeats byte for byte', () => {
    const random = vi.spyOn(Math, 'random');
    const first = labHost('demo');
    const second = labHost('demo');
    expect(random).not.toHaveBeenCalled();
    const serialize = (sessions: Map<string, unknown>) => JSON.stringify([...sessions.values()]);
    expect(serialize(first.state.sessions)).toBe(serialize(second.state.sessions));
    expect(JSON.stringify([...first.state.orchestration.values()])).toBe(JSON.stringify([...second.state.orchestration.values()]));
    random.mockRestore();
  });

  it('selects the scenario from ?lab= and falls back to the demo', () => {
    expect(scenarioFromSearch('?lab=empty')).toBe('empty');
    expect(scenarioFromSearch('?view=classic&lab=long')).toBe('long');
    expect(scenarioFromSearch('?lab=unknown')).toBe('demo');
    expect(scenarioFromSearch('')).toBe('demo');
  });

  it('rejects unknown commands and malformed arguments the way Tauri does', async () => {
    const host = labHost('demo');
    expect(await rejection(host.invoke('no_such_command'))).toBe('Command no_such_command not found');
    expect(await rejection(host.invoke('workspace_command_v15', { command: { type: 'catalog', extra: true } })))
      .toContain('unknown field `extra`');
    expect(await rejection(host.invoke('workspace_command_v15', {})))
      .toBe('invalid args `command` for command `workspace_command_v15`: command workspace_command_v15 missing required key command');
    expect(await rejection(host.invoke('workspace_command_v15', { command: { type: 'explode' } }))).toContain('unknown variant');
    expect(await rejection(host.invoke('orchestration_catalog_v6', { request: { workspaceId: 1 } }))).toContain('expected a string');
  });

  it('implements bootstrap, preferences, the folder picker and project trust with classic shapes', async () => {
    const host = labHost('demo');
    const bootstrap = await host.invoke<AppSnapshot>('bootstrap_v10');
    expect(bootstrap.safeMode).toBe(false);
    expect(bootstrap.projects.map((project) => project.name)).toEqual(['piui', 'video-studio', 'legacy-repo']);
    const preferences: Preferences = { theme: 'dark', density: 'compact', reducedMotion: 'reduce', fontSize: 'large', chatWidth: 'focused' };
    expect(await host.invoke('update_preferences_v8', { ...preferences })).toEqual(preferences);
    expect((await host.invoke<AppSnapshot>('bootstrap_v10')).preferences).toEqual(preferences);
    expect(await rejection(host.invoke('update_preferences_v8', { ...preferences, theme: 'neon' }))).toMatchObject({ code: 'INVALID_ARGUMENT' });

    const added = await host.invoke<ProjectSummary>('pick_and_add_project_v10', { agentKind: 'pi' });
    expect(added).toMatchObject({ name: 'sandbox-1', trustState: 'restricted', agentKind: 'pi', pinned: false, missing: false });
    expect(await rejection(host.invoke('pick_and_add_project_v10', { agentKind: 'codex' }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const trusted = await host.invoke<ProjectSummary>('set_project_trust', { projectId: added.id, trustState: 'trusted' });
    expect(trusted.trustState).toBe('trusted');
    const catalog = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'catalog' } });
    expect(catalog.type === 'catalog' && catalog.catalog.workspaces.find((workspace) => workspace.id === added.id)?.trust).toBe('trusted');

    const chats = catalog.type === 'catalog' ? catalog.catalog.workspaces.find((workspace) => workspace.personal) : undefined;
    expect(await rejection(host.invoke('set_project_trust', { projectId: chats?.id, trustState: 'restricted' })))
      .toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await rejection(host.invoke('set_project_trust', { projectId: 'missing', trustState: 'trusted' }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('closes live runtimes when trust is revoked', async () => {
    const host = labHost('demo');
    const piui = host.state.projects.find((project) => project.name === 'piui');
    await host.invoke('set_project_trust', { projectId: piui?.id, trustState: 'restricted' });
    const result = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'catalog' } });
    if (result.type !== 'catalog') throw new Error('Expected a catalog.');
    const piuiSessions = result.catalog.sessions.filter((session) => session.workspaceId === piui?.id);
    expect(piuiSessions.every((session) => session.status === 'closed')).toBe(true);
  });
});
