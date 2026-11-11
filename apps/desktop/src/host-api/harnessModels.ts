import { hostInvoke } from './transport';
import type { HarnessCatalogPart, HarnessModelsRequest, HarnessModelsResult } from '../../../../contracts/harness-models-v18';
import type { WorkspaceModel } from '../../../../contracts/workspace-v15';
import { workspaceError } from './workspaceClient';

/**
 * Catalog entries carry catalog-only fields (`supportsFast`, a null provider);
 * session commands take the strict `WorkspaceModel` (`deny_unknown_fields` in
 * the host), so only its fields are forwarded.
 */
export function workspaceModel(model: WorkspaceModel): WorkspaceModel {
  return {
    id: model.id,
    name: model.name,
    ...(typeof model.provider === 'string' ? { provider: model.provider } : {}),
    ...(Array.isArray(model.thinkingLevels) ? { thinkingLevels: [...model.thinkingLevels] } : {}),
  };
}

// Session-local, workspace-scoped catalog reuse. Explicit refresh and preflight
// bypass completed entries; concurrent consumers share the native request.
// `split` marks the entry of a models-then-resources load (`splitCatalog`).
const catalogs = new Map<string, { promise: Promise<HarnessModelsResult>; pending: boolean; split?: true }>();
const catalogKey = (request: HarnessModelsRequest): string => JSON.stringify([request.workspaceId, request.harness]);
const partKey = (request: HarnessModelsRequest, part: HarnessCatalogPart): string => JSON.stringify([request.workspaceId, request.harness, part]);

const RESOURCES_UNAVAILABLE = 'Skills, MCP servers and tools could not be loaded from the harness.';

/**
 * True when resource discovery failed and the host answered with a warning in
 * place of the resources: the models are real, the empty resource list is not.
 */
export function catalogDegraded(result: HarnessModelsResult): boolean {
  return result.resources.warnings.includes(RESOURCES_UNAVAILABLE);
}

function nativeCatalog(request: HarnessModelsRequest, part: HarnessCatalogPart | undefined, refresh: boolean): Promise<HarnessModelsResult> {
  const full = catalogKey(request);
  const key = part ? partKey(request, part) : full;
  const cached = catalogs.get(key);
  // An explicit refresh joins a full probe in flight, never a split load: that
  // one may be reusing models answered before.
  if (cached && (!refresh || (cached.pending && !cached.split))) return cached.promise;
  // A full refresh also retires the answered parts, so a later split load asks
  // the harness again instead of reusing the models and resources it replaced.
  if (refresh && !part) {
    for (const piece of ['models', 'resources'] as const) {
      const pieceKey = partKey(request, piece);
      if (catalogs.get(pieceKey)?.pending === false) catalogs.delete(pieceKey);
    }
  }
  const promise = hostInvoke<HarnessModelsResult>('harness_models_v18', { request: part ? { ...request, part } : request }).then(result => {
    if (result.protocol !== 18 || result.harness !== request.harness) throw new Error('Invalid model catalog');
    entry.pending = false;
    // A degraded answer is not remembered: the next load asks for the resources again.
    const degraded = part !== 'models' && catalogDegraded(result);
    if (degraded && catalogs.get(key) === entry) catalogs.delete(key);
    if (!part) storeSnapshot(full, degraded ? { ...result, resources: readSnapshot(full, request)?.resources ?? { items: [], warnings: [] } } : result);
    return result;
  }).catch(error => {
    if (catalogs.get(key) === entry) catalogs.delete(key);
    if (part !== 'resources') forgetSnapshot(full);
    const mapped = workspaceError(error);
    if (mapped.code === 'RUNTIME_FAILED') throw new Error('Could not load models.');
    throw mapped;
  });
  const entry = { promise, pending: true };
  catalogs.set(key, entry);
  return entry.promise;
}

/** Models and resources from one native probe; resolves once both are known. */
export function harnessModels(request: HarnessModelsRequest, refresh = false): Promise<HarnessModelsResult> {
  return nativeCatalog(request, undefined, refresh);
}

/**
 * True once no native request for this project and harness is in flight: the
 * models and the resources are both known, or the load ended without them (a
 * failure, or resources degraded to a warning). False while either is still
 * loading, so a picker can tell "resources are on their way" from "none".
 */
export function catalogSettled(request: HarnessModelsRequest): boolean {
  return ![catalogKey(request), partKey(request, 'models'), partKey(request, 'resources')].some(key => catalogs.get(key)?.pending);
}

/**
 * Models first, resources after: the host answers `models` without waiting for
 * resource discovery (MCP startup) and hands that discovery to `resources`.
 * A failed resource discovery keeps the models and reports a warning; that
 * degraded catalog is not remembered, so the next load asks for the resources
 * again (the answered models are reused).
 */
