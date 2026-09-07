import { describe, expect, it } from 'vitest';
import type { DefinitionSummary, StoredDefinition } from '../../../../../contracts/orchestration-host-v5';
import type { LaunchCommandReference } from '../../../../../contracts/orchestration-v5';
import { initialRunLaunchSelection, validateRunLaunchSelection } from './runLaunch';

const teams: readonly DefinitionSummary[] = [{ id: 'team-a', name: 'Team A', revision: 1 }];
const pipelines: readonly DefinitionSummary[] = [{ id: 'pipeline-a', name: 'Pipeline A', revision: 2 }];
const command: StoredDefinition<LaunchCommandReference> = {
  revision: 3,
  value: { id: 'command-a', name: 'Release', teamId: 'team-a', pipelineId: 'pipeline-a' },
};

describe('run launch selection', () => {
  it('starts custom selection blank instead of inventing a team or pipeline', () => {
    expect(initialRunLaunchSelection(undefined)).toEqual({ teamId: '', pipelineId: '' });
    expect(validateRunLaunchSelection({ teamId: '', pipelineId: '' }, teams, pipelines, undefined)).toEqual([
      'Select a team.', 'Select a pipeline.',
    ]);
  });

  it('uses exact named-command references and rejects missing catalog definitions', () => {
    const selection = initialRunLaunchSelection(command);
    expect(selection).toEqual({ teamId: 'team-a', pipelineId: 'pipeline-a', launchCommandId: 'command-a' });
    expect(validateRunLaunchSelection(selection, teams, pipelines, command)).toEqual([]);
    expect(validateRunLaunchSelection(selection, [], pipelines, command)).toEqual(['The selected team is no longer available.']);
  });

  it('rejects changing a named command reference', () => {
    expect(validateRunLaunchSelection(
      { teamId: 'team-a', pipelineId: 'pipeline-a', launchCommandId: 'other' }, teams, pipelines, command,
    )).toEqual(['The named launch command must use its saved team and pipeline references.']);
  });
});
