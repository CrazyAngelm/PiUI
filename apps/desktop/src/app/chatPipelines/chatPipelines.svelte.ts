/**
 * Chat pipelines (ADR-040): a chat whose messages start a saved pipeline of
 * its project. The chat itself is an ordinary workspace session (the harness
 * of the pipeline's answering step), so follow-ups talk to that agent
 * directly. Runs are started through orchestration v6 with a `chat` trigger
 * and the `message` input; the pipeline library remembers which runs belong
 * to which chat. Native histories are never rewritten: a finished run's
 * result reaches the chat's agent only inside the person's next message.
 */
import { SvelteSet } from 'svelte/reactivity';
import type { HarnessKind, PermissionMode, WorkspaceModel } from '../../../../../contracts/workspace-v15';
import {
  orchestrationError,
  orchestrationHost,
  type DefinitionSummary,
  type OrchestrationClient,
  type OrchestrationRunV6,
  type PipelineInput,
  type RunInputValue,
} from '../../host-api/orchestrationClient';
import { pipelineLibraryHost, type ChatPipelineV1, type PipelineLibraryCommandV1, type PipelineLibraryResultV1, type PipelineTemplateV1 } from '../../host-api/pipelineLibraryClient';
import { resolveRunInputs } from '../../host-api/runInputs';
import { readWorkspaceHistory } from '../../host-api/workspaceHistory';
import { performRunAction } from '../../features/orchestration/runActions';
import { formatValue } from '../runs/runPresentation';
import { acceptsChat, answerTask, chatInput, extraInputs, replyStep, runMessage, withPipelineContext, type PipelineContext } from './chatPipeline';

export interface PipelineLibraryClient {
  request(command: PipelineLibraryCommandV1): Promise<PipelineLibraryResultV1>;
}

/** Everything a chat needs to send through one saved pipeline. */
export interface ChatPipelineDetail {
  readonly commandId: string;
  readonly name: string;
  readonly teamId: string;
  readonly pipelineId: string;
  readonly inputs: readonly PipelineInput[];
  readonly accepts: boolean;
  /** The agent that answers and then continues the chat. */
  readonly reply?: { readonly stepName: string; readonly harness: HarnessKind; readonly model?: WorkspaceModel };
}

export interface ProjectLibrary {
  readonly templates: readonly PipelineTemplateV1[];
  readonly chatDefault?: string;
}

/** What starting a chat needs from the workspace store (kept narrow for tests). */
export interface ChatCreator {
  createChat(
    request: { workspaceId: string; harness: HarnessKind; model?: WorkspaceModel; permissionMode: PermissionMode; text: string },
    options: { open: boolean; title?: string },
  ): Promise<{ sessionId: string; error?: string }>;
}

export class ChatPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatPipelineError';
  }
}

const TERMINAL = new Set<OrchestrationRunV6['status']>(['succeeded', 'failed', 'cancelled']);

export function runFinished(run: OrchestrationRunV6 | undefined): boolean {
  return run !== undefined && TERMINAL.has(run.status);
}

export class ChatPipelinesStore {
  /** Launch commands per project. */
  commands = $state<Record<string, readonly DefinitionSummary[]>>({});
  commandErrors = $state<Record<string, string>>({});
  /** Keyed `${workspaceId}:${commandId}`. */
  details = $state<Record<string, ChatPipelineDetail>>({});
  libraries = $state<Record<string, ProjectLibrary>>({});
  /** Pipeline binding per chat; null once known to have none. */
  chats = $state<Record<string, ChatPipelineV1 | null>>({});
  runs = $state<Record<string, OrchestrationRunV6>>({});
  /** Answer text per finished run. */
  answers = $state<Record<string, string>>({});
  readonly loadingProjects = new SvelteSet<string>();

  private stopLive: (() => void) | undefined;
  private liveStarting = false;
  private readonly pendingDetails = new Map<string, Promise<ChatPipelineDetail>>();
  private readonly pendingAnswers = new Map<string, Promise<string>>();

  constructor(
    private readonly client: OrchestrationClient = orchestrationHost,
    private readonly library: PipelineLibraryClient = pipelineLibraryHost,
    private readonly readHistory: typeof readWorkspaceHistory = readWorkspaceHistory,
  ) {}

  private detailKey(workspaceId: string, commandId: string): string {
    return `${workspaceId}:${commandId}`;
  }

  detailFor(workspaceId: string, commandId: string | undefined): ChatPipelineDetail | undefined {
    return commandId ? this.details[this.detailKey(workspaceId, commandId)] : undefined;
  }

