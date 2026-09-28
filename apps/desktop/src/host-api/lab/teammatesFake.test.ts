import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeammatesResultV1 } from '../../../../../contracts/teammates-v1';
import type { OrchestrationCatalogV6 } from '../../../../../contracts/orchestration-host-v6';
import { decodeTeammatesResult } from '../teammatesClient';
import type { LabHost } from './labHost';
import { labHost, record, rejection } from './labTestKit';
import { DEMO_PROJECTS } from './scenarios/demoChats';
import { resolveCardInput } from './teammatesFake';

const WS = DEMO_PROJECTS.video;
const PERMISSIONS = { read: true, comment: true, create: false, move: true, claim: true, assign: false };

async function teammates(host: LabHost, command: Record<string, unknown>): Promise<TeammatesResultV1> {
  const result = decodeTeammatesResult(await host.invoke<unknown>('teammates_command_v1', { command: { workspaceId: WS, ...command } }));
  if (result === undefined) throw new Error('invalid teammates result');
  return result;
}

async function catalog(host: LabHost): Promise<OrchestrationCatalogV6> {
  return host.invoke<OrchestrationCatalogV6>('orchestration_catalog_v6', { request: { workspaceId: WS } });
}

function simpleDraft(handle: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle,
    name: 'Docs writer',
    color: 'chaos-gold',
    avatar: 'DW',
    role: 'Writes and fixes docs.',
    body: { type: 'simple', agent: { harness: 'codex', model: 'gpt-lab-5-codex', permissionMode: 'workspace-write', instructions: 'Write clear docs.' } },
    cardInput: { type: 'auto' },
    board: PERMISSIONS,
    maxConcurrentRuns: 1,
    wake: { onAssign: 'ask', onMention: true },
    enabled: true,
    ...patch,
  };
}

describe('teammates lab fake', () => {
  let host: LabHost;
  beforeEach(() => {
    vi.useFakeTimers();
    host = labHost('demo');
  });
  afterEach(() => vi.useRealTimers());

  it('seeds @coder (simple) and @release-team (pipeline), both assignable', async () => {
    const result = await teammates(host, { type: 'list' });
    if (result.type !== 'teammates') throw new Error('expected a list');
    expect(result.teammates.map((item) => [item.handle, item.kind.type])).toEqual([['coder', 'simple'], ['release-team', 'pipeline']]);
    expect(result.status.every((item) => item.notAssignableReason === undefined)).toBe(true);
    const commands = (await catalog(host)).launchCommands.map((command) => command.id);
    expect(commands).toContain(result.teammates[0]?.launchCommandId);
  });

  it('saves a simple teammate with managed definitions and deletes them with it', async () => {
    const events = await record<{ workspaceId: string }>(host, 'piui://teammates-changed-v1');
    const saved = await teammates(host, { type: 'save', teammate: simpleDraft('docs') });
    if (saved.type !== 'teammate') throw new Error('expected a teammate');
    expect(saved.teammate).toMatchObject({ handle: 'docs', revision: 1, kind: { type: 'simple' } });
    expect((await catalog(host)).launchCommands.map((command) => command.id)).toContain(saved.teammate.launchCommandId);

    expect(await rejection(teammates(host, { type: 'save', teammate: simpleDraft('docs') }))).toMatchObject({ code: 'HANDLE_TAKEN' });
    expect(await rejection(teammates(host, { type: 'save', teammate: simpleDraft('Docs!') }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await rejection(teammates(host, { type: 'save', teammate: simpleDraft('docs', { id: saved.teammate.id, expectedRevision: 7 }) })))
      .toMatchObject({ code: 'REVISION_CONFLICT' });

    const renamed = await teammates(host, { type: 'save', teammate: simpleDraft('docs-writer', { id: saved.teammate.id, expectedRevision: 1 }) });
    expect(renamed.type === 'teammate' && renamed.teammate).toMatchObject({ handle: 'docs-writer', revision: 2, launchCommandId: saved.teammate.launchCommandId });

    const deleted = await teammates(host, { type: 'delete', teammateId: saved.teammate.id, expectedRevision: 2 });
    expect(deleted).toEqual({ protocol: 1, type: 'deleted', teammateId: saved.teammate.id });
    expect((await catalog(host)).launchCommands.map((command) => command.id)).not.toContain(saved.teammate.launchCommandId);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.items.length).toBe(3);
  });

  it('wraps an existing launch command and refuses a missing one', async () => {
    const commands = (await catalog(host)).launchCommands;
    const review = commands.find((command) => command.name === 'Release notes');
    const saved = await teammates(host, {
      type: 'save',
      teammate: simpleDraft('reviewers', { body: { type: 'pipeline', launchCommandId: review?.id }, cardInput: { type: 'named', inputName: 'changes' } }),
    });
    expect(saved.type === 'teammate' && saved.status.notAssignableReason).toBeFalsy();
    // A pipeline without a text input is saved but cannot take cards.
    const video = commands.find((command) => command.name === 'Video pipeline');
    const noInput = await teammates(host, { type: 'save', teammate: simpleDraft('video', { body: { type: 'pipeline', launchCommandId: video?.id } }) });
    expect(noInput.type === 'teammate' && noInput.status.notAssignableReason).toBeTruthy();
    expect(await rejection(teammates(host, { type: 'save', teammate: simpleDraft('ghost', { body: { type: 'pipeline', launchCommandId: 'missing' } }) })))
      .toMatchObject({ code: 'NOT_FOUND' });
    const wrongInput = await teammates(host, {
      type: 'save',
      teammate: simpleDraft('wrong-input', { body: { type: 'pipeline', launchCommandId: review?.id }, cardInput: { type: 'named', inputName: 'nope' } }),
    });
    expect(wrongInput.type === 'teammate' && wrongInput.status.notAssignableReason).toBeTruthy();
  });

  it('toggles enabled and refuses changes in safe mode', async () => {
    const list = await teammates(host, { type: 'list' });
    const coder = list.type === 'teammates' ? list.teammates[0] : undefined;
    const off = await teammates(host, { type: 'setEnabled', teammateId: coder?.id, enabled: false });
    expect(off.type === 'teammate' && off.teammate.enabled).toBe(false);

    const safe = labHost('safe');
    expect(await rejection(safe.invoke('teammates_command_v1', { command: { type: 'setEnabled', workspaceId: WS, teammateId: coder?.id, enabled: false } })))
      .toMatchObject({ code: 'SAFE_MODE' });
  });
});

describe('card input resolution', () => {
  const text = (name: string) => ({ name, label: name, kind: 'text' as const });
  it('prefers card, then message, then the only text input', () => {
    expect(resolveCardInput([text('message'), text('card')], { type: 'auto' })).toEqual({ inputName: 'card' });
    expect(resolveCardInput([text('topic'), text('message')], { type: 'auto' })).toEqual({ inputName: 'message' });
    expect(resolveCardInput([text('since'), { name: 'n', label: 'n', kind: 'number' }], { type: 'auto' })).toEqual({ inputName: 'since' });
    expect(resolveCardInput([text('a'), text('b')], { type: 'auto' })).toHaveProperty('reason');
    expect(resolveCardInput([], { type: 'auto' })).toHaveProperty('reason');
    expect(resolveCardInput([text('a'), text('b')], { type: 'named', inputName: 'b' })).toEqual({ inputName: 'b' });
  });
});
