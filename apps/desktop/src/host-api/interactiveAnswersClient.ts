import { hostInvoke } from './transport';
import type {
  InteractiveAnswersErrorCode, InteractiveAnswersHostCommandsV1, InteractiveAnswersSettingsV1, InteractiveAnswersUpdateRequest,
} from '../../../../contracts/interactive-answers-v1';

export type * from '../../../../contracts/interactive-answers-v1';
export interface InteractiveAnswersClient {
  settings(): Promise<InteractiveAnswersSettingsV1>;
  update(change: InteractiveAnswersUpdateRequest): Promise<InteractiveAnswersSettingsV1>;
}
export type InteractiveAnswersRoute = keyof InteractiveAnswersHostCommandsV1;
export type InteractiveAnswersRequest = Parameters<InteractiveAnswersHostCommandsV1[InteractiveAnswersRoute]>[0];
export type InteractiveAnswersInvoke = <T>(route: InteractiveAnswersRoute, args: { request: InteractiveAnswersRequest }) => Promise<T>;

export class InteractiveAnswersOperationError extends Error {
  constructor(readonly code: InteractiveAnswersErrorCode) {
    super(code === 'read-only' ? 'Runtime actions are disabled in safe mode.' : 'The setting could not be saved. Nothing was changed.');
    this.name = 'InteractiveAnswersOperationError';
  }
}

function errorOf(cause: unknown): InteractiveAnswersOperationError {
  if (cause instanceof InteractiveAnswersOperationError) return cause;
  let value = cause;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { value = undefined; }
  }
  return new InteractiveAnswersOperationError(typeof value === 'object' && value !== null && 'code' in value && value.code === 'read-only' ? 'read-only' : 'io');
}

function settingsOf(value: unknown): InteractiveAnswersSettingsV1 {
  if (typeof value !== 'object' || value === null || !('protocol' in value) || value.protocol !== 1
    || !('enabled' in value) || typeof value.enabled !== 'boolean' || !('readOnly' in value) || typeof value.readOnly !== 'boolean') {
    throw new InteractiveAnswersOperationError('io');
  }
  return { protocol: 1, enabled: value.enabled, readOnly: value.readOnly };
}

export function createInteractiveAnswersClient(invoke: InteractiveAnswersInvoke): InteractiveAnswersClient {
  async function call(route: InteractiveAnswersRoute, request: InteractiveAnswersRequest): Promise<InteractiveAnswersSettingsV1> {
    try { return settingsOf(await invoke<unknown>(route, { request })); }
    catch (cause) { throw errorOf(cause); }
  }
  return {
    settings: () => call('interactive_answers_settings_v1', {}),
    update: change => call('interactive_answers_update_v1', { enabled: change.enabled }),
  };
}

export const interactiveAnswersHost = createInteractiveAnswersClient((route, args) => hostInvoke(route, args));
