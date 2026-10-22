import type { AgentGraph, GraphIssue } from './agentGraph';
import {
  formatIssue, mappingProblems, parentBreakage, reaches, SUBPIPELINE_ISSUE_TEMPLATES, SUBPIPELINE_ISSUES,
  type SubpipelineInfo, type SubpipelineParent,
} from '../../host-api/subpipelines';
import type { HarnessModelsResult } from '../../../../../contracts/harness-models-v18';
import type { AgentProfile } from '../../../../../contracts/orchestration-v6';
import { executorConfigurationErrors, profileConfigurationErrors } from '../../harness-adapters/validation';
export interface PreflightIssue { nodeId: string; message: string }
/** Catalog preflight is advisory freshness; the trusted host rechecks launch authority. Scripts have no native profile. */
export async function preflightGraph(graph: AgentGraph, catalog: (harness: AgentProfile['harness']) => Promise<HarnessModelsResult>): Promise<PreflightIssue[]> {
  const nativeNodes = graph.nodes.filter(node => (node.kind !== 'router' || node.router?.mode === 'agent') && node.executor?.type !== 'script' && node.executor?.type !== 'plugin' && node.executor?.type !== 'pipeline');
  const catalogs = new Map<AgentProfile['harness'], HarnessModelsResult>();
  const failed = new Set<AgentProfile['harness']>();
  await Promise.all([...new Set(nativeNodes.map(node => node.profile.harness))].map(async harness => {
    try { const result = await catalog(harness); if (result.harness !== harness) throw new Error('Catalog mismatch'); catalogs.set(harness,result); }
    catch { failed.add(harness); }
  }));
  const issues: PreflightIssue[] = [];
  for (const node of nativeNodes) {
    const add = (message: string) => issues.push({nodeId:node.id,message});
    const profile = node.profile;
    for (const message of profileConfigurationErrors(node.id,profile)) add(message);
    for (const message of executorConfigurationErrors(node.id,node.executor,profile)) add(message);
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

/**
 * Sub-pipeline checks (v6.7, ADR-042) against the saved pipelines the editor
 * has read: the named launch command still exists, running it does not come
 * back to this pipeline, and the mapping fits the child's declared inputs.
 * `saved` is the project's launch command ids (undefined while unknown);
 * a child that could not be read yet is not reported. The host checks
 * references, cycles and depth again when saving and when a step starts.
 */
export function subpipelineIssues(
  graph: AgentGraph,
  children: ReadonlyMap<string, SubpipelineInfo>,
  saved: ReadonlySet<string> | undefined,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const own = graph.nodes.flatMap(node => node.executor?.type === 'pipeline' ? [node.executor.launchCommandId] : []);
  const references = (id: string): readonly string[] | undefined => id === graph.id ? own : children.get(id)?.references;
  for (const node of graph.nodes) {
    const executor = node.executor;
    if (executor?.type !== 'pipeline' || !executor.launchCommandId.trim() || executor.launchCommandId === graph.id) continue;
    const add = (message: string) => { if (!issues.some(issue => issue.message === message && issue.nodeIds[0] === node.id)) issues.push({ message, nodeIds: [node.id] }); };
    if (saved !== undefined && !saved.has(executor.launchCommandId)) { add(SUBPIPELINE_ISSUES.missing); continue; }
    const child = children.get(executor.launchCommandId);
    if (child === undefined) continue;
    if (reaches(executor.launchCommandId, graph.id, references)) add(SUBPIPELINE_ISSUES.cycle);
    const dependencies = graph.edges.filter(edge => (edge.kind === 'result' || edge.kind === 'route') && edge.to === node.id).map(edge => edge.from);
    const fieldsOf = (id: string) => graph.nodes.find(candidate => candidate.id === id)?.resultFields ?? [];
    for (const problem of mappingProblems(executor, child, graph.inputs ?? [], dependencies, fieldsOf)) add(problem.message);
  }
  return issues;
}

/**
 * `subpipeline-breaks-parent` (v6.7) before saving: other saved pipelines
 * that run this one (the draft's launch command `graph.id`) as a
 * sub-pipeline, and whose input mapping or result fields the draft's inputs
 * and outputs would break while the saved version fits them
 * (`parentBreakage`). One issue lists them by name; the host refuses such a
 * save too. Parents not read yet are not reported.
 */
export function parentIssues(graph: AgentGraph, saved: ReadonlyMap<string, SubpipelineInfo>): GraphIssue[] {
  const parents: SubpipelineParent[] = [];
  for (const info of saved.values()) {
    if (info.commandId === graph.id || info.pipeline === undefined || !info.references.includes(graph.id)) continue;
    parents.push({ commandId: info.commandId, name: info.name, pipeline: info.pipeline });
  }
  if (parents.length === 0) return [];
  const previous = saved.get(graph.id);
  const broken = parentBreakage([graph.id], { inputs: graph.inputs ?? [], outputs: graph.outputs ?? [] }, parents, previous);
  if (broken.length === 0) return [];
  const names = broken.map(parent => `“${parent.name || 'Untitled pipeline'}”`).join(', ');
  return [{ message: formatIssue(SUBPIPELINE_ISSUE_TEMPLATES.breaksParent, names), nodeIds: [] }];
}
