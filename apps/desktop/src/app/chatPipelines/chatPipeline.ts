/**
 * Pure rules of chat pipelines (ADR-040): which saved pipelines a chat can
 * send through, which step answers the chat, and the labelled context block
 * that hands a finished run's result to the chat's own harness. Nothing here
 * reads or writes native history; the host stays the authority for inputs.
 */
import type { OrchestrationRunV6, PipelineInput, PipelineStep, RunInputValue, TaskRecord } from '../../host-api/orchestrationClient';

/** The name of the run input a pipeline adds to accept chat messages. */
export const CHAT_INPUT = 'message';
/** Most characters of one run result handed on to the chat. */
export const MAX_CONTEXT_RESULT_CHARS = 24_000;

const textual = (input: PipelineInput): boolean => input.kind === 'text' || input.kind === 'long-text';

/**
 * The run input a chat message fills: the text input named `message`, else
 * the only text input the pipeline declares (a template's `task`). Every
 * step receives it as labelled task context.
 */
export function chatInput(inputs: readonly PipelineInput[] | undefined): PipelineInput | undefined {
  const text = (inputs ?? []).filter(textual);
  return text.find((input) => input.name === CHAT_INPUT) ?? (text.length === 1 ? text[0] : undefined);
}

/** A pipeline accepts chat messages when it has a chat input. */
export function acceptsChat(inputs: readonly PipelineInput[] | undefined): boolean {
  return chatInput(inputs) !== undefined;
}

/** The declared `message` input a pipeline gets when it starts accepting chat messages. */
export function chatMessageInput(label: string, description: string): PipelineInput {
  return { name: CHAT_INPUT, label, kind: 'long-text', required: true, description };
}

/** Adds the chat input first; an existing `message` input is kept as it is. */
export function withChatInput(inputs: readonly PipelineInput[] | undefined, input: PipelineInput): PipelineInput[] {
  const list = [...(inputs ?? [])];
  return list.some((item) => item.name === CHAT_INPUT) ? list : [input, ...list];
}

/** Inputs the person fills besides the message. */
export function extraInputs(inputs: readonly PipelineInput[] | undefined): PipelineInput[] {
  const chat = chatInput(inputs);
  return (inputs ?? []).filter((input) => input !== chat);
}

/** Required extra inputs that have neither a value nor a default. */
export function missingInputs(inputs: readonly PipelineInput[], values: Readonly<Record<string, RunInputValue>>): string[] {
  return extraInputs(inputs)
    .filter((input) => input.required)
    .filter((input) => {
      const value = Object.hasOwn(values, input.name) ? values[input.name] : input.defaultValue;
      return value === undefined || (typeof value === 'string' && value.trim() === '');
    })
    .map((input) => input.name);
}

const answers = (step: PipelineStep): boolean =>
  !step.router && step.executionMode !== 'callable' && (step.executor === undefined || step.executor.type === 'agent' || step.executor.type === 'llm');

/**
 * Steps no other step waits for, in pipeline order. Routers and callable
 * templates never end a chat turn.
 */
export function finalSteps(steps: readonly PipelineStep[]): PipelineStep[] {
  const awaited = new Set(steps.flatMap((step) => [...step.dependencyStepIds, ...(step.router ? [step.router.inputStepId] : [])]));
  return steps.filter((step) => !awaited.has(step.id) && !step.router && step.executionMode !== 'callable');
}

/**
 * The step whose agent continues the chat after a run: the last final step
 * run by an agent, else the last agent step of the pipeline.
 */
export function replyStep(steps: readonly PipelineStep[]): PipelineStep | undefined {
  const final = finalSteps(steps).filter(answers);
  return final.at(-1) ?? steps.filter(answers).at(-1);
}

/**
 * The finished step that answers this run: the last final step that
 * succeeded (a router may have skipped the others), else the last step that
 * succeeded at all.
 */
export function answerTask(run: Pick<OrchestrationRunV6, 'definition' | 'tasks'>): { step: PipelineStep; task: TaskRecord } | undefined {
  const tasks = new Map(run.tasks.map((task) => [task.stepId, task]));
  const done = (step: PipelineStep) => tasks.get(step.id)?.status === 'succeeded';
  const steps = run.definition.pipeline.steps;
  const step = finalSteps(steps).filter(done).at(-1) ?? steps.filter(done).at(-1);
  const task = step ? tasks.get(step.id) : undefined;
  return step && task ? { step, task } : undefined;
}

export function runMessage(run: Pick<OrchestrationRunV6, 'inputs' | 'definition'>): string {
  const name = chatInput(run.definition.pipeline.inputs)?.name;
  const value = name ? run.inputs?.[name] : undefined;
  return typeof value === 'string' ? value : '';
}

const OPEN = '[PiUI pipeline result';
const CLOSE = '[/PiUI pipeline result]';

export interface PipelineContext {
  readonly pipelineName: string;
  readonly runId: string;
  readonly request: string;
  readonly result: string;
}

function bounded(text: string): string {
  return text.length > MAX_CONTEXT_RESULT_CHARS ? `${text.slice(0, MAX_CONTEXT_RESULT_CHARS)}\n…(truncated)` : text;
}

/** One labelled block per run, then the person's message. */
export function withPipelineContext(contexts: readonly PipelineContext[], text: string): string {
  const blocks = contexts.map(
    (context) =>
      `${OPEN} — pipeline "${context.pipelineName.replaceAll('"', "'")}", run ${context.runId}]\nRequest:\n${context.request.trim()}\n\nResult:\n${bounded(context.result.trim()) || '(no text result)'}\n${CLOSE}`,
  );
  return [...blocks, text].join('\n\n');
}

export interface SplitMessage {
  readonly contexts: readonly { readonly pipelineName: string; readonly body: string }[];
  readonly text: string;
}

/** Separates leading pipeline result blocks from what the person wrote. */
export function splitPipelineContext(message: string): SplitMessage {
  const contexts: { pipelineName: string; body: string }[] = [];
  let rest = message;
  while (rest.startsWith(OPEN)) {
    const headerEnd = rest.indexOf(']\n');
    const close = rest.indexOf(CLOSE);
    if (headerEnd < 0 || close < headerEnd) break;
    const header = rest.slice(OPEN.length, headerEnd);
    const name = /pipeline "([^"]*)"/u.exec(header)?.[1] ?? '';
    contexts.push({ pipelineName: name, body: rest.slice(headerEnd + 2, close).trimEnd() });
    rest = rest.slice(close + CLOSE.length).replace(/^\n{1,2}/u, '');
  }
  return { contexts, text: rest };
}
