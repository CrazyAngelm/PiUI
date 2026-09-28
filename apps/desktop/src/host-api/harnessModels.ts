import { hostInvoke } from './transport';
import type { HarnessModelsRequest, HarnessModelsResult } from '../../../../contracts/harness-models-v18';
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
const catalogs = new Map<string, { promise: Promise<HarnessModelsResult>; pending: boolean }>();
export function harnessModels(request: HarnessModelsRequest, refresh = false): Promise<HarnessModelsResult> {
  const key = JSON.stringify([request.workspaceId, request.harness]);
  const cached = catalogs.get(key);
  if (cached && (!refresh || cached.pending)) return cached.promise;
  const promise = hostInvoke<HarnessModelsResult>('harness_models_v18', { request }).then(result => {
    if (result.protocol !== 18 || result.harness !== request.harness) throw new Error('Invalid model catalog');
    entry.pending = false;
    storeSnapshot(key, result);
    return result;
  }).catch(error => {
    if (catalogs.get(key) === entry) catalogs.delete(key);
    forgetSnapshot(key);
    const mapped = workspaceError(error);
    if (mapped.code === 'RUNTIME_FAILED') throw new Error('Could not load models.');
    throw mapped;
  });
  const entry = { promise, pending: true };
  catalogs.set(key, entry);
  return entry.promise;
}

// A catalog probe starts the native harness (seconds for Claude Code), so a
// model picker shows the last catalog this project saw at once and replaces it
// when the probe answers. Pickers only: sign-in checks and preflight never read
// a snapshot, and a failed probe forgets it.
const SNAPSHOT_KEY = 'piui.harness.catalog.v1:';
const SNAPSHOT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function storeSnapshot(key: string, result: HarnessModelsResult): void {
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
 * and harness when one is remembered, and reports the native probe through
 * `handlers`. Without a snapshot it is `harnessModels`.
 */
export function cachedHarnessModels(request: HarnessModelsRequest, handlers: CachedCatalogHandlers = {}): Promise<HarnessModelsResult> {
  const key = JSON.stringify([request.workspaceId, request.harness]);
  const live = catalogs.get(key);
  const snapshot = live && !live.pending ? undefined : readSnapshot(key, request);
  const fresh = harnessModels(request);
  if (!snapshot) return fresh;
  fresh.then(result => handlers.onFresh?.(result), error => handlers.onError?.(error));
  return Promise.resolve(snapshot);
}
