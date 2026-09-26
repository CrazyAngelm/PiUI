import type { AgentGraph, GraphNode } from './agentGraph';

/** UI-only document history. Gestures and text edits are committed by the editor. */
export class GraphHistory {
  private past: string[] = [];
  private future: string[] = [];
  private current: string;
  constructor(graph: AgentGraph) { this.current = JSON.stringify(graph); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  record(graph: AgentGraph): void {
    const value = JSON.stringify(graph);
    if (value === this.current) return;
    this.past.push(this.current); this.current = value; this.future = [];
  }
  reset(graph: AgentGraph): void { this.past = []; this.future = []; this.current = JSON.stringify(graph); }
  undo(): AgentGraph | undefined {
    const previous = this.past.pop();
    if (previous === undefined) return;
    this.future.push(this.current); this.current = previous;
    return JSON.parse(previous) as AgentGraph;
  }
  redo(): AgentGraph | undefined {
    const next = this.future.pop();
    if (next === undefined) return;
    this.past.push(this.current); this.current = next;
    return JSON.parse(next) as AgentGraph;
  }
}

/** Copies configuration, never grants the copy authority to spawn other profiles. */
export function duplicateNode(source: GraphNode, name: string): GraphNode {
  const copy = structuredClone(source);
  copy.id = crypto.randomUUID();
  copy.profile = {...copy.profile,id:crypto.randomUUID(),name,allowedSpawnProfileIds:[]};
  copy.x += 40; copy.y += 40;
  copy.condition = undefined; copy.inputBindings = undefined; copy.review = undefined;
  // A copy has produced no output: pinned data stays with the original.
  delete copy.pinnedOutput;
  if (copy.router) copy.router = { ...copy.router, inputStepId: '', branches: copy.router.branches.map(branch => ({ ...branch, id: crypto.randomUUID() })) };
  return copy;
}
