import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AgentKind,
  ApiRuntimeStart,
  AppSnapshot,
  ExtensionSummary,
  ExtensionUiResponse,
  FakeScenario,
  FakeScenarioResult,
  ModelLite,
  PiUiContributionCatalog,
  Preferences,
  ProjectSummary,
  ProjectTrustState,
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeSnapshot,
  SessionCatalogEvent,
  SessionCatalogSnapshot,
  SessionRootHint,
  SessionStateLite,
  SessionSummary,
  SessionTree,
  SystemPiProbeSummary,
  TimelineBlock,
  TimelinePage,
} from './types';

export interface HostClient {
  bootstrap(): Promise<AppSnapshot>;
  updatePreferences(preferences: Preferences): Promise<Preferences>;
  listExtensions(agentKind: AgentKind): Promise<ExtensionSummary[]>;
  setExtensionEnabled(agentKind: AgentKind, extensionId: string, enabled: boolean): Promise<ExtensionSummary[]>;
  /** Opens the host-owned native folder picker when available. */
  pickAndAddProject(agentKind: AgentKind): Promise<ProjectSummary | undefined>;
  addProject(path: string, agentKind: AgentKind): Promise<ProjectSummary>;
  setProjectTrust(projectId: string, trustState: ProjectTrustState): Promise<ProjectSummary>;
  renameProject(projectId: string, name: string): Promise<ProjectSummary>;
  setProjectPinned(projectId: string, pinned: boolean): Promise<ProjectSummary>;
  removeProject(projectId: string): Promise<void>;
  searchSessions(query: string): Promise<SessionSummary[]>;
  /** Legacy cache-only list. Prefer the versioned catalog commands below. */
  listSessions(projectId: string): Promise<SessionSummary[]>;
  /** Lists Pi-owned chats whose neutral workspace is not a user project. */
  listPersonalSessions(): Promise<SessionSummary[]>;
  getSessionCatalog(projectId: string): Promise<SessionCatalogSnapshot>;
  getPersonalSessionCatalog(): Promise<SessionCatalogSnapshot>;
  /** Runs a bounded read-only reconciliation after the caller has painted cache. */
  refreshSessionCatalog(projectId: string): Promise<SessionCatalogSnapshot>;
  refreshPersonalSessionCatalog(): Promise<SessionCatalogSnapshot>;
  listenSessionCatalogEvents(handler: (event: SessionCatalogEvent) => void): Promise<() => void>;
  listenSessionRootHints(handler: (hint: SessionRootHint) => void): Promise<() => void>;
  getTimeline(projectId: string, sessionId: string): Promise<TimelineBlock[]>;
  getTimelinePage(projectId: string, sessionId: string, cursor?: string): Promise<TimelinePage>;
  getPersonalTimelinePage(sessionId: string, cursor?: string): Promise<TimelinePage>;
  getTree(projectId: string, sessionId: string): Promise<SessionTree>;
  getPersonalTree(sessionId: string): Promise<SessionTree>;
  probeSystemRuntime(): Promise<SystemPiProbeSummary>;
  runFakeScenario(projectId: string, sessionId: string, scenario: FakeScenario, text: string): Promise<FakeScenarioResult>;
  startFakeRuntime(projectId: string, sessionId?: string): Promise<RuntimeSnapshot>;
  stopRuntime(): Promise<RuntimeSnapshot | undefined>;
  // Live Pi runtime
  startRuntime(projectId: string, sessionId?: string): Promise<ApiRuntimeStart>;
  startPersonalChat(sessionId?: string): Promise<ApiRuntimeStart>;
  sendPrompt(runtimeId: string, text: string): Promise<void>;
  sendSteer(runtimeId: string, text: string): Promise<void>;
  sendFollowUp(runtimeId: string, text: string): Promise<void>;
  abortRuntime(runtimeId: string): Promise<void>;
  stopLiveRuntime(runtimeId: string): Promise<RuntimeSnapshot>;
  getRuntimeState(runtimeId: string): Promise<SessionStateLite>;
  getRuntimeModels(runtimeId: string): Promise<ModelLite[]>;
  getRuntimeThinkingLevels(runtimeId: string): Promise<string[]>;
  getRuntimeCommands(runtimeId: string): Promise<RuntimeCommand[]>;
  listPiUiContributions(): Promise<PiUiContributionCatalog>;
  respondExtensionUi(runtimeId: string, requestId: string, response: ExtensionUiResponse): Promise<void>;
  setRuntimeModel(runtimeId: string, provider: string, modelId: string): Promise<void>;
  setRuntimeThinking(runtimeId: string, level: string): Promise<void>;
  setRuntimeSessionName(runtimeId: string, name: string): Promise<void>;
  /** Subscribes to streamed runtime events. Returns an unlisten function. */
  listenRuntimeEvents(handler: (event: RuntimeEventEnvelope) => void): Promise<() => void>;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const hasNativeFolderPicker = inTauri();

type SafeHostErrorCode = 'CONFLICT' | 'PROJECT_KIND_CONFLICT' | 'SESSION_ALREADY_ACTIVE';

export class HostOperationError extends Error {
  readonly code?: SafeHostErrorCode;

