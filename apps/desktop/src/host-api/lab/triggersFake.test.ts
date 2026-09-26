import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackgroundSettingsV1, OrchestrationAutomationsChangedEventV7, OrchestrationCatalogV6, OrchestrationRunV6,
  OrchestrationScheduleChangedEventV7, RunSummary, ScheduleSnapshot,
} from './labContracts';
import type { LabHost } from './labHost';
import { labUuid } from './labRandom';
import { labHost, record, rejection } from './labTestKit';

const REVIEW_INPUTS = { task: 'Check the release notes against the merged changes.' };

function projectId(host: LabHost, name: string): string {
  const project = host.state.projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new Error(`No project ${name}`);
  return project.id;
}

function call<T>(host: LabHost, route: string, request: Record<string, unknown>): Promise<T> {
  return host.invoke<T>(route, { request });
}

async function commands(host: LabHost, workspaceId: string): Promise<{ review: string; release: string }> {
  const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
  const find = (name: string): string => {
    const command = catalog.launchCommands.find((item) => item.name === name);
    if (command === undefined) throw new Error(`No launch command ${name}`);
    return command.id;
  };
  return { review: find('Code review'), release: find('Release check') };
}

function afterRelease(release: string, review: string, outcomes: string[] = ['succeeded', 'failed']): Record<string, unknown> {
  return {
    id: 'lab-after-release', name: 'Review after release check', launchCommandId: review,
    trigger: { type: 'event', event: { kind: 'run-finished', launchCommandId: release, outcomes } },
    missedRunPolicy: 'skip', overlapPolicy: 'skip', inputs: REVIEW_INPUTS,
  };
}

async function saveAndEnable(host: LabHost, workspaceId: string, value: Record<string, unknown>): Promise<ScheduleSnapshot> {
  const saved = await call<ScheduleSnapshot>(host, 'orchestration_save_schedule_v7', { workspaceId, value });
  return call<ScheduleSnapshot>(host, 'orchestration_set_schedule_enabled_v7', {
    workspaceId, id: saved.value.id, expectedRevision: saved.revision, enabled: true,
  });
}

async function startRelease(host: LabHost, workspaceId: string, release: string, runId: string): Promise<OrchestrationRunV6> {
  const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
  const teamId = catalog.teams.find((item) => item.name === 'Release check')?.id;
  const pipelineId = catalog.pipelines.find((item) => item.name === 'Release check')?.id;
  return call<OrchestrationRunV6>(host, 'orchestration_start_run_v6', { workspaceId, runId, teamId, pipelineId, launchCommandId: release });
}

async function until(host: LabHost, check: () => Promise<boolean>): Promise<void> {
  for (let second = 0; second < 240; second += 1) {
    if (await check()) return;
    await vi.advanceTimersByTimeAsync(1_000);
  }
  throw new Error('The lab did not reach the expected state.');
}

async function triggeredRuns(host: LabHost, workspaceId: string): Promise<OrchestrationRunV6[]> {
  const summaries = await call<RunSummary[]>(host, 'orchestration_list_runs_v6', { workspaceId });
  const runs = await Promise.all(summaries.map((summary) =>
    call<OrchestrationRunV6>(host, 'orchestration_get_run_v6', { workspaceId, runId: summary.id })));
  return runs.filter((run) => run.trigger?.kind === 'event' && run.trigger.scheduleId === 'lab-after-release');
}