function splitCatalog(request: HarnessModelsRequest): { models: Promise<HarnessModelsResult>; full: Promise<HarnessModelsResult> } {
  const key = catalogKey(request);
  const live = catalogs.get(key);
  // A later consumer of a split in flight takes its models entry: `live` only
  // settles with the resources, which can be seconds behind the models.
  if (live) return { models: (live.split ? catalogs.get(partKey(request, 'models'))?.promise : undefined) ?? live.promise, full: live.promise };
  const models = nativeCatalog(request, 'models', false);
  let degraded = false;
  const full = models.then(listed => nativeCatalog(request, 'resources', false).then(
    found => {
      degraded = catalogDegraded(found);
      return { ...listed, resources: found.resources };
    },
    () => {
      degraded = true;
      return { ...listed, resources: { items: [], warnings: [RESOURCES_UNAVAILABLE] } };
    },
  )).then(result => {
    entry.pending = false;
    if (degraded) {
      if (catalogs.get(key) === entry) catalogs.delete(key);
      // The snapshot gets the fresh models with the resources it already had.
      storeSnapshot(key, { ...result, resources: readSnapshot(key, request)?.resources ?? { items: [], warnings: [] } });
    } else {
      storeSnapshot(key, result);
    }
    return result;
  }, error => {
    if (catalogs.get(key) === entry) catalogs.delete(key);
    throw error;
  });
  const entry = { promise: full, pending: true, split: true as const };
  catalogs.set(key, entry);
  return { models, full };
}

// A catalog probe starts the native harness (seconds for Claude Code), so a
// model picker shows the last catalog this project saw at once and replaces it
// when the probe answers. Pickers only: sign-in checks and preflight never read
// a snapshot, and a failed probe forgets it.
const SNAPSHOT_KEY = 'piui.harness.catalog.v1:';
const SNAPSHOT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/**
 * The Nano catalog is account state (sign-in, workspace, entitled modes) that the
 * host serves at once, not a slow native probe: it is never remembered across
 * sessions, so a picker cannot show modes an earlier account could use.
 */
const NO_SNAPSHOT_HARNESS = 'nano';

/** The harness of a catalog key (`[workspaceId, harness]` or `[workspaceId, harness, part]`). */
function harnessOfKey(key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drops every catalog of `harness`: the answers this session reuses (full and
 * part entries) and the remembered snapshots. A load in flight still answers
 * its own callers but is not reused. For catalogs that follow account state.
 */
export function forgetHarnessCatalogs(harness: string): void {
  for (const key of [...catalogs.keys()]) {
    if (harnessOfKey(key) === harness) catalogs.delete(key);
  }
  try {
    const remembered: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const name = localStorage.key(index);
      if (name !== null && name.startsWith(SNAPSHOT_KEY) && harnessOfKey(name.slice(SNAPSHOT_KEY.length)) === harness) remembered.push(name);
    }
    for (const name of remembered) localStorage.removeItem(name);
  } catch {
    // Storage is a convenience; the session entries are already gone.
  }
}

function storeSnapshot(key: string, result: HarnessModelsResult): void {
  if (result.harness === NO_SNAPSHOT_HARNESS) return;
  try {
    localStorage.setItem(SNAPSHOT_KEY + key, JSON.stringify({ at: Date.now(), result }));
  } catch {
    // The snapshot is a convenience; the probe stays authoritative.
  }
}

function forgetSnapshot(key: string): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY + key);
  } catch {
    // Nothing to forget.
  }
}

function readSnapshot(key: string, request: HarnessModelsRequest): HarnessModelsResult | undefined {
  if (request.harness === NO_SNAPSHOT_HARNESS) return undefined;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SNAPSHOT_KEY + key) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { at, result } = parsed as { at?: unknown; result?: Partial<HarnessModelsResult> };
    if (typeof at !== 'number' || Date.now() - at > SNAPSHOT_MAX_AGE) return undefined;
    if (!result || result.protocol !== 18 || result.harness !== request.harness || !Array.isArray(result.models)) return undefined;
    const resources = result.resources && Array.isArray(result.resources.items) ? result.resources : { items: [], warnings: [] };
    return { protocol: 18, harness: request.harness, models: result.models, resources };
  } catch {
    return undefined;
  }
}

export interface CachedCatalogHandlers {
  /** The probe answered after a snapshot was shown. */
  onFresh?: (result: HarnessModelsResult) => void;
  /** The probe failed after a snapshot was shown. */
  onError?: (error: unknown) => void;
}

/**
 * For model pickers: resolves at once with the last catalog of this project
 * and harness when one is remembered, otherwise as soon as the native models
 * are known; later answers (models, then resources) arrive through `handlers`.
 */
export function cachedHarnessModels(request: HarnessModelsRequest, handlers: CachedCatalogHandlers = {}): Promise<HarnessModelsResult> {
  const key = catalogKey(request);
  const live = catalogs.get(key);
  if (live && !live.pending) return live.promise;
  const snapshot = readSnapshot(key, request);
  const { models, full } = splitCatalog(request);
  if (!snapshot) {
    // Models resolve the call; resources follow through `onFresh`.
    full.then(result => handlers.onFresh?.(result), () => undefined);
    return models;
  }
  // Fresher answers follow the snapshot, even when the models are already known.
  const shown = Promise.resolve(snapshot);
  if (models !== full) shown.then(() => models).then(result => handlers.onFresh?.({ ...result, resources: snapshot.resources }), () => undefined);
  shown.then(() => full).then(result => handlers.onFresh?.(result), error => handlers.onError?.(error));
  return shown;
}
