import { desktopAvailable, hostInvoke, hostListen } from './transport';
import {
  ORCHESTRATION_EVENT_V6,
  ORCHESTRATION_SCHEDULE_EVENT_V7,
  type OrchestrationHostCommandsV7,
  type OrchestrationHostErrorCode,
  type OrchestrationRunChangedEventV6,
  type OrchestrationScheduleChangedEventV7,
} from '../../../../contracts/orchestration-host-v7';

export type * from '../../../../contracts/orchestration-host-v7';
export type * from '../../../../contracts/orchestration-v6';
export { ORCHESTRATION_EVENT_V6, ORCHESTRATION_SCHEDULE_EVENT_V7 };
export interface OrchestrationClient extends OrchestrationHostCommandsV7 {
  listen(handler: (event: OrchestrationRunChangedEventV6) => void): Promise<() => void>;
  listenSchedules(handler: (event: OrchestrationScheduleChangedEventV7) => void): Promise<() => void>;
}
export type OrchestrationCommandName = keyof OrchestrationHostCommandsV7;
export type OrchestrationRequest = Parameters<OrchestrationHostCommandsV7[OrchestrationCommandName]>[0];
export type OrchestrationInvoke = <T>(route: OrchestrationCommandName, args: { request: OrchestrationRequest }) => Promise<T>;
export type OrchestrationSubscribe = (handler: (payload: unknown) => void) => Promise<() => void>;
export type OrchestrationErrorCode = OrchestrationHostErrorCode | 'desktop-unavailable' | 'unknown';

const ERROR_COPY: Readonly<Record<OrchestrationErrorCode, string>> = {
  invalid: 'Check the definition, references and requested native policy before trying again.',
  conflict: 'This record changed elsewhere. Keep your draft and reload before saving again.',
  'not-found': 'This definition or run is no longer available. Refresh the list.',
  'already-exists': 'This record already exists. Reload it before saving another change.',
  io: 'The operation could not be saved. Your draft and native history have not been removed.',
  'runtime-unavailable': 'The native runtime is unavailable. Check the run and runtime setup before retrying.',
  denied: 'This action was refused by project trust, safe mode or the requested policy.',
  'unsupported-policy': 'The requested native policy is unsupported. Keep the requirement or choose a runtime that can enforce it.',
  'native-outcome-uncertain': 'The native outcome is uncertain. Inspect the recorded run and linked session before retrying.',
  'desktop-unavailable': 'Open the PiUI desktop app to use orchestration. Browser preview does not save definitions or execute agents.',
  unknown: 'The workspace operation could not be completed. Your draft is unchanged.',
};

export class OrchestrationOperationError extends Error {
  constructor(readonly code: OrchestrationErrorCode, message: string = ERROR_COPY[code]) {
    super(message);
    this.name = 'OrchestrationOperationError';
  }
}

export function orchestrationError(cause: unknown): OrchestrationOperationError {
  if (cause instanceof OrchestrationOperationError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { value = undefined; }
  }
  const code = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    && Object.hasOwn(ERROR_COPY, value.code) ? value.code as OrchestrationErrorCode : 'unknown';
  return new OrchestrationOperationError(code);
}

/** Only versioned, scalar invalidations cross this boundary; native payload details do not. */
export function orchestrationRunChanged(payload: unknown): OrchestrationRunChangedEventV6 | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (!('protocol' in payload) || payload.protocol !== 6 || !('type' in payload) || payload.type !== 'runChanged') return undefined;
  if (!('workspaceId' in payload) || typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim()) return undefined;
  if (!('runId' in payload) || typeof payload.runId !== 'string' || !payload.runId.trim()) return undefined;
  if (!('revision' in payload) || typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision) || payload.revision < 0) return undefined;
  return { protocol: 6, type: 'runChanged', workspaceId: payload.workspaceId, runId: payload.runId, revision: payload.revision };
}

export function orchestrationScheduleChanged(payload: unknown): OrchestrationScheduleChangedEventV7 | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (!('protocol' in payload) || payload.protocol !== 7 || !('type' in payload) || payload.type !== 'scheduleChanged') return undefined;
  if (!('workspaceId' in payload) || typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim()) return undefined;
  if (!('scheduleId' in payload) || typeof payload.scheduleId !== 'string' || !payload.scheduleId.trim()) return undefined;
  if (!('revision' in payload) || typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision) || payload.revision < 0) return undefined;
  return { protocol: 7, type: 'scheduleChanged', workspaceId: payload.workspaceId, scheduleId: payload.scheduleId, revision: payload.revision };
}

