import type { AgentProfile, OrchestrationRunV6, RunDefinitionSnapshot, StepExecutor } from '../../../../../contracts/orchestration-v6';
import type { AgentGraph } from '../../features/orchestration/agentGraph';
import { harnessConfiguration } from '../../harness-adapters';
import { nodeHasNoMember } from '../../features/orchestration/agentGraph';

// Presentation mirrors the native remote dispatcher's checks. The computer
// independently checks persisted definitions before every save or execution.
function supportedStep(executor: StepExecutor | undefined): boolean {
  return !executor || executor.type === 'agent' || executor.type === 'llm';
}

export function remoteHarnessSupported(harness: AgentProfile['harness']): boolean {
  return harnessConfiguration(harness).permissionModes.includes('read-only');
}

function supportedProfile(profile: AgentProfile): boolean {
  return remoteHarnessSupported(profile.harness) && profile.permissionMode === 'read-only' && !profile.networkAccess
    && !profile.resourceRules?.some((rule) => rule.enabled)
    && profile.toolPolicy.rules.every((rule) => rule.decision === 'deny')
    && profile.allowedSpawnProfileIds.length === 0;
}

export function remoteGraphIssue(graph: AgentGraph): string | undefined {
  if (graph.nodes.some((node) => !supportedStep(node.executor))) return 'Open the desktop app to save or run a pipeline with a script, plugin or nested pipeline.';
  if (graph.edges.some((edge) => edge.kind === 'spawn')) return 'Remove delegation links to save or run this pipeline from the browser.';
  if (graph.nodes.some((node) => !nodeHasNoMember(node) && !supportedProfile(node.profile))) {
    return 'Browser pipelines need read-only agents without network access, enabled resources, tool grants or delegation.';
  }
  return undefined;
}

export function remoteGraphSupported(graph: AgentGraph): boolean {
  return remoteGraphIssue(graph) === undefined;
}

export function remoteRunSupported(run: Pick<OrchestrationRunV6, 'definition' | 'pairedBrowser'>): boolean {
  return run.pairedBrowser === true && remoteDefinitionSupported(run.definition);
}

export function remoteDefinitionSupported(snapshot: RunDefinitionSnapshot): boolean {
  const command = snapshot.launchCommand;
  return command?.teamId === snapshot.team.id && command.pipelineId === snapshot.pipeline.id
    && snapshot.pipeline.steps.every((step) => supportedStep(step.executor))
    && snapshot.team.members.every(({ profileId }) => {
      const profile = snapshot.profiles.find((candidate) => candidate.id === profileId);
      return profile !== undefined && supportedProfile(profile);
    });
}
