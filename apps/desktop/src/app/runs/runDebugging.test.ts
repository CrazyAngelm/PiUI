import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { translate } from '../../features/locale/language';
import type {
  OrchestrationClient,
  OrchestrationRunV6,
  PipelineDefinition,
  RunSummary,
  StoredDefinition,
} from '../../host-api/orchestrationClient';
import { PINNED_ISSUES } from '../../host-api/pinnedData';
import { RUN_DEBUGGING_ERROR_COPY, RunDebuggingOperationError, type RunDebuggingClient } from '../../host-api/runDebuggingClient';
import { DRAFT_REASONS } from '../pipelines/runDraft';
import DraftOutputChecklist from './DraftOutputChecklist.svelte';
import PinnedTaskNote from './PinnedTaskNote.svelte';
import RunDeletionSummary from './RunDeletionSummary.svelte';
import { PIN_REFUSALS, planPin } from './pinOutput';
import { canPinOutput, isActiveRun, listedRuns, stepViews } from './runPresentation';
import { failureText } from './runGraph';
import { RunsStore } from './runsStore.svelte';

/** Run debugging v1 in the run views: pins, archive and delete. */
function run(patch: Partial<OrchestrationRunV6> = {}): OrchestrationRunV6 {
  return {
    schemaVersion: 6, id: 'run-1', status: 'succeeded', revision: 7,
    definition: {
      profiles: [{ id: 'p', name: 'Worker', harness: 'codex', model: 'm', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] }],
      team: { id: 't', name: 'Team', members: [{ id: 'plan', profileId: 'p' }, { id: 'check', profileId: 'p' }], sendEdges: [], observeEdges: [], orchestratorMemberId: 'plan' },
      pipeline: { id: 'pipeline', name: 'Pipeline', steps: [
        { id: 'plan', name: 'Plan', assignedMemberId: 'plan', instructions: '', dependencyStepIds: [],
          pinnedOutput: { text: 'The plan', pinnedAt: '2026-09-27T10:00:00Z', sourceRunId: 'run-0' } },
        { id: 'check', name: 'Check', assignedMemberId: 'check', instructions: '', dependencyStepIds: ['plan'],
          review: { field: 'ok', retryFromStepId: 'plan' }, resultFields: [{ name: 'ok', kind: 'boolean' }] },
      ] },
    },
    tasks: [
      { stepId: 'plan', status: 'succeeded', revision: 1, pinned: true, output: { text: 'The plan' } },
      { stepId: 'check', status: 'succeeded', revision: 2, execution: { id: 'session-1' }, resultData: { ok: true } },
    ],
    messages: [], agentRequests: [], usePinnedData: true,
    ...patch,
  };
}

function summary(id: string, status: RunSummary['status'], archived = false): RunSummary {
  return { id, status, revision: 1, teamName: 'T', pipelineName: 'P', ...(archived ? { archived } : {}) };
}

