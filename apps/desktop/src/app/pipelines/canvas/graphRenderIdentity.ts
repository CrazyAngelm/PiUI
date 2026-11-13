/** Presentation nodes never reserve an identifier in a user's portable graph. */
export function presentationNodeIds(ids: readonly string[]): { start: string; output: string } {
  const used = new Set(ids);
  const allocate = (preferred: string): string => {
    let value = preferred;
    while (used.has(value)) value += ':';
    used.add(value);
    return value;
  };
  return { start: allocate('__start'), output: allocate('__output') };
}
export function presentationEdgeId(kind: 'start' | 'output', nodeId: string): string {
  return JSON.stringify(['presentation', kind, nodeId]);
}
export function isPresentationEdge(id: string): boolean {
  try {
    const value: unknown = JSON.parse(id);
    return Array.isArray(value) && value.length === 3 && value[0] === 'presentation' && (value[1] === 'start' || value[1] === 'output') && typeof value[2] === 'string';
  } catch { return false; }
}
