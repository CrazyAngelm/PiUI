import {
  orchestrationError,
  type DefinitionSummary,
  type OrchestrationClient,
  type OrchestrationRunV6,
  type PipelineInput,
  type RunInputValue,
} from '../../host-api/orchestrationClient';
import { performRunAction } from '../../features/orchestration/runActions';

interface Target {
  readonly commandId: string;
  readonly teamId: string;
  readonly pipelineId: string;
  readonly inputs: PipelineInput[];
}

/**
 * Starts a saved pipeline of one project on a person's request from a chat.
 * The run records a `chat` trigger; the chat's native history is untouched.
 * Trust and safe mode are enforced by the host like for any run start.
 */
export class RunLaunch {
  pipelines = $state.raw<readonly DefinitionSummary[]>([]);
  selectedId = $state('');
  inputs = $state.raw<PipelineInput[]>([]);
  loading = $state(false);
  busy = $state(false);
  error = $state('');

  /**
   * Reactive: `ready` and `needsInputs` read it first and short-circuit, so a
   * plain field would leave the dialog's buttons without a dependency on the
   * values that change once the target has loaded.
   */
  private target = $state.raw<Target | undefined>();
  private generation = 0;
  /** Kept until the start is confirmed, so a retry cannot start a second run. */
  private pendingRunId: string | undefined;

  constructor(
    readonly workspaceId: string,
    readonly sessionId: string | undefined,
    private readonly client: OrchestrationClient,
    readonly safeMode: boolean,
  ) {}

  get selected(): DefinitionSummary | undefined {
    return this.pipelines.find((pipeline) => pipeline.id === this.selectedId);
  }

  /** The target is loaded and it asks for run inputs. */
  get needsInputs(): boolean {
    return this.target?.commandId === this.selectedId && this.inputs.length > 0;
  }

  get ready(): boolean {
    return this.target?.commandId === this.selectedId && !this.loading;
  }

  async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.error = '';
    try {
      const catalog = await this.client.orchestration_catalog_v6({ workspaceId: this.workspaceId });
      if (generation !== this.generation) return;
      this.pipelines = catalog.launchCommands;
      const first = catalog.launchCommands[0];
      if (first) await this.select(first.id);
    } catch (error) {
      if (generation === this.generation) this.error = orchestrationError(error).message;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  async select(commandId: string): Promise<void> {
    const generation = ++this.generation;
    this.selectedId = commandId;
    this.pendingRunId = undefined;
    this.target = undefined;
    this.inputs = [];
    this.loading = true;
    this.error = '';
    try {
      const command = await this.client.orchestration_get_launch_command_v6({ workspaceId: this.workspaceId, id: commandId });
      const pipeline = command
        ? await this.client.orchestration_get_pipeline_v6({ workspaceId: this.workspaceId, id: command.value.pipelineId })
        : null;
      if (generation !== this.generation) return;
      if (!command || !pipeline) {
        this.error = 'This pipeline is no longer saved. Choose another one.';
        return;
      }
      const inputs = (pipeline.value.inputs ?? []).map((input) => ({ ...input }));
      this.target = { commandId, teamId: command.value.teamId, pipelineId: command.value.pipelineId, inputs };
      this.inputs = inputs;
    } catch (error) {
      if (generation === this.generation) this.error = orchestrationError(error).message;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  /** Starts the selected pipeline; returns the recorded run, or undefined with `error` set. */
  async start(values: Record<string, RunInputValue> | undefined): Promise<OrchestrationRunV6 | undefined> {
    const target = this.target;
    if (this.busy || !target || target.commandId !== this.selectedId) return undefined;
    this.busy = true;
    this.error = '';
    this.pendingRunId ??= crypto.randomUUID();
    try {
      const outcome = await performRunAction(
        this.client,
        {
          type: 'start',
          request: {
            workspaceId: this.workspaceId,
            runId: this.pendingRunId,
            teamId: target.teamId,
            pipelineId: target.pipelineId,
            launchCommandId: target.commandId,
            ...(values && Object.keys(values).length ? { inputs: values } : {}),
            trigger: { kind: 'chat', ...(this.sessionId ? { sessionId: this.sessionId } : {}) },
          },
        },
        this.safeMode,
      );
      if (outcome.type === 'unconfirmed') {
        this.error = outcome.error.message;
        return undefined;
      }
      this.pendingRunId = undefined;
      return outcome.run;
    } finally {
      this.busy = false;
    }
  }
}
