/**
 * State and actions for the pipeline editor. The canvas edits the existing
 * agent-graph model (agent and router nodes; result, route, message,
 * observation and delegation edges) and keeps every validation rule of the
 * previous editor: connection checks, structural issues, native catalog
 * preflight and the host's atomic save.
 */
import dagre from '@dagrejs/dagre';
import { harnessModels } from '../../host-api/harnessModels';
import {
  orchestrationError,
  orchestrationHost,
  type AgentProfile,
  type DefinitionSummary,
  type OrchestrationClient,
  type OrchestrationRunV6,
  type PipelineInput,
  type RunInputValue,
} from '../../host-api/orchestrationClient';
import type { HarnessModelsResult } from '../../../../../contracts/harness-models-v18';
import {
  emptyGraph,
  graphIssues,
  newGraphNode,
  newLlmNode,
  newRouterNode,
  newScriptNode,
  type AgentGraph,
  type ConnectionKind,
  type GraphIssue,
  type GraphNode,
} from '../../features/orchestration/agentGraph';
import { connectAgents, connectRoute } from '../../features/orchestration/graphConnections';
import { preflightGraph, type PreflightIssue } from '../../features/orchestration/graphPreflight';
import { GraphHistory, duplicateNode } from '../../features/orchestration/graphHistory';
import { graphNodeHeight } from '../../features/orchestration/graphLayout';
import { performRunAction } from '../../features/orchestration/runActions';
import { GraphDocumentError, openGraph, saveGraph, type Revisions } from './graphDocument';
import { applyConversion, planConversion, type ConversionContext, type NodeType } from './nodeConversion';
import { ScriptTests } from './scriptTests.svelte';
import { scriptTestHost, type ScriptTestClient } from '../../host-api/scriptTestClient';

export type EditorOperation = 'open' | 'save' | 'check' | 'import' | 'run';
export const NODE_WIDTH = 248;

function message(error: unknown): string {
  if (error instanceof GraphDocumentError) return error.message;
  if (error instanceof Error && !('code' in error)) return error.message;
  return orchestrationError(error).message;
}

function syncRouterInputs(graph: AgentGraph): AgentGraph {
  const nodes = graph.nodes.map((node) => {
    if (node.kind !== 'router' || !node.router) return node;
    const inputStepId = graph.edges.find((edge) => edge.kind === 'result' && edge.to === node.id)?.from ?? '';
    return node.router.inputStepId === inputStepId ? node : { ...node, router: { ...node.router, inputStepId } };
  });
  return { ...graph, nodes };
}

export function edgeKey(edge: { from: string; to: string; kind: ConnectionKind; branchId?: string }): string {
  return `${edge.from}:${edge.to}:${edge.kind}:${edge.branchId ?? ''}`;
}

/** Dagre layout of result and route edges, left to right; returns a new graph. */
export function autoLayout(graph: AgentGraph, heights: ReadonlyMap<string, number> = new Map()): AgentGraph {
  if (!graph.nodes.length) return graph;
  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 96, marginx: 40, marginy: 40 });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) {
    layout.setNode(node.id, { width: NODE_WIDTH, height: heights.get(node.id) ?? graphNodeHeight(node) });
  }
  for (const edge of graph.edges) {
    if (edge.kind === 'result' || edge.kind === 'route' || edge.kind === 'spawn') layout.setEdge(edge.from, edge.to);
  }
  dagre.layout(layout);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const placed = layout.node(node.id);
      return placed ? { ...node, x: Math.round(placed.x - NODE_WIDTH / 2), y: Math.round(placed.y - placed.height / 2) } : node;
    }),
  };
}