  /** Saved pipelines of a project with their chat readiness, plus its library. */
  async loadProject(workspaceId: string): Promise<void> {
    if (!workspaceId || this.loadingProjects.has(workspaceId)) return;
    this.loadingProjects.add(workspaceId);
    try {
      const [catalog] = await Promise.all([
        this.client.orchestration_catalog_v6({ workspaceId }).catch((cause: unknown) => {
          this.commandErrors = { ...this.commandErrors, [workspaceId]: orchestrationError(cause).message };
          return undefined;
        }),
        this.loadLibrary(workspaceId),
      ]);
      if (!catalog) return;
      const { [workspaceId]: _cleared, ...errors } = this.commandErrors;
      this.commandErrors = errors;
      this.commands = { ...this.commands, [workspaceId]: catalog.launchCommands };
      await Promise.all(catalog.launchCommands.map((command) => this.detail(workspaceId, command.id, true).catch(() => undefined)));
    } finally {
      this.loadingProjects.delete(workspaceId);
    }
  }

  async loadLibrary(workspaceId: string): Promise<ProjectLibrary | undefined> {
    try {
      const result = await this.library.request({ type: 'list', workspaceId });
      if (result.type !== 'library') return undefined;
      const library: ProjectLibrary = { templates: result.templates, ...(result.chatDefault ? { chatDefault: result.chatDefault } : {}) };
      this.libraries = { ...this.libraries, [workspaceId]: library };
      return library;
    } catch {
      // The library is optional: pipelines still load and chats stay direct.
      return undefined;
    }
  }

  /** Loads (or reloads with `fresh`) the definitions behind one launch command. */
  detail(workspaceId: string, commandId: string, fresh = false): Promise<ChatPipelineDetail> {
    const key = this.detailKey(workspaceId, commandId);
    const known = this.details[key];
    if (known && !fresh) return Promise.resolve(known);
    const pending = this.pendingDetails.get(key);
    if (pending) return pending;
    const load = this.fetchDetail(workspaceId, commandId).finally(() => this.pendingDetails.delete(key));
    this.pendingDetails.set(key, load);
    return load;
  }

  private async fetchDetail(workspaceId: string, commandId: string): Promise<ChatPipelineDetail> {
    let detail: ChatPipelineDetail;
    try {
      const command = await this.client.orchestration_get_launch_command_v6({ workspaceId, id: commandId });
      if (!command) throw new ChatPipelineError('This pipeline is no longer saved. Choose another one.');
      const [pipeline, team] = await Promise.all([
        this.client.orchestration_get_pipeline_v6({ workspaceId, id: command.value.pipelineId }),
        this.client.orchestration_get_team_v6({ workspaceId, id: command.value.teamId }),
      ]);
      if (!pipeline || !team) throw new ChatPipelineError('This pipeline is no longer saved. Choose another one.');
      const step = replyStep(pipeline.value.steps);
      const member = step ? team.value.members.find((item) => item.id === step.assignedMemberId) : undefined;
      const profile = member ? await this.client.orchestration_get_profile_v6({ workspaceId, id: member.profileId }) : null;
      const inputs = pipeline.value.inputs ?? [];
      const model = profile?.value.model.trim();
      detail = {
        commandId,
        name: command.value.name || pipeline.value.name,
        teamId: command.value.teamId,
        pipelineId: command.value.pipelineId,
        inputs,
        accepts: acceptsChat(inputs),
        ...(step && profile
          ? {
              reply: {
                stepName: step.name || step.id,
                harness: profile.value.harness as HarnessKind,
                ...(model ? { model: { id: model, name: model, ...(profile.value.modelProvider ? { provider: profile.value.modelProvider } : {}) } } : {}),
              },
            }
          : {}),
      };
    } catch (cause) {
      throw cause instanceof ChatPipelineError ? cause : new ChatPipelineError(orchestrationError(cause).message);
    }
    this.details = { ...this.details, [this.detailKey(workspaceId, commandId)]: detail };
    return detail;
  }

  async setChatDefault(workspaceId: string, commandId: string | undefined): Promise<void> {
    const result = await this.library.request({ type: 'setChatDefault', workspaceId, ...(commandId ? { launchCommandId: commandId } : {}) });
    if (result.type === 'library') {
      this.libraries = { ...this.libraries, [workspaceId]: { templates: result.templates, ...(result.chatDefault ? { chatDefault: result.chatDefault } : {}) } };
    }
  }

  // ---- chats ----------------------------------------------------------

  async loadChat(sessionId: string): Promise<ChatPipelineV1 | null> {
    try {
      const result = await this.library.request({ type: 'chat', sessionId });
      const chat = result.type === 'chat' ? result.chat : null;
      this.putChat(sessionId, chat);
      if (chat) void this.loadRuns(chat);
      return chat;
    } catch {
      this.putChat(sessionId, null);
      return null;
    }
  }

  private putChat(sessionId: string, chat: ChatPipelineV1 | null): void {
    this.chats = { ...this.chats, [sessionId]: chat };
  }

