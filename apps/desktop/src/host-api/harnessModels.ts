import { hostInvoke } from './transport';
import type { HarnessCatalogPart, HarnessModelsRequest, HarnessModelsResult } from '../../../../contracts/harness-models-v18';
import type { HarnessModelsResultV19 } from '../../../../contracts/harness-models-v19';
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
// `models` lets pickers join a full refresh before resource discovery finishes;
// `at` is when a completed entry was answered; `version` is the native version
// named when the load started, also retained for direct refresh callers.
// `owner` is the split generation a part load belongs to.
interface CatalogEntry { promise: Promise<HarnessModelsResult>; pending: boolean; models?: Promise<HarnessModelsResult>; fullRequest?: boolean; at?: number; version?: string; owner?: number }
const catalogs = new Map<string, CatalogEntry>();
const knownVersions = new Map<string, string>();
/** A picker shows an older completed catalog at once and asks the harness again in the background. */
const CATALOG_STALE_MS = 5 * 60 * 1000;
// Every native load of a project's whole catalog (a split load or a full probe)
// starts a new generation. Only the newest one may update the snapshot or the
// pickers: a slower, older load must not overwrite a refresh that answered first.
const generations = new Map<string, number>();
/** The whole-catalog promise of the newest generation, kept even after its entry is retired. */
const currentLoads = new Map<string, Promise<HarnessModelsResult>>();
function nextGeneration(key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

/**
 * The newest answer for a catalog: follows replacements until the load it
 * waited for is still the newest when it settles (A waits for B, C replaces B
 * and answers first: A gets C, never the late B).
 */
function newestAnswer(key: string): Promise<HarnessModelsResult> | undefined {
  const target = generations.get(key);
  const load = currentLoads.get(key);
  if (!load) return undefined;
  return load.then(
    result => (generations.get(key) === target ? result : (newestAnswer(key) ?? result)),
    error => {
      if (generations.get(key) === target) throw error;
      return newestAnswer(key) ?? Promise.reject(error);
    },
  );
}
const catalogKey = (request: HarnessModelsRequest): string => JSON.stringify([request.workspaceId, request.harness]);
const partKey = (request: HarnessModelsRequest, part: HarnessCatalogPart): string => JSON.stringify([request.workspaceId, request.harness, part]);

const RESOURCES_UNAVAILABLE = 'Skills, MCP servers and tools could not be loaded from the harness.';

/**
 * True when resource discovery failed and the host answered with a warning in
 * place of the resources: the models are real, the empty resource list is not.
 */
export function catalogDegraded(result: HarnessModelsResult): boolean {
  return result.resources.warnings.some(warning => warning === RESOURCES_UNAVAILABLE
    || warning === 'Skills could not be loaded from Codex.'
    || warning === 'MCP servers could not be loaded from Codex.'
    || warning === 'MCP tools could not be loaded from Codex.'
    || warning === 'Hermes tool inventory is unavailable.'
    || warning === 'Hermes skill inventory is unavailable.'
    || warning === 'Skills could not be loaded from Pi.'
    || warning === 'Skills could not be loaded from Prime Agent.'
    || warning === 'Tools could not be loaded from Prime Agent.'
    || /^MCP server .+ could not start\.$/u.test(warning));
}

/** `owner` is the generation of the split load a part belongs to. */
function nativeCatalog(request: HarnessModelsRequest, part: HarnessCatalogPart, owner: number, discoveryId: string, version: string | undefined): Promise<HarnessModelsResult> {
  const full = catalogKey(request);
  const key = partKey(request, part);
  const cached = catalogs.get(key);
  // A split never joins a part another split started while it is in flight (it
  // answers for an older CLI or a replaced load), nor another split's resources
  // (each split claims its own discovery). Answered models are reused.
  const foreign = cached !== undefined && cached.owner !== owner && (cached.pending || part === 'resources');
  if (cached && !foreign && (cached.pending || !outdated(cached, version))) return cached.promise;
  const promise = hostInvoke<HarnessModelsResultV19>('harness_models_v19', { request: { ...request, part, discoveryId } }).then(response => {
    if (response.protocol !== 19) throw new Error('Invalid model catalog');
    const result = response.catalog;
    if (result.protocol !== 18 || result.harness !== request.harness) throw new Error('Invalid model catalog');
    entry.pending = false;
    entry.at = Date.now();
    // A degraded answer is not remembered: the next load asks for the resources again.
    const degraded = part === 'resources' && catalogDegraded(result);
    // A part of a replaced split is not the catalog's answer: the next split asks again.
    const superseded = generations.get(full) !== owner;
    if ((degraded || superseded) && catalogs.get(key) === entry) catalogs.delete(key);
    return result;
  }).catch(error => {
    if (catalogs.get(key) === entry) catalogs.delete(key);
    const mapped = workspaceError(error);
    // A coded refusal (sign-in, trust, safe mode…) retires what was remembered;
    // a transient failure (slow start, crash) keeps it for the next picker.
    // A newer load answers for the snapshot instead of this older one.
    const newest = generations.get(full) === owner;
    if (part !== 'resources' && !transient(mapped.code) && newest) forgetSnapshot(full, request);
    if (mapped.code === 'RUNTIME_FAILED') throw new Error('Could not load models.');
    throw mapped;
  });
  const entry: CatalogEntry = { promise, pending: true, owner, version };
  // A replaced split's part runs unlisted: it must not displace the newest split's part.
  if (owner === generations.get(full) || !catalogs.has(key)) catalogs.set(key, entry);
  return entry.promise;
}

/** Models and resources from one native probe; resolves once both are known. */
export function harnessModels(request: HarnessModelsRequest, refresh = false, version: string | undefined = undefined): Promise<HarnessModelsResult> {
  const key = catalogKey(request);
  if (version) knownVersions.set(key, version);
  const live = catalogs.get(key);
  // Explicit refreshes share each other, but replace a picker's split that
  // may have reused an older models answer. Every path exposes models early.
  const nativeVersion = version ?? knownVersions.get(key);
  if ((live && otherVersion(live, nativeVersion)) || (refresh && !(live?.pending && live.fullRequest))) retire(request, true);
  return splitCatalog(request, nativeVersion, true).full;
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
function splitCatalog(request: HarnessModelsRequest, version: string | undefined, fullRequest = false): { models: Promise<HarnessModelsResult>; full: Promise<HarnessModelsResult> } {
  const key = catalogKey(request);
  const live = catalogs.get(key);
  // A later consumer of a split in flight takes its models entry: `live` only
  // settles with the resources, which can be seconds behind the models.
  if (live) return { models: live.models ?? live.promise, full: live.promise };
  const generation = nextGeneration(key);
  const discoveryId = crypto.randomUUID();
  const models = nativeCatalog(request, 'models', generation, discoveryId, version);
  let degraded = false;
  const unavailable = (listed: HarnessModelsResult): HarnessModelsResult => {
    degraded = true;
    return { ...listed, resources: { items: [], warnings: [RESOURCES_UNAVAILABLE] } };
  };
  // Both parts name the same discovery, even if their IPC answers arrive out
  // of order or another WebView left an unclaimed probe behind.
  const full = models.then(listed => {
    return nativeCatalog(request, 'resources', generation, discoveryId, version).then(
      found => {
        degraded = catalogDegraded(found);
        return { ...listed, resources: found.resources };
      },
      () => unavailable(listed),
    );
  }).then(result => {
    entry.pending = false;
    entry.at = Date.now();
    if (degraded && catalogs.get(key) === entry) catalogs.delete(key);
    if (generations.get(key) === generation) {
      // A degraded snapshot gets the fresh models with the resources it already had.
      storeSnapshot(key, request, degraded ? { ...result, resources: readSnapshot(key, request)?.resources ?? { items: [], warnings: [] } } : result);
    }
    return generations.get(key) === generation ? result : (newestAnswer(key) ?? result);
  }, error => {
    if (catalogs.get(key) === entry) catalogs.delete(key);
    if (generations.get(key) !== generation) return newestAnswer(key) ?? Promise.reject(error);
    throw error;
  });
  const entry: CatalogEntry = { promise: full, models, fullRequest, pending: true, version };
  catalogs.set(key, entry);
  currentLoads.set(key, full);
  return { models, full };
}

// A catalog probe starts the native harness (seconds for Claude Code), so a
// model picker shows the last catalog this project saw at once and replaces it
// when the probe answers. A project without one gets the models this harness
// listed for any project, as a provisional list only (resources are per
// project). Pickers only: sign-in checks and preflight never read a snapshot,
// and a coded refusal forgets it.
const SNAPSHOT_KEY = 'piui.harness.catalog.v1:';
const SNAPSHOT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const harnessSnapshotKey = (request: HarnessModelsRequest): string => JSON.stringify(['*', request.harness]);

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
  for (const key of [...generations.keys()]) {
    if (harnessOfKey(key) === harness) {
      nextGeneration(key);
      currentLoads.delete(key);
      knownVersions.delete(key);
    }
  }
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

/** Failures a later probe may not repeat; anything else is the host's answer. */
function transient(code: string): boolean {
  return code === 'UNKNOWN' || code === 'RUNTIME_FAILED';
}

function storeSnapshot(key: string, request: HarnessModelsRequest, result: HarnessModelsResult): void {
  if (result.harness === NO_SNAPSHOT_HARNESS) return;
  try {
    const at = Date.now();
    localStorage.setItem(SNAPSHOT_KEY + key, JSON.stringify({ at, result }));
    const models: HarnessModelsResult = { protocol: 18, harness: result.harness, models: result.models, resources: { items: [], warnings: [] } };
    localStorage.setItem(SNAPSHOT_KEY + harnessSnapshotKey(request), JSON.stringify({ at, result: models }));
  } catch {
    // The snapshot is a convenience; the probe stays authoritative.
  }
}

function forgetSnapshot(key: string, request: HarnessModelsRequest): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY + key);
    localStorage.removeItem(SNAPSHOT_KEY + harnessSnapshotKey(request));
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
  /**
   * Called at once, before the call resolves, with the models this harness
   * listed for another project when this one has nothing remembered: a
   * provisional list to show while the probe runs (no resources). The call
   * still resolves with this project's own answer.
   */
  onProvisional?: (result: HarnessModelsResult) => void;
  /** The native version shown for this harness; a change asks the harness again. */
  version?: string;
}

