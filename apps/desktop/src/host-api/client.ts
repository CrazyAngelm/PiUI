import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ApiRuntimeStart,
  AppSnapshot,
  ExtensionSummary,
  FakeScenario,
  FakeScenarioResult,
  ModelLite,
  Preferences,
  ProjectSummary,
  ProjectTrustState,
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
  listExtensions(): Promise<ExtensionSummary[]>;
  setExtensionEnabled(extensionId: string, enabled: boolean): Promise<ExtensionSummary[]>;
  /** Opens the host-owned native folder picker when available. */
  pickAndAddProject(): Promise<ProjectSummary | undefined>;
  addProject(path: string): Promise<ProjectSummary>;
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

export class HostOperationError extends Error {
  readonly code?: 'CONFLICT';

  constructor(message: string, code?: 'CONFLICT') {
    super(message);
    this.name = 'HostOperationError';
    this.code = code;
  }
}

export function isHostConflict(error: unknown): error is HostOperationError {
  return error instanceof HostOperationError && error.code === 'CONFLICT';
}

function conflictCode(cause: unknown): 'CONFLICT' | undefined {
  if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'CONFLICT') {
    return 'CONFLICT';
  }
  // Tauri can serialize a command error as JSON text on some webview builds.
  // Parse only the known non-sensitive error code; never surface raw payloads.
  if (typeof cause === 'string') {
    try {
      const parsed: unknown = JSON.parse(cause);
      if (typeof parsed === 'object' && parsed !== null && 'code' in parsed && parsed.code === 'CONFLICT') {
        return 'CONFLICT';
      }
    } catch {
      // A non-JSON host error remains intentionally generic.
    }
  }
  return undefined;
}

