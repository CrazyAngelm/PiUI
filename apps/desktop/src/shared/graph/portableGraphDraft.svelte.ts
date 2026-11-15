import type { GraphCreationProfile, GraphDraftPersistence, GraphDraftSnapshot, GraphDraftSummary, GraphEditorDraftState } from '../../../../../contracts/graph-drafts-v1';
import { checkedCreationProfile, cloudProfile } from './cloudCreationProfile';
import type { GraphCanvasController } from '../../app/pipelines/canvas/graphCanvasController';
import { inputNameFrom } from '../../app/pipelines/inputs/runInputs';
import {
  emptyGraph, graphIssues, newGraphNode, type AgentGraph, type ConnectionKind, type GraphIssue, type GraphLayout, type GraphNode,
} from '../../features/orchestration/agentGraph';
import { freeStepPosition, readBlockPositions, resetBlockPositions, withBlockPositions, writeBlockPositions } from '../../features/orchestration/graphBlocks';
import { autoLayout, edgeKey, syncRouterInputs } from '../../features/orchestration/graphCanvasEditing';
import { connectAgents, connectRoute } from '../../features/orchestration/graphConnections';
import { GraphHistory } from '../../features/orchestration/graphHistory';
import { graphToSystemFile, parseSystemFile, serializeSystemFile, systemFileToGraph } from '../../features/orchestration/systemFile';
import { MAX_PIPELINE_OUTPUTS, SUBPIPELINE_ISSUES, type SubpipelineInfo } from '../../host-api/subpipelines';

/** A document editor only: it has no native host, model catalog, execution or network dependency. */
export class PortableGraphDraft implements GraphCanvasController {
  readonly executionLocation = 'cloud-draft';
  graph = $state.raw<AgentGraph>(emptyGraph());
  summaries = $state.raw<GraphDraftSummary[]>([]);
  revision = $state<number | null>(null);
  private selectionId = $state('');
  selectedBlock = $state<'start' | 'output' | undefined>();
  get selectedId(): string { return this.selectionId; }
  set selectedId(value: string) { this.selectionId = value; this.selectedBlock = undefined; }
  selectedEdge = $state('');
  connectKind = $state<ConnectionKind>('result');
  showCollaboration = $state(true);
  busy = $state(false);
  canUndo = $state(false);
  canRedo = $state(false);
  errors = $state.raw<string[]>([]);
  notice = $state('');
  conflict = $state(false);
  saveUncertain = $state(false);
  /** Text in the advanced editor that has not yet passed the portable parser. */
  pendingDocument = $state<string | undefined>();
  issues = $state.raw<GraphIssue[]>([]);
  readonly preflight: readonly unknown[] = [];
  readonly subpipelines: ReadonlyMap<string, SubpipelineInfo> = new Map();
  private baseline = $state(JSON.stringify(this.graph));
  private history = new GraphHistory(this.graph);
  private disposed = false;
  creationProfile = $state.raw<GraphCreationProfile | null>(null);

  constructor(private readonly persistence: GraphDraftPersistence, profile: GraphCreationProfile | null | undefined = undefined) {
    this.creationProfile = checkedCreationProfile(profile);
  }

  draftState(): GraphEditorDraftState { return { id: this.graph.id, revision: this.revision, dirty: this.dirty }; }
  setCreationProfile(profile: GraphCreationProfile | null): void {
    if (!this.disposed) this.creationProfile = checkedCreationProfile(profile);
  }

  get unavailable(): boolean { return this.busy || this.disposed; }
  /** Pending JSON owns editing until explicitly applied or discarded. */
  get readOnly(): boolean { return this.unavailable || this.pendingDocument !== undefined; }
  get canReload(): boolean { return this.revision !== null || this.conflict || this.saveUncertain; }
  get dirty(): boolean { return this.pendingDocument !== undefined || JSON.stringify(this.graph) !== this.baseline; }
  get selected(): GraphNode | undefined { return this.graph.nodes.find(node => node.id === this.selectedId); }

  dispose(): void { this.disposed = true; }

  private accept(graph: AgentGraph, revision: number | null, saved: boolean): void {
    const settled = withBlockPositions(graph);
    this.graph = settled;
    this.revision = revision;
    this.history.reset(settled);
    this.canUndo = this.canRedo = false;
    this.selectedId = this.selectedEdge = '';
    this.conflict = false;
    this.saveUncertain = false;
    this.errors = [];
    this.issues = [];
    this.notice = '';
    this.pendingDocument = undefined;
    this.baseline = saved ? JSON.stringify(settled) : '';
  }

  newDraft(): void {
    if (!this.unavailable) this.accept(emptyGraph(), null, true);
  }

  async refresh(): Promise<void> {
    try {
      const values = await this.persistence.list();
      if (!this.disposed) this.summaries = values;
    } catch {
      if (!this.disposed) this.errors = ['Could not load saved pipelines.'];
    }
  }

