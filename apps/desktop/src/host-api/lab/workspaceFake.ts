import {
  catalogModel, claudeSignInRequired, defaultModel, defaultSessionTitle, HARNESS_MODELS, HARNESS_RESOURCES,
  NATIVE_PERMISSION_MODES, reportsServiceTier, runtimeModels,
} from './catalogFake';
import type {
  HarnessModelsRequest, HarnessModelsResult, HarnessKind, RuntimeSettings, RuntimeSettingsCommand, SessionSnapshot,
  WorkspaceCatalog, WorkspaceCommand, WorkspaceHistoryRequestV1, WorkspaceHistoryResultV1, WorkspaceLifecycleCommand,
  WorkspaceLifecycleResult, WorkspaceModel, WorkspaceResult,
} from './labContracts';
import { answerMatchesForm } from '../approvalForms';
import { NativeRejection, workspaceFailure } from './labErrors';
import {
  authorizeLive, hasControl, normalizedTitle, requireLive, requireRecord, validateModel, validText, validToken,
} from './labGuards';
import type { LabHandlers } from './labHandlers';
import { isUuid } from './labRandom';
import { decodeArgument } from './labSchema';
import {
  harnessModelsRequestSchema, historyRequestSchema, lifecycleCommandSchema, settingsCommandSchema, workspaceCommandSchema,
} from './labSchemas';
import {
  newQueue, sessionSummary, verifiedProject, workspaceSummary,
  type LabSessionRecord, type LabState,
} from './labState';
import { fullHistory, historicalSnapshot, liveSnapshot } from './sessionProjection';
import type { LabSessions } from './sessionRuntime';

/** Simulated native process start for catalog probes (the host spawns and retires a runtime). */
const CATALOG_LATENCY_MS = 350;

function assertNotSafe(state: LabState): void {
  if (state.safeMode) throw workspaceFailure('SAFE_MODE');
}

function assertHarnessAvailable(state: LabState, harness: HarnessKind): void {
  if (state.harnesses.find((summary) => summary.kind === harness)?.status !== 'available') throw workspaceFailure('RUNTIME_FAILED');
}

/** Mirrors the host: every Claude Code start verifies the Claude subscription login. */
function assertSignedIn(state: LabState, harness: HarnessKind): void {
  if (harness === 'claude-code' && claudeSignInRequired(state.harnesses)) throw workspaceFailure('SIGN_IN_REQUIRED');
}

/** The runtime refused: the plain workspace route reports every native rejection as RUNTIME_FAILED. */
function native<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NativeRejection) throw workspaceFailure('RUNTIME_FAILED');
    throw error;
  }
}

/** Reasoning level kept across a model change when the new model offers it (Pi clamps otherwise). */
export function carriedThinkingLevel(model: WorkspaceModel, current: string | undefined): string | undefined {
  const levels = model.thinkingLevels;
  if (!levels?.length) return undefined;
  if (current !== undefined && levels.includes(current)) return current;
  return levels.includes('medium') ? 'medium' : levels[0];
}

export function catalog(state: LabState): WorkspaceCatalog {
  return {
    protocol: 15,
    safeMode: state.safeMode,
    workspaces: state.projects.map(workspaceSummary),
    sessions: [...state.sessions.values()].map(sessionSummary),
    harnesses: state.harnesses.map((summary) => ({ ...summary })),
  };
}

export function snapshot(state: LabState, sessionId: string): SessionSnapshot {
  const record = requireRecord(state, sessionId);
  if (!state.safeMode && record.live !== undefined) {
    verifiedProject(state, record.workspaceId, true);
    return liveSnapshot(state, record);
  }
  verifiedProject(state, record.workspaceId, false);
  return historicalSnapshot(state, record);
}

function createSession(runtime: LabSessions, command: Extract<WorkspaceCommand, { type: 'createSession' }>): WorkspaceResult {
  const { state } = runtime;
  verifiedProject(state, command.workspaceId, true);
  if (!validToken(command.workspaceId)) throw workspaceFailure('INVALID_ARGUMENT');
  const title = command.title === undefined ? undefined : normalizedTitle(command.title);
  if (command.title !== undefined && title === undefined) throw workspaceFailure('INVALID_ARGUMENT');
  if (command.model) validateModel(command.model, undefined);
  assertHarnessAvailable(state, command.harness);
  if (!NATIVE_PERMISSION_MODES[command.harness].includes(command.permissionMode)) throw workspaceFailure('RUNTIME_FAILED');
  assertSignedIn(state, command.harness);
  if (command.model && catalogModel(command.harness, command.model.id, command.model.provider) === undefined) {
    throw workspaceFailure('RUNTIME_FAILED');
  }
  const model = command.model ? { ...command.model } : defaultModel(command.harness);
  const record: LabSessionRecord = {
    id: state.ids.next('session'),
    workspaceId: command.workspaceId,
    harness: command.harness,
    title: title ?? defaultSessionTitle(command.harness),
    updatedAt: runtime.clock.iso(),
    model,
    thinkingLevel: carriedThinkingLevel(model, undefined),
    ...(reportsServiceTier(command.harness, model) ? { serviceTier: 'standard' as const } : {}),
    permissionMode: command.permissionMode,
    revision: 0,
    blocks: [],
    usage: [],
    composer: newQueue(),
    turnSerial: 0,
  };
  state.sessions.set(record.id, record);
  runtime.open(record);
  const result: SessionSnapshotResult = { type: 'session', snapshot: liveSnapshot(state, record) };
  runtime.publishSession(record);
  return result;
}