describe('run debugging presentation', () => {
  it('hides archived runs unless asked and keeps the filter', () => {
    const runs = [summary('a', 'succeeded'), summary('b', 'failed', true), summary('c', 'running')];
    const archived = new Set(['b']);
    expect(listedRuns(runs, 'all', archived, false).map((item) => item.id)).toEqual(['c', 'a']);
    expect(listedRuns(runs, 'all', archived, true).map((item) => item.id)).toEqual(['c', 'b', 'a']);
    expect(listedRuns(runs, 'attention', archived, true).map((item) => item.id)).toEqual(['b']);
    expect(isActiveRun('running')).toBe(true);
    expect(isActiveRun('uncertain')).toBe(true);
    expect(isActiveRun('cancelled')).toBe(false);
  });

  it('offers Pin output only where the host can pin', () => {
    const finished = run();
    const [plan, check] = stepViews(finished);
    expect(canPinOutput(finished, plan!)).toBe(true);
    expect(canPinOutput(finished, check!)).toBe(false);
    expect(canPinOutput({ status: 'running' }, plan!)).toBe(false);
    expect(canPinOutput(finished, { ...plan!, spawned: true })).toBe(false);
    expect(canPinOutput(finished, { ...plan!, task: { ...plan!.task!, status: 'failed', failure: { code: 'x' } } })).toBe(false);
    expect(failureText('review-retry-pinned')).toContain('pinned data');
  });

  it('plans a pin against the saved pipeline and asks before replacing one', async () => {
    const saved: StoredDefinition<PipelineDefinition> = { revision: 4, value: run().definition.pipeline };
    const client = (value: StoredDefinition<PipelineDefinition> | null) =>
      ({ orchestration_get_pipeline_v6: async () => value }) as Pick<OrchestrationClient, 'orchestration_get_pipeline_v6'>;
    expect(await planPin(client(saved), 'w', run(), 'plan')).toEqual({
      kind: 'ready', pipelineId: 'pipeline', revision: 4, replaces: run().definition.pipeline.steps[0]!.pinnedOutput,
    });
    const unpinned = { ...saved, value: { ...saved.value, steps: saved.value.steps.map(({ pinnedOutput: _p, ...step }) => step) } };
    expect(await planPin(client(unpinned), 'w', run(), 'plan')).toEqual({ kind: 'ready', pipelineId: 'pipeline', revision: 4 });
    expect(await planPin(client(saved), 'w', run(), 'check')).toEqual({ kind: 'refused', message: PIN_REFUSALS.notPinnable });
    expect(await planPin(client(saved), 'w', run(), 'gone')).toEqual({ kind: 'refused', message: PIN_REFUSALS.stepGone });
    expect(await planPin(client(null), 'w', run(), 'plan')).toEqual({ kind: 'refused', message: PIN_REFUSALS.pipelineGone });
  });
});

describe('run archive and delete in the store', () => {
  function stores(listed: RunSummary[], refuse: string | undefined = undefined) {
    const calls: unknown[] = [];
    const client = {
      orchestration_list_runs_v6: async () => listed,
      orchestration_get_run_v6: async () => null,
    } as unknown as OrchestrationClient;
    const debugging: RunDebuggingClient = {
      outputs: async () => ({ protocol: 1, runId: 'x', outputs: [] }),
      pin: async () => {
        throw new RunDebuggingOperationError('unknown');
      },
      setArchived: async (request) => {
        calls.push(request);
        if (refuse) throw { code: refuse };
        return request.archived;
      },
      delete: async (request) => {
        calls.push(request);
        if (refuse) throw { code: refuse };
      },
    };
    return { store: new RunsStore('w', false, client, debugging), calls };
  }

  it('archives and deletes through the host and never shows a deleted run again', async () => {
    const { store, calls } = stores([summary('a', 'succeeded', true), summary('b', 'failed')]);
    await store.refresh();
    expect([...store.archived]).toEqual(['a']);
    expect(await store.setArchived('b', true)).toBe(true);
    expect([...store.archived].sort()).toEqual(['a', 'b']);
    expect(await store.setArchived('a', false)).toBe(true);
    expect([...store.archived]).toEqual(['b']);
    expect(await store.deleteRun('b', 9)).toBe(true);
    expect(calls.at(-1)).toEqual({ workspaceId: 'w', runId: 'b', expectedRunRevision: 9 });
    expect(store.summaries.map((item) => item.id)).toEqual(['a']);
    expect(store.isDeleted('b')).toBe(true);
    // An older list read that still has the run does not bring it back.
    await store.refresh();
    expect(store.summaries.map((item) => item.id)).toEqual(['a']);
  });

  it('keeps the run and shows the host refusal', async () => {
    const { store } = stores([summary('a', 'running')], 'run-active');
    await store.refresh();
    expect(await store.deleteRun('a', 1)).toBe(false);
    expect(store.actionError).toBe(RUN_DEBUGGING_ERROR_COPY['run-active']);
    expect(store.summaries.map((item) => item.id)).toEqual(['a']);
    expect(await store.setArchived('a', true)).toBe(false);
    expect(store.archived.size).toBe(0);
  });
});

