import { describe, expect, it } from 'vitest';
import type { PinnedOutput, PipelineStep } from '../../../../contracts/orchestration-v6';
import {
  MAX_PINNED_DATA_BYTES,
  MAX_PINNED_TEXT_BYTES,
  PINNED_REASONS,
  hasPinnedSteps,
  pinnedOutputIssue,
  pinnedPreview,
  pinnedResult,
  pinnedSize,
  pinningRefusal,
  pipelinePinsIssue,
} from './pinnedData';

/** The rules of `piui-orchestration/src/pinned.rs`, mirrored for the editor and the UI Lab. */
const AT = '2026-09-27T10:00:00Z';

function step(patch: Partial<PipelineStep> = {}): PipelineStep {
  return { id: 'plan', name: 'Plan', assignedMemberId: 'plan', instructions: '', dependencyStepIds: [], ...patch };
}

function pin(patch: Partial<PinnedOutput> = {}): PinnedOutput {
  return { text: 'The plan', pinnedAt: AT, sourceRunId: 'run-1', ...patch };
}

describe('pinned data rules', () => {
  it('refuses steps that always run', () => {
    expect(pinningRefusal(step())).toBeUndefined();
    expect(pinningRefusal(step({ executionMode: 'callable' }))).toBe(PINNED_REASONS.callable);
    expect(pinningRefusal(step({ router: { mode: 'program', inputStepId: 'a', branches: [] } }))).toBe(PINNED_REASONS.programRouter);
    expect(pinningRefusal(step({ router: { mode: 'agent', inputStepId: 'a', branches: [], selectionField: 'picked' } }))).toBeUndefined();
    expect(pinningRefusal(step({ review: { field: 'ok', retryFromStepId: 'a' } }))).toBe(PINNED_REASONS.review);
  });

  it('checks shape and bounds like the host', () => {
    expect(pinnedOutputIssue(step(), pin())).toBeUndefined();
    expect(pinnedOutputIssue(step(), { pinnedAt: AT })).toBe(PINNED_REASONS.empty);
    expect(pinnedOutputIssue(step(), pin({ text: undefined, data: {}, truncated: true }))).toBe(PINNED_REASONS.cutWithoutText);
    expect(pinnedOutputIssue(step(), pin({ text: 'x'.repeat(MAX_PINNED_TEXT_BYTES + 1) }))).toBe(PINNED_REASONS.textSize);
    // UTF-8 bytes, not characters.
    expect(pinnedOutputIssue(step(), pin({ text: 'я'.repeat(MAX_PINNED_TEXT_BYTES / 2 + 1) }))).toBe(PINNED_REASONS.textSize);
    expect(pinnedOutputIssue(step(), pin({ data: [1] as unknown as Record<string, unknown> }))).toBe(PINNED_REASONS.notObject);
    expect(pinnedOutputIssue(step(), pin({ data: { text: 'x'.repeat(MAX_PINNED_DATA_BYTES) } }))).toBe(PINNED_REASONS.dataSize);
    expect(pinnedOutputIssue(step(), pin({ pinnedAt: ' ' }))).toBe(PINNED_REASONS.time);
    expect(pinnedOutputIssue(step(), pin({ sourceRunId: '' }))).toBe(PINNED_REASONS.source);
    // A null option is absent, like serde.
    expect(pinnedOutputIssue(step(), { ...pin(), data: null } as unknown as PinnedOutput)).toBeUndefined();
  });

  it('bounds all pins of a pipeline at 1 MiB', () => {
    const big = pin({ text: 'x'.repeat(250 * 1024) });
    const steps = [0, 1, 2, 3, 4].map((index) => step({ id: `s${index}`, pinnedOutput: big }));
    expect(pipelinePinsIssue(steps.slice(0, 4))).toBeUndefined();
    expect(pipelinePinsIssue(steps)).toEqual({ stepId: 's4', reason: PINNED_REASONS.total });
    expect(pinnedSize(pin({ text: 'ab', data: { a: 1 } }))).toBe(2 + '{"a":1}'.length);
    expect(hasPinnedSteps(steps)).toBe(true);
    expect(hasPinnedSteps([step()])).toBe(false);
  });

  it('records what a run with pinned data admits, checked like a native result', () => {
    expect(pinnedResult(step(), pin())).toEqual({ ok: true, output: { text: 'The plan' } });
    const fields = step({ resultFields: [{ name: 'files', kind: 'number' }] });
    expect(pinnedResult(fields, pin({ text: '{"files": 3}' }))).toEqual({ ok: true, data: { files: 3 }, output: { text: '{"files": 3}' } });
    expect(pinnedResult(fields, pin({ text: undefined, data: { files: '3' } }))).toEqual({ ok: false, failure: { code: 'result-field-type' } });
    expect(pinnedResult(fields, pin({ text: 'three files' }))).toEqual({ ok: false, failure: { code: 'result-invalid-json' } });
    expect(pinnedResult(fields, pin({ text: '[3]' }))).toEqual({ ok: false, failure: { code: 'result-not-object' } });
    // Cut text is never read as JSON.
    expect(pinnedResult(fields, pin({ text: '{"files": 3}', truncated: true }))).toEqual({ ok: false, failure: { code: 'result-invalid-json' } });
    const router = step({
      router: { mode: 'agent', inputStepId: 'a', selectionField: 'picked', branches: [{ id: 'docs', label: 'Docs', description: 'd' }] },
      resultFields: [{ name: 'picked', kind: 'text-list' }],
    });
    expect(pinnedResult(router, pin({ text: undefined, data: { picked: ['docs'] } }))).toEqual({ ok: true, data: { picked: ['docs'] } });
    expect(pinnedResult(router, pin({ text: undefined, data: { picked: ['deploy'] } }))).toEqual({ ok: false, failure: { code: 'router-selection-invalid' } });
  });

  it('previews pinned data on one line', () => {
    expect(pinnedPreview(pin({ text: 'line one\n\nline two' }))).toBe('line one line two');
    expect(pinnedPreview({ data: { files: 2 } })).toBe('{"files":2}');
    expect(pinnedPreview(pin({ text: 'x'.repeat(400) }), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
