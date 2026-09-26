/**
 * Changing the type of an existing pipeline node: agent, model call (`llm`)
 * or script (orchestration v6.2 executors). A conversion keeps the node's id,
 * name, position, result and route connections and its result fields, run
 * condition, review and approval settings. What the new type cannot keep is
 * listed first so a person confirms it: collaboration connections (messages,
 * observation, delegation), on-call mode and input mappings that would make
 * the graph invalid, least-authority changes of a model call, and user data
 * the new type discards (script code, task/prompt, instructions, the agent's
 * harness and model). One conversion is one undo step in the editor.
 */
import type { AgentProfile } from '../../host-api/orchestrationClient';
import { harnessConfiguration, harnessConfigurations } from '../../harness-adapters';
import { isBuiltinHarness } from '../../../../../contracts/harness-identity-v2';
import { profileForHarness } from '../../harness-adapters/normalize';
import {
  newGraphNode,
  placeholderProfile,
  type AgentGraph,
  type GraphEdge,
  type GraphNode,
} from '../../features/orchestration/agentGraph';
import { harnessMeta } from '../harnessMeta';

export type NodeType = 'agent' | 'llm' | 'script';
type Harness = AgentProfile['harness'];

export const NODE_TYPES: readonly NodeType[] = ['agent', 'llm', 'script'];

/** English source strings of the locale catalog. */
export const NODE_TYPE_LABEL: Readonly<Record<NodeType, string>> = { agent: 'Agent', llm: 'Model call', script: 'Script' };

/** A new script starts empty with the editor's default time limit. */
export const NEW_SCRIPT_TIMEOUT_SECONDS = 60;

/** The node's type; routers keep their own kind and are never converted. */
export function nodeType(node: Pick<GraphNode, 'kind' | 'executor'>): NodeType | undefined {
  if (node.kind === 'router') return undefined;
  return node.executor?.type ?? 'agent';
}

/** A locale message (English source with `{n}` parameters). */
export interface ConversionNote {
  readonly message: string;
  readonly params?: readonly (string | number)[];
}

export interface ConversionContext {
  /** Harness of a new agent profile (script → agent). */
  readonly agentHarness: Harness;
  /** Harness of a new or moved model call; it runs one read-only turn. */
  readonly modelCallHarness: Harness;
}

export interface ConversionPlan {
  readonly nodeId: string;
  readonly from: NodeType;
  readonly to: NodeType;
  /** The exact connections removed with the conversion. */
  readonly removedEdges: readonly GraphEdge[];
  /** Connections and settings the new type cannot keep valid. */
  readonly removals: readonly ConversionNote[];
  /** User data the new type discards. */
  readonly losses: readonly ConversionNote[];
  /** The harness the converted node moves to (its model is chosen again). */
  readonly harness?: Harness;
  /** Anything is removed or discarded: a person confirms first. */
  readonly needsConfirmation: boolean;
}

/** The harnesses a conversion uses, from the native catalog's statuses. */
export function conversionContext(harnesses: readonly { readonly kind: string; readonly status: string }[]): ConversionContext {
  const available = harnesses.filter((item) => item.status === 'available' && item.kind in harnessConfigurations).map((item) => item.kind as Harness);
  const agentHarness = available[0] ?? 'codex';
  const modelCallHarness = harnessConfiguration(agentHarness).oneShot
    ? agentHarness
    : (available.find((kind) => harnessConfiguration(kind).oneShot !== undefined) ?? 'codex');
  return { agentHarness, modelCallHarness };
}

const COLLABORATION: readonly GraphEdge['kind'][] = ['send', 'observe', 'spawn'];

const EDGE_NOTES: Readonly<Record<'send' | 'observe' | 'spawn', readonly [outgoing: string, incoming: string]>> = {
  send: ['Sends messages to {0}', 'Receives messages from {0}'],
  observe: ['Observes {0}', 'Is observed by {0}'],
  spawn: ['May start instances of {0}', 'May be started by {0}'],
};

const filled = (value: string | undefined): boolean => (value ?? '').trim() !== '';

function lineCount(source: string): number {
  return source.trimEnd().split(/\r?\n/u).length;
}

function nodeName(graph: AgentGraph, id: string): string {
  return graph.nodes.find((node) => node.id === id)?.profile.name.trim() || id;
}

/** The harness a model call needs: its own when it can answer read-only, otherwise the context's. */
function modelCallHarnessFor(node: GraphNode, context: ConversionContext): Harness {
  return harnessConfiguration(node.profile.harness).oneShot ? node.profile.harness : context.modelCallHarness;
}

function harnessName(harness: Harness): string {
  // An ACP agent is named by its catalog entry, not by the generic ACP manifest.
  return isBuiltinHarness(harness) ? harnessConfigurations[harness].name : harnessMeta(harness).label;
}

/**
 * What converting `nodeId` to `to` removes and discards; undefined when the
 * node does not exist, is a router or already has that type.
 */