type SessionSnapshotResult = Extract<WorkspaceResult, { type: 'session' }>;

function openSession(runtime: LabSessions, sessionId: string): WorkspaceResult {
  const { state } = runtime;
  const record = requireRecord(state, sessionId);
  verifiedProject(state, record.workspaceId, true);
  if (!isUuid(sessionId)) throw workspaceFailure('INVALID_ARGUMENT');
  if (record.live !== undefined) return { type: 'session', snapshot: liveSnapshot(state, record) };
  // Managed run sessions stay readable through the process-free snapshot path only.
  if (record.runId !== undefined) throw workspaceFailure('NOT_SUPPORTED');
  assertHarnessAvailable(state, record.harness);
  runtime.open(record);
  const result: SessionSnapshotResult = { type: 'session', snapshot: liveSnapshot(state, record) };
  runtime.publishSession(record);
  return result;
}

function closeSession(runtime: LabSessions, sessionId: string): void {
  if (!isUuid(sessionId)) throw workspaceFailure('INVALID_ARGUMENT');
  const record = requireRecord(runtime.state, sessionId);
  if (record.live === undefined) return;
  runtime.close(record);
}

function workspaceCommand(runtime: LabSessions, command: WorkspaceCommand): WorkspaceResult {
  const { state } = runtime;
  switch (command.type) {
    case 'catalog':
      return { type: 'catalog', catalog: catalog(state) };
    case 'snapshot':
      return { type: 'session', snapshot: snapshot(state, command.sessionId) };
    case 'createSession':
      assertNotSafe(state);
      return createSession(runtime, command);
    case 'openSession':
      assertNotSafe(state);
      return openSession(runtime, command.sessionId);
    case 'send': {
      assertNotSafe(state);
      const record = authorizeLive(state, command.sessionId);
      requireLive(record);
      if (!validText(command.text)) throw workspaceFailure('INVALID_ARGUMENT');
      native(() => runtime.prompt(record, command.text, command.mode));
      runtime.touch(record);
      return { type: 'accepted', sessionId: command.sessionId };
    }
    case 'interrupt': {
      assertNotSafe(state);
      const record = authorizeLive(state, command.sessionId);
      runtime.pauseQueue(record);
      requireLive(record);
      native(() => runtime.interrupt(record));
      return { type: 'accepted', sessionId: command.sessionId };
    }
    case 'closeSession':
      assertNotSafe(state);
      closeSession(runtime, command.sessionId);
      return { type: 'accepted', sessionId: command.sessionId };
    case 'setModel': {
      assertNotSafe(state);
      const record = authorizeLive(state, command.sessionId);
      validateModel(command.model, command.thinkingLevel);
      const live = requireLive(record);
      if (live.status === 'failed') throw workspaceFailure('RUNTIME_FAILED');
      if (record.harness === 'pi' && !command.model.provider) throw workspaceFailure('RUNTIME_FAILED');
      if (catalogModel(record.harness, command.model.id, command.model.provider) === undefined) throw workspaceFailure('RUNTIME_FAILED');
      record.model = { ...command.model };
      record.thinkingLevel = command.thinkingLevel ?? carriedThinkingLevel(command.model, record.thinkingLevel);
      runtime.touch(record);
      runtime.publishSession(record);
      return { type: 'accepted', sessionId: command.sessionId };
    }
    case 'renameSession': {
      assertNotSafe(state);
      const record = authorizeLive(state, command.sessionId);
      const title = normalizedTitle(command.title);
      if (title === undefined) throw workspaceFailure('INVALID_ARGUMENT');
      const live = requireLive(record);
      if (live.status === 'failed') throw workspaceFailure('RUNTIME_FAILED');
      record.title = title;
      runtime.touch(record);
      runtime.publishSession(record);
      return { type: 'accepted', sessionId: command.sessionId };
    }
    case 'respond': {
      assertNotSafe(state);
      const record = authorizeLive(state, command.sessionId);
      if (!validToken(command.requestId)) throw workspaceFailure('INVALID_ARGUMENT');
      const live = requireLive(record);
      const approval = live.approvals.find((candidate) => candidate.id === command.requestId);
      if (approval === undefined || !approval.decisions.includes(command.decision)) throw workspaceFailure('APPROVAL_EXPIRED');
      if (typeof command.text === 'string' && hasControl(command.text)) throw workspaceFailure('INVALID_ARGUMENT');
      if (approval.kind === 'input' && command.decision === 'approve-once' && typeof command.text !== 'string') {
        throw workspaceFailure('RUNTIME_FAILED');
      }
      // The adapter rejects a form answer that does not match its fields; the request stays pending.
      if (approval.form && command.decision === 'approve-once' && !answerMatchesForm(approval.form, command.text)) {
        throw workspaceFailure('RUNTIME_FAILED');
      }
      native(() => runtime.respond(record, command.requestId, command.decision));
      return { type: 'accepted', sessionId: command.sessionId };
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function runtimeSettings(runtime: LabSessions, command: RuntimeSettingsCommand): RuntimeSettings {
  const { state } = runtime;
  assertNotSafe(state);
  const record = authorizeLive(state, command.sessionId);
  const live = requireLive(record);
  // Claude Code runs only at standard speed: fast mode can use paid extra usage.
  if (command.type === 'set' && record.harness === 'claude-code' && command.serviceTier != null && command.serviceTier !== 'standard') {
    throw workspaceFailure('NOT_SUPPORTED');
  }
  if (live.status === 'failed') throw workspaceFailure('RUNTIME_FAILED');
  const models = runtimeModels(record.harness);
  if (command.type === 'set') {
    if (live.status !== 'idle') throw workspaceFailure('INVALID_ARGUMENT');
    const candidate = models.find((model) => model.id === command.model.id && model.provider === command.model.provider);
    if (candidate === undefined) throw workspaceFailure('INVALID_ARGUMENT');
    const thinkingLevel = command.thinkingLevel ?? undefined;
    validateModel(candidate, thinkingLevel);
    const tier = command.serviceTier ?? undefined;
    if (tier !== undefined && (record.harness === 'pi' || (tier !== 'standard' && tier !== 'fast'))) {
      throw workspaceFailure('INVALID_ARGUMENT');
    }
    const fastCapable = catalogModel(record.harness, candidate.id, candidate.provider)?.supportsFast === true;
    if (tier !== undefined && (record.harness === 'hermes' || (tier === 'fast' && !fastCapable))) throw workspaceFailure('RUNTIME_FAILED');
    record.model = candidate;
    record.thinkingLevel = thinkingLevel ?? carriedThinkingLevel(candidate, record.thinkingLevel);
    if (tier === 'standard' || tier === 'fast') record.serviceTier = tier;
    runtime.touch(record);
  }
  const reportsTier = reportsServiceTier(record.harness, record.model);
  return {
    protocol: 16,
    sessionId: command.sessionId,
    model: record.model ?? null,
    models,
    thinkingLevel: record.thinkingLevel ?? null,
    serviceTier: reportsTier ? record.serviceTier ?? 'standard' : null,
  };
}

function deleteSession(runtime: LabSessions, command: WorkspaceLifecycleCommand): WorkspaceLifecycleResult {
  const { state } = runtime;
  assertNotSafe(state);
  if (!isUuid(command.sessionId)) throw workspaceFailure('INVALID_ARGUMENT');
  const record = requireRecord(state, command.sessionId);
  if (record.runId !== undefined) throw workspaceFailure('NOT_SUPPORTED');
  const status = record.live?.status;
  if (status !== undefined && status !== 'idle' && status !== 'failed') throw workspaceFailure('CONFLICT');
  if (record.live !== undefined) runtime.close(record);
  state.sessions.delete(command.sessionId);
  return { protocol: 17, sessionId: command.sessionId };
}

function history(state: LabState, request: WorkspaceHistoryRequestV1): WorkspaceHistoryResultV1 {
  const record = requireRecord(state, request.sessionId);
  verifiedProject(state, record.workspaceId, false);
  return { protocol: 1, sessionId: request.sessionId, blocks: fullHistory(record) };
}

async function harnessModels(runtime: LabSessions, request: HarnessModelsRequest): Promise<HarnessModelsResult> {
  const { state } = runtime;
  assertNotSafe(state);
  verifiedProject(state, request.workspaceId, true);
  assertHarnessAvailable(state, request.harness);
  await runtime.clock.delay(CATALOG_LATENCY_MS);
  assertSignedIn(state, request.harness);
  return {
    protocol: 18,
    harness: request.harness,
    models: HARNESS_MODELS[request.harness].map((model) => ({ ...model })),
    resources: structuredClone(HARNESS_RESOURCES[request.harness]),
  };
}

export function workspaceHandlers(runtime: LabSessions): LabHandlers {
  return {
    workspace_command_v15: (args) =>
      workspaceCommand(runtime, decodeArgument<WorkspaceCommand>(args, 'command', workspaceCommandSchema)),
    workspace_settings_v16: (args) =>
      runtimeSettings(runtime, decodeArgument<RuntimeSettingsCommand>(args, 'command', settingsCommandSchema)),
    workspace_lifecycle_v17: (args) =>
      deleteSession(runtime, decodeArgument<WorkspaceLifecycleCommand>(args, 'command', lifecycleCommandSchema)),
    workspace_history_v1: (args) =>
      history(runtime.state, decodeArgument<WorkspaceHistoryRequestV1>(args, 'request', historyRequestSchema)),
    harness_models_v18: (args) =>
      harnessModels(runtime, decodeArgument<HarnessModelsRequest>(args, 'request', harnessModelsRequestSchema)),
  };
}