async function unavailableSubscription(): Promise<() => void> {
  throw new OrchestrationOperationError('runtime-unavailable');
}

export function createOrchestrationClient(
  invokeCommand: OrchestrationInvoke,
  subscribe: OrchestrationSubscribe = unavailableSubscription,
  subscribeSchedules: OrchestrationSubscribe = unavailableSubscription,
): OrchestrationClient {
  async function call<T>(route: OrchestrationCommandName, request: OrchestrationRequest): Promise<T> {
    try { return await invokeCommand<T>(route, { request }); }
    catch (error) { throw orchestrationError(error); }
  }
  return {
    async listen(handler) {
      try {
        return await subscribe((payload) => {
          const event = orchestrationRunChanged(payload);
          if (event !== undefined) handler(event);
        });
      } catch (error) { throw orchestrationError(error); }
    },
    async listenSchedules(handler) {
      try {
        return await subscribeSchedules((payload) => {
          const event = orchestrationScheduleChanged(payload);
          if (event !== undefined) handler(event);
        });
      } catch (error) { throw orchestrationError(error); }
    },
    orchestration_cancel_task_v6: (request) => call('orchestration_cancel_task_v6', request),
    orchestration_control_flow_v6: (request) => call('orchestration_control_flow_v6', request),
    orchestration_run_usage_v6: (request) => call('orchestration_run_usage_v6', request),
    orchestration_save_graph_v6: (request) => call('orchestration_save_graph_v6', request),
    orchestration_catalog_v6: (request) => call('orchestration_catalog_v6', request),
    orchestration_get_profile_v6: (request) => call('orchestration_get_profile_v6', request),
    orchestration_save_profile_v6: (request) => call('orchestration_save_profile_v6', request),
    orchestration_delete_profile_v6: (request) => call('orchestration_delete_profile_v6', request),
    orchestration_get_team_v6: (request) => call('orchestration_get_team_v6', request),
    orchestration_save_team_v6: (request) => call('orchestration_save_team_v6', request),
    orchestration_delete_team_v6: (request) => call('orchestration_delete_team_v6', request),
    orchestration_get_pipeline_v6: (request) => call('orchestration_get_pipeline_v6', request),
    orchestration_save_pipeline_v6: (request) => call('orchestration_save_pipeline_v6', request),
    orchestration_delete_pipeline_v6: (request) => call('orchestration_delete_pipeline_v6', request),
    orchestration_get_launch_command_v6: (request) => call('orchestration_get_launch_command_v6', request),
    orchestration_save_launch_command_v6: (request) => call('orchestration_save_launch_command_v6', request),
    orchestration_delete_launch_command_v6: (request) => call('orchestration_delete_launch_command_v6', request),
    orchestration_list_schedules_v7: (request) => call('orchestration_list_schedules_v7', request),
    orchestration_save_schedule_v7: (request) => call('orchestration_save_schedule_v7', request),
    orchestration_set_schedule_enabled_v7: (request) => call('orchestration_set_schedule_enabled_v7', request),
    orchestration_delete_schedule_v7: (request) => call('orchestration_delete_schedule_v7', request),
    orchestration_list_runs_v6: (request) => call('orchestration_list_runs_v6', request),
    orchestration_get_run_v6: (request) => call('orchestration_get_run_v6', request),
    orchestration_start_run_v6: (request) => call('orchestration_start_run_v6', request),
    orchestration_cancel_run_v6: (request) => call('orchestration_cancel_run_v6', request),
    orchestration_reconcile_uncertain_task_v6: (request) => call('orchestration_reconcile_uncertain_task_v6', request),
    orchestration_retry_uncertain_task_v6: (request) => call('orchestration_retry_uncertain_task_v6', request),
  };
}

/** Browser preview has no durable store and must never report a fake save/run. */
export function createUnavailableOrchestrationClient(): OrchestrationClient {
  const unavailable = async (): Promise<never> => { throw new OrchestrationOperationError('desktop-unavailable'); };
  return createOrchestrationClient(unavailable, unavailable);
}

export const orchestrationDesktopAvailable = desktopAvailable;
export const orchestrationHost: OrchestrationClient = createOrchestrationClient(
  (route, args) => hostInvoke(route, args),
  (handler) => hostListen<unknown>(ORCHESTRATION_EVENT_V6, handler),
  (handler) => hostListen<unknown>(ORCHESTRATION_SCHEDULE_EVENT_V7, handler),
);
