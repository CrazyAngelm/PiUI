/**
 * True only in the Nano Web remote bundle (ADR-062), where `host-api/transport`
 * is replaced by a relay to a paired computer. There the shell may call nothing
 * outside `NANO_REMOTE_COMMANDS`: entries that would need another command are
 * hidden, and starters answer their empty state without a host call. On the
 * desktop it is `false` and nothing changes.
 */
import { hostRemote, hostSupports } from '../../host-api/transport';
import type { PipelineSection, Route } from '../workspaceStore.svelte';

export { hostRemote as remoteMode, hostSupports };

/** The host advertises these commands before the shell mounts. Each section asks for its actual reads. */
export function pipelineSectionAvailable(section: PipelineSection): boolean {
  if (!hostRemote) return true;
  switch (section) {
    case 'systems': return hostSupports('orchestration_catalog_v6', 'orchestration_get_launch_command_v6', 'orchestration_get_pipeline_v6', 'orchestration_get_team_v6', 'orchestration_get_profile_v6');
    case 'agents': return hostSupports('orchestration_catalog_v6', 'orchestration_get_profile_v6');
    case 'teams': return hostSupports('orchestration_catalog_v6', 'orchestration_get_team_v6');
    case 'pipelines': return hostSupports('orchestration_catalog_v6', 'orchestration_get_pipeline_v6', 'orchestration_get_launch_command_v6');
    case 'runs': return hostSupports('orchestration_list_runs_v6', 'orchestration_get_run_v6', 'orchestration_run_usage_v6');
    case 'schedules': return hostSupports('orchestration_catalog_v6', 'orchestration_list_schedules_v7', 'orchestration_automations_v7');
  }
}

export function routeAvailable(route: Route): boolean {
  if (!hostRemote) return true;
  switch (route.name) {
    case 'pipelines': return pipelineSectionAvailable(route.section);
    case 'settings': return false;
    case 'board': return hostSupports('board_command_v1', 'teammates_command_v1');
    case 'team': return hostSupports('teammates_command_v1', 'board_command_v1');
    default: return true;
  }
}

export function remoteChatOnly(): boolean {
  const sections: PipelineSection[] = ['systems', 'agents', 'teams', 'pipelines', 'runs', 'schedules'];
  return hostRemote && !sections.some(pipelineSectionAvailable) && !hostSupports('board_command_v1', 'teammates_command_v1');
}

/** English source copy for an action the remote session refuses before it reaches the host. */
export const REMOTE_UNAVAILABLE_COPY = 'This is not available in a remote session.';