export class PipelineEditorStore {
  graph = $state.raw<AgentGraph>(emptyGraph());
  baseline = $state(JSON.stringify(this.graph));
  systems = $state.raw<readonly DefinitionSummary[]>([]);
  profiles = $state.raw<readonly DefinitionSummary[]>([]);
  selectedId = $state('');
  selectedEdge = $state('');
  busy = $state(false);
  operation = $state<EditorOperation | undefined>();
  errors = $state.raw<string[]>([]);
  issues = $state.raw<GraphIssue[]>([]);
  preflight = $state.raw<PreflightIssue[]>([]);
  checkedNotice = $state('');
  checkedStamp = $state('');
  canUndo = $state(false);
  canRedo = $state(false);
  connectKind = $state<ConnectionKind>('result');
  showCollaboration = $state(true);
  catalogs = $state.raw<Partial<Record<AgentProfile['harness'], HarnessModelsResult>>>({});
  catalogErrors = $state.raw<Partial<Record<AgentProfile['harness'], string>>>({});
  /** A navigation that waits for "save / discard / keep editing". */
  pending = $state<(() => void | Promise<void>) | undefined>();
  lastRun = $state.raw<OrchestrationRunV6 | undefined>();

  private revisions: Revisions = new Map();
  private history = new GraphHistory(this.graph);
  private pendingRunId: string | undefined;
  private validationShown = false;

  /** Script tests of this editor session: samples and last results per node. */
  readonly scriptTests: ScriptTests;

  constructor(
    readonly workspaceId: string,
    readonly safeMode: boolean,
    private readonly client: OrchestrationClient = orchestrationHost,
    scriptTestClient: ScriptTestClient = scriptTestHost,
  ) {
    this.scriptTests = new ScriptTests(workspaceId, scriptTestClient);
  }

  get dirty(): boolean {
    return JSON.stringify(this.graph) !== this.baseline;
  }

  get selected(): GraphNode | undefined {
    return this.graph.nodes.find((node) => node.id === this.selectedId);
  }

  get stale(): boolean {
    return this.checkedStamp !== '' && this.checkedStamp !== JSON.stringify(this.graph);
  }

  get readOnly(): boolean {
    return this.safeMode || this.busy;
  }

  // ---- document ------------------------------------------------------------

  async refresh(): Promise<void> {
    try {
      const catalog = await this.client.orchestration_catalog_v6({ workspaceId: this.workspaceId });
      this.systems = catalog.launchCommands;
      this.profiles = catalog.profiles;
    } catch (error) {
      this.errors = [message(error)];
    }
  }

  /** Runs `action` now, or asks first when the draft has unsaved changes. */
  guard(action: () => void | Promise<void>): void {
    if (this.dirty) this.pending = action;
    else void action();
  }

  async resolvePending(choice: 'save' | 'discard' | 'keep'): Promise<void> {
    const action = this.pending;
    if (choice === 'keep') {
      this.pending = undefined;
      return;
    }
    if (choice === 'save' && !(await this.save())) return;
    this.pending = undefined;
    await action?.();
  }

  private load(graph: AgentGraph, revisions: Revisions): void {
    this.graph = graph;
    this.baseline = JSON.stringify(graph);
    this.revisions = revisions;
    this.history.reset(graph);
    this.canUndo = false;
    this.canRedo = false;
    this.selectedId = '';
    this.selectedEdge = '';
    this.errors = [];
    this.issues = [];
    this.preflight = [];
    this.checkedNotice = '';
    this.checkedStamp = '';
    this.validationShown = false;
    this.pendingRunId = undefined;
  }

  newGraph(): void {
    this.guard(() => this.load(emptyGraph(), new Map()));
  }

  /** Starts an unsaved draft from a template graph. */
  startFrom(graph: AgentGraph): void {
    this.guard(() => {
      this.load(graph, new Map());
      // A template is a draft until saved.
      this.baseline = '';
    });
  }

  open(id: string): void {
    this.guard(async () => {
      this.busy = true;
      this.operation = 'open';
      try {
        const opened = await openGraph(this.client, this.workspaceId, id);
        // Lay out graphs that have no canvas positions yet, before the baseline,
        // so opening one never reports unsaved changes.
        this.load(opened.needsLayout ? autoLayout(opened.graph) : opened.graph, opened.revisions);
      } catch (error) {
        this.errors = [message(error)];
      } finally {
        this.busy = false;
        this.operation = undefined;
      }
    });
  }

  importText(text: string): void {
    this.guard(async () => {
      this.busy = true;
      this.operation = 'import';
      try {
        const { parseSystemFile, systemFileToGraph } = await import('../../features/orchestration/systemFile');
        this.load(systemFileToGraph(parseSystemFile(text)), new Map());
        this.checkedNotice = 'Imported as a new system. Save to keep it.';
      } catch (error) {
        this.errors = [error instanceof Error ? error.message : 'Could not import the system.'];
      } finally {
        this.busy = false;
        this.operation = undefined;
      }
    });
  }

