import type { AgentGraph, ConnectionKind, GraphIssue } from '../../../features/orchestration/agentGraph';
import type { SubpipelineInfo } from '../../../host-api/subpipelines';

/** Presentation port shared by the desktop editor and the authenticated web island. */
export interface GraphCanvasController {
  readonly executionLocation?: 'this-computer' | 'cloud-draft';
  readonly graph: AgentGraph;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly issues: readonly GraphIssue[];
  readonly preflight: readonly unknown[];
  selectedId: string;
  selectedBlock: 'start' | 'output' | undefined;
  selectedEdge: string;
  connectKind: ConnectionKind;
  showCollaboration: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly subpipelines: ReadonlyMap<string, SubpipelineInfo>;
  nodeProblems(id: string): readonly unknown[];
  connect(source: string, target: string, sourceHandle: string | null | undefined): string | undefined;
  connectOutput(source: string): string | undefined;
  removeSelection(nodeIds: readonly string[], edgeKeys: readonly string[]): void;
  movedNodes(moves: readonly { id: string; x: number; y: number }[]): void;
  arrange(heights: ReadonlyMap<string, number>): void;
  undo(): void;
  redo(): void;
  open(id: string): void | Promise<unknown>;
}
