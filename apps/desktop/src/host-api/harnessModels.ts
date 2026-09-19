import { invoke } from '@tauri-apps/api/core';
import type { HarnessModelsRequest, HarnessModelsResult } from '../../../../contracts/harness-models-v18';
import { workspaceError } from './workspaceClient';

// Session-local, workspace-scoped catalog reuse. Explicit refresh and preflight
// bypass completed entries; concurrent consumers share the native request.
const catalogs = new Map<string, { promise: Promise<HarnessModelsResult>; pending: boolean }>();
export function harnessModels(request: HarnessModelsRequest, refresh = false): Promise<HarnessModelsResult> {
  const key = JSON.stringify([request.workspaceId, request.harness]);
  const cached = catalogs.get(key);
  if (cached && (!refresh || cached.pending)) return cached.promise;
  const promise = invoke<HarnessModelsResult>('harness_models_v18', { request }).then(result => {
    if (result.protocol !== 18 || result.harness !== request.harness) throw new Error('Invalid model catalog');
    entry.pending = false;
    return result;
  }).catch(error => {
    if (catalogs.get(key) === entry) catalogs.delete(key);
    const mapped = workspaceError(error);
    if (mapped.code === 'RUNTIME_FAILED') throw new Error('Could not load models.');
    throw mapped;
  });
  const entry = { promise, pending: true };
  catalogs.set(key, entry);
  return entry.promise;
}