describe('UI Lab event automations (host v7.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks event rules like the host and keeps them out of the due-time queue', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const { review, release } = await commands(host, piui);
    const base = afterRelease(release, review);
    const trigger = (event: Record<string, unknown>): Record<string, unknown> => ({ ...base, trigger: { type: 'event', event } });
    for (const value of [
      trigger({ kind: 'run-finished', launchCommandId: 'missing', outcomes: ['succeeded'] }),
      trigger({ kind: 'run-finished', launchCommandId: release, outcomes: [] }),
      trigger({ kind: 'run-finished', launchCommandId: release, outcomes: ['failed', 'failed'] }),
      { ...base, missedRunPolicy: 'coalesce' },
      trigger({ kind: 'files-changed', include: ['../outside/*'], debounceSeconds: 10 }),
      trigger({ kind: 'files-changed', include: ['src/**'], debounceSeconds: 1 }),
      trigger({ kind: 'files-changed', include: [], debounceSeconds: 10 }),
    ]) {
      expect(await rejection(call(host, 'orchestration_save_schedule_v7', { workspaceId: piui, value }))).toMatchObject({ code: 'invalid' });
    }
    const enabled = await saveAndEnable(host, piui, base);
    expect(enabled).toMatchObject({ enabled: true, nextDueAt: null, lastOccurrence: null });
    const files = await call<ScheduleSnapshot>(host, 'orchestration_save_schedule_v7', {
      workspaceId: piui,
      value: { ...trigger({ kind: 'files-changed', include: ['src/**/*.ts'], exclude: [], debounceSeconds: 10 }), id: 'lab-files' },
    });
    expect(files.value.trigger).toEqual({ type: 'event', event: { kind: 'files-changed', include: ['src/**/*.ts'], debounceSeconds: 10 } });
    // A pipeline an automation waits for cannot be deleted.
    expect(await rejection(call(host, 'orchestration_delete_launch_command_v6', { workspaceId: piui, id: release, expectedRevision: 0 })))
      .toMatchObject({ code: 'conflict' });
  });

  it('starts the target when the watched pipeline finishes and records the chain', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const { review, release } = await commands(host, piui);
    await saveAndEnable(host, piui, afterRelease(release, review));
    const events = await record<OrchestrationScheduleChangedEventV7>(host, 'piui://orchestration-schedule-event');
    const sourceId = labUuid('test:release');
    await startRelease(host, piui, release, sourceId);
    await until(host, async () => (await triggeredRuns(host, piui)).length > 0);
    const source = await call<OrchestrationRunV6>(host, 'orchestration_get_run_v6', { workspaceId: piui, runId: sourceId });
    expect(source.status).not.toBe('running');
    const [started] = await triggeredRuns(host, piui);
    expect(started?.trigger).toEqual({
      kind: 'event', scheduleId: 'lab-after-release', scheduleName: 'Review after release check', occurrenceId: started?.id,
      event: 'run-finished', sourceRunId: sourceId, chainDepth: 1,
    });
    expect(started?.definition.launchCommand?.id).toBe(review);
    expect(started?.inputs).toEqual(REVIEW_INPUTS);
    const schedules = await call<ScheduleSnapshot[]>(host, 'orchestration_list_schedules_v7', { workspaceId: piui });
    const rule = schedules.find((schedule) => schedule.value.id === 'lab-after-release');
    expect(rule?.lastOccurrence).toMatchObject({ outcome: 'started', runId: started?.id, sourceRunId: sourceId, chainDepth: 1 });
    expect(events.items.some((event) => event.scheduleId === 'lab-after-release')).toBe(true);
  });

  it('records a paused or over-deep firing as skipped with its reason', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const { review, release } = await commands(host, piui);
    await saveAndEnable(host, piui, afterRelease(release, review, ['succeeded', 'failed', 'cancelled']));
    const changes = await record<OrchestrationAutomationsChangedEventV7>(host, 'piui://orchestration-automations-event');

    // A source run that is already three event hops deep.
    const deepId = labUuid('test:deep');
    const deep = await startRelease(host, piui, release, deepId);
    const stored = host.state.orchestration.get(piui)?.runs.find((run) => run.id === deepId);
    if (stored === undefined) throw new Error('No stored run.');
    stored.trigger = { kind: 'event', scheduleId: 'elsewhere', scheduleName: 'Elsewhere', occurrenceId: 'event-x', event: 'files-changed', chainDepth: 3 };
    await call(host, 'orchestration_cancel_run_v6', { workspaceId: piui, runId: deepId, expectedRunRevision: deep.revision });
    const afterDeep = await call<ScheduleSnapshot[]>(host, 'orchestration_list_schedules_v7', { workspaceId: piui });
    expect(afterDeep.find((item) => item.value.id === 'lab-after-release')?.lastOccurrence)
      .toMatchObject({ outcome: 'skippedChainLimit', sourceRunId: deepId, chainDepth: 4 });

    expect(await call(host, 'orchestration_set_automations_paused_v7', { paused: true })).toEqual({ paused: true });
    expect(await call(host, 'orchestration_automations_v7', {})).toEqual({ paused: true });
    const pausedId = labUuid('test:paused');
    const paused = await startRelease(host, piui, release, pausedId);
    await call(host, 'orchestration_cancel_run_v6', { workspaceId: piui, runId: pausedId, expectedRunRevision: paused.revision });
    const afterPause = await call<ScheduleSnapshot[]>(host, 'orchestration_list_schedules_v7', { workspaceId: piui });
    expect(afterPause.find((item) => item.value.id === 'lab-after-release')?.lastOccurrence)
      .toMatchObject({ outcome: 'skippedPaused', sourceRunId: pausedId });
    expect(await triggeredRuns(host, piui)).toEqual([]);
    await call(host, 'orchestration_set_automations_paused_v7', { paused: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.items).toEqual([
      { protocol: 7, type: 'automationsChanged', paused: true },
      { protocol: 7, type: 'automationsChanged', paused: false },
    ]);
  });

  it('keeps the pause switch read-only in safe mode', async () => {
    const host = labHost('safe');
    expect(await rejection(call(host, 'orchestration_set_automations_paused_v7', { paused: true }))).toMatchObject({ code: 'runtime-unavailable' });
    expect(await call(host, 'orchestration_automations_v7', {})).toEqual({ paused: false });
  });
});

