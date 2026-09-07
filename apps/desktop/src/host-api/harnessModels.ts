import { invoke } from '@tauri-apps/api/core';
import type { HarnessModelsRequest, HarnessModelsResult } from '../../../../contracts/harness-models-v18';
import { workspaceError } from './workspaceClient';
export async function harnessModels(request: HarnessModelsRequest): Promise<HarnessModelsResult> {
  try {
    const result = await invoke<HarnessModelsResult>('harness_models_v18', { request });
    if (result.protocol !== 18 || result.harness !== request.harness) throw new Error('Invalid model catalog');
    return result;
  } catch (error) { throw workspaceError(error); }
}
