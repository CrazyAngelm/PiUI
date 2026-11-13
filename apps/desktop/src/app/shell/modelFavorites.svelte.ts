/** Favorite models: a local UI preference per harness (or other scope), never sent to a harness. */
export const FAVORITES_STORAGE_KEY = 'piui.models.favorites.v1';
export const MAX_FAVORITES_PER_SCOPE = 100;
const MAX_SCOPES = 64;
const MAX_TEXT = 512;

export type FavoritesMap = Record<string, string[]>;

/** Validates stored JSON: bad shape, bad entries and oversize lists are dropped, never thrown. */
export function parseFavorites(raw: string | null | undefined): FavoritesMap {
  const result: FavoritesMap = {};
  if (!raw) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return result;
  let scopes = 0;
  for (const [scope, entries] of Object.entries(parsed)) {
    if (scopes >= MAX_SCOPES) break;
    if (scope === '__proto__' || scope.length > MAX_TEXT || !Array.isArray(entries)) continue;
    const keys: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry === '' || entry.length > MAX_TEXT || keys.includes(entry)) continue;
      keys.push(entry);
      if (keys.length >= MAX_FAVORITES_PER_SCOPE) break;
    }
    if (keys.length > 0) {
      result[scope] = keys;
      scopes += 1;
    }
  }
  return result;
}

function readStored(): FavoritesMap {
  try {
    return parseFavorites(localStorage.getItem(FAVORITES_STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeStored(map: FavoritesMap): void {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage can be blocked or full; the favorites then last for this run only.
  }
}

class ModelFavorites {
  map = $state<FavoritesMap>(readStored());

  list(scope: string): readonly string[] {
    return this.map[scope] ?? [];
  }

  has(scope: string, key: string): boolean {
    return this.list(scope).includes(key);
  }

  /** Flips a favorite and returns whether it is one now. A full scope drops its oldest entry. */
  toggle(scope: string, key: string): boolean {
    const current = this.list(scope);
    const on = !current.includes(key);
    const next = on ? [...current, key].slice(-MAX_FAVORITES_PER_SCOPE) : current.filter((entry) => entry !== key);
    const map = { ...this.map };
    if (next.length > 0) map[scope] = next;
    else delete map[scope];
    this.map = map;
    writeStored(map);
    return on;
  }
}

export const modelFavorites = new ModelFavorites();
