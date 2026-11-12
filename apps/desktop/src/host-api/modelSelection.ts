import type { HarnessKind, WorkspaceModel } from '../../../../contracts/workspace-v15';

type ModelIdentity = Pick<WorkspaceModel, 'id'> & { provider?: string | null };

export function modelSelectionKey(model: ModelIdentity): string {
  return JSON.stringify([model.provider ?? null, model.id]);
}

export function resolveModelSelection<T extends ModelIdentity>(
  models: readonly T[],
  key: string,
  harness: HarnessKind | '',
): T | undefined {
  const exact = models.find((model) => modelSelectionKey(model) === key);
  if (exact || harness !== 'codex' || !key) return exact;

  // Older Codex pickers recorded OpenAI for the implicit provider. A native
  // catalog without a provider can resolve that legacy key if the id is unique.
  const implicit = models.find((model) => model.provider == null && modelSelectionKey({ provider: 'openai', id: model.id }) === key);
  return implicit && models.filter((model) => model.id === implicit.id).length === 1 ? implicit : undefined;
}
