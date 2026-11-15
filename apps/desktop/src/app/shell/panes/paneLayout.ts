/** The pure model of the chat area: a binary tree of panes, at most four leaves. */
export type SplitDirection = 'row' | 'column';
export type PaneEdge = 'left' | 'right' | 'top' | 'bottom';
export interface PaneLeaf {
  readonly kind: 'pane';
  readonly id: string;
  readonly sessionId: string;
}
export interface PaneSplit {
  readonly kind: 'split';
  readonly direction: SplitDirection;
  readonly ratio: number;
  readonly first: PaneNode;
  readonly second: PaneNode;
}
export type PaneNode = PaneLeaf | PaneSplit;
export type SplitPath = readonly ('first' | 'second')[];

export const MAX_PANES = 4;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

const clampRatio = (ratio: number): number => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

/** The panes in reading order (left to right, top to bottom). */
export function panes(node: PaneNode | undefined): PaneLeaf[] {
  if (!node) return [];
  return node.kind === 'pane' ? [node] : [...panes(node.first), ...panes(node.second)];
}

export function paneOf(node: PaneNode | undefined, sessionId: string): PaneLeaf | undefined {
  return panes(node).find((leaf) => leaf.sessionId === sessionId);
}

export function withSession(node: PaneNode, paneId: string, sessionId: string): PaneNode {
  if (node.kind === 'pane') return node.id === paneId ? { ...node, sessionId } : node;
  const first = withSession(node.first, paneId, sessionId);
  const second = withSession(node.second, paneId, sessionId);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/**
 * A new pane on `edge` of `paneId`. Undefined when four panes exist, the pane is
 * unknown or the chat is already shown. left/right split in a row, top/bottom in a
 * column; left and top put the new pane first.
 */
export function splitPane(node: PaneNode, paneId: string, edge: PaneEdge, sessionId: string, newPaneId: string): PaneNode | undefined {
  const all = panes(node);
  if (all.length >= MAX_PANES || !all.some((leaf) => leaf.id === paneId)) return undefined;
  if (all.some((leaf) => leaf.sessionId === sessionId || leaf.id === newPaneId)) return undefined;
  const fresh: PaneLeaf = { kind: 'pane', id: newPaneId, sessionId };
  const direction: SplitDirection = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const newFirst = edge === 'left' || edge === 'top';
  const replace = (current: PaneNode): PaneNode => {
    if (current.kind === 'pane') {
      if (current.id !== paneId) return current;
      return { kind: 'split', direction, ratio: 0.5, first: newFirst ? fresh : current, second: newFirst ? current : fresh };
    }
    return { ...current, first: replace(current.first), second: replace(current.second) };
  };
  return replace(node);
}

/** The sibling takes the parent's place. Undefined when it was the only pane. */
export function closePane(node: PaneNode, paneId: string): PaneNode | undefined {
  if (node.kind === 'pane') return node.id === paneId ? undefined : node;
  const first = closePane(node.first, paneId);
  const second = closePane(node.second, paneId);
  if (first === undefined) return second;
  if (second === undefined) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Sets the ratio of the split at `path` (empty: the root), clamped. A path that is not a split changes nothing. */
export function resizeSplit(node: PaneNode, path: SplitPath, ratio: number): PaneNode {
  if (node.kind === 'pane' || !Number.isFinite(ratio)) return node;
  const [head, ...rest] = path;
  if (head === undefined) return { ...node, ratio: clampRatio(ratio) };
  const child = resizeSplit(node[head], rest, ratio);
  return child === node[head] ? node : { ...node, [head]: child };
}

function parseNode(value: unknown, ids: Set<string>, chats: Set<string>, depth: number): PaneNode | undefined {
  if (typeof value !== 'object' || value === null || depth > MAX_PANES) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'pane') {
    const { id, sessionId } = record;
    if (typeof id !== 'string' || typeof sessionId !== 'string' || id === '' || sessionId === '') return undefined;
    if (ids.has(id) || chats.has(sessionId)) return undefined;
    ids.add(id);
    chats.add(sessionId);
    return { kind: 'pane', id, sessionId };
  }
  if (record.kind !== 'split') return undefined;
  const { direction, ratio } = record;
  if ((direction !== 'row' && direction !== 'column') || typeof ratio !== 'number' || !Number.isFinite(ratio)) return undefined;
  const first = parseNode(record.first, ids, chats, depth + 1);
  const second = first && parseNode(record.second, ids, chats, depth + 1);
  if (!first || !second) return undefined;
  return { kind: 'split', direction, ratio: clampRatio(ratio), first, second };
}

/** Strict validation of a persisted value: shape, at most four panes, unique pane ids and chat ids, finite ratio (clamped). Anything else: undefined. */
export function parseLayout(value: unknown): PaneNode | undefined {
  const node = parseNode(value, new Set(), new Set(), 0);
  return node && panes(node).length <= MAX_PANES ? node : undefined;
}