  constructor(message: string, code?: SafeHostErrorCode) {
    super(message);
    this.name = 'HostOperationError';
    this.code = code;
  }
}

export function isHostConflict(error: unknown): error is HostOperationError {
  return error instanceof HostOperationError && error.code === 'CONFLICT';
}

function safeHostErrorCode(cause: unknown): SafeHostErrorCode | undefined {
  const knownCode = (value: unknown): SafeHostErrorCode | undefined => {
    if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
    return value.code === 'CONFLICT'
      || value.code === 'PROJECT_KIND_CONFLICT'
      || value.code === 'SESSION_ALREADY_ACTIVE'
      ? value.code
      : undefined;
  };
  const direct = knownCode(cause);
  if (direct !== undefined) return direct;
  // Tauri can serialize a command error as JSON text on some webview builds.
  // Parse only the known non-sensitive error code; never surface raw payloads.
  if (typeof cause === 'string') {
    try {
      return knownCode(JSON.parse(cause) as unknown);
    } catch {
      // A non-JSON host error remains intentionally generic.
    }
  }
  return undefined;
}

export function toSafeHostError(operation: string, cause: unknown): HostOperationError {
  const code = safeHostErrorCode(cause);
  if (code === 'CONFLICT') {
    return new HostOperationError('This project folder changed. Add it again and confirm trust before continuing.', code);
  }
  if (code === 'PROJECT_KIND_CONFLICT') {
    return new HostOperationError('This folder already uses another agent runtime. Remove it before adding it with a different runtime.', code);
  }
  if (code === 'SESSION_ALREADY_ACTIVE') {
    return new HostOperationError('This Prime Agent session is already active in another runtime. Stop it there before reopening it here.', code);
  }
  return new HostOperationError(`${operation} could not be completed. Open diagnostics for a safe error code.`);
}

async function invokeSafe<T>(operation: string, command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toSafeHostError(operation, error);
  }
}