  async setChatPipeline(sessionId: string, workspaceId: string, commandId: string | undefined): Promise<void> {
    const result = await this.library.request({ type: 'setChatPipeline', sessionId, workspaceId, ...(commandId ? { launchCommandId: commandId } : {}) });
    if (result.type === 'chat') this.putChat(sessionId, result.chat);
  }

  private async loadRuns(chat: ChatPipelineV1): Promise<void> {
    this.ensureLive();
    await Promise.all(chat.runs.filter((entry) => !runFinished(this.runs[entry.runId])).map((entry) => this.refreshRun(chat.workspaceId, entry.runId)));
  }

  async refreshRun(workspaceId: string, runId: string): Promise<void> {
    try {
      const run = await this.client.orchestration_get_run_v6({ workspaceId, runId });
      if (run) this.putRun(run);
    } catch {
      // The card keeps its last known state and offers to open the run.
    }
  }

  private putRun(run: OrchestrationRunV6): void {
    const known = this.runs[run.id];
    if (known && known.revision > run.revision) return;
    this.runs = { ...this.runs, [run.id]: run };
    if (run.status === 'succeeded' && this.answers[run.id] === undefined) void this.answer(run);
  }

  private ensureLive(): void {
    if (this.stopLive || this.liveStarting) return;
    this.liveStarting = true;
    void this.client
      .listen((event) => {
        if (this.runs[event.runId] && event.revision > (this.runs[event.runId]?.revision ?? -1)) void this.refreshRun(event.workspaceId, event.runId);
      })
      .then(
        (stop) => {
          this.stopLive = stop;
        },
        () => undefined,
      )
      .finally(() => {
        this.liveStarting = false;
      });
  }

  /** The answering step's final text: a script's output or the agent's last answer. */
  answer(run: OrchestrationRunV6): Promise<string> {
    const known = this.answers[run.id];
    if (known !== undefined) return Promise.resolve(known);
    const pending = this.pendingAnswers.get(run.id);
    if (pending) return pending;
    const load = this.fetchAnswer(run)
      .then((text) => {
        this.answers = { ...this.answers, [run.id]: text };
        return text;
      })
      .finally(() => this.pendingAnswers.delete(run.id));
    this.pendingAnswers.set(run.id, load);
    return load;
  }

  private async fetchAnswer(run: OrchestrationRunV6): Promise<string> {
    const found = answerTask(run);
    if (!found) return '';
    const { task } = found;
    if (task.output?.text) return task.output.text;
    const sessionId = task.resultReference?.sessionId ?? task.execution?.id;
    if (sessionId && found.step.executor?.type !== 'script' && found.step.executor?.type !== 'plugin') {
      try {
        const blocks = await this.readHistory(sessionId);
        const answers = blocks.filter((block) => block.kind === 'assistant' && block.text);
        const exact = task.resultReference?.blockId ? answers.find((block) => block.id === task.resultReference?.blockId) : undefined;
        const text = (exact ?? answers.at(-1))?.text;
        if (text) return text;
      } catch {
        // Fall back to the recorded result fields below.
      }
    }
    return task.resultData ? formatValue(task.resultData) : '';
  }

  // ---- sending --------------------------------------------------------

  /**
   * Creates the chat (the answering agent's harness) and starts the first
   * run for its message. Returns the new chat id.
   */
  async startChat(
    creator: ChatCreator,
    request: {
      workspaceId: string;
      commandId: string;
      text: string;
      values: Readonly<Record<string, RunInputValue>>;
      permissionMode: PermissionMode;
      /** Used when the pipeline has no agent step to continue with. */
      fallbackHarness: HarnessKind;
      available: readonly HarnessKind[];
      safeMode: boolean;
      title: string;
    },
  ): Promise<string> {
    const detail = await this.detail(request.workspaceId, request.commandId, true);
    const inputs = this.checkedInputs(detail, request.text, request.values);
    const harness = detail.reply && request.available.includes(detail.reply.harness) ? detail.reply.harness : request.fallbackHarness;
    const model = detail.reply?.harness === harness ? detail.reply.model : undefined;
    const { sessionId } = await creator.createChat(
      { workspaceId: request.workspaceId, harness, permissionMode: request.permissionMode, text: '', ...(model ? { model } : {}) },
      { open: true, title: request.title },
    );
    // Only the first message goes through the pipeline; follow-ups talk to the chat's agent.
    await this.startRun(detail, request.workspaceId, sessionId, inputs, request.safeMode);
    return sessionId;
  }

  /** Starts a run of the chat's pipeline for one message. */
  async send(request: {
    workspaceId: string;
    sessionId: string;
    commandId: string;
    text: string;
    values: Readonly<Record<string, RunInputValue>>;
    safeMode: boolean;
  }): Promise<OrchestrationRunV6> {
    const detail = await this.detail(request.workspaceId, request.commandId, true);
    return this.startRun(detail, request.workspaceId, request.sessionId, this.checkedInputs(detail, request.text, request.values), request.safeMode);
  }

