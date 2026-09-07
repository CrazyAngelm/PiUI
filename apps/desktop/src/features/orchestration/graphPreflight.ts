import type { AgentGraph } from './agentGraph';
import type { HarnessModelsResult } from '../../../../../contracts/harness-models-v18';
import type { AgentProfile } from '../../../../../contracts/orchestration-v6';
import { profileConfigurationErrors } from '../../harness-adapters/validation';
export interface PreflightIssue { nodeId: string; message: string }
/** Catalog preflight is advisory freshness; the trusted host rechecks launch authority. */
export async function preflightGraph(graph: AgentGraph, catalog: (harness: AgentProfile['harness']) => Promise<HarnessModelsResult>): Promise<PreflightIssue[]> {
  const catalogs = new Map<AgentProfile['harness'], HarnessModelsResult>();
  const failed = new Set<AgentProfile['harness']>();
  await Promise.all([...new Set(graph.nodes.map(node => node.profile.harness))].map(async harness => {
    try { const result = await catalog(harness); if (result.harness !== harness) throw new Error('Catalog mismatch'); catalogs.set(harness,result); }
    catch { failed.add(harness); }
  }));
  const issues: PreflightIssue[] = [];
  for (const node of graph.nodes) {
    const add = (message: string) => issues.push({nodeId:node.id,message});
    const profile = node.profile;
    for (const message of profileConfigurationErrors(node.id,profile)) add(message);
    if (failed.has(profile.harness)) { add('Could not verify the native catalog. Check the harness connection.'); continue; }
    const models = catalogs.get(profile.harness);
    const model = models?.models.find(model => model.id === profile.model && model.provider === profile.modelProvider);
    if (!model) add('The selected model is not in the native catalog.');
    if (profile.reasoning && !model?.thinkingLevels?.includes(profile.reasoning)) add('The selected reasoning level is unavailable for this model.');
    if (profile.serviceTier === 'fast' && !model?.supportsFast) add('Fast is unavailable for this model.');
    for (const rule of profile.resourceRules ?? []) {
      const resource = models?.resources.items.find(item => item.id === rule.id && item.kind === rule.kind);
      if (!resource || !resource.configurable) add('A selected resource is unavailable or cannot be configured per agent.');
    }
  }
  return issues;
}