const tauriClient: HostClient = {
  async bootstrap() {
    return invokeSafe<AppSnapshot>('Startup', 'bootstrap_v10');
  },
  async updatePreferences(preferences) {
    return invokeSafe<Preferences>('Preference update', 'update_preferences_v8', {
      theme: preferences.theme,
      density: preferences.density,
      reducedMotion: preferences.reducedMotion,
      fontSize: preferences.fontSize,
      chatWidth: preferences.chatWidth,
    });
  },
  async listExtensions(agentKind) {
    return invokeSafe<ExtensionSummary[]>('Extension inventory', 'list_extensions_v10', { agentKind });
  },
  async setExtensionEnabled(agentKind, extensionId, enabled) {
    return invokeSafe<ExtensionSummary[]>('Extension update', 'set_extension_enabled_v10', {
      agentKind,
      extensionId,
      enabled,
    });
  },
  async pickAndAddProject(agentKind) {
    const project = await invokeSafe<ProjectSummary | null>('Folder selection', 'pick_and_add_project_v10', { agentKind });
    return project ?? undefined;
  },
  async addProject(path, agentKind) {
    return invokeSafe<ProjectSummary>('Project registration', 'add_project_v10', { path, agentKind });
  },
  async setProjectTrust(projectId, trustState) {
    return invokeSafe<ProjectSummary>('Trust update', 'set_project_trust', { projectId, trustState });
  },
  async renameProject(projectId, name) {
    return invokeSafe<ProjectSummary>('Project rename', 'rename_project', { projectId, name });
  },
  async setProjectPinned(projectId, pinned) {
    return invokeSafe<ProjectSummary>('Project pin update', 'set_project_pinned', { projectId, pinned });
  },
  async removeProject(projectId) {
    await invokeSafe<void>('Project removal', 'remove_project', { projectId });
  },
  async searchSessions(query) {
    return invokeSafe<SessionSummary[]>('Local search', 'search_sessions', { query });
  },
  async listSessions(projectId) {
    return invokeSafe<SessionSummary[]>('Session scan', 'list_sessions', { projectId });
  },
  async listPersonalSessions() {
    return invokeSafe<SessionSummary[]>('Chats catalog', 'list_personal_sessions');
  },
  async getSessionCatalog(projectId) {
    return invokeSafe<SessionCatalogSnapshot>('Session catalog', 'get_session_catalog', { projectId });
  },
  async getPersonalSessionCatalog() {
    return invokeSafe<SessionCatalogSnapshot>('Chats catalog', 'get_personal_session_catalog');
  },
  async refreshSessionCatalog(projectId) {
    return invokeSafe<SessionCatalogSnapshot>('Session catalog refresh', 'refresh_session_catalog', { projectId });
  },
  async refreshPersonalSessionCatalog() {
    return invokeSafe<SessionCatalogSnapshot>('Chats catalog refresh', 'refresh_personal_session_catalog');
  },
  async listenSessionCatalogEvents(handler) {
    const unlisten = await listen<SessionCatalogEvent>('piui://session-catalog', (event) => {
      handler(event.payload);
    });
    return unlisten;
  },
  async listenSessionRootHints(handler) {
    const unlisten = await listen<SessionRootHint>('piui://session-root-hint', (event) => {
      handler(event.payload);
    });
    return unlisten;
  },
  async getTimeline(projectId, sessionId) {
    return invokeSafe<TimelineBlock[]>('Timeline load', 'get_timeline', { projectId, sessionId });
  },
  async getTimelinePage(projectId, sessionId, cursor) {
    return invokeSafe<TimelinePage>('Timeline page load', 'get_timeline_page', { projectId, sessionId, cursor });
  },
  async getPersonalTimelinePage(sessionId, cursor) {
    return invokeSafe<TimelinePage>('Chats timeline load', 'get_personal_timeline_page', { sessionId, cursor });
  },
  async getTree(projectId, sessionId) {
    return invokeSafe<SessionTree>('Tree load', 'get_tree', { projectId, sessionId });
  },
  async getPersonalTree(sessionId) {
    return invokeSafe<SessionTree>('Chats tree load', 'get_personal_tree', { sessionId });
  },
  async probeSystemRuntime() {
    return invokeSafe<SystemPiProbeSummary>('System Pi diagnostic probe', 'probe_system_runtime');
  },
  async runFakeScenario(projectId, sessionId, scenario, text) {
    return invokeSafe<FakeScenarioResult>('Fake scenario', 'run_fake_scenario', { projectId, sessionId, scenario, text });
  },
  async startFakeRuntime(projectId, sessionId) {
    return invokeSafe<RuntimeSnapshot>('Fake runtime start', 'start_fake_runtime', { projectId, sessionId });
  },
  async stopRuntime() {
    return invokeSafe<RuntimeSnapshot | undefined>('Runtime shutdown', 'stop_runtime');
  },
  async startRuntime(projectId, sessionId) {
    return invokeSafe<ApiRuntimeStart>('Runtime start', 'start_runtime', { projectId, sessionId });
  },
  async startPersonalChat(sessionId) {
    return invokeSafe<ApiRuntimeStart>('Chats runtime start', 'start_personal_chat', { sessionId });
  },
  async sendPrompt(runtimeId, text) {
    await invokeSafe<void>('Send prompt', 'send_prompt', { runtimeId, text });
  },
  async sendSteer(runtimeId, text) {
    await invokeSafe<void>('Send steer', 'send_steer', { runtimeId, text });
  },
  async sendFollowUp(runtimeId, text) {
    await invokeSafe<void>('Send follow-up', 'send_follow_up', { runtimeId, text });
  },
  async abortRuntime(runtimeId) {
    await invokeSafe<void>('Abort runtime', 'abort_runtime', { runtimeId });
  },
  async stopLiveRuntime(runtimeId) {
    return invokeSafe<RuntimeSnapshot>('Runtime stop', 'stop_live_runtime', { runtimeId });
  },
  async getRuntimeState(runtimeId) {
    return invokeSafe<SessionStateLite>('Runtime state', 'get_runtime_state', { runtimeId });
  },
  async getRuntimeModels(runtimeId) {
    return invokeSafe<ModelLite[]>('Runtime models', 'get_runtime_models', { runtimeId });
  },
  async getRuntimeThinkingLevels(runtimeId) {
    return invokeSafe<string[]>('Runtime thinking levels', 'get_runtime_thinking_levels', { runtimeId });
  },
  async getRuntimeCommands(runtimeId) {
    return invokeSafe<RuntimeCommand[]>('Runtime commands', 'get_runtime_commands', { runtimeId });
  },
  async listPiUiContributions() {
    return invokeSafe<PiUiContributionCatalog>('PiUI contributions', 'list_piui_contributions');
  },
  async respondExtensionUi(runtimeId, requestId, response) {
    await invokeSafe<void>('Extension response', 'respond_extension_ui', { runtimeId, requestId, response });
  },
  async setRuntimeModel(runtimeId, provider, modelId) {
    await invokeSafe<void>('Runtime model set', 'set_runtime_model', { runtimeId, provider, modelId });
  },
  async setRuntimeThinking(runtimeId, level) {
    await invokeSafe<void>('Runtime thinking set', 'set_runtime_thinking', { runtimeId, level });
  },
  async setRuntimeSessionName(runtimeId, name) {
    await invokeSafe<void>('Runtime session name', 'set_runtime_session_name', { runtimeId, name });
  },
  async listenRuntimeEvents(handler) {
    const unlisten = await listen<RuntimeEventEnvelope>('piui://runtime-event', (event) => {
      handler(event.payload);
    });
    return unlisten;
  },
};