  /** Starts the same pipeline again with a finished run's inputs. */
  async repeat(workspaceId: string, sessionId: string, run: OrchestrationRunV6, safeMode: boolean): Promise<OrchestrationRunV6> {
    const commandId = run.definition.launchCommand?.id;
    if (!commandId) throw new ChatPipelineError('This run was not started from a saved pipeline.');
    const detail = await this.detail(workspaceId, commandId, true);
    const values = Object.fromEntries(Object.entries(run.inputs ?? {}).filter(([name]) => detail.inputs.some((input) => input.name === name)));
    return this.startRun(detail, workspaceId, sessionId, this.checkedInputs(detail, runMessage(run), values), safeMode);
  }

  private checkedInputs(detail: ChatPipelineDetail, text: string, values: Readonly<Record<string, RunInputValue>>): Record<string, RunInputValue> {
    const chat = chatInput(detail.inputs);
    if (!chat) throw new ChatPipelineError('This pipeline does not accept chat messages. Add a message input to its start.');
    const known = new Set(extraInputs(detail.inputs).map((input) => input.name));
    const inputs: Record<string, RunInputValue> = { [chat.name]: text };
    for (const [name, value] of Object.entries(values)) if (known.has(name)) inputs[name] = value;
    const resolved = resolveRunInputs(detail.inputs, inputs);
    if (!resolved.ok) {
      const error = resolved.error;
      throw new ChatPipelineError(
        error.kind === 'too-long' || error.kind === 'total-too-long'
          ? 'The message is too long for a pipeline run.'
          : error.kind === 'missing-required'
            ? 'Fill in the pipeline inputs before sending.'
            : 'Check the pipeline inputs before sending.',
      );
    }
    return inputs;
  }

  private async startRun(
    detail: ChatPipelineDetail,
    workspaceId: string,
    sessionId: string,
    inputs: Record<string, RunInputValue>,
    safeMode: boolean,
  ): Promise<OrchestrationRunV6> {
    const outcome = await performRunAction(
      this.client,
      {
        type: 'start',
        request: {
          workspaceId,
          runId: crypto.randomUUID(),
          teamId: detail.teamId,
          pipelineId: detail.pipelineId,
          launchCommandId: detail.commandId,
          inputs,
          trigger: { kind: 'chat', sessionId },
        },
      },
      safeMode,
    );
    if (outcome.type === 'unconfirmed') throw new ChatPipelineError(outcome.error.message);
    this.ensureLive();
    this.putRun(outcome.run);
    try {
      const result = await this.library.request({ type: 'recordChatRun', sessionId, workspaceId, runId: outcome.run.id });
      if (result.type === 'chat') this.putChat(sessionId, result.chat);
    } catch {
      // The run started; only its place in this chat was not remembered.
      throw new ChatPipelineError('The run started, but this chat could not remember it. Find it in Runs.');
    }
    return outcome.run;
  }

  /** Finished runs whose result the chat's agent has not been given yet. */
  pendingResults(sessionId: string): OrchestrationRunV6[] {
    const chat = this.chats[sessionId];
    if (!chat) return [];
    return chat.runs
      .filter((entry) => !entry.consumed)
      .map((entry) => this.runs[entry.runId])
      .filter((run): run is OrchestrationRunV6 => runFinished(run));
  }

  /** The person's message with the pending results in front, and the runs it hands on. */
  async withResults(sessionId: string, text: string): Promise<{ text: string; runIds: string[] }> {
    const pending = this.pendingResults(sessionId);
    const succeeded = pending.filter((run) => run.status === 'succeeded');
    const contexts: PipelineContext[] = await Promise.all(
      succeeded.map(async (run) => ({
        pipelineName: run.definition.launchCommand?.name ?? run.definition.pipeline.name,
        runId: run.id,
        request: runMessage(run),
        result: await this.answer(run).catch(() => ''),
      })),
    );
    return { text: contexts.length ? withPipelineContext(contexts, text) : text, runIds: pending.map((run) => run.id) };
  }

  async consume(sessionId: string, runIds: readonly string[]): Promise<void> {
    if (!runIds.length) return;
    try {
      const result = await this.library.request({ type: 'consumeChatRuns', sessionId, runIds: [...runIds] });
      if (result.type === 'chat') this.putChat(sessionId, result.chat);
    } catch {
      // A later message would hand the same result on again; nothing is lost.
    }
  }

  dispose(): void {
    this.stopLive?.();
    this.stopLive = undefined;
  }
}

export const chatPipelines = new ChatPipelinesStore();
