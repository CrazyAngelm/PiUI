import { describe, expect, it } from 'vitest';
import { newGraphNode, newRouterNode, newScriptNode, type AgentGraph, type GraphNode } from '../../features/orchestration/agentGraph';
import type { ScriptTestClient, ScriptTestRequestV1, ScriptTestResultV1 } from '../../host-api/scriptTestClient';
import { ScriptTestOperationError } from '../../host-api/scriptTestClient';
import { checkSample, defaultSample, dependencyStepIds, ScriptTests, testIsStale } from './scriptTests.svelte';

function scriptNode(source = 'console.log(1)'): GraphNode {
  const node = newScriptNode(0);
  return { ...node, profile: { ...node.profile, name: 'Metrics' }, executor: { type: 'script', runtime: 'node', source, timeoutSeconds: 30 } };
}

function graph(node: GraphNode): AgentGraph {
  const plan = newGraphNode(1);
  const router = newRouterNode(2);
  const branch = router.router?.branches[0]?.id ?? '';
  return {
    id: 'g', name: 'G', teamId: 't', pipelineId: 'p',
    inputs: [
      { name: 'task', label: 'Task', kind: 'text', defaultValue: 'demo' },
      { name: 'strict', label: 'Strict', kind: 'boolean' },
      { name: 'notes', label: 'Notes', kind: 'long-text' },
    ],
    nodes: [plan, router, node],
    edges: [
      { from: plan.id, to: node.id, kind: 'result' },
      { from: router.id, to: node.id, kind: 'route', branchId: branch },
      { from: plan.id, to: router.id, kind: 'result' },
    ],
  };
}

function result(patch: Partial<ScriptTestResultV1> = {}): ScriptTestResultV1 {
  return {
    protocol: 1, outcome: 'exited', exitCode: 0, durationMs: 12, stdout: '{"files":2}\n', stdoutTruncated: false,
    stderr: '', stderrTruncated: false, data: { files: 2 }, fieldIssues: [], failure: null, ...patch,
  };
}

/** A controllable host: each run waits until the test resolves or rejects it. */
function fakeClient() {
  const requests: ScriptTestRequestV1[] = [];
  const cancels: string[] = [];
  let settle: { resolve: (value: ScriptTestResultV1) => void; reject: (error: unknown) => void } | undefined;
  const client: ScriptTestClient = {
    run: (request) => {
      requests.push(request);
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    cancel: async (request) => {
      cancels.push(request.testId);
      settle?.resolve(result({ outcome: 'cancelled', exitCode: null, stdout: '', data: null }));
      return true;
    },
  };
  return { client, requests, cancels, resolve: (value: ScriptTestResultV1) => settle?.resolve(value), reject: (error: unknown) => settle?.reject(error) };
}

describe('script test samples', () => {
  it('defaults to the run document with input defaults and every direct dependency', () => {
    const node = scriptNode();
    const value = graph(node);
    const sample = JSON.parse(defaultSample(value, node)) as Record<string, unknown>;
    const [plan, router] = value.nodes;
    expect(dependencyStepIds(value, node.id)).toEqual([plan!.id, router!.id]);
    expect(sample).toEqual({
      inputs: { task: 'demo', strict: false },
      dependencies: { [plan!.id]: { text: null, data: null }, [router!.id]: { text: null, data: null } },
      step: { id: node.id, name: 'Metrics' },
    });
  });

  it('accepts one JSON object of at most 256 KiB', () => {
    expect(checkSample('{"inputs": {}}')).toEqual({ ok: true, value: { inputs: {} } });
    expect(checkSample('{"inputs": ')).toEqual({ ok: false, error: 'The sample input is not valid JSON.' });
    expect(checkSample('[1, 2]')).toEqual({ ok: false, error: 'The sample input must be one JSON object.' });
    expect(checkSample('null')).toEqual({ ok: false, error: 'The sample input must be one JSON object.' });
    expect(checkSample(JSON.stringify({ padding: 'x'.repeat(256 * 1024) }))).toEqual({ ok: false, error: 'The sample input is larger than 256 KiB.' });
  });

  it('remembers an edited sample per node until it is reset', () => {
    const tests = new ScriptTests('workspace', fakeClient().client);
    const node = scriptNode();
    const value = graph(node);
    tests.setSample(node.id, '{"inputs": {"task": "custom"}}');
    expect(tests.sample(value, node)).toBe('{"inputs": {"task": "custom"}}');
    const other = scriptNode();
    const otherGraph = graph(other);
    expect(tests.sample(otherGraph, other)).toBe(defaultSample(otherGraph, other));
    tests.resetSample(node.id);
    expect(tests.sample(value, node)).toBe(defaultSample(value, node));
  });
});

describe('script test runs', () => {
  it('sends the draft script and shows the result when it ends', async () => {
    const host = fakeClient();
    const tests = new ScriptTests('workspace', host.client, () => 1_000);
    const node = { ...scriptNode('print(1)'), resultFields: [{ name: 'files', kind: 'number' as const }] };
    const pending = tests.run(node, { inputs: {} });
    expect(tests.view(node.id)).toMatchObject({ status: 'running', startedAt: 1_000 });
    expect(host.requests).toEqual([
      {
        workspaceId: 'workspace', testId: tests.view(node.id).testId, runtime: 'node', source: 'print(1)', timeoutSeconds: 30,
        resultFields: [{ name: 'files', kind: 'number' }], stdin: { inputs: {} },
      },
    ]);
    // A second click while it runs does not start another test.
    await tests.run(node, { inputs: {} });
    expect(host.requests).toHaveLength(1);
    host.resolve(result());
    await pending;
    expect(tests.view(node.id)).toMatchObject({ status: 'done', result: { exitCode: 0, data: { files: 2 } } });
    expect(testIsStale(node, tests.view(node.id).tested)).toBe(false);
    expect(testIsStale({ ...node, executor: { type: 'script', runtime: 'node', source: 'print(2)', timeoutSeconds: 30 } }, tests.view(node.id).tested)).toBe(true);
    expect(testIsStale({ ...node, resultFields: [] }, tests.view(node.id).tested)).toBe(true);
  });

  it('cancels a running test and shows typed refusals as safe copy', async () => {
    const host = fakeClient();
    const tests = new ScriptTests('workspace', host.client);
    const node = scriptNode();
    const pending = tests.run(node, {});
    await tests.cancel(node.id);
    await pending;
    expect(host.cancels).toHaveLength(1);
    expect(tests.view(node.id).result?.outcome).toBe('cancelled');

    const refused = tests.run(node, {});
    host.reject({ code: 'not-trusted' });
    await refused;
    expect(tests.view(node.id)).toMatchObject({ status: 'error', error: 'Trust this project folder to test scripts.' });

    const failed = tests.run(node, {});
    host.reject(new ScriptTestOperationError('script-runtime-unavailable'));
    await failed;
    expect(tests.view(node.id).error).toBe('The script runtime (Node.js, Python or PowerShell) was not found on this computer.');
  });

  it('forgets a test whose node stopped being a script, and never tests other nodes', async () => {
    const host = fakeClient();
    const tests = new ScriptTests('workspace', host.client);
    const node = scriptNode();
    const pending = tests.run(node, {});
    tests.forget(node.id);
    await pending;
    expect(tests.view(node.id).status).toBe('idle');
    expect(host.cancels).toHaveLength(1);

    await tests.run(newGraphNode(0), {});
    expect(host.requests).toHaveLength(1);
  });
});
