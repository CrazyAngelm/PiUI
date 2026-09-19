import type { WorkspaceModel } from '../../../../../contracts/workspace-v15';
export function selectedRuntimeModel(models: WorkspaceModel[], current: WorkspaceModel | null | undefined): WorkspaceModel | undefined {
  return models.find(model => model.id === current?.id && model.provider === current?.provider) ?? current ?? undefined;
}
export function effortName(level: string): string {
  const names: Readonly<Record<string, string>> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Maximum', ultra: 'Ultra' };
  return names[level] ?? level;
}
