import type { HostTransport } from '../transport';
import { attentionHandlers } from './attentionFake';
import { backgroundHandlers } from './backgroundFake';
import { interactiveAnswersHandlers } from './interactiveAnswersFake';
import { boardHandlers, createLabBoards, seedLabBoard } from './boardFake';
import { acpHandlers } from './acpFake';
import { appUpdateHandlers, updateScenarioFromSearch, type LabUpdateScenario } from './appUpdateFake';
import { classicHandlers } from './classicFake';
import { createLabNanoAccount, nanoScenarioFromSearch, type LabNanoScenario } from './nanoAccountFake';
import { createLabNanoRemote, remoteScenarioFromSearch, type LabRemoteScenario } from './nanoRemoteFake';
import { nanoChatGptHandler, nanoProvidersHandler } from './nanoProvidersFake';
import { composerHandlers } from './composerFake';
import { composerInputsHandlers } from './composerInputsFake';
import { chatFilesHandlers } from './chatFilesFake';
import { chatLinkHandlers } from './chatLinkFake';
import { dictationHandlers } from './dictationFake';
import { demoExtensions, extensionHandlers } from './extensionsFake';
import { codexSandboxFromSearch, createLabFusion, fusionHandlers, type LabFusion } from './fusionFake';
import { harnessConnectHandlers } from './harnessConnectFake';
import { LabEventBus } from './labBus';
import { browserTimers, LabClock, LAB_BASE_TIME, labIso, type LabTimers } from './labClock';
import { LabDecodeFailure, tauriArgumentError } from './labErrors';
import type { LabHandlers } from './labHandlers';
import { LabIdSource } from './labRandom';
import { LAB_SCENARIOS, wire, type LabCatalogBehavior, type LabScenarioName, type LabState } from './labState';
import { orchestrationHandlers } from './orchestration/orchestrationFake';
import { EMPTY_NATIVE_HISTORY, piHistoryHandlers } from './piHistoryFake';
import { pipelineLibraryHandlers } from './pipelineLibraryFake';
import { pluginHandlers } from './pluginsFake';
import { LabRunScheduler } from './orchestration/runScheduler';
import { scriptTestHandlers } from './orchestration/scriptTestFake';
import { runDebuggingHandlers } from './orchestration/runDebuggingFake';
import { buildSeed, type SeedActivity } from './scenarios';
import { demoSessionId } from './scenarios/demoChats';
import { sessionTasksHandlers } from './sessionTasksFake';
import { sessionToolsHandlers } from './sessionToolsFake';
import { createLabSessionLinks } from './sessionLinksFake';
import { createLabTeam, seedLabTeam, teammatesHandlers } from './teammatesFake';
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
  /** App update state (see `appUpdateFake.ts`). Defaults to `?updates=`, then `off`. */
  readonly updates?: LabUpdateScenario;
  /** Nano account state (see `nanoAccountFake.ts`). Defaults to `?nano=`, then `signed-out`. */
  readonly nano?: LabNanoScenario;
  /** Remote access state (see `nanoRemoteFake.ts`). Defaults to `?remote=`, then `off`. */
  readonly remote?: LabRemoteScenario;
  /** Native catalog probe behavior. Defaults to `?catalog=`, then `normal`. */
  readonly catalog?: LabCatalogBehavior;
  /** Seeds one linked child under the first demo chat (see `sessionLinksFake.ts`). Defaults to `?links=seed`. */
  readonly links?: 'seed';
}

export interface LabHost extends HostTransport {
  readonly scenario: LabScenarioName;
  /** Live lab state, exposed for tests and debugging only. */
  readonly state: LabState;
  /** Fusion lab store: toggles and the scripted demo brief (`simulateBrief`). */
  readonly fusion: LabFusion;
}

export function scenarioFromSearch(search: string): LabScenarioName {
  const requested = new URLSearchParams(search).get('lab');
  return LAB_SCENARIOS.find((name) => name === requested) ?? 'demo';
}

