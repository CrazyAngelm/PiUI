/**
 * Schedules of one project. Saving never enables execution: enabling is a
 * separate, revision-bound request, exactly as the host contract requires.
 */
import {
  orchestrationError,
  type DefinitionSummary,
  type OrchestrationClient,
  type PipelineInput,
  type ScheduleDefinition,
  type ScheduleSnapshot,
} from '../../host-api/orchestrationClient';
import { automationsHost, type AutomationsClient } from '../../host-api/automationsClient';

export class AutomationsStore {
  schedules = $state.raw<readonly ScheduleSnapshot[]>([]);
  launchCommands = $state.raw<readonly DefinitionSummary[]>([]);
  /** Host v7.2: every automation is paused (from here or the tray). */
  paused = $state(false);
  loading = $state(false);
  error = $state('');
  busy = $state('');
  actionError = $state('');

  private generation = 0;
  private stops: (() => void)[] = [];
  private disposed = false;

  constructor(
    readonly workspaceId: string,
    readonly safeMode: boolean,
    private readonly client: OrchestrationClient,
    private readonly automations: AutomationsClient = automationsHost,
  ) {}

  start(): () => void {
    this.disposed = false;
    const generation = ++this.generation;
    const keep = (stop: () => void): void => {
      if (this.disposed || generation !== this.generation) stop();
      else this.stops.push(stop);
    };
    void this.client
      .listenSchedules((event) => {
        if (event.workspaceId === this.workspaceId) void this.refresh();
      })
      .then(keep)
      .catch(() => {
        // Without live events the list still refreshes after each action.
      });
    void this.automations
      .listen((event) => {
        this.paused = event.paused;
        void this.refresh();
      })
      .then(keep)
      .catch(() => {
        // The pause state is also read on every refresh.
      });
    void this.refresh();
    return () => this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    this.loading = true;
    this.error = '';
    try {
      const [schedules, catalog, automations] = await Promise.all([
        this.client.orchestration_list_schedules_v7({ workspaceId: this.workspaceId }),
        this.client.orchestration_catalog_v6({ workspaceId: this.workspaceId }),
        // An older host without the switch reads as "not paused".
        this.automations.state().catch(() => ({ paused: false })),
      ]);
      if (generation !== this.generation) return;
      this.schedules = [...schedules].sort((left, right) => left.value.name.localeCompare(right.value.name));
      this.launchCommands = catalog.launchCommands;
      this.paused = automations.paused;
    } catch (error) {
      if (generation === this.generation) this.error = orchestrationError(error).message;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  /** Pauses or resumes every automation of every project. */
  async setPaused(paused: boolean): Promise<boolean> {
    const next = await this.act('pause', () => this.automations.setPaused(paused));
    if (!next) return false;
    this.paused = next.paused;
    return true;
  }

  /** The run inputs the scheduled pipeline asks for (empty when it has none). */
  async pipelineInputs(launchCommandId: string): Promise<PipelineInput[]> {
    const command = await this.client.orchestration_get_launch_command_v6({ workspaceId: this.workspaceId, id: launchCommandId });
    if (!command) return [];
    const pipeline = await this.client.orchestration_get_pipeline_v6({ workspaceId: this.workspaceId, id: command.value.pipelineId });
    return pipeline?.value.inputs ? pipeline.value.inputs.map((input) => ({ ...input })) : [];
  }

  pipelineName(launchCommandId: string): string {
    return this.launchCommands.find((command) => command.id === launchCommandId)?.name ?? '';
  }

  private async act<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) return undefined;
    if (this.safeMode) {
      this.actionError = 'Safe mode keeps automations read-only.';
      return undefined;
    }
    this.busy = key;
    this.actionError = '';
    try {
      return await action();
    } catch (error) {
      this.actionError = orchestrationError(error).message;
      await this.refresh();
      return undefined;
    } finally {
      this.busy = '';
    }
  }

  /** Save, then optionally enable the saved revision in a second explicit request. */
  async save(value: ScheduleDefinition, enable: boolean): Promise<boolean> {
    const current = this.schedules.find((item) => item.value.id === value.id);
    const saved = await this.act(`save:${value.id}`, () =>
      this.client.orchestration_save_schedule_v7({ workspaceId: this.workspaceId, value, ...(current ? { expectedRevision: current.revision } : {}) }),
    );
    if (!saved) return false;
    this.replace(saved);
    if (enable && !saved.enabled) return this.setEnabled(saved, true);
    return true;
  }

  async setEnabled(schedule: ScheduleSnapshot, enabled: boolean): Promise<boolean> {
    const next = await this.act(`enable:${schedule.value.id}`, () =>
      this.client.orchestration_set_schedule_enabled_v7({ workspaceId: this.workspaceId, id: schedule.value.id, expectedRevision: schedule.revision, enabled }),
    );
    if (!next) return false;
    this.replace(next);
    return true;
  }

  async remove(schedule: ScheduleSnapshot): Promise<boolean> {
    const done = await this.act(`delete:${schedule.value.id}`, async () => {
      await this.client.orchestration_delete_schedule_v7({ workspaceId: this.workspaceId, id: schedule.value.id, expectedRevision: schedule.revision });
      return true;
    });
    if (!done) return false;
    this.schedules = this.schedules.filter((item) => item.value.id !== schedule.value.id);
    return true;
  }

  private replace(next: ScheduleSnapshot): void {
    const others = this.schedules.filter((item) => item.value.id !== next.value.id);
    this.schedules = [...others, next].sort((left, right) => left.value.name.localeCompare(right.value.name));
  }
}
