import type {
  AcpAgentDescriptorV1,
  AcpAgentEntryV1,
  HarnessRegistryCommandV1,
  HarnessRegistryV1,
  HarnessStatusV1,
} from '../../../../../contracts/harness-registry-v1';
import { acpAgentId, acpHarnessId, isAcpHarness, type HarnessId } from '../../../../../contracts/harness-identity-v2';
import {
  HarnessRegistryError,
  harnessRegistryError,
  harnessRegistryHost,
  type HarnessRegistryClient,
} from '../../host-api/harnessRegistry';
import { rememberHarnessNames } from '../harnessMeta';

export interface AcpAgentRow {
  agent: AcpAgentEntryV1;
  /** Location, tested range and sign-in hint as the registry lists the harness. */
  status: HarnessStatusV1 | undefined;
}

/**
 * Settings → Harnesses state (ADR-034). Listing runs no agent and never
 * blocks first paint: the section loads it after mount, and discovery
 * results arrive through the registry event. One change runs at a time;
 * failures stay local to the page, the agent card or the open dialog.
 */
export class HarnessesStore {
  registry = $state.raw<HarnessRegistryV1>();
  loading = $state(false);
  /** Page-level failure (listing or "Check again" for every harness). */
  error = $state<string>();
  /** The action in flight: `check`, `check:<harness>`, `add`, `trust:<id>`, … */
  busy = $state('');
  /** Failures of per-agent actions, by descriptor id. */
  agentErrors = $state.raw<Record<string, string>>({});

  private request = 0;
  private unlisten: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly client: HarnessRegistryClient = harnessRegistryHost) {}

  get safeMode(): boolean {
    return this.registry?.safeMode ?? false;
  }

  get builtins(): HarnessStatusV1[] {
    return this.registry?.harnesses.filter((harness) => harness.source === 'built-in') ?? [];
  }

  get agents(): AcpAgentRow[] {
    const registry = this.registry;
    if (registry === undefined) return [];
    return registry.agents.map((agent) => ({
      agent,
      status: registry.harnesses.find((harness) => harness.harness === acpHarnessId(agent.descriptor.id)),
    }));
  }

  agent(id: string): AcpAgentEntryV1 | undefined {
    return this.registry?.agents.find((agent) => agent.descriptor.id === id);
  }

  async start(): Promise<void> {
    try {
      const stop = await this.client.listen(() => void this.load());
      if (this.disposed) stop();
      else this.unlisten = stop;
    } catch {
      // Without the event the list still loads; "Check again" refreshes it.
    }
    if (!this.disposed) await this.load();
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
  }

  private apply(next: HarnessRegistryV1, request: number): void {
    if (this.disposed || request !== this.request) return;
    this.registry = next;
    rememberHarnessNames(next.harnesses.map((harness) => ({ kind: harness.harness, name: harness.name })));
  }

  async load(): Promise<void> {
    const request = ++this.request;
    this.loading = true;
    try {
      this.apply(await this.client.run({ type: 'list' }), request);
      if (!this.disposed && request === this.request) this.error = undefined;
    } catch (error) {
      if (!this.disposed && request === this.request) this.error = harnessRegistryError(error).message;
    } finally {
      if (!this.disposed && request === this.request) this.loading = false;
    }
  }

  /**
   * Runs one registry change. A failure is shown on the page, on one agent's
   * card, or returned to the caller (a dialog keeps the user's draft and
   * shows it there).
   */
  private async perform(
    busy: string,
    command: HarnessRegistryCommandV1,
    report: 'page' | 'caller' | { agent: string },
  ): Promise<HarnessRegistryError | undefined> {
    if (this.busy !== '') return new HarnessRegistryError('UNAVAILABLE', 'Wait for the current harness change to finish.');
    this.busy = busy;
    if (typeof report === 'object') this.clearError(report.agent);
    const request = ++this.request;
    try {
      this.apply(await this.client.run(command), request);
      return undefined;
    } catch (error) {
      const failure = harnessRegistryError(error);
      if (!this.disposed) {
        if (report === 'page') this.error = failure.message;
        else if (report !== 'caller') this.agentErrors = { ...this.agentErrors, [report.agent]: failure.message };
        // The list changed under the user: show the current one to review again.
        if (failure.code === 'CONFLICT' || failure.code === 'TRUST_CHANGED' || failure.code === 'NOT_FOUND') void this.load();
      }
      return failure;
    } finally {
      if (!this.disposed) this.busy = '';
    }
  }

  clearError(id: string): void {
    if (!(id in this.agentErrors)) return;
    const { [id]: _removed, ...rest } = this.agentErrors;
    this.agentErrors = rest;
  }

  /** Every harness, or one ACP agent. Built-in discovery is recomputed by every list. */
  async check(harness: HarnessId | undefined = undefined): Promise<void> {
    const report = harness !== undefined && isAcpHarness(harness) ? { agent: acpAgentId(harness) } : 'page';
    if (report === 'page') this.error = undefined;
    await this.perform(harness ? `check:${harness}` : 'check', { type: 'check', ...(harness ? { harness } : {}) }, report);
  }

  /** Adds a user descriptor: untrusted until the user reviews its command line. */
  async add(descriptor: AcpAgentDescriptorV1): Promise<HarnessRegistryError | undefined> {
    return this.perform('add', { type: 'add', expectedRevision: this.registry?.revision ?? 0, descriptor }, 'caller');
  }

  /** Trusts exactly the command line and descriptor fingerprint the user reviewed. */
  async trust(reviewed: AcpAgentEntryV1): Promise<HarnessRegistryError | undefined> {
    const commandLine = reviewed.commandLine;
    if (commandLine === undefined) return undefined;
    const id = reviewed.descriptor.id;
    return this.perform(`trust:${id}`, {
      type: 'trust', expectedRevision: this.registry?.revision ?? 0, id, fingerprint: reviewed.fingerprint, commandLine,
    }, 'caller');
  }

  /** Confirms the exact reported version the user saw; an update needs a new confirmation. */
  async confirmVersion(agent: AcpAgentEntryV1, version: string): Promise<HarnessRegistryError | undefined> {
    const id = agent.descriptor.id;
    return this.perform(`version:${id}`, { type: 'confirmVersion', expectedRevision: this.registry?.revision ?? 0, id, version }, 'caller');
  }

  /** Allows exactly `names` of the secret-like environment names; an empty list withdraws. */
  async allowSecrets(agent: AcpAgentEntryV1, names: string[]): Promise<HarnessRegistryError | undefined> {
    const id = agent.descriptor.id;
    return this.perform(`secrets:${id}`, {
      type: 'allowSecrets', expectedRevision: this.registry?.revision ?? 0, id, fingerprint: agent.fingerprint, names,
    }, 'caller');
  }

  async remove(agent: AcpAgentEntryV1): Promise<HarnessRegistryError | undefined> {
    const id = agent.descriptor.id;
    return this.perform(`remove:${id}`, { type: 'remove', expectedRevision: this.registry?.revision ?? 0, id }, 'caller');
  }
}
