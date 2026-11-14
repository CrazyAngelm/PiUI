import { modelSelectionKey } from '../../host-api/modelSelection';

export type ModelTab = 'favorites' | 'all';

interface Viewable {
  key: string;
  id: string;
  provider?: string | undefined;
}

/** The favorite key of a row: derived from provider and id, so it does not depend on the caller's `key` format. */
export function favoriteKey(model: Pick<Viewable, 'id' | 'provider'>): string {
  return modelSelectionKey(model);
}

/** Opens on Favorites when the scope has a favorite that is in the list now; otherwise on All models. */
export function defaultTab(models: readonly Viewable[], favorites: readonly string[]): ModelTab {
  if (favorites.length === 0) return 'all';
  const set = new Set(favorites);
  return models.some((model) => set.has(favoriteKey(model))) ? 'favorites' : 'all';
}

export interface ModelView {
  tab: ModelTab;
  search: string;
  /** Favorite keys of the scope. */
  favorites: readonly string[];
  /** Caller key of the selected model. */
  value: string;
  /** Favorite keys un-favorited in this view; they stay until the tab changes or the popover closes. */
  kept?: readonly string[];
}

/** Models for the list: a search always covers all models; Favorites adds the selected and kept ones. */
export function visibleModels<T extends Viewable>(models: readonly T[], view: ModelView): readonly T[] {
  if (view.search.trim() !== '' || view.tab === 'all') return models;
  const keep = new Set([...view.favorites, ...(view.kept ?? [])]);
  return models.filter((model) => keep.has(favoriteKey(model)) || (view.value !== '' && model.key === view.value));
}