  private decode(snapshot: GraphDraftSnapshot, expectedId: string): AgentGraph {
    if (snapshot.contractVersion !== 1 || snapshot.id !== expectedId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
      throw new Error('The saved pipeline has an unsupported contract.');
    }
    // The portable parser rejects unsupported fields; no partial projection is adopted.
    return { ...systemFileToGraph(parseSystemFile(snapshot.document)), id: snapshot.id };
  }

  async open(id: string): Promise<boolean> {
    if (this.unavailable) return false;
    this.busy = true;
    this.errors = [];
    try {
      const snapshot = await this.persistence.load(id);
      if (this.disposed) return false;
      if (snapshot === null) throw new Error('The saved pipeline is no longer available.');
      const graph = this.decode(snapshot, id);
      const blocks = readBlockPositions('portable', id);
      this.accept(blocks ? { ...graph, layout: blocks } : graph, snapshot.revision, true);
      return true;
    } catch (error) {
      if (!this.disposed) this.errors = [error instanceof Error ? error.message : 'Could not load the pipeline.'];
      return false;
    } finally { this.busy = false; }
  }

  /** Import is a new unsaved identity even if the file came from an existing draft. */
  importText(text: string): boolean {
    if (this.unavailable) return false;
    try {
      const graph = systemFileToGraph(parseSystemFile(text));
      this.accept(graph, null, false);
      this.notice = 'Imported as a new draft.';
      return true;
    } catch (error) {
      this.errors = [error instanceof Error ? error.message : 'Could not import the system.'];
      return false;
    }
  }

  /** A full-document edit retains storage identity; parser failure preserves the graph. */
  applyDocument(text: string): boolean {
    if (this.unavailable) return false;
    try {
      const next = systemFileToGraph(parseSystemFile(text));
      this.commit({ ...next, id: this.graph.id, teamId: this.graph.teamId, pipelineId: this.graph.pipelineId, layout: this.graph.layout }, true);
      this.pendingDocument = undefined;
      this.errors = [];
      return true;
    } catch (error) {
      this.errors = [error instanceof Error ? error.message : 'Could not apply the document.'];
      return false;
    }
  }

  documentText(): string { return JSON.stringify(graphToSystemFile(this.graph), null, 2) + '\n'; }
  discardDocument(): void { if (!this.unavailable) this.pendingDocument = undefined; }
  exportText(): string {
    if (this.pendingDocument !== undefined && !this.applyDocument(this.pendingDocument)) {
      throw new Error(this.errors[0] ?? 'Could not validate the pipeline.');
    }
    return serializeSystemFile(this.graph);
  }

  async save(): Promise<boolean> {
    if (this.unavailable) return false;
    if (this.pendingDocument !== undefined && !this.applyDocument(this.pendingDocument)) return false;
    this.errors = [];
    this.notice = '';
    this.issues = graphIssues(this.graph);
    let document: string;
    try { document = this.exportText(); }
    catch (error) {
      this.errors = [error instanceof Error ? error.message : 'Could not validate the pipeline.'];
      return false;
    }
    const request = { contractVersion: 1 as const, id: this.graph.id, expectedRevision: this.revision, document };
    this.busy = true;
    try {
      const result = await this.persistence.save(request);
      if (this.disposed) return false;
      if (result.kind === 'conflict') {
        this.conflict = true;
        this.errors = [];
        return false;
      }
      if (result.kind === 'rejected') {
        this.errors = [result.message];
        return false;
      }
      const saved = this.decode(result.snapshot, request.id);
      if (serializeSystemFile(saved) !== document) throw new Error('The server returned a different pipeline. The local draft was kept.');
      this.revision = result.snapshot.revision;
      this.baseline = JSON.stringify(this.graph);
      writeBlockPositions('portable', this.graph);
      this.conflict = false;
      this.saveUncertain = false;
      this.notice = 'Pipeline saved.';
      await this.refresh();
      return true;
    } catch {
      if (!this.disposed) { this.saveUncertain = true; this.errors = ['Could not confirm the save. Your draft is still open.']; }
      return false;
    } finally { this.busy = false; }
  }

  /** A conflict never changes expectedRevision; Save as new explicitly forks storage identity. */
  saveAsNew(): boolean {
    if (this.unavailable) return false;
    if (this.pendingDocument !== undefined && !this.applyDocument(this.pendingDocument)) return false;
    this.accept({ ...this.graph, id: crypto.randomUUID() }, null, false);
    return true;
  }

  private commit(next: AgentGraph, fromDocument = false): void {
    if (this.unavailable || (!fromDocument && this.pendingDocument !== undefined)) return;
    this.graph = withBlockPositions(syncRouterInputs(next));
    this.history.record(this.graph);
    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;
    this.notice = '';
    this.issues = graphIssues(this.graph);
  }

