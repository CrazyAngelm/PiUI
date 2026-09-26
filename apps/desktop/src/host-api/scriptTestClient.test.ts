import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../contracts/fixtures/orchestration-script-test-v1.json';
import type {
  ScriptTestCancelRequestV1,
  ScriptTestCancelResultV1,
  ScriptTestRequestV1,
  ScriptTestResultV1,
} from '../../../../contracts/orchestration-script-test-v1';
import { labHost, rejection } from './lab/labTestKit';
import type { LabHost } from './lab/labHost';
import {
  createScriptTestClient,
  decodeScriptTestResult,
  scriptTestError,
  ScriptTestOperationError,
  type ScriptTestClient,
} from './scriptTestClient';

describe('script test v1 contract', () => {
  it('keeps the public fixture in the TypeScript contract shape', () => {
    const request: ScriptTestRequestV1 = { ...fixture.request, runtime: 'node', resultFields: [{ name: 'files', kind: 'number' }] };
    const cancel: ScriptTestCancelRequestV1 = fixture.cancelRequest;
    const cancelled: ScriptTestCancelResultV1 = { ...fixture.cancelResult, protocol: 1 };
    expect(Object.keys(request).sort()).toEqual(['resultFields', 'runtime', 'source', 'stdin', 'testId', 'timeoutSeconds', 'workspaceId']);
    expect(Object.keys(cancel).sort()).toEqual(['testId', 'workspaceId']);
    expect(cancelled.cancelled).toBe(true);
    const result = decodeScriptTestResult(fixture.result);
    expect(result?.fieldIssues).toEqual([{ field: 'files', code: 'result-field-type' }]);
    expect(result?.failure).toEqual({ code: 'result-field-type' });
    const timedOut = decodeScriptTestResult(fixture.timedOut);
    expect(timedOut?.outcome).toBe('timedOut');
    expect(timedOut?.failure).toEqual({ code: 'script-timeout', detail: 'still waiting' });
    expect(scriptTestError(fixture.error).code).toBe('not-trusted');
  });

  it('rejects results outside the contract instead of trusting them', () => {
    const valid = fixture.result;
    for (const change of [
      { protocol: 2 },
      { outcome: 'killed' },
      { exitCode: 1.5 },
      { durationMs: -1 },
      { stdout: 3 },
      { data: [1] },
      { fieldIssues: [{ field: 'files', code: 'other' }] },
      { failure: { detail: 'no code' } },
    ]) {
      expect(decodeScriptTestResult({ ...valid, ...change }), JSON.stringify(change)).toBeUndefined();
    }
    const { stderr: _stderr, ...missing } = valid;
    expect(decodeScriptTestResult(missing)).toBeUndefined();
  });

  it('maps host refusals to safe copy without forwarding details', () => {
    expect(scriptTestError({ code: 'safe-mode', message: 'secret path C:\\x' }).message).toBe('Scripts do not run in safe mode.');
    expect(scriptTestError('{"code":"busy"}').code).toBe('busy');
    expect(scriptTestError('invalid args `request` for command: unknown field `cwd`').code).toBe('unknown');
    expect(scriptTestError(new Error('boom')).code).toBe('unknown');
  });

  it('refuses a malformed response as unknown', async () => {
    const client = createScriptTestClient(async <T,>() => ({ protocol: 1, outcome: 'exited' }) as T);
    const error = await rejection(client.run({ ...fixture.request, runtime: 'node', resultFields: [] }));
    expect(error).toBeInstanceOf(ScriptTestOperationError);
    expect((error as ScriptTestOperationError).code).toBe('unknown');
  });
});

