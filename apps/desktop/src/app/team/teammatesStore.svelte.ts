/**
 * Teammates per project (ADR-041): `@handle` addresses that resolve to one
 * saved launch command. Loaded on demand; every host change reloads the
 * project's list.
 */
import {
  teammatesError,
  teammatesHost,
  type TeammateDraftV1,
  type TeammatesClient,
  type TeammateStatusV1,
  type TeammateV1,
} from '../../host-api/teammatesClient';

export interface ProjectTeam {
  readonly teammates: readonly TeammateV1[];
  readonly status: readonly TeammateStatusV1[];
}

const EMPTY: ProjectTeam = { teammates: [], status: [] };

export class TeammatesStore {
  teams = $state.raw<Record<string, ProjectTeam>>({});
  errors = $state.raw<Record<string, string>>({});
  loading = $state.raw<Record<string, boolean>>({});
  private readonly serials = new Map<string, number>();
  private listening: Promise<void> | undefined;

  constructor(private readonly client: TeammatesClient = teammatesHost) {}

  team(workspaceId: string): ProjectTeam {
    return this.teams[workspaceId] ?? EMPTY;
  }

  list(workspaceId: string): readonly TeammateV1[] {
    return this.team(workspaceId).teammates;
  }

  get(workspaceId: string, teammateId: string | undefined): TeammateV1 | undefined {
    return teammateId === undefined ? undefined : this.list(workspaceId).find((teammate) => teammate.id === teammateId);
  }

  status(workspaceId: string, teammateId: string): TeammateStatusV1 | undefined {
    return this.team(workspaceId).status.find((item) => item.teammateId === teammateId);
  }

  /** The teammate that owns this launch command (a chat's executor), if any. */
  byLaunchCommand(workspaceId: string, launchCommandId: string | undefined): TeammateV1 | undefined {
    return launchCommandId === undefined ? undefined : this.list(workspaceId).find((teammate) => teammate.launchCommandId === launchCommandId);
  }

  /** Loads once per project; `force` reloads. */
  ensure(workspaceId: string, force = false): Promise<void> {
    this.listen();
    if (!workspaceId || (!force && (this.teams[workspaceId] !== undefined || this.loading[workspaceId]))) return Promise.resolve();
    return this.load(workspaceId);
  }

  async load(workspaceId: string): Promise<void> {
    const serial = (this.serials.get(workspaceId) ?? 0) + 1;
    this.serials.set(workspaceId, serial);
    this.loading = { ...this.loading, [workspaceId]: true };
    try {
      const result = await this.client.request({ type: 'list', workspaceId });
      if (this.serials.get(workspaceId) !== serial) return;
      if (result.type === 'teammates') this.teams = { ...this.teams, [workspaceId]: { teammates: result.teammates, status: result.status } };
      const { [workspaceId]: _cleared, ...rest } = this.errors;
      this.errors = rest;
    } catch (cause) {
      if (this.serials.get(workspaceId) === serial) this.errors = { ...this.errors, [workspaceId]: teammatesError(cause).message };
    } finally {
      if (this.serials.get(workspaceId) === serial) {
        const { [workspaceId]: _done, ...rest } = this.loading;
        this.loading = rest;
      }
    }
  }

  async save(workspaceId: string, draft: TeammateDraftV1): Promise<TeammateV1> {
    try {
      const result = await this.client.request({ type: 'save', workspaceId, teammate: draft });
      if (result.type !== 'teammate') throw teammatesError(undefined);
      this.replace(workspaceId, result.teammate, result.status);
      return result.teammate;
    } catch (cause) {
      throw teammatesError(cause);
    }
  }

  async remove(workspaceId: string, teammate: TeammateV1): Promise<void> {
    try {
      await this.client.request({ type: 'delete', workspaceId, teammateId: teammate.id, expectedRevision: teammate.revision });
    } catch (cause) {
      throw teammatesError(cause);
    }
    const team = this.team(workspaceId);
    this.teams = {
      ...this.teams,
      [workspaceId]: { teammates: team.teammates.filter((item) => item.id !== teammate.id), status: team.status.filter((item) => item.teammateId !== teammate.id) },
    };
  }

  async setEnabled(workspaceId: string, teammateId: string, enabled: boolean): Promise<void> {
    try {
      const result = await this.client.request({ type: 'setEnabled', workspaceId, teammateId, enabled });
      if (result.type === 'teammate') this.replace(workspaceId, result.teammate, result.status);
    } catch (cause) {
      throw teammatesError(cause);
    }
  }

  private replace(workspaceId: string, teammate: TeammateV1, status: TeammateStatusV1): void {
    const team = this.team(workspaceId);
    const known = team.teammates.some((item) => item.id === teammate.id);
    this.teams = {
      ...this.teams,
      [workspaceId]: {
        teammates: known ? team.teammates.map((item) => (item.id === teammate.id ? teammate : item)) : [...team.teammates, teammate],
        status: [...team.status.filter((item) => item.teammateId !== teammate.id), status],
      },
    };
  }

  private listen(): void {
    this.listening ??= this.client
      .onChanged((event) => {
        if (this.teams[event.workspaceId] !== undefined) void this.load(event.workspaceId);
      })
      .then(() => undefined)
      .catch(() => {
        this.listening = undefined;
      });
  }
}

export const teammates = new TeammatesStore();