export function toSafeHostError(operation: string, cause: unknown): HostOperationError {
  const code = conflictCode(cause);
  if (code === 'CONFLICT') {
    return new HostOperationError('This project folder changed. Add it again and confirm trust before continuing.', code);
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
    return invokeSafe<AppSnapshot>('Startup', 'bootstrap');
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
  async listExtensions() {
    return invokeSafe<ExtensionSummary[]>('Extension inventory', 'list_extensions');
  },
  async setExtensionEnabled(extensionId, enabled) {
    return invokeSafe<ExtensionSummary[]>('Extension update', 'set_extension_enabled', { extensionId, enabled });
  },
  async pickAndAddProject() {
    const project = await invokeSafe<ProjectSummary | null>('Folder selection', 'pick_and_add_project');
    return project ?? undefined;
  },
  async addProject(path) {
    return invokeSafe<ProjectSummary>('Project registration', 'add_project', { path });
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

interface MockState {
  projects: ProjectSummary[];
  sessions: Map<string, SessionSummary[]>;
}

const mockState: MockState = { projects: [], sessions: new Map() };
let mockPreferences: Preferences = {
  theme: 'system',
  density: 'comfortable',
  reducedMotion: 'system',
  fontSize: 'medium',
  chatWidth: 'wide',
};
let mockExtensions: ExtensionSummary[] = [
  { id: 'ext-mock-guard', name: 'permission-guard', source: 'Global', enabled: true },
  { id: 'ext-mock-tools', name: 'workspace-tools', source: 'Package', enabled: false },
];

function makeMockSessions(projectId: string): SessionSummary[] {
  return [
    {
      id: `${projectId}-session`,
      projectId,
      title: 'Read-only session preview',
      titleSource: 'date-id',
      createdAt: new Date().toISOString(),
      entryCount: 2,
      branchCount: 1,
      parseState: 'healthy',
    },
  ];
}

const mockClient: HostClient = {
  async bootstrap() {
    return { appVersion: '0.1.0-dev', safeMode: false, preferences: mockPreferences, projects: mockState.projects };
  },
  async updatePreferences(preferences) {
    mockPreferences = { ...preferences };
    return mockPreferences;
  },
  async listExtensions() {
    return mockExtensions.map((extension) => ({ ...extension }));
  },
  async setExtensionEnabled(extensionId, enabled) {
    if (!mockExtensions.some((extension) => extension.id === extensionId)) {
      throw new Error('Extension not found.');
    }
    mockExtensions = mockExtensions.map((extension) => extension.id === extensionId ? { ...extension, enabled } : extension);
    return mockExtensions.map((extension) => ({ ...extension }));
  },
  async pickAndAddProject() {
    return undefined;
  },
  async addProject(path) {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
      throw new Error('A folder path is required.');
    }
    const name = trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project';
    const id = `project-${crypto.randomUUID()}`;
    const project: ProjectSummary = { id, name, displayPath: trimmed, trustState: 'restricted', pinned: false, missing: false };
    mockState.projects = [...mockState.projects, project];
    mockState.sessions.set(id, makeMockSessions(id));
    return project;
  },
  async setProjectTrust(projectId, trustState) {
    const project = mockState.projects.find((item) => item.id === projectId);
    if (project === undefined) {
      throw new Error('Project not found.');
    }
    const updated = { ...project, trustState };
    mockState.projects = mockState.projects.map((item) => item.id === projectId ? updated : item);
    return updated;
  },
  async renameProject(projectId, name) {
    const project = mockState.projects.find((item) => item.id === projectId);
    if (project === undefined || name.trim().length === 0) {
      throw new Error('Project rename is invalid.');
    }
    const updated = { ...project, name: name.trim() };
    mockState.projects = mockState.projects.map((item) => item.id === projectId ? updated : item);
    return updated;
  },
  async setProjectPinned(projectId, pinned) {
    const project = mockState.projects.find((item) => item.id === projectId);
    if (project === undefined) {
      throw new Error('Project not found.');
    }
    const updated = { ...project, pinned };
    mockState.projects = mockState.projects.map((item) => item.id === projectId ? updated : item);
    return updated;
  },
  async removeProject(projectId) {
    mockState.projects = mockState.projects.filter((item) => item.id !== projectId);
    mockState.sessions.delete(projectId);
  },
  async searchSessions(query) {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return [];
    return [...mockState.sessions.values()]
      .flat()
      .filter((session) => `${session.title} ${session.preview ?? ''}`.toLocaleLowerCase().includes(needle))
      .slice(0, 50);
  },
  async listSessions(projectId) {
    return mockState.sessions.get(projectId) ?? [];
  },
  async listPersonalSessions() {
    return [];
  },
  async getSessionCatalog(projectId) {
    return { protocol: 7, scope: 'project', projectId, sequence: 0, freshness: 'current', sessions: mockState.sessions.get(projectId) ?? [] };
  },
  async getPersonalSessionCatalog() {
    return { protocol: 7, scope: 'personal', sequence: 0, freshness: 'current', sessions: [] };
  },
  async refreshSessionCatalog(projectId) {
    return mockClient.getSessionCatalog(projectId);
  },
  async refreshPersonalSessionCatalog() {
    return mockClient.getPersonalSessionCatalog();
  },
  async listenSessionCatalogEvents() {
    return () => {};
  },
  async listenSessionRootHints() {
    return () => {};
  },
  async getTimeline(_projectId, sessionId) {
    return [
      { id: `${sessionId}-entry-1`, kind: 'user', label: 'User', text: 'This is a local, read-only session projection.', status: 'complete' },
      { id: `${sessionId}-entry-2`, parentId: `${sessionId}-entry-1`, kind: 'assistant', label: 'Pi', text: 'The foundation never writes this history directly.', status: 'complete' },
    ];
  },
  async getTimelinePage(_projectId, sessionId) {
    return {
      projectionVersion: 2,
      sessionId,
      fileRevision: 'mock-revision',
      rangeStart: 0,
      totalBlocks: 3,
      staleCursor: false,
      tree: {
        nodes: [
          { entryId: `${sessionId}-entry-1`, kind: 'user', label: 'User message', depth: 0, isCurrentPath: true },
          { entryId: `${sessionId}-entry-2`, parentId: `${sessionId}-entry-1`, kind: 'assistant', label: 'Assistant response', depth: 1, isCurrentPath: true },
        ],
        diagnosticCount: 0,
        navigationSupported: false,
      },
      blocks: [
        { id: `${sessionId}-entry-1`, kind: 'user', label: 'You', text: 'Check the session renderer and run the focused tests.', status: 'complete' },
        { id: `${sessionId}-entry-2`, parentId: `${sessionId}-entry-1`, kind: 'assistant', label: 'Pi', text: 'The transcript now keeps **assistant prose** primary:\n\n- Markdown stays structured\n- Tool activity stays compact\n- Unknown entries keep a safe fallback\n\n```ts\nconst projectionVersion = 2;\n```', status: 'complete' },
        { id: `${sessionId}-entry-3`, parentId: `${sessionId}-entry-2`, kind: 'tool', label: 'Tool activity', title: 'bash', toolName: 'bash', text: 'Test Files  4 passed\nTests      14 passed', collapsible: true, status: 'complete' },
      ],
    };
  },
  async getPersonalTimelinePage(sessionId) {
    return mockClient.getTimelinePage('personal', sessionId);
  },
  async getTree(_projectId, sessionId) {
    return {
      nodes: [
        { entryId: `${sessionId}-entry-1`, kind: 'user', label: 'User message', depth: 0, isCurrentPath: true },
        { entryId: `${sessionId}-entry-2`, parentId: `${sessionId}-entry-1`, kind: 'assistant', label: 'Assistant response', depth: 1, isCurrentPath: true },
      ],
      diagnosticCount: 0,
      navigationSupported: false,
    };
  },
  async getPersonalTree(sessionId) {
    return mockClient.getTree('personal', sessionId);
  },
  async probeSystemRuntime() {
    return {
      eligibility: 'managed_runtime_required',
      managedRuntimeRequired: true,
      externalAuthGuidance: true,
    };
  },
  async runFakeScenario(_projectId, _sessionId, scenario, text) {
    const failed = scenario === 'crash' || scenario === 'malformed';
    const blocks = [
      { id: 'mock-fake-user', kind: 'user' as const, label: 'You · fake scenario', text, status: 'complete' as const },
      ...(failed
        ? [{ id: 'mock-fake-error', kind: 'error' as const, label: 'Fake runtime notice', safeSummary: 'A deterministic mock failure was selected.', status: 'failed' as const }]
        : [{ id: 'mock-fake-assistant', kind: 'assistant' as const, label: 'Pi · fake scenario', text: `deterministic ${text}`, status: scenario === 'abort' ? 'interrupted' as const : 'complete' as const }]),
    ];
    return {
      runtime: { runtimeId: 'fake-runtime', state: failed ? 'failed' : 'ready', revision: 3, capabilities: { rpc: true, 'session.tree.read': true, 'session.tree.navigate': false, 'auth.headless': false, 'ui.standardDialogs': true }, safeSummary: 'Mock fake scenario completed.' },
      blocks,
      ephemeral: true,
    };
  },
  async startFakeRuntime() {
    return { runtimeId: 'fake-runtime', state: 'ready', revision: 1, capabilities: { rpc: true, 'session.tree.read': true, 'session.tree.navigate': false, 'auth.headless': false, 'ui.standardDialogs': true }, safeSummary: 'Deterministic fake runtime ready.' };
  },
  async stopRuntime() {
    return { runtimeId: 'fake-runtime', state: 'dormant', revision: 2, capabilities: { rpc: true, 'session.tree.read': true, 'session.tree.navigate': false, 'auth.headless': false, 'ui.standardDialogs': true }, safeSummary: 'Runtime stopped.' };
  },
  // The live Pi runtime is only available inside the Tauri host; the mock
  // keeps the vite-only dev shell navigable without a real process.
  async startRuntime() {
    throw new Error('A live Pi runtime is only available inside the PiUI desktop app.');
  },
  async startPersonalChat() {
    throw new Error('A live Pi runtime is only available inside the PiUI desktop app.');
  },
  async sendPrompt() {
    throw new Error('A live Pi runtime is only available inside the PiUI desktop app.');
  },
  async sendSteer() {
    throw new Error('A live Pi runtime is only available inside the PiUI desktop app.');
  },
  async sendFollowUp() {
    throw new Error('A live Pi runtime is only available inside the PiUI desktop app.');
  },
  async abortRuntime() {
    /* not available in mock */
  },
  async stopLiveRuntime() {
    return { runtimeId: 'live-runtime', state: 'dormant', revision: 0, capabilities: { rpc: true, 'session.tree.read': true, 'session.tree.navigate': false, 'auth.headless': false, 'ui.standardDialogs': true }, safeSummary: 'Mock: live runtime stopped.' };
  },
  async getRuntimeState() {
    throw new Error('A live Pi runtime is only available inside the PiUI desktop app.');
  },
  async getRuntimeModels() {
    return [];
  },
  async getRuntimeThinkingLevels() {
    return ['off'];
  },
  async setRuntimeModel() {
    /* not available in mock */
  },
  async setRuntimeThinking() {
    /* not available in mock */
  },
  async setRuntimeSessionName() {
    /* not available in mock */
  },
  async listenRuntimeEvents() {
    return async () => {};
  },
};

export const host: HostClient = inTauri() ? tauriClient : mockClient;