describe('script test in the UI Lab host', () => {
  let host: LabHost;
  let client: ScriptTestClient;
  let workspaceId: string;

  function request(source: string, change: Partial<ScriptTestRequestV1> = {}): ScriptTestRequestV1 {
    return {
      workspaceId,
      testId: crypto.randomUUID(),
      runtime: 'node',
      source,
      timeoutSeconds: 5,
      resultFields: [],
      stdin: { inputs: { task: 'demo' }, dependencies: { plan: { text: null, data: null } }, step: { id: 'metrics', name: 'Metrics' } },
      ...change,
    };
  }

  async function finished(promise: Promise<ScriptTestResultV1>, ms = 1_000): Promise<ScriptTestResultV1> {
    await vi.advanceTimersByTimeAsync(ms);
    return promise;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    host = labHost();
    client = createScriptTestClient((command, args) => host.invoke(command, args));
    workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('echoes the stdin deterministically and checks fields like a run', async () => {
    const result = await finished(client.run(request('console.log(1)', { resultFields: [{ name: 'step', kind: 'text' }, { name: 'files', kind: 'number' }] })));
    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ step: 'metrics', inputs: ['task'], dependencies: ['plan'] });
    expect(result.fieldIssues).toEqual([{ field: 'files', code: 'result-missing-field' }]);
    expect(result.failure).toEqual({ code: 'result-missing-field' });

    const passed = await finished(client.run(request('console.log(1)', { resultFields: [{ name: 'step', kind: 'text' }] })));
    expect(passed.failure).toBeNull();
    const text = await finished(client.run(request('// lab:text')));
    expect(text.data).toBeNull();
    expect(text.stdout).toMatch(/^Metrics: 1 dependencies, \d+ characters\n$/);
    expect(text.failure).toBeNull();
  });

  it('reports a failing script, a timeout and a cancellation', async () => {
    const failed = await finished(client.run(request('// lab:fail')));
    expect(failed.exitCode).toBe(1);
    expect(failed.failure).toEqual({ code: 'script-failed', detail: 'Error: the check failed (lab:fail)' });

    const slow = client.run(request('// lab:timeout', { timeoutSeconds: 2 }));
    await vi.advanceTimersByTimeAsync(1_000);
    const timedOut = await finished(slow, 1_500);
    expect(timedOut.outcome).toBe('timedOut');
    expect(timedOut.stdout).toBe('started\n');
    expect(timedOut.failure?.code).toBe('script-timeout');

    const running = request('// lab:timeout', { timeoutSeconds: 60 });
    const pending = client.run(running);
    await vi.advanceTimersByTimeAsync(100);
    expect(await client.cancel({ workspaceId, testId: running.testId })).toBe(true);
    const cancelled = await pending;
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.failure).toBeNull();
    expect(await client.cancel({ workspaceId, testId: running.testId })).toBe(false);
  });

  it('refuses like the host: untrusted, safe mode, runtime, conflicts and invalid requests', async () => {
    const legacy = host.state.projects.find((project) => project.trustState === 'restricted')?.id ?? '';
    const refused = async (promise: Promise<unknown>): Promise<string> => ((await rejection(promise)) as ScriptTestOperationError).code;
    expect(await refused(client.run({ ...request('x'), workspaceId: legacy }))).toBe('not-trusted');
    expect(await refused(client.run({ ...request('x'), workspaceId: 'missing' }))).toBe('not-found');
    expect(await refused(client.run(request(' ')))).toBe('invalid');
    expect(await refused(client.run(request('x', { timeoutSeconds: 0 })))).toBe('invalid');
    expect(await refused(client.run(request('x', { stdin: { padding: 'x'.repeat(256 * 1024) } })))).toBe('invalid');
    expect(await refused(client.run(request('x', { resultFields: [{ name: 'a', kind: 'text' }, { name: 'a', kind: 'number' }] })))).toBe('invalid');

    host.state.missingScriptRuntimes = ['python'];
    expect(await refused(client.run(request('x', { runtime: 'python' })))).toBe('script-runtime-unavailable');

    const first = request('// lab:timeout', { timeoutSeconds: 60 });
    const pending = client.run(first);
    expect(await refused(client.run({ ...request('x'), testId: first.testId }))).toBe('conflict');
    await client.cancel({ workspaceId, testId: first.testId });
    await pending;

    // Unknown fields fail decoding exactly like serde's deny_unknown_fields.
    const error = await rejection(host.invoke('orchestration_script_test_v1', { request: { ...request('x'), cwd: 'C:\\' } }));
    expect(String(error)).toContain('unknown field `cwd`');
    const agent = await rejection(host.invoke('orchestration_script_test_v1', { request: { ...request('x'), runtime: 'agent' } }));
    expect(String(agent)).toContain('unknown variant');

    host.state.safeMode = true;
    expect(await refused(client.run(request('x')))).toBe('safe-mode');
  });
});