// Browser-only preview data is not loaded by the native startup surface.
async function browserPreview(): Promise<HostClient> { return (await import('./mockClient')).mockClient; }
const browserClient: HostClient = {
  bootstrap: async (...args) => (await browserPreview()).bootstrap(...args),
  updatePreferences: async (...args) => (await browserPreview()).updatePreferences(...args),
  listExtensions: async (...args) => (await browserPreview()).listExtensions(...args),
  setExtensionEnabled: async (...args) => (await browserPreview()).setExtensionEnabled(...args),
  pickAndAddProject: async (...args) => (await browserPreview()).pickAndAddProject(...args),
  addProject: async (...args) => (await browserPreview()).addProject(...args),
  setProjectTrust: async (...args) => (await browserPreview()).setProjectTrust(...args),
  renameProject: async (...args) => (await browserPreview()).renameProject(...args),
  setProjectPinned: async (...args) => (await browserPreview()).setProjectPinned(...args),
  removeProject: async (...args) => (await browserPreview()).removeProject(...args),
  searchSessions: async (...args) => (await browserPreview()).searchSessions(...args),
  listSessions: async (...args) => (await browserPreview()).listSessions(...args),
  listPersonalSessions: async (...args) => (await browserPreview()).listPersonalSessions(...args),
  getSessionCatalog: async (...args) => (await browserPreview()).getSessionCatalog(...args),
  getPersonalSessionCatalog: async (...args) => (await browserPreview()).getPersonalSessionCatalog(...args),
  refreshSessionCatalog: async (...args) => (await browserPreview()).refreshSessionCatalog(...args),
  refreshPersonalSessionCatalog: async (...args) => (await browserPreview()).refreshPersonalSessionCatalog(...args),
  listenSessionCatalogEvents: async (...args) => (await browserPreview()).listenSessionCatalogEvents(...args),
  listenSessionRootHints: async (...args) => (await browserPreview()).listenSessionRootHints(...args),
  getTimeline: async (...args) => (await browserPreview()).getTimeline(...args),
  getTimelinePage: async (...args) => (await browserPreview()).getTimelinePage(...args),
  getPersonalTimelinePage: async (...args) => (await browserPreview()).getPersonalTimelinePage(...args),
  getTree: async (...args) => (await browserPreview()).getTree(...args),
  getPersonalTree: async (...args) => (await browserPreview()).getPersonalTree(...args),
  probeSystemRuntime: async (...args) => (await browserPreview()).probeSystemRuntime(...args),
  runFakeScenario: async (...args) => (await browserPreview()).runFakeScenario(...args),
  startFakeRuntime: async (...args) => (await browserPreview()).startFakeRuntime(...args),
  stopRuntime: async (...args) => (await browserPreview()).stopRuntime(...args),
  startRuntime: async (...args) => (await browserPreview()).startRuntime(...args),
  startPersonalChat: async (...args) => (await browserPreview()).startPersonalChat(...args),
  sendPrompt: async (...args) => (await browserPreview()).sendPrompt(...args),
  sendSteer: async (...args) => (await browserPreview()).sendSteer(...args),
  sendFollowUp: async (...args) => (await browserPreview()).sendFollowUp(...args),
  abortRuntime: async (...args) => (await browserPreview()).abortRuntime(...args),
  stopLiveRuntime: async (...args) => (await browserPreview()).stopLiveRuntime(...args),
  getRuntimeState: async (...args) => (await browserPreview()).getRuntimeState(...args),
  getRuntimeModels: async (...args) => (await browserPreview()).getRuntimeModels(...args),
  getRuntimeThinkingLevels: async (...args) => (await browserPreview()).getRuntimeThinkingLevels(...args),
  getRuntimeCommands: async (...args) => (await browserPreview()).getRuntimeCommands(...args),
  listPiUiContributions: async (...args) => (await browserPreview()).listPiUiContributions(...args),
  respondExtensionUi: async (...args) => (await browserPreview()).respondExtensionUi(...args),
  setRuntimeModel: async (...args) => (await browserPreview()).setRuntimeModel(...args),
  setRuntimeThinking: async (...args) => (await browserPreview()).setRuntimeThinking(...args),
  setRuntimeSessionName: async (...args) => (await browserPreview()).setRuntimeSessionName(...args),
  listenRuntimeEvents: async (...args) => (await browserPreview()).listenRuntimeEvents(...args),
};

export const host: HostClient = inTauri() ? tauriClient : browserClient;
