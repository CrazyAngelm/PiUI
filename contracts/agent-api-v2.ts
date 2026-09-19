/** Schedule-capable local operator protocol. Protocol v1 remains accepted for
 * every pre-existing method; the four schedule methods require protocol 2.
 */
import type { OrchestrationHostCommandsV7 } from './orchestration-host-v7';

export interface AgentApiMethodsV2 {
  listSchedules: OrchestrationHostCommandsV7['orchestration_list_schedules_v7'];
  saveSchedule: OrchestrationHostCommandsV7['orchestration_save_schedule_v7'];
  setScheduleEnabled: OrchestrationHostCommandsV7['orchestration_set_schedule_enabled_v7'];
  deleteSchedule: OrchestrationHostCommandsV7['orchestration_delete_schedule_v7'];
}

export type AgentApiV2Request = { [M in keyof AgentApiMethodsV2]: {
  protocol: 2;
  method: M;
  params: Parameters<AgentApiMethodsV2[M]> extends []
    ? Record<string, never>
    : Parameters<AgentApiMethodsV2[M]>[0];
} }[keyof AgentApiMethodsV2];

export type AgentApiV2Response<T> =
  | { protocol: 2; ok: true; result: T }
  | { protocol: 2; ok: false; error: { code: string } };
