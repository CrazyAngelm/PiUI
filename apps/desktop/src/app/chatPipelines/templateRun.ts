/**
 * A template chosen in the new-chat executor picker (ADR-053). It is a draft
 * graph until the first message: sending fills the models, saves the draft as
 * a new pipeline of the project (fresh ids, no overwrite) and runs it. The
 * graph builders and validators load on demand, outside the first-paint bundle.
 */
import type { HarnessKind } from '../../../../../contracts/workspace-v15';
import type { AgentGraph } from '../../features/orchestration/agentGraph';
import type { AgentProfile } from '../../host-api/orchestrationClient';
import type { PipelineTemplateV1 } from '../../host-api/pipelineLibraryClient';
import type { PipelineName } from '../../host-api/subpipelines';
import { harnessMeta } from '../harnessMeta';
import { TEMPLATES, type TemplateId } from '../pipelines/templateCatalog';
import { acceptsChat, replyStep } from './chatPipeline';
import { ChatPipelineError, type ChatPipelineDetail } from './chatPipelines.svelte';

type Translate = (value: string, parameters?: readonly unknown[]) => string;
export type ModelPick = (harness: AgentProfile['harness']) => Promise<Pick<AgentProfile, 'model' | 'modelProvider'> | undefined>;

export type TemplateChoice = { kind: 'builtin'; id: TemplateId } | { kind: 'saved'; template: PipelineTemplateV1 };

/** What the composer holds for a chosen template until it is sent. */
export interface TemplateDraft {
  readonly key: string;
  readonly name: string;
  readonly graph: AgentGraph;
  /** What the composer needs before anything is saved: inputs, whether chat messages are accepted, who answers. */
  readonly detail: ChatPipelineDetail;
}

/** `builtin:<TemplateId>` or `saved:<templateId>`: the id of a template executor. */
export function templateKey(choice: TemplateChoice): string {
  return choice.kind === 'builtin' ? `builtin:${choice.id}` : `saved:${choice.template.id}`;
}

/** The choice behind a template key; undefined when the template is gone. */
export function choiceFromKey(key: string, templates: readonly PipelineTemplateV1[]): TemplateChoice | undefined {
  const split = key.indexOf(':');
  const kind = key.slice(0, split);
  const id = key.slice(split + 1);
  if (kind === 'builtin') return TEMPLATES.some((template) => template.id === id) ? { kind: 'builtin', id: id as TemplateId } : undefined;
  if (kind === 'saved') {
    const template = templates.find((item) => item.id === id);
    return template ? { kind: 'saved', template } : undefined;
  }
  return undefined;
}

/** The detail the composer shows for an unsaved draft; ids stay empty until it is saved. */
export async function previewDetail(graph: AgentGraph): Promise<ChatPipelineDetail> {
  const { compileGraph } = await import('../../features/orchestration/agentGraph');
  const { pipeline } = compileGraph(graph);
  const inputs = pipeline.inputs ?? [];
  const step = replyStep(pipeline.steps);
  const profile = step ? graph.nodes.find((node) => node.id === step.id)?.profile : undefined;
  const model = profile?.model.trim();
  return {
    commandId: '',
    name: graph.name,
    teamId: '',
    pipelineId: '',
    inputs,
    accepts: acceptsChat(inputs),
    ...(step && profile
      ? {
          reply: {
            stepName: step.name || step.id,
            harness: profile.harness as HarnessKind,
            ...(model ? { model: { id: model, name: model, ...(profile.modelProvider ? { provider: profile.modelProvider } : {}) } } : {}),
          },
        }
      : {}),
  };
}

/** The draft of a template, built once; `harness` is the base harness of a built-in template's agents. */
export async function draftFromTemplate(
  choice: TemplateChoice,
  harness: AgentProfile['harness'],
  translate: Translate,
  pipelines: readonly PipelineName[] = [],
): Promise<TemplateDraft> {
  const graph =
    choice.kind === 'builtin'
      ? (await import('../pipelines/templates')).buildTemplate(choice.id, harness, translate)
      : (await import('./templateLibrary')).graphFromTemplate(choice.template, pipelines);
  return { key: templateKey(choice), name: graph.name, graph, detail: await previewDetail(graph) };
}

/** `Name`, else `Name 2`, `Name 3`… the first that no pipeline of the project uses (case-insensitive). */
export function uniquePipelineName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((item) => item.trim().toLowerCase()));
  const base = name.trim();
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The graph to save: a unique name, a default model for every step that needs
 * one, and the editor's own validation. Throws a `ChatPipelineError` with the
 * reason; nothing is saved here.
 */
export async function readyToSave(
  draft: TemplateDraft,
  pick: ModelPick,
  takenNames: readonly string[],
  translate: Translate | undefined = undefined,
): Promise<AgentGraph> {
  const [{ needsModel, withDefaultModels }, { graphIssues }] = await Promise.all([
    import('./templateLibrary'),
    import('../../features/orchestration/agentGraph'),
  ]);
  const named: AgentGraph = { ...draft.graph, name: uniquePipelineName(draft.graph.name, takenNames) };
  const graph = await withDefaultModels(named, pick);
  const missing = graph.nodes.find(needsModel);
  if (missing) {
    const label = harnessMeta(missing.profile.harness as HarnessKind).label;
    const message = 'This template needs a model, but {0} has none available.';
    throw new ChatPipelineError(translate ? translate(message, [label]) : message.replace('{0}', label));
  }
  const issue = graphIssues(graph)[0];
  if (issue) throw new ChatPipelineError(translate ? translate(issue.message) : issue.message);
  return graph;
}

const REMEMBER_KEY = 'piui.chat.templatePipelines.v1';

function readRemembered(): Record<string, Record<string, string>> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? 'null');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}

/** The pipeline a template was saved as in this project, if one was remembered. */
export function rememberedPipeline(workspaceId: string, key: string): string | undefined {
  const entry = readRemembered()[workspaceId];
  const id = entry && typeof entry === 'object' ? entry[key] : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

export function rememberPipeline(workspaceId: string, key: string, commandId: string): void {
  try {
    const all = readRemembered();
    all[workspaceId] = { ...all[workspaceId], [key]: commandId };
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(all));
  } catch {
    // Only the picker's row hiding is a convenience; the saved pipeline stays.
  }
}
