import type { ModelLite } from '../../host-api/types';

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  'openai-codex': 'OpenAI Codex',
  'opencode-go': 'OpenCode Go',
};

export function modelDisplayName(model: ModelLite): string {
  const label = model.label?.trim();
  return label && label.length > 0 ? label : model.id.split('/').at(-1) ?? model.id;
}

export function providerDisplayName(provider: string): string {
  const known = PROVIDER_LABELS[provider];
  if (known !== undefined) return known;
  return provider
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function modelKey(model: ModelLite): string {
  return `${model.provider}\u0000${model.id}`;
}

export function modelIsAvailable(models: readonly ModelLite[], currentModel: ModelLite | undefined): boolean {
  return currentModel !== undefined && models.some((model) => modelKey(model) === modelKey(currentModel));
}

export function orderModelPickerOptions(models: readonly ModelLite[], currentModel: ModelLite | undefined): ModelLite[] {
  if (currentModel === undefined) return [...models];
  const currentKey = modelKey(currentModel);
  return [currentModel, ...models.filter((model) => modelKey(model) !== currentKey)];
}

export function filterModelPickerOptions(models: readonly ModelLite[], query: string): ModelLite[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const filtered = terms.length === 0
    ? [...models]
    : models.filter((model) => {
        const searchText = `${model.provider} ${providerDisplayName(model.provider)} ${model.id} ${model.label ?? ''}`.toLocaleLowerCase();
        return terms.every((term) => searchText.includes(term));
      });

  const providers: string[] = [];
  const grouped = new Map<string, ModelLite[]>();
  for (const model of filtered) {
    const group = grouped.get(model.provider);
    if (group === undefined) {
      providers.push(model.provider);
      grouped.set(model.provider, [model]);
    } else {
      group.push(model);
    }
  }
  return providers.flatMap((provider) => grouped.get(provider) ?? []);
}
