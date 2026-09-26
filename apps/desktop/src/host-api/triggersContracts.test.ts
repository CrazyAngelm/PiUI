import { describe, expect, it } from 'vitest';
import golden from '../../../../contracts/fixtures/triggers-v7-2.json';
import { decode } from './lab/labSchema';
import { backgroundUpdateSchema, scheduleSchema, startRunSchema, trayLabelsSchema } from './lab/labSchemas';
import { automationsChanged, createAutomationsClient, type AutomationsRoute } from './automationsClient';
import { backgroundError, createBackgroundClient, type BackgroundRoute } from './backgroundClient';
import {
  createOrchestrationClient,
  type OrchestrationCommandName,
  type OrchestrationRequest,
  type OrchestrationRunV6,
  type RunTrigger,
  type ScheduleDefinition,
  type ScheduleOccurrence,
} from './orchestrationClient';

describe('orchestration host v7.2 contract', () => {
  it('passes the chat trigger of a run start through unchanged', async () => {
    const calls: { route: OrchestrationCommandName; request: OrchestrationRequest }[] = [];
    const client = createOrchestrationClient(async <T>(route: OrchestrationCommandName, { request }: { request: OrchestrationRequest }): Promise<T> => {
      calls.push({ route, request });
      return null as T;
    });
    await client.orchestration_start_run_v6({
      workspaceId: 'fixture-workspace', runId: 'fixture-run', teamId: 'team', pipelineId: 'pipeline', launchCommandId: 'command',
      trigger: { kind: 'chat', sessionId: 'chat-session' },
    });
    expect(calls).toEqual([{
      route: 'orchestration_start_run_v6',
      request: {
        workspaceId: 'fixture-workspace', runId: 'fixture-run', teamId: 'team', pipelineId: 'pipeline', launchCommandId: 'command',
        trigger: { kind: 'chat', sessionId: 'chat-session' },
      },
    }]);
  });

  it('types event triggers, skip reasons and run triggers exactly as the host writes them', () => {
    const afterBuild: ScheduleDefinition = {
      id: 'after-build', name: 'After build', launchCommandId: 'deploy',
      trigger: { type: 'event', event: { kind: 'run-finished', launchCommandId: 'build', outcomes: ['succeeded', 'failed'] } },
      missedRunPolicy: 'skip', overlapPolicy: 'skip',
    };
    const onFiles: ScheduleDefinition = {
      id: 'on-files', name: 'On files', launchCommandId: 'deploy',
      trigger: { type: 'event', event: { kind: 'files-changed', include: ['src/**/*.ts'], exclude: ['src/gen/**'], debounceSeconds: 10 } },
      missedRunPolicy: 'skip', overlapPolicy: 'skip',
    };
    const skipped: ScheduleOccurrence = {
      id: 'event-1', nominalAt: '2026-09-27T10:00:00Z', recordedAt: '2026-09-27T10:00:00Z',
      outcome: 'skippedChainLimit', sourceRunId: 'build-run', chainDepth: 4,
    };
    const trigger: RunTrigger = {
      kind: 'event', scheduleId: 'after-build', scheduleName: 'After build', occurrenceId: 'event-1',
      event: 'run-finished', sourceRunId: 'build-run', chainDepth: 1,
    };
    const run: Pick<OrchestrationRunV6, 'trigger'> = { trigger };
    // Round trip through JSON: no field is renamed or dropped.
    for (const value of [afterBuild, onFiles, skipped, run]) expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    expect(Object.keys(afterBuild.trigger)).toEqual(['type', 'event']);
  });

  it('accepts the golden JSON the host round-trips (contracts/fixtures/triggers-v7-2.json)', async () => {
    // The lab decoders transcribe the host's serde rules (deny_unknown_fields, tags, defaults).
    for (const schedule of golden.schedules) expect(() => decode(scheduleSchema, schedule)).not.toThrow();
    expect(() => decode(startRunSchema, golden.startRun)).not.toThrow();
    expect(() => decode(startRunSchema, { ...golden.startRun, trigger: { kind: 'schedule', scheduleId: 's' } })).toThrow();
    expect(() => decode(backgroundUpdateSchema, golden.backgroundUpdate)).not.toThrow();
    expect(() => decode(trayLabelsSchema, golden.trayLabels)).not.toThrow();
    expect(automationsChanged(golden.automationsEvent)).toEqual(golden.automationsEvent);
    const background = createBackgroundClient(async <T>() => golden.backgroundSettings as T);
    expect(await background.settings()).toEqual(golden.backgroundSettings);
    const outcomes = new Set<ScheduleOccurrence['outcome']>(['started', 'skippedChainLimit', 'skippedCooldown', 'skippedPaused']);
    for (const occurrence of golden.occurrences) expect(outcomes.has(occurrence.outcome as ScheduleOccurrence['outcome'])).toBe(true);
    const kinds = new Set<RunTrigger['kind']>(['schedule', 'event', 'chat']);
    for (const trigger of golden.runTriggers) expect(kinds.has(trigger.kind as RunTrigger['kind'])).toBe(true);
  });
});

