import type { HostTransport } from '../transport';
import { backgroundHandlers } from './backgroundFake';
import { acpHandlers } from './acpFake';
import { classicHandlers } from './classicFake';
import { composerHandlers } from './composerFake';
import { demoExtensions, extensionHandlers } from './extensionsFake';
import { LabEventBus } from './labBus';
import { browserTimers, LabClock, type LabTimers } from './labClock';
import { LabDecodeFailure, tauriArgumentError } from './labErrors';
import type { LabHandlers } from './labHandlers';
import { LabIdSource } from './labRandom';
import { LAB_SCENARIOS, wire, type LabScenarioName, type LabState } from './labState';
import { orchestrationHandlers } from './orchestration/orchestrationFake';
import { EMPTY_NATIVE_HISTORY, piHistoryHandlers } from './piHistoryFake';
import { pluginHandlers } from './pluginsFake';
import { LabRunScheduler } from './orchestration/runScheduler';
import { scriptTestHandlers } from './orchestration/scriptTestFake';
import { buildSeed, type SeedActivity } from './scenarios';
import { withSignedOutClaude } from './scenarios/signedOutClaude';
import { LabSessions } from './sessionRuntime';
import { ambientSegment } from './turnScripts';
import { workspaceHandlers } from './workspaceFake';

/**
 * UI Lab host: a deterministic, in-memory fake of the Rust host used when the
 * UI runs in a plain browser (`pnpm dev`). It answers the same commands with
 * the same JSON shapes, error codes and event channels, simulates native turns
 * and orchestration runs with timers, and never executes an agent, touches a
 * file or makes a network request. Pick a scenario with `?lab=<name>`.
 */
export interface LabHostOptions {
  /** Defaults to `?lab=` in the page URL, then `demo`. */
  readonly scenario?: LabScenarioName;
  /** Timer seam for tests (fake timers work with the default too). */
  readonly timers?: LabTimers;
  /** Starts the scenario's background activity (a streaming chat, a running run). Default `true`. */
  readonly ambient?: boolean;
  /** Claude Code signed out (see `withSignedOutClaude`). Defaults to `?claude=signed-out`. */
  readonly claudeSignedOut?: boolean;
}

export interface LabHost extends HostTransport {
  readonly scenario: LabScenarioName;
  /** Live lab state, exposed for tests and debugging only. */
  readonly state: LabState;
}

export function scenarioFromSearch(search: string): LabScenarioName {
  const requested = new URLSearchParams(search).get('lab');
  return LAB_SCENARIOS.find((name) => name === requested) ?? 'demo';
}

function currentScenario(): LabScenarioName {
  return typeof window === 'undefined' ? 'demo' : scenarioFromSearch(window.location.search);
}

/** `?claude=signed-out` shows Claude Code as not signed in with a Claude subscription. */
export function claudeSignedOutFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('claude') === 'signed-out';
}

function startActivity(activity: readonly SeedActivity[], runtime: LabSessions, scheduler: LabRunScheduler, start: boolean): void {
  for (const item of activity) {
    switch (item.kind) {
      case 'ambient-stream': {
        const record = runtime.record(item.sessionId);
        if (record === undefined) break;
        const context = runtime.nextContext(record);
        runtime.startTurn(record, ambientSegment(context, item.firstCycle), { start });
        break;
      }
      case 'paused-approval': {
        const record = runtime.record(item.sessionId);
        if (record !== undefined) runtime.registerPausedTurn(record, item.approvalId, item.step, []);
        break;
      }
      case 'running-task': {
        const run = scheduler.findRun(item.workspaceId, item.runId);
        if (run !== undefined) scheduler.resumeSeeded(item.workspaceId, run, item.stepId, item.steps, start);
        break;
      }
      default: {
        const exhaustive: never = item;
        return exhaustive;
      }
    }
  }
}

export function createLabHost(options: LabHostOptions = {}): LabHost {
  const scenario = options.scenario ?? currentScenario();
  const timers = options.timers ?? browserTimers;
  const clock = new LabClock(timers);
  const bus = new LabEventBus(timers);
  const signedOut = options.claudeSignedOut
    ?? (typeof window !== 'undefined' && claudeSignedOutFromSearch(window.location.search));
  const seed = signedOut ? withSignedOutClaude(buildSeed(scenario)) : buildSeed(scenario);
  const state: LabState = {
    scenario,
    safeMode: seed.safeMode,
    appVersion: '0.1.1-lab',
    preferences: { theme: 'system', density: 'comfortable', reducedMotion: 'system', fontSize: 'medium', chatWidth: 'wide' },
    projects: seed.projects,
    harnesses: seed.harnesses,
    sessions: new Map(seed.sessions.map((record) => [record.id, record])),
    orchestration: new Map(seed.orchestration.map((workspace) => [workspace.workspaceId, workspace])),
    ids: new LabIdSource(`lab:${scenario}`),
  };
  const runtime = new LabSessions(state, bus, clock);
  const scheduler = new LabRunScheduler(runtime, bus);
  const handlers: LabHandlers = {
    ...workspaceHandlers(runtime),
    ...composerHandlers(runtime),
    ...classicHandlers(runtime),
    ...orchestrationHandlers(runtime, scheduler, bus),
    ...scriptTestHandlers(runtime),
    ...piHistoryHandlers(runtime, seed.nativeHistory ?? EMPTY_NATIVE_HISTORY, bus),
    ...extensionHandlers(scenario === 'empty' ? [] : demoExtensions()),
    ...backgroundHandlers(state),
    ...acpHandlers(runtime, bus),
    // After the ACP registry: plugin ACP agents join it.
    ...pluginHandlers(runtime, bus),
  };
  startActivity(seed.activity, runtime, scheduler, options.ambient ?? true);

  return {
    scenario,
    state,
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      const handler = handlers[command];
      // Tauri rejects unregistered commands with a plain message string.
      if (handler === undefined) throw `Command ${command} not found`;
      try {
        const result = await handler(wire(args));
        return (result === undefined ? null : wire(result)) as T;
      } catch (error) {
        if (error instanceof LabDecodeFailure) throw tauriArgumentError(command, error);
        throw error;
      }
    },
    async listen<T>(channel: string, handler: (payload: T) => void): Promise<() => void> {
      return bus.on(channel, handler as (payload: unknown) => void);
    },
  };
}