/** The load answered for another native version than the one shown now (a CLI update). */
function otherVersion(entry: CatalogEntry, version: string | undefined): boolean {
  return Boolean(version && entry.version !== version);
}

/** Whether a picker should ask the harness again behind a completed catalog. */
function outdated(entry: CatalogEntry, version: string | undefined): boolean {
  return otherVersion(entry, version) || entry.at === undefined || Date.now() - entry.at > CATALOG_STALE_MS;
}

/**
 * Retires a catalog's entries so the next load asks the harness: the completed
 * ones, or also those in flight (their answers then reach nobody new, and the
 * generation check keeps them out of the snapshot).
 */
function retire(request: HarnessModelsRequest, inFlight: boolean): void {
  for (const key of [catalogKey(request), partKey(request, 'models'), partKey(request, 'resources')]) {
    const entry = catalogs.get(key);
    if (entry && (inFlight || !entry.pending)) catalogs.delete(key);
  }
}

/**
 * For model pickers: resolves at once with the last catalog of this project
 * and harness when one is remembered, otherwise as soon as the native models
 * are known; later answers (models, then resources) arrive through `handlers`.
 * A catalog answered more than a few minutes ago, or before the harness
 * version changed, is shown at once and asked again in the background.
 */
export function cachedHarnessModels(request: HarnessModelsRequest, handlers: CachedCatalogHandlers = {}): Promise<HarnessModelsResult> {
  const key = catalogKey(request);
  const version = handlers.version ?? knownVersions.get(key);
  if (version) knownVersions.set(key, version);
  const live = catalogs.get(key);
  let earlier: Promise<HarnessModelsResult> | undefined;
  if (live && !live.pending) {
    if (!outdated(live, version)) return live.promise;
    earlier = live.promise;
    retire(request, false);
  } else if (live && otherVersion(live, version)) {
    // The load in flight answers for the CLI that was installed before.
    retire(request, true);
  }
  const snapshot = earlier ? undefined : readSnapshot(key, request);
  const { models, full } = splitCatalog(request, version);
  const generation = generations.get(key);
  const current = (): boolean => generations.get(key) === generation;
  // A newer load (an explicit refresh, a newer version) replaced this one: the
  // picker gets that load's answer, or its failure, instead of this older one.
  const newer = (): void => {
    newestAnswer(key)?.then(result => handlers.onFresh?.(result), error => handlers.onError?.(error));
  };
  const fresh = (result: HarnessModelsResult): void => (current() ? handlers.onFresh?.(result) : newer());
  if (!earlier && !snapshot) {
    const provisional = readSnapshot(harnessSnapshotKey(request), request);
    if (provisional) handlers.onProvisional?.(provisional);
    // Models resolve the call; resources follow through `onFresh`.
    full.then(fresh, () => undefined);
    return models.then(
      result => (current() ? result : (newestAnswer(key) ?? result)),
      error => {
        if (current()) throw error;
        return newestAnswer(key) ?? Promise.reject(error);
      },
    );
  }
  // Fresher answers follow what is shown, even when the models are already known.
  const shown = earlier ?? Promise.resolve(snapshot!);
  if (models !== full) {
    shown.then(first => models.then(result => {
      if (current()) handlers.onFresh?.({ ...result, resources: first.resources });
    })).catch(() => undefined);
  }
  shown.then(() => full).then(fresh, error => (current() ? handlers.onError?.(error) : newer()));
  return shown;
}
