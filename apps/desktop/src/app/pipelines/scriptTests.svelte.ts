/**
 * The editor's "Test script" state: one sample stdin document and the last
 * test of each script node, remembered while the pipeline editor is open.
 * A test runs the node's current draft once through the host's script
 * runner (script test v1); it never creates a run and never starts an agent
 * or a model call.
 */
import { initialValues } from './inputs/runInputs';
import type { AgentGraph, GraphNode } from '../../features/orchestration/agentGraph';
import type { ResultField, ScriptRuntime } from '../../host-api/orchestrationClient';
import {
  MAX_SCRIPT_TEST_STDIN_BYTES,
  scriptTestError,
  scriptTestHost,
  type ScriptTestClient,
  type ScriptTestResultV1,
} from '../../host-api/scriptTestClient';

export type ScriptTestStatus = 'idle' | 'running' | 'done' | 'error';

/** What a test ran: the script and the result fields it was checked against. */
export interface TestedScript {
  readonly runtime: ScriptRuntime;
  readonly source: string;
  readonly timeoutSeconds: number;
  readonly resultFields: readonly ResultField[];
}

export interface ScriptTestView {
  readonly status: ScriptTestStatus;
  readonly testId?: string;
  /** Epoch milliseconds when the running test started. */
  readonly startedAt?: number;
  readonly cancelling?: boolean;
  readonly tested?: TestedScript;
  readonly result?: ScriptTestResultV1;
  /** English source string of the locale catalog. */
  readonly error?: string;
}

/** The node's script or result fields changed since `tested` ran. */
export function testIsStale(node: GraphNode, tested: TestedScript | undefined): boolean {
  const executor = node.executor;
  if (tested === undefined || executor?.type !== 'script') return false;
  return (
    executor.runtime !== tested.runtime ||
    executor.source !== tested.source ||
    executor.timeoutSeconds !== tested.timeoutSeconds ||
    JSON.stringify(node.resultFields ?? []) !== JSON.stringify(tested.resultFields)
  );
}

const IDLE: ScriptTestView = { status: 'idle' };

/** Direct dependencies of a node, in the order a run lists them (`compileGraph`). */
export function dependencyStepIds(graph: AgentGraph, nodeId: string): string[] {
  const incoming = (kind: 'result' | 'route') => graph.edges.filter((edge) => edge.kind === kind && edge.to === nodeId).map((edge) => edge.from);
  return [...new Set([...incoming('result'), ...incoming('route')])];
}

/**
 * The document a run would write to stdin, with the run inputs' defaults and
 * an empty result for every direct dependency:
 * `{inputs, dependencies: {<stepId>: {text: null, data: null}}, step: {id, name}}`.
 */
export function defaultSample(graph: AgentGraph, node: GraphNode): string {
  const inputs = Object.fromEntries(Object.entries(initialValues(graph.inputs ?? [])).filter(([, value]) => value !== undefined));
  const dependencies = Object.fromEntries(dependencyStepIds(graph, node.id).map((id) => [id, { text: null, data: null }]));
  return JSON.stringify({ inputs, dependencies, step: { id: node.id, name: node.profile.name } }, null, 2);
}

export type SampleCheck =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

const encoder = new TextEncoder();

/** The sample as the host accepts it: one JSON object of at most 256 KiB. */
export function checkSample(text: string): SampleCheck {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The sample input is not valid JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'The sample input must be one JSON object.' };
  }
  if (encoder.encode(JSON.stringify(value)).length > MAX_SCRIPT_TEST_STDIN_BYTES) {
    return { ok: false, error: 'The sample input is larger than 256 KiB.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export class ScriptTests {
  /** Edited sample documents by node id; absent means the default sample. */
  samples = $state<Record<string, string>>({});
  views = $state<Record<string, ScriptTestView>>({});

  constructor(
    private readonly workspaceId: string,
    private readonly client: ScriptTestClient = scriptTestHost,
    private readonly now: () => number = () => Date.now(),
  ) {}

  sample(graph: AgentGraph, node: GraphNode): string {
    return this.samples[node.id] ?? defaultSample(graph, node);
  }

  setSample(nodeId: string, text: string): void {
    this.samples[nodeId] = text;
  }

  resetSample(nodeId: string): void {
    delete this.samples[nodeId];
  }

  view(nodeId: string): ScriptTestView {
    return this.views[nodeId] ?? IDLE;
  }

  running(nodeId: string): boolean {
    return this.view(nodeId).status === 'running';
  }

  /** Runs the node's current script once with `stdin`; the view shows how it ended. */
  async run(node: GraphNode, stdin: Record<string, unknown>): Promise<void> {
    const executor = node.executor;
    if (executor?.type !== 'script' || this.running(node.id)) return;
    const testId = crypto.randomUUID();
    const tested: TestedScript = {
      runtime: executor.runtime,
      source: executor.source,
      timeoutSeconds: executor.timeoutSeconds,
      resultFields: structuredClone(node.resultFields ?? []),
    };
    this.views[node.id] = { status: 'running', testId, startedAt: this.now(), tested };
    try {
      const result = await this.client.run({ workspaceId: this.workspaceId, testId, ...tested, stdin });
      if (this.views[node.id]?.testId === testId) this.views[node.id] = { status: 'done', tested, result };
    } catch (error) {
      if (this.views[node.id]?.testId === testId) this.views[node.id] = { status: 'error', tested, error: scriptTestError(error).message };
    }
  }

  /** Asks the host to stop the node's running test; its run call then reports "cancelled". */
  async cancel(nodeId: string): Promise<void> {
    const view = this.view(nodeId);
    if (view.status !== 'running' || view.testId === undefined || view.cancelling) return;
    this.views[nodeId] = { ...view, cancelling: true };
    try {
      await this.client.cancel({ workspaceId: this.workspaceId, testId: view.testId });
    } catch {
      // The running test call still reports how the script ended.
      const current = this.views[nodeId];
      if (current?.testId === view.testId) this.views[nodeId] = { ...current, cancelling: false };
    }
  }

  /** Stops the node's test and forgets its result, e.g. when it is no longer a script. */
  forget(nodeId: string): void {
    void this.cancel(nodeId);
    delete this.views[nodeId];
  }

  /** Stops every running test (the editor is closing). */
  cancelAll(): void {
    for (const nodeId of Object.keys(this.views)) void this.cancel(nodeId);
  }
}
