/** Opt-in loopback operator protocol. 64 hex token + LF, then one JSON request
 * + LF; one JSON response + LF. Never exposed to WebView or managed children.
 * Existing host DTO versions and portable file versions remain unchanged.
 */
import type { OrchestrationHostCommandsV6 } from './orchestration-host-v6';
import type { DesktopProjectSummaryV10 } from './runtime-protocol';
import type { WorkspaceCommand, WorkspaceResult } from './workspace-v15';
import type { HarnessModelsRequest, HarnessModelsResult } from './harness-models-v18';

export interface AgentApiMethods {
  ping: () => Promise<{ api: 'piui-agent'; version: 1 }>;
  workspace: (params: WorkspaceCommand) => Promise<WorkspaceResult>;
  models: (params: HarnessModelsRequest) => Promise<HarnessModelsResult>;
  addProject: (params: { path: string }) => Promise<DesktopProjectSummaryV10>;
  setProjectTrust: (params: { projectId: string; trustState: 'trusted' | 'restricted' | 'unknown' }) => Promise<DesktopProjectSummaryV10>;
  waitRun: (params: { workspaceId: string; runId: string; afterRevision: number; timeoutMs: number }) => ReturnType<OrchestrationHostCommandsV6['orchestration_get_run_v6']>;
  catalog: OrchestrationHostCommandsV6['orchestration_catalog_v6'];
  getProfile: OrchestrationHostCommandsV6['orchestration_get_profile_v6'];
  getTeam: OrchestrationHostCommandsV6['orchestration_get_team_v6'];
  getPipeline: OrchestrationHostCommandsV6['orchestration_get_pipeline_v6'];
  getLaunchCommand: OrchestrationHostCommandsV6['orchestration_get_launch_command_v6'];
  listRuns: OrchestrationHostCommandsV6['orchestration_list_runs_v6'];
  getRun: OrchestrationHostCommandsV6['orchestration_get_run_v6'];
  usage: OrchestrationHostCommandsV6['orchestration_run_usage_v6'];
  saveGraph: OrchestrationHostCommandsV6['orchestration_save_graph_v6'];
  saveProfile: OrchestrationHostCommandsV6['orchestration_save_profile_v6'];
  saveTeam: OrchestrationHostCommandsV6['orchestration_save_team_v6'];
  savePipeline: OrchestrationHostCommandsV6['orchestration_save_pipeline_v6'];
  saveLaunchCommand: OrchestrationHostCommandsV6['orchestration_save_launch_command_v6'];
  deleteProfile: OrchestrationHostCommandsV6['orchestration_delete_profile_v6'];
  deleteTeam: OrchestrationHostCommandsV6['orchestration_delete_team_v6'];
  deletePipeline: OrchestrationHostCommandsV6['orchestration_delete_pipeline_v6'];
  deleteLaunchCommand: OrchestrationHostCommandsV6['orchestration_delete_launch_command_v6'];
  startRun: OrchestrationHostCommandsV6['orchestration_start_run_v6'];
  controlFlow: OrchestrationHostCommandsV6['orchestration_control_flow_v6'];
  reconcileTask: OrchestrationHostCommandsV6['orchestration_reconcile_uncertain_task_v6'];
  retryTask: OrchestrationHostCommandsV6['orchestration_retry_uncertain_task_v6'];
  cancelRun: OrchestrationHostCommandsV6['orchestration_cancel_run_v6'];
  cancelTask: OrchestrationHostCommandsV6['orchestration_cancel_task_v6'];
}
export type AgentApiRequest = { [M in keyof AgentApiMethods]: {
  protocol: 1; method: M; params: Parameters<AgentApiMethods[M]> extends [] ? Record<string, never> : Parameters<AgentApiMethods[M]>[0];
} }[keyof AgentApiMethods];
export type AgentApiResponse<T> = { protocol: 1; ok: true; result: T } | { protocol: 1; ok: false; error: { code: string } };
