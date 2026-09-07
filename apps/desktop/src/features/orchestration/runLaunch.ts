import type { DefinitionSummary, StoredDefinition } from '../../../../../contracts/orchestration-host-v6';
import type { LaunchCommandReference } from '../../../../../contracts/orchestration-v6';

export interface RunLaunchSelection {
  readonly teamId: string;
  readonly pipelineId: string;
  readonly launchCommandId?: string;
}

export function initialRunLaunchSelection(
  command: StoredDefinition<LaunchCommandReference> | undefined,
): RunLaunchSelection {
  return command === undefined
    ? { teamId: '', pipelineId: '' }
    : { teamId: command.value.teamId, pipelineId: command.value.pipelineId, launchCommandId: command.value.id };
}

export function validateRunLaunchSelection(
  selection: RunLaunchSelection,
  teams: readonly DefinitionSummary[],
  pipelines: readonly DefinitionSummary[],
  command: StoredDefinition<LaunchCommandReference> | undefined,
): readonly string[] {
  const errors: string[] = [];
  if (selection.teamId === '') errors.push('Select a team.');
  else if (!teams.some((team) => team.id === selection.teamId)) errors.push('The selected team is no longer available.');
  if (selection.pipelineId === '') errors.push('Select a pipeline.');
  else if (!pipelines.some((pipeline) => pipeline.id === selection.pipelineId)) errors.push('The selected pipeline is no longer available.');
  if (command !== undefined && (
    selection.launchCommandId !== command.value.id
    || selection.teamId !== command.value.teamId
    || selection.pipelineId !== command.value.pipelineId
  )) errors.push('The named launch command must use its saved team and pipeline references.');
  return errors;
}
