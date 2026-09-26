import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/fixtures/orchestration-run-debugging-v1.json';
import type { PipelineStep, TaskRecord } from '../../../../contracts/orchestration-v6';
import type { RunSummary, StartRunRequest } from '../../../../contracts/orchestration-host-v7';
import type {
  DeleteRunRequestV1,
  PinStepOutputRequestV1,
  PinStepOutputResultV1,
  RunDebuggingErrorCodeV1,
  RunOutputsRequestV1,
  RunOutputsResultV1,
  SetRunArchivedRequestV1,
} from '../../../../contracts/orchestration-run-debugging-v1';
import {
  RUN_DEBUGGING_ERROR_COPY,
  RunDebuggingOperationError,
  createRunDebuggingClient,
  decodePinResult,
  decodeRunOutputs,
  runDebuggingError,
} from './runDebuggingClient';

/** Run debugging v1 against the fixture the Rust host checks too. */
describe('run debugging contract v1', () => {
  it('matches the shared fixture shapes', () => {
    const outputs: RunOutputsRequestV1 = fixture.outputsRequest;
    const pin: PinStepOutputRequestV1 = fixture.pinRequest;
    const archive: SetRunArchivedRequestV1 = fixture.archiveRequest;
    const remove: DeleteRunRequestV1 = fixture.deleteRequest;
    expect([outputs.runId, pin.expectedRevision, archive.archived, remove.expectedRunRevision]).toEqual(['run-1', 3, true, 12]);
    expect(decodeRunOutputs(fixture.outputsResult)).toEqual(fixture.outputsResult as RunOutputsResultV1);
    expect(decodePinResult(fixture.pinResult)).toEqual(fixture.pinResult as PinStepOutputResultV1);
    const codes: readonly RunDebuggingErrorCodeV1[] = fixture.errors.map((error) => error.code as RunDebuggingErrorCodeV1);
    expect(codes.every((code) => Object.hasOwn(RUN_DEBUGGING_ERROR_COPY, code))).toBe(true);
    // v6.3 additive fields of the orchestration contracts.
    const start: StartRunRequest = fixture.startRequest;
    const summary = fixture.runSummary as RunSummary;
    const pinnedStep = fixture.pinnedStep as PipelineStep;
    const pinnedTask = fixture.pinnedTask as TaskRecord;
    expect([start.usePinnedData, summary.archived, pinnedStep.pinnedOutput?.sourceRunId, pinnedTask.pinned]).toEqual([true, true, 'run-1', true]);
  });

  it('rejects results that do not match the contract', () => {
    expect(decodeRunOutputs({ ...fixture.outputsResult, protocol: 2 })).toBeUndefined();
    expect(decodeRunOutputs({ ...fixture.outputsResult, outputs: [{ stepId: 'a', issue: 'gone' }] })).toBeUndefined();
    expect(decodeRunOutputs({ ...fixture.outputsResult, outputs: [{ stepId: 'a', data: [1] }] })).toBeUndefined();
    expect(decodePinResult({ ...fixture.pinResult, pinnedOutput: { pinnedAt: 'x' } })).toBeUndefined();
    expect(decodePinResult({ ...fixture.pinResult, revision: -1.5 })).toBeUndefined();
  });

  it('maps every refusal to typed copy and never forwards host details', () => {
    for (const { code } of fixture.errors) {
      const error = runDebuggingError({ code, message: 'C:\\Users\\secret\\path' });
      expect(error.code).toBe(code);
      expect(error.message).not.toContain('secret');
    }
    expect(runDebuggingError('{"code":"run-active"}').code).toBe('run-active');
    expect(runDebuggingError(new Error('boom')).code).toBe('unknown');
    expect(runDebuggingError({ code: 'rm -rf' }).code).toBe('unknown');
  });

  it('calls the four commands with one request argument each', async () => {
    const calls: [string, unknown][] = [];
    const answers: Record<string, unknown> = {
      orchestration_run_outputs_v1: fixture.outputsResult,
      orchestration_pin_step_output_v1: fixture.pinResult,
      orchestration_set_run_archived_v1: fixture.archiveResult,
      orchestration_delete_run_v1: fixture.deleteResult,
    };
    const client = createRunDebuggingClient(async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      return answers[command] as T;
    });
    await expect(client.outputs(fixture.outputsRequest)).resolves.toEqual(fixture.outputsResult);
    await expect(client.pin(fixture.pinRequest)).resolves.toEqual(fixture.pinResult);
    await expect(client.setArchived(fixture.archiveRequest)).resolves.toBe(true);
    await expect(client.delete(fixture.deleteRequest)).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['orchestration_run_outputs_v1', { request: fixture.outputsRequest }],
      ['orchestration_pin_step_output_v1', { request: fixture.pinRequest }],
      ['orchestration_set_run_archived_v1', { request: fixture.archiveRequest }],
      ['orchestration_delete_run_v1', { request: fixture.deleteRequest }],
    ]);
    const refusing = createRunDebuggingClient(async () => {
      throw { code: 'safe-mode' };
    });
    await expect(refusing.delete(fixture.deleteRequest)).rejects.toEqual(new RunDebuggingOperationError('safe-mode'));
    const wrong = createRunDebuggingClient(async <T,>() => ({ protocol: 1, runId: 'other' }) as T);
    await expect(wrong.delete(fixture.deleteRequest)).rejects.toMatchObject({ code: 'unknown' });
  });
});