  rename(name: string): void { this.commit({ ...this.graph, name }); }
  updateNode(id: string, change: Partial<GraphNode>): void {
    this.commit({ ...this.graph, nodes: this.graph.nodes.map(node => node.id === id ? { ...node, ...change } : node) });
  }
  addAgent(position: { x: number; y: number }): void {
    if (this.readOnly) return;
    const node = newGraphNode(this.graph.nodes.length);
    if (this.creationProfile) node.profile = cloudProfile(node.profile, this.creationProfile);
    Object.assign(node, freeStepPosition(this.graph, { x: Math.max(0, Math.round(position.x)), y: Math.max(0, Math.round(position.y)) }));
    this.commit({ ...this.graph, nodes: [...this.graph.nodes, node] });
    this.selectedId = node.id;
  }
  nodeProblems(id: string): GraphIssue[] { return this.issues.filter(issue => issue.nodeIds.includes(id)); }
  connect(source: string, target: string, sourceHandle: string | null | undefined): string | undefined {
    if (this.readOnly) return undefined;
    const branch = sourceHandle?.startsWith('branch:') ? sourceHandle.slice('branch:'.length) : undefined;
    const result = branch ? connectRoute(this.graph, source, target, branch) : connectAgents(this.graph, source, target, this.connectKind, 'forward');
    if (result.error) return result.error;
    this.commit({ ...this.graph, edges: result.edges });
    return undefined;
  }
  connectOutput(source: string): string | undefined {
    if (this.readOnly) return undefined;
    if (this.connectKind !== 'result') return 'Only result connections can connect to Output.';
    const node = this.graph.nodes.find(item => item.id === source);
    if (!node) return 'Choose a source step for Output.';
    if (node.kind === 'router') return 'A router exposes branch routes, not a result output.';
    if (node.executionMode === 'callable') return 'Callable agents exchange results through their caller, not pipeline dependencies.';
    const outputs = this.graph.outputs ?? [];
    if (outputs.some(output => output.sourceStepId === source)) return undefined;
    if (outputs.length >= MAX_PIPELINE_OUTPUTS) return SUBPIPELINE_ISSUES.outputs;
    const name = inputNameFrom('result', new Set(outputs.map(output => output.name)));
    this.commit({ ...this.graph, outputs: [...outputs, { name, kind: 'text', sourceStepId: source }] });
    return undefined;
  }
  removeSelection(nodeIds: readonly string[], edgeKeys: readonly string[], outputSources: readonly string[] = []): void {
    if (!nodeIds.length && !edgeKeys.length && !outputSources.length) return;
    const nodes = new Set(nodeIds), edges = new Set(edgeKeys), sources = new Set(outputSources);
    const outputs = (this.graph.outputs ?? []).filter(output => !sources.has(output.sourceStepId));
    this.commit({
      ...this.graph,
      nodes: this.graph.nodes.filter(node => !nodes.has(node.id)),
      edges: this.graph.edges.filter(edge => !nodes.has(edge.from) && !nodes.has(edge.to) && !edges.has(edgeKey(edge))),
      ...(sources.size ? { outputs: outputs.length ? outputs : undefined } : {}),
    });
    if (nodes.has(this.selectedId)) this.selectedId = '';
    if (edges.has(this.selectedEdge)) this.selectedEdge = '';
  }
  movedNodes(moves: readonly { id: string; x: number; y: number }[], blocks: Partial<GraphLayout> | undefined = undefined): void {
    const byId = new Map(moves.map(move => [move.id, move]));
    let changed = false;
    const nodes = this.graph.nodes.map(node => {
      const move = byId.get(node.id);
      if (!move) return node;
      const x = Math.max(0, Math.round(move.x)), y = Math.max(0, Math.round(move.y));
      if (x === node.x && y === node.y) return node;
      changed = true;
      return { ...node, x, y };
    });
    const current = this.graph.layout;
    let layout = current;
    if (current && blocks) {
      const round = (place: { x: number; y: number }) => ({ x: Math.round(place.x), y: Math.round(place.y) });
      const start = blocks.start ? round(blocks.start) : current.start;
      const output = blocks.output ? round(blocks.output) : current.output;
      if (start.x !== current.start.x || start.y !== current.start.y || output.x !== current.output.x || output.y !== current.output.y) {
        layout = { start, output };
        changed = true;
      }
    }
    if (changed) this.commit({ ...this.graph, nodes, layout });
  }
  arrange(heights: ReadonlyMap<string, number>): void { this.commit(resetBlockPositions(autoLayout(this.graph, heights))); }
  undo(): void {
    if (this.readOnly) return;
    const next = this.history.undo();
    if (next) this.graph = next;
    this.canUndo = this.history.canUndo; this.canRedo = this.history.canRedo;
    this.issues = graphIssues(this.graph);
  }
  redo(): void {
    if (this.readOnly) return;
    const next = this.history.redo();
    if (next) this.graph = next;
    this.canUndo = this.history.canUndo; this.canRedo = this.history.canRedo;
    this.issues = graphIssues(this.graph);
  }
}