describe('run debugging markup', () => {
  it('says exactly what deleting a run removes and keeps', () => {
    const markup = render(RunDeletionSummary, { props: { sessions: 2, scripts: 1 } }).body;
    expect(markup).toMatch(/<section[^>]*aria-labelledby="run-delete-removed"/);
    expect(markup).toContain('This run in PiUI’s run journal');
    expect(markup).toContain('Script working copies PiUI may still hold for it');
    expect(markup).toContain('2 sessions and their native history');
    expect(markup).toContain('Files in the project folder');
    expect(markup).toContain('This cannot be undone.');
    expect(render(RunDeletionSummary, { props: { sessions: 0, scripts: 0 } }).body).not.toContain('Script working copies');
  });

  it('lists outputs with labelled checkboxes and says why one cannot be pinned', () => {
    const markup = render(DraftOutputChecklist, {
      props: {
        items: [
          { stepId: 'plan', name: 'Plan', pin: { text: 'The plan', pinnedAt: 'x' }, reason: undefined, wasPinned: true },
          { stepId: 'check', name: 'Check', pin: undefined, reason: DRAFT_REASONS.notPinnable, wasPinned: false },
        ],
        checked: { plan: true },
      },
    }).body;
    expect(markup).toMatch(/<legend[^>]*>Pin the outputs to reuse<\/legend>/);
    expect(markup.match(/role="checkbox"/g)).toHaveLength(2);
    expect(markup).toMatch(/aria-checked="true"/);
    expect(markup).toContain('Pinned data in this run · The plan');
    expect(markup).toContain(DRAFT_REASONS.notPinnable);
    expect(markup).toMatch(/<button[^>]*disabled[^>]*role="checkbox"|role="checkbox"[^>]*disabled/);
    expect(render(DraftOutputChecklist, { props: { items: [], checked: {} } }).body).toContain('nothing to pin');
  });

  it('explains a pinned task in the step panel', () => {
    const current = run();
    const markup = render(PinnedTaskNote, { props: { run: current, record: current.tasks[0] } }).body;
    expect(markup).toContain('role="note"');
    expect(markup).toContain('this step’s result is its pinned data');
    expect(markup).toContain('Pinned from run #run0');
    const failed = { ...current.tasks[0]!, status: 'failed' as const, failure: { code: 'result-field-type' } };
    expect(render(PinnedTaskNote, { props: { run: current, record: failed } }).body).toContain('does not match this step’s result fields');
    expect(render(PinnedTaskNote, { props: { run: current, record: current.tasks[1] } }).body).not.toContain('role="note"');
  });
});

describe('run debugging copy', () => {
  it('has Russian text for every new string', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const files = [
      './RunActions.svelte', './DebugRunDialog.svelte', './DraftOutputChecklist.svelte', './RunDeletionSummary.svelte',
      './PinOutputButton.svelte', './PinnedTaskNote.svelte', './RunNodeCard.svelte', './RunsView.svelte',
      '../pipelines/PinnedDataSection.svelte', '../pipelines/inputs/PinnedRunOption.svelte', '../pipelines/ScriptTestPanel.svelte',
      '../pipelines/canvas/AgentNodeCard.svelte', '../pipelines/canvas/RouterNodeCard.svelte',
    ];
    const calls = files.flatMap((path) => [...read(path).matchAll(/\$t\(\s*'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]!));
    const strings = [
      ...new Set([
        ...calls,
        ...Object.values(RUN_DEBUGGING_ERROR_COPY),
        ...Object.values(PIN_REFUSALS),
        ...Object.values(DRAFT_REASONS),
        ...Object.values(PINNED_ISSUES),
        failureText('review-retry-pinned'),
        'Opened from a run as a new draft',
        'Saving creates a new pipeline; the saved one is not changed.',
        'Pinned data is not exported',
        'System files never include pinned data; the pins stay in PiUI.',
        'This run’s pipeline cannot be opened in the editor.',
      ]),
    ].filter((text) => text.trim() !== '' && text !== 'stderr');
    expect(strings.length).toBeGreaterThan(80);
    const missing = strings.filter((text) => translate(text, 'ru') === text);
    expect(missing).toEqual([]);
  });
});
