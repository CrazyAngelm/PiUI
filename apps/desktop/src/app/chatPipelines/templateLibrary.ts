/**
 * Pipeline templates (ADR-040) are `piui-system` documents in the pipeline
 * library. They go through the same parser as import: a template becomes a
 * new unsaved draft with fresh ids, and saving it is the user's decision.
 */
import type { AgentProfile } from '../../host-api/orchestrationClient';
import type { PipelineTemplateV1 } from '../../host-api/pipelineLibraryClient';
import type { AgentGraph } from '../../features/orchestration/agentGraph';
import { graphToSystemFile, parseSystemFile, serializeSystemFile, systemFileToGraph } from '../../features/orchestration/systemFile';

/** A new draft from a template; throws the parser's message when the document is invalid. */
export function graphFromTemplate(template: Pick<PipelineTemplateV1, 'system' | 'name'>): AgentGraph {
  const graph = systemFileToGraph(parseSystemFile(JSON.stringify(template.system)));
  return { ...graph, name: graph.name || template.name };
}

/** The template document of a graph, validated by the export path. */
export function templateSystem(graph: AgentGraph): Record<string, unknown> {
  serializeSystemFile(graph);
  return graphToSystemFile(graph) as unknown as Record<string, unknown>;
}

/** Steps that run on a native model and have no model chosen yet. */
export function needsModel(node: AgentGraph['nodes'][number]): boolean {
  if (node.executor?.type === 'script' || node.executor?.type === 'plugin') return false;
  if (node.kind === 'router' && node.router?.mode === 'program') return false;
  return !node.profile.model.trim();
}

/**
 * Fills empty models with the first model of each harness's native catalog,
 * so a draft from a template can run at once. Chosen models are kept.
 */
export async function withDefaultModels(
  graph: AgentGraph,
  pick: (harness: AgentProfile['harness']) => Promise<Pick<AgentProfile, 'model' | 'modelProvider'> | undefined>,
): Promise<AgentGraph> {
  const harnesses = [...new Set(graph.nodes.filter(needsModel).map((node) => node.profile.harness))];
  const models = new Map(await Promise.all(harnesses.map(async (harness) => [harness, await pick(harness).catch(() => undefined)] as const)));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const model = needsModel(node) ? models.get(node.profile.harness) : undefined;
      return model ? { ...node, profile: { ...node.profile, ...model } } : node;
    }),
  };
}