describe('automations switch client', () => {
  it('reads and flips the global pause switch through the exact commands', async () => {
    const calls: { route: AutomationsRoute; request: unknown }[] = [];
    let paused = false;
    const client = createAutomationsClient(async <T>(route: AutomationsRoute, { request }: { request: unknown }): Promise<T> => {
      calls.push({ route, request });
      if (route === 'orchestration_set_automations_paused_v7') paused = (request as { paused: boolean }).paused;
      return { paused } as T;
    }, async () => () => {});
    expect(await client.state()).toEqual({ paused: false });
    expect(await client.setPaused(true)).toEqual({ paused: true });
    expect(calls).toEqual([
      { route: 'orchestration_automations_v7', request: {} },
      { route: 'orchestration_set_automations_paused_v7', request: { paused: true } },
    ]);
  });

  it('maps refusals to safe copy and accepts only the versioned event', async () => {
    const client = createAutomationsClient(async () => { throw { code: 'runtime-unavailable', message: 'D:/private' }; }, async () => { throw new Error('closed'); });
    await expect(client.setPaused(true)).rejects.toMatchObject({ code: 'runtime-unavailable' });
    await expect(client.listen(() => {})).rejects.toMatchObject({ code: 'unknown' });
    expect(automationsChanged({ protocol: 7, type: 'automationsChanged', paused: true })).toEqual({ protocol: 7, type: 'automationsChanged', paused: true });
    expect(automationsChanged({ protocol: 7, type: 'automationsChanged', paused: 'yes' })).toBeUndefined();
    expect(automationsChanged({ protocol: 6, type: 'automationsChanged', paused: true })).toBeUndefined();
    const received: boolean[] = [];
    let emit: (payload: unknown) => void = () => {};
    const live = createAutomationsClient(async () => ({ paused: false }) as never, async (handler) => { emit = handler; return () => {}; });
    await live.listen((event) => received.push(event.paused));
    emit({ protocol: 7, type: 'automationsChanged', paused: true });
    emit({ protocol: 7, type: 'scheduleChanged', workspaceId: 'w', scheduleId: 's', revision: 1 });
    expect(received).toEqual([true]);
  });
});

describe('background mode client (background-v1)', () => {
  const settings = { protocol: 1, keepInTray: false, launchAtLogin: false, trayAvailable: true, launchAtLoginAvailable: true, readOnly: false };

  it('sends exactly the changed field and validates the reply', async () => {
    const calls: { route: BackgroundRoute; request: unknown }[] = [];
    const client = createBackgroundClient(async <T>(route: BackgroundRoute, { request }: { request: unknown }): Promise<T> => {
      calls.push({ route, request });
      return (route === 'background_tray_labels_v1' ? null : { ...settings, keepInTray: route === 'background_update_v1' }) as T;
    });
    expect(await client.settings()).toEqual(settings);
    expect((await client.update({ keepInTray: true })).keepInTray).toBe(true);
    await client.trayLabels({ open: 'Open PiUI', pause: 'Pause all automations', resume: 'Resume automations', quit: 'Quit PiUI', tooltip: 'PiUI', pausedTooltip: 'PiUI (paused)' });
    expect(calls.map((call) => call.route)).toEqual(['background_settings_v1', 'background_update_v1', 'background_tray_labels_v1']);
    expect(calls[0]?.request).toEqual({});
    expect(calls[1]?.request).toEqual({ keepInTray: true });
    await expect(client.update({})).rejects.toMatchObject({ code: 'invalid' });
  });

  it('never trusts a malformed reply or a host detail', async () => {
    const malformed = createBackgroundClient(async <T>() => ({ ...settings, protocol: 2 }) as T);
    await expect(malformed.settings()).rejects.toMatchObject({ code: 'io' });
    const refused = createBackgroundClient(async () => { throw JSON.stringify({ code: 'read-only', message: 'C:/Users/private' }); });
    await expect(refused.update({ launchAtLogin: true })).rejects.toMatchObject({ code: 'read-only' });
    const error = backgroundError({ code: 'registry-denied', message: 'HKCU secret' });
    expect(error.code).toBe('unknown');
    expect(error.message).not.toContain('HKCU');
  });
});