  async exportText(): Promise<string> {
    const { serializeSystemFile } = await import('../../features/orchestration/systemFile');
    return serializeSystemFile(this.graph);
  }

  // ---- editing -------------------------------------------------------------

  /** Replace the graph and record one undo step. */
  private commit(next: AgentGraph): void {
    this.graph = syncRouterInputs(next);
    this.history.record(this.graph);
    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;
    if (this.validationShown) this.issues = graphIssues(this.graph);
  }

  /** Adopt a whole new version of the draft (e.g. the assistant's) as one undo step. */
  replaceGraph(next: AgentGraph): void {
    if (this.readOnly) return;
    this.history.record(this.graph);
    this.selectedId = '';
    this.selectedEdge = '';
    this.checkedNotice = '';
    this.commit(next);
  }

  /** Text edits update the graph live; `settle` records them as one step. */
  setLive(next: AgentGraph): void {
    this.graph = next;
  }

  settle(): void {
    this.history.record(this.graph);
    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;
  }

  undo(): void {
    if (this.readOnly) return;
    this.history.record(this.graph);
    const next = this.history.undo();
    if (!next) return;
    this.graph = next;
    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;
    if (!next.nodes.some((node) => node.id === this.selectedId)) this.selectedId = '';
  }

  redo(): void {
    if (this.readOnly) return;
    const next = this.history.redo();
    if (!next) return;
    this.graph = next;
    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;
  }

  rename(name: string): void {
    this.setLive({ ...this.graph, name });
  }

  updateNode(id: string, change: Partial<GraphNode>, live = false): void {
    const next = { ...this.graph, nodes: this.graph.nodes.map((node) => (node.id === id ? { ...node, ...change } : node)) };
    if (live) this.setLive(next);
    else this.commit(next);
  }

  updateProfile(id: string, change: Partial<AgentProfile>, live = false): void {
    const node = this.graph.nodes.find((item) => item.id === id);
    if (node) this.updateNode(id, { profile: { ...node.profile, ...change } }, live);
  }

  addNode(kind: 'agent' | 'router' | 'llm' | 'script', position: { x: number; y: number }): string {
    const index = this.graph.nodes.length;
    const node =
      kind === 'router' ? newRouterNode(index) : kind === 'llm' ? newLlmNode(index) : kind === 'script' ? newScriptNode(index) : newGraphNode(index);
    node.x = Math.round(position.x);
    node.y = Math.round(position.y);
    this.commit({ ...this.graph, nodes: [...this.graph.nodes, node] });
    this.selectedId = node.id;
    return node.id;
  }

  addFromProfile(profile: AgentProfile, position: { x: number; y: number }): string {
    const node = newGraphNode(this.graph.nodes.length);
    node.profile = { ...structuredClone(profile), id: crypto.randomUUID(), allowedSpawnProfileIds: [] };
    node.x = Math.round(position.x);
    node.y = Math.round(position.y);
    this.commit({ ...this.graph, nodes: [...this.graph.nodes, node] });
    this.selectedId = node.id;
    return node.id;
  }

  /**
   * Changes a node's type (agent, model call or script) as one undo step and
   * re-runs the graph checks. The node keeps its id, name, position and every
   * connection and setting the new type can keep (see `nodeConversion.ts`);
   * `model` is the native default for a new or moved profile. Returns false
   * when nothing changed.
   */
  convertNode(id: string, to: NodeType, context: ConversionContext, model: Pick<AgentProfile, 'model' | 'modelProvider'> | undefined = undefined): boolean {
    if (this.readOnly) return false;
    const plan = planConversion(this.graph, id, to, context);
    if (plan === undefined) return false;
    // A test of the old script stops with it; undo brings the code back, not the run.
    if (plan.from === 'script') this.scriptTests.forget(id);
    this.commit(applyConversion(this.graph, plan, model));
    if (plan.removedEdges.some((edge) => edgeKey(edge) === this.selectedEdge)) this.selectedEdge = '';
    this.checkedNotice = '';
    // Native preflight described the old type; the structural checks run again now.
    this.preflight = this.preflight.filter((issue) => issue.nodeId !== id);
    this.validationShown = true;
    this.issues = graphIssues(this.graph);
    return true;
  }

