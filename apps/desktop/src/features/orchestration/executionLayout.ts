/** Dependency levels keep parallel work together. Definitions are validated DAGs;
 * unresolved legacy nodes still render without recursive traversal. */
export function executionLayout(steps: readonly { id: string; dependencyStepIds: readonly string[] }[]): { id: string; x: number; y: number }[] {
  const levels = new Map<string, number>();
  let pending = [...steps];
  while (pending.length) {
    const ready = pending.filter(step => step.dependencyStepIds.every(id => levels.has(id)));
    if (!ready.length) break;
    for (const step of ready) levels.set(step.id, Math.max(-1, ...step.dependencyStepIds.map(id => levels.get(id)!)) + 1);
    pending = pending.filter(step => !levels.has(step.id));
  }
  const rows = new Map<number, number>();
  return steps.map(step => {
    const level = levels.get(step.id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return { id: step.id, x: 40 + level * 300, y: 40 + row * 180 };
  });
}