export function planConversion(graph: AgentGraph, nodeId: string, to: NodeType, context: ConversionContext): ConversionPlan | undefined {
  const node = graph.nodes.find((item) => item.id === nodeId);
  const from = node === undefined ? undefined : nodeType(node);
  if (node === undefined || from === undefined || from === to) return undefined;
  const removals: ConversionNote[] = [];
  const losses: ConversionNote[] = [];
  const removedEdges: GraphEdge[] = [];
  const profile = node.profile;
  let harness: Harness | undefined;

  if (to !== 'agent') {
    // Model calls and scripts never collaborate, delegate or wait for a caller.
    for (const edge of graph.edges) {
      if (!COLLABORATION.includes(edge.kind) || (edge.from !== nodeId && edge.to !== nodeId)) continue;
      removedEdges.push(edge);
      const [outgoing, incoming] = EDGE_NOTES[edge.kind as 'send' | 'observe' | 'spawn'];
      removals.push(edge.from === nodeId ? { message: outgoing, params: [nodeName(graph, edge.to)] } : { message: incoming, params: [nodeName(graph, edge.from)] });
    }
    if (node.executionMode === 'callable') {
      removals.push({ message: 'Runs only when another agent calls it; it will run in order instead' });
      if (filled(profile.whenToCall)) losses.push({ message: 'When to call' });
    }
  }

  if (from === 'script') {
    const source = node.executor?.type === 'script' ? node.executor.source : '';
    if (filled(source)) losses.push({ message: 'Script code ({0} lines)', params: [lineCount(source)] });
    harness = to === 'llm' ? context.modelCallHarness : context.agentHarness;
  } else if (to === 'script') {
    if ((node.inputBindings ?? []).length > 0) removals.push({ message: 'Input mappings ({0})', params: [node.inputBindings?.length ?? 0] });
    if (filled(node.task)) losses.push({ message: from === 'llm' ? 'Prompt' : 'Task' });
    if (filled(profile.instructions)) losses.push({ message: 'Role instructions' });
    if (filled(node.input)) losses.push({ message: 'Expected input' });
    if (filled(profile.expectedResult)) losses.push({ message: 'Expected result' });
    if (filled(profile.model)) {
      losses.push({ message: 'Harness and model: {0}', params: [[harnessName(profile.harness), profile.model].join(' · ')] });
    }
    const access = profile.permissionMode !== 'read-only' || profile.networkAccess === true || profile.toolPolicy.rules.length > 0 || (profile.resourceRules ?? []).length > 0;
    if (from === 'agent' && access) losses.push({ message: 'Permissions, tools, skills and MCP settings' });
  } else if (to === 'llm') {
    // agent → model call: the same profile at least authority.
    const target = modelCallHarnessFor(node, context);
    if (target !== profile.harness) {
      harness = target;
      losses.push({ message: 'Harness {0} cannot answer read-only; it becomes {1} and the model is chosen again', params: [harnessName(profile.harness), harnessName(target)] });
    }
    if (profile.permissionMode !== 'read-only') removals.push({ message: 'File access becomes read-only' });
    if (profile.networkAccess === true) removals.push({ message: 'Network access is turned off' });
    if (profile.toolPolicy.rules.length > 0) removals.push({ message: 'Tool rules ({0})', params: [profile.toolPolicy.rules.length] });
    if ((profile.resourceRules ?? []).length > 0) removals.push({ message: 'Skills and MCP settings ({0})', params: [profile.resourceRules?.length ?? 0] });
  }
  // model call → agent keeps everything: an agent may do all a model call does.
  return {
    nodeId,
    from,
    to,
    removedEdges,
    removals,
    losses,
    ...(harness === undefined ? {} : { harness }),
    needsConfirmation: removals.length > 0 || losses.length > 0,
  };
}

type Model = Pick<AgentProfile, 'model' | 'modelProvider'>;

/** A fresh agent profile on `harness` that keeps the node's name. */
function freshProfile(name: string, harness: Harness, model: Model | undefined): AgentProfile {
  const base = profileForHarness(newGraphNode(0).profile, harness);
  return { ...base, id: crypto.randomUUID(), name, ...(model ?? {}) };
}

/** The least authority of a model call's profile (see `llmProfileIssue`). */
function leastAuthority(profile: AgentProfile): AgentProfile {
  const { networkAccess: _network, resourceRules: _resources, whenToCall: _when, ...rest } = profile;
  return { ...rest, permissionMode: 'read-only', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] };
}

function converted(node: GraphNode, plan: ConversionPlan, model: Model | undefined): GraphNode {
  const { executor: _executor, executionMode: _mode, ...kept } = node;
  const name = node.profile.name;
  switch (plan.to) {
    case 'agent':
      return plan.from === 'script' ? { ...kept, task: '', profile: freshProfile(name, plan.harness ?? 'codex', model) } : kept;
    case 'llm': {
      const profile =
        plan.from === 'script'
          ? freshProfile(name, plan.harness ?? 'codex', model)
          : plan.harness === undefined
            ? node.profile
            : { ...profileForHarness(node.profile, plan.harness), ...(model ?? {}) };
      return { ...kept, ...(plan.from === 'script' ? { task: '' } : {}), executor: { type: 'llm' }, profile: leastAuthority(profile) };
    }
    case 'script': {
      const { inputBindings: _bindings, input: _input, ...rest } = kept;
      return {
        ...rest,
        task: '',
        executor: { type: 'script', runtime: 'node', source: '', timeoutSeconds: NEW_SCRIPT_TIMEOUT_SECONDS },
        profile: placeholderProfile(name, 'script'),
      };
    }
    default: {
      const exhaustive: never = plan.to;
      return exhaustive;
    }
  }
}

function sameEdge(left: GraphEdge, right: GraphEdge): boolean {
  return left.from === right.from && left.to === right.to && left.kind === right.kind && (left.branchId ?? '') === (right.branchId ?? '');
}

/**
 * The graph after `plan`. `model` is the native default for a node that gets
 * a new or moved profile (`plan.harness`); without it the model stays empty
 * and the graph check asks for one.
 */
export function applyConversion(graph: AgentGraph, plan: ConversionPlan, model: Model | undefined = undefined): AgentGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === plan.nodeId ? converted(node, plan, model) : node)),
    edges: graph.edges.filter((edge) => !plan.removedEdges.some((removed) => sameEdge(edge, removed))),
  };
}