  /** The first model of a harness's native catalog, so a new profile can run at once. */
  async defaultModel(harness: AgentProfile['harness']): Promise<Pick<AgentProfile, 'model' | 'modelProvider'> | undefined> {
    if (!this.catalogs[harness]) await this.loadCatalog(harness);
    const model = this.catalogs[harness]?.models[0];
    return model ? { model: model.id, ...(model.provider ? { modelProvider: model.provider } : {}) } : undefined;
  }

  duplicate(id: string, name: string): void {
    const source = this.graph.nodes.find((node) => node.id === id);
    if (!source) return;
    const copy = duplicateNode(source, name);
    this.commit({ ...this.graph, nodes: [...this.graph.nodes, copy] });
    this.selectedId = copy.id;
  }

  removeNodes(ids: readonly string[]): void {
    if (!ids.length) return;
    const drop = new Set(ids);
    this.commit({
      ...this.graph,
      nodes: this.graph.nodes.filter((node) => !drop.has(node.id)),
      edges: this.graph.edges.filter((edge) => !drop.has(edge.from) && !drop.has(edge.to)),
    });
    if (drop.has(this.selectedId)) this.selectedId = '';
  }

  removeEdges(keys: readonly string[]): void {
    this.removeSelection([], keys);
  }

  /** Deletes nodes (with their connections) and edges as one undo step. */
  removeSelection(nodeIds: readonly string[], edgeKeys: readonly string[]): void {
    if (this.readOnly || (!nodeIds.length && !edgeKeys.length)) return;
    const nodes = new Set(nodeIds);
    const edges = new Set(edgeKeys);
    this.commit({
      ...this.graph,
      nodes: this.graph.nodes.filter((node) => !nodes.has(node.id)),
      edges: this.graph.edges.filter((edge) => !edges.has(edgeKey(edge)) && !nodes.has(edge.from) && !nodes.has(edge.to)),
    });
    if (nodes.has(this.selectedId)) this.selectedId = '';
    if (edges.has(this.selectedEdge)) this.selectedEdge = '';
  }

  /** Returns an error message when the connection is not allowed. */
  connect(source: string, target: string, sourceHandle: string | null | undefined): string | undefined {
    if (this.readOnly) return undefined;
    const branchId = sourceHandle?.startsWith('branch:') ? sourceHandle.slice('branch:'.length) : undefined;
    const result = branchId
      ? connectRoute(this.graph, source, target, branchId)
      : connectAgents(this.graph, source, target, this.connectKind, 'forward');
    if (result.error) return result.error;
    this.commit({ ...this.graph, edges: result.edges });
    return undefined;
  }