describe('UI Lab run from chat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the chat trigger and refuses any other claimed origin', async () => {
    const host = labHost();
    const piui = projectId(host, 'piui');
    const { release } = await commands(host, piui);
    const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId: piui });
    const teamId = catalog.teams.find((item) => item.name === 'Release check')?.id;
    const pipelineId = catalog.pipelines.find((item) => item.name === 'Release check')?.id;
    const start = (runId: string, trigger: unknown) => call<OrchestrationRunV6>(host, 'orchestration_start_run_v6', {
      workspaceId: piui, runId, teamId, pipelineId, launchCommandId: release, trigger,
    });
    const run = await start(labUuid('test:chat'), { kind: 'chat', sessionId: 'chat-session-1' });
    expect(run.trigger).toEqual({ kind: 'chat', sessionId: 'chat-session-1' });
    expect(await rejection(start(labUuid('test:bad-chat'), { kind: 'chat', sessionId: 'a\nb' }))).toMatchObject({ code: 'invalid' });
    // A caller can never claim an automation identity.
    expect(String(await rejection(start(labUuid('test:claimed'), { kind: 'schedule', scheduleId: 's', scheduleName: 'S', occurrenceId: 'o' }))))
      .toContain('unknown variant');
  });
});

describe('UI Lab background mode', () => {
  it('starts off, changes only on explicit requests and stays read-only in safe mode', async () => {
    const host = labHost();
    const initial = await call<BackgroundSettingsV1>(host, 'background_settings_v1', {});
    expect(initial).toEqual({ protocol: 1, keepInTray: false, launchAtLogin: false, trayAvailable: true, launchAtLoginAvailable: true, readOnly: false });
    expect((await call<BackgroundSettingsV1>(host, 'background_update_v1', { keepInTray: true })).keepInTray).toBe(true);
    expect((await call<BackgroundSettingsV1>(host, 'background_update_v1', { launchAtLogin: true })).launchAtLogin).toBe(true);
    expect(await rejection(call(host, 'background_update_v1', {}))).toMatchObject({ code: 'invalid' });
    const labels = { open: 'Открыть PiUI', pause: 'Приостановить', resume: 'Возобновить', quit: 'Выйти', tooltip: 'PiUI', pausedTooltip: 'PiUI (пауза)' };
    expect(await call(host, 'background_tray_labels_v1', labels)).toBeNull();
    expect(await rejection(call(host, 'background_tray_labels_v1', { ...labels, quit: ' ' }))).toMatchObject({ code: 'invalid' });

    const safe = labHost('safe');
    expect(await call<BackgroundSettingsV1>(safe, 'background_settings_v1', {})).toMatchObject({ readOnly: true, trayAvailable: false });
    expect(await rejection(call(safe, 'background_update_v1', { keepInTray: true }))).toMatchObject({ code: 'read-only' });
  });
});