function currentScenario(): LabScenarioName {
  return typeof window === 'undefined' ? 'demo' : scenarioFromSearch(window.location.search);
}

/** `?catalog=slow` or `?catalog=no-resources` (see `LabCatalogBehavior`). */
export function catalogBehaviorFromSearch(search: string): LabCatalogBehavior {
  const value = new URLSearchParams(search).get('catalog');
  return value === 'slow' || value === 'no-resources' ? value : 'normal';
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

/**
 * Project board (ADR-041): the demo's video-studio folder gets two teammates
 * and an enabled board (the piui folder's definitions stay as other suites
 * expect them); other scenarios start without boards.
 */
function seedBoards(runtime: LabSessions, team: ReturnType<typeof createLabTeam>, boards: ReturnType<typeof createLabBoards>): void {
  const { state } = runtime;
  if (state.scenario !== 'demo' && state.scenario !== 'safe') return;
  const trusted = state.projects.filter((item) => !item.personal && !item.missing && item.trustState === 'trusted');
  const project = trusted.find((item) => item.name === 'video-studio') ?? trusted[0];
  if (project === undefined) return;
  seedLabTeam(runtime, team, project.id);
  const session = [...state.sessions.values()].find((record) => record.workspaceId === project.id && record.runId === undefined);
  const run = state.orchestration.get(project.id)?.runs[0];
  seedLabBoard(runtime, team, boards, project.id, { sessionId: session?.id, runId: run?.id });
}

export function createLabHost(options: LabHostOptions = {}): LabHost {
  const scenario = options.scenario ?? currentScenario();
  const timers = options.timers ?? browserTimers;
  const clock = new LabClock(timers);
  const bus = new LabEventBus(timers);
  const signedOut = options.claudeSignedOut
    ?? (typeof window !== 'undefined' && claudeSignedOutFromSearch(window.location.search));
  const seed = signedOut ? withSignedOutClaude(buildSeed(scenario)) : buildSeed(scenario);
  // The fixture projects a native request without granting access to a desktop.
  const computerUseFixture = !seed.safeMode && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('computer-use') === 'active'
    ? seed.sessions.find((record) => record.id === demoSessionId('keymap'))
    : undefined;
  let computerUseEnabled = computerUseFixture?.live !== undefined;
  if (computerUseFixture?.live !== undefined) {
    computerUseFixture.live.status = 'running';
    computerUseFixture.blocks.push({
      id: 'lab-computer-use', kind: 'tool', label: 'Computer Use', status: 'streaming',
      toolName: 'mcp__nano-computer-use__computer_use',
    });
  }
  const state: LabState = {
    scenario,
    safeMode: seed.safeMode,
    appVersion: '0.2.0-lab',
    preferences: { theme: 'system', density: 'comfortable', reducedMotion: 'system', fontSize: 'medium', chatWidth: 'wide' },
    projects: seed.projects,
    harnesses: seed.harnesses,
    sessions: new Map(seed.sessions.map((record) => [record.id, record])),
    orchestration: new Map(seed.orchestration.map((workspace) => [workspace.workspaceId, workspace])),
    ids: new LabIdSource(`lab:${scenario}`),
    catalog: options.catalog ?? (typeof window === 'undefined' ? 'normal' : catalogBehaviorFromSearch(window.location.search)),
  };
  // Seeded tasks sit on the Lab epoch; the window measures elapsed time against this computer's clock.
  const taskShift = timers.now() - LAB_BASE_TIME;
  const shifted = (instant: string): string => labIso(Date.parse(instant) + taskShift);
  for (const record of state.sessions.values()) {
    if (record.live === undefined) continue;
    record.live.tasks = record.live.tasks.map((task) => ({
      ...task,
      startedAt: shifted(task.startedAt),
      ...(task.endedAt === undefined ? {} : { endedAt: shifted(task.endedAt) }),
    }));
  }
  const runtime = new LabSessions(state, bus, clock);
  const scheduler = new LabRunScheduler(runtime, bus);
  const team = createLabTeam();
  const boards = createLabBoards();
  seedBoards(runtime, team, boards);
  const fusion = createLabFusion(runtime, bus, {
    codexSandbox: typeof window === 'undefined' ? true : codexSandboxFromSearch(window.location.search),
  });
  const sessionLinks = createLabSessionLinks(runtime, bus, (options.links ?? (typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search).get('links'))) === 'seed');
  // The catalog and session fakes gate Nano on this account, as the desktop host does.
  const nanoAccount = createLabNanoAccount(
    options.nano ?? (typeof window === 'undefined' ? 'signed-out' : nanoScenarioFromSearch(window.location.search)),
    bus,
    clock,
    state.safeMode,
  );
  state.nanoAccount = nanoAccount;
  // Remote access (ADR-062) follows the account and safe mode, as the host's supervisor does.
  const nanoRemote = createLabNanoRemote(
    options.remote ?? (typeof window === 'undefined' ? 'off' : remoteScenarioFromSearch(window.location.search)),
    bus,
    clock,
    nanoAccount.status,
    state.safeMode,
  );
  const handlers: LabHandlers = {
    ...workspaceHandlers(runtime),
    ...composerHandlers(runtime),
    ...composerInputsHandlers(runtime),
    ...chatFilesHandlers(runtime),
    ...chatLinkHandlers(state),
    ...classicHandlers(runtime),
    ...orchestrationHandlers(runtime, scheduler, bus),
    ...scriptTestHandlers(runtime),
    ...piHistoryHandlers(runtime, seed.nativeHistory ?? EMPTY_NATIVE_HISTORY, bus),
    ...extensionHandlers(scenario === 'empty' ? [] : demoExtensions()),
    ...backgroundHandlers(state),
    workspace_computer_use_v1: ({ sessionId, enabled }) => {
      const available = computerUseFixture !== undefined && sessionId === computerUseFixture.id;
      if (available && typeof enabled === 'boolean') computerUseEnabled = enabled;
      return { protocol: 1, available, enabled: available && computerUseEnabled };
    },
    ...interactiveAnswersHandlers(state),
    ...attentionHandlers(),
    ...acpHandlers(runtime, bus),
    ...sessionTasksHandlers(runtime),
    ...harnessConnectHandlers(state),
    ...runDebuggingHandlers(runtime),
    ...appUpdateHandlers(
      options.updates ?? (typeof window === 'undefined' ? 'off' : updateScenarioFromSearch(window.location.search)),
      bus,
      clock,
    ),
    ...nanoAccount.handlers,
    ...nanoRemote.handlers,
    nano_providers_v1: (args) => nanoProvidersHandler(state, args),
    nano_chatgpt_v1: (args) => nanoChatGptHandler(state, args),
    ...dictationHandlers(state, clock),
    ...sessionToolsHandlers(runtime, seed.nativeHistory ?? EMPTY_NATIVE_HISTORY, undefined, sessionLinks.adopt),
    ...pipelineLibraryHandlers(runtime),
    ...teammatesHandlers(runtime, bus, team),
    ...boardHandlers(runtime, bus, team, boards),
    ...fusionHandlers(fusion),
    ...sessionLinks.handlers,
    // After the ACP registry: plugin ACP agents join it.
    ...pluginHandlers(runtime, bus),
  };
  startActivity(seed.activity, runtime, scheduler, options.ambient ?? true);

  return {
    scenario,
    state,
    fusion,
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      const handler = handlers[command];
      // Tauri rejects unregistered commands with a plain message string.
      if (handler === undefined) throw `Command ${command} not found`;
      try {
        const result = await handler(wire(args));
        const operation = args.command;
        if (typeof operation === 'object' && operation !== null && 'sessionId' in operation && typeof operation.sessionId === 'string') {
          if (command === 'workspace_composer_v19' && 'type' in operation && operation.type === 'send') sessionLinks.personMessage(operation.sessionId);
          if (command === 'workspace_lifecycle_v17') sessionLinks.sessionDeleted(operation.sessionId);
        }
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