  hasEdge(from: string, to: string, kind: ConnectionKind): boolean {
    return this.graph.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind);
  }

  /** Adds or removes one directed permission edge; returns an error when refused. */
  toggleEdge(from: string, to: string, kind: ConnectionKind): string | undefined {
    if (this.readOnly) return undefined;
    if (this.hasEdge(from, to, kind)) {
      this.removeSelection([], [edgeKey({ from, to, kind })]);
      return undefined;
    }
    const result = connectAgents(this.graph, from, to, kind, 'forward');
    if (result.error) return result.error;
    this.commit({ ...this.graph, edges: result.edges });
    return undefined;
  }

  movedNodes(positions: readonly { id: string; x: number; y: number }[]): void {
    const byId = new Map(positions.map((position) => [position.id, position]));
    let changed = false;
    const nodes = this.graph.nodes.map((node) => {
      const position = byId.get(node.id);
      if (!position) return node;
      const x = Math.round(position.x);
      const y = Math.round(position.y);
      if (x === node.x && y === node.y) return node;
      changed = true;
      return { ...node, x, y };
    });
    if (changed) this.commit({ ...this.graph, nodes });
  }

  /** Layered left-to-right layout over result and route edges. */
  arrange(heights: ReadonlyMap<string, number> = new Map()): void {
    if (!this.graph.nodes.length) return;
    this.commit(autoLayout(this.graph, heights));
  }

  /** Declared run inputs (asked for when the pipeline starts). */
  setInputs(inputs: PipelineInput[], live = false): void {
    const next = { ...this.graph, inputs: inputs.length ? inputs : undefined };
    if (live) this.setLive(next);
    else this.commit(next);
  }

  // ---- catalogs ------------------------------------------------------------

  async loadCatalog(harness: AgentProfile['harness'], refresh = false): Promise<void> {
    if (this.safeMode) return;
    try {
      const result = await harnessModels({ workspaceId: this.workspaceId, harness }, refresh);
      this.catalogs = { ...this.catalogs, [harness]: result };
      const { [harness]: _error, ...rest } = this.catalogErrors;
      this.catalogErrors = rest;
    } catch (error) {
      this.catalogErrors = { ...this.catalogErrors, [harness]: error instanceof Error ? error.message : 'Could not load models.' };
    }
  }

  // ---- check, save, run -------------------------------------------------------

  async check(): Promise<boolean> {
    this.validationShown = true;
    this.errors = [];
    this.checkedNotice = '';
    this.checkedStamp = JSON.stringify(this.graph);
    this.issues = graphIssues(this.graph);
    this.preflight = [];
    if (this.issues.length) return false;
    this.preflight = await preflightGraph(this.graph, (harness) => harnessModels({ workspaceId: this.workspaceId, harness }, true));
    if (!this.preflight.length) this.checkedNotice = 'The pipeline and native settings are valid. The host checks permissions again at launch.';
    return this.preflight.length === 0;
  }

  async runCheck(): Promise<void> {
    if (this.readOnly) return;
    this.busy = true;
    this.operation = 'check';
    try {
      await this.check();
    } finally {
      this.busy = false;
      this.operation = undefined;
    }
  }

  async save(run = false, inputs: Readonly<Record<string, RunInputValue>> | undefined = undefined): Promise<boolean> {
    if (this.readOnly) return false;
    this.validationShown = true;
    this.errors = [];
    this.issues = graphIssues(this.graph);
    if (this.issues.length) return false;
    this.busy = true;
    this.operation = run ? 'run' : 'save';
    try {
      if (run && !(await this.check())) return false;
      this.revisions = await saveGraph(this.client, this.workspaceId, this.graph, this.revisions);
      this.baseline = JSON.stringify(this.graph);
      await this.refresh();
      if (run) {
        this.pendingRunId ??= crypto.randomUUID();
        const outcome = await performRunAction(
          this.client,
          {
            type: 'start',
            request: {
              workspaceId: this.workspaceId,
              runId: this.pendingRunId,
              teamId: this.graph.teamId,
              pipelineId: this.graph.pipelineId,
              launchCommandId: this.graph.id,
              ...(inputs && Object.keys(inputs).length ? { inputs } : {}),
            },
          },
          this.safeMode,
        );
        if (outcome.type === 'unconfirmed') {
          this.errors = [outcome.error.message];
          return false;
        }
        this.pendingRunId = undefined;
        this.lastRun = outcome.run;
      }
      return true;
    } catch (error) {
      this.errors = [message(error)];
      return false;
    } finally {
      this.busy = false;
      this.operation = undefined;
    }
  }

  problemCount(): number {
    return this.issues.length + this.preflight.length;
  }

  /**
   * Issue text for people: validators name agents by their stable id, which
   * means nothing on screen. Localizes first, then shows agent names instead.
   */
  describeIssue(message: string, translate: (value: string) => string = (value) => value): string {
    const colon = message.indexOf(': ');
    const head = colon > 0 ? message.slice(0, colon) : '';
    const node = head ? this.graph.nodes.find((item) => item.id === head) : undefined;
    if (!node) return translate(message);
    return `${node.profile.name || head}: ${translate(message.slice(colon + 2))}`;
  }

  nodeProblems(id: string): string[] {
    return [
      ...this.issues.filter((issue) => issue.nodeIds.includes(id)).map((issue) => issue.message),
      ...this.preflight.filter((issue) => issue.nodeId === id).map((issue) => issue.message),
    ];
  }
}
