import type { HostClient } from './client';
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
  { id: 'ext-mock-pi-guard', agentKind: 'pi', name: 'permission-guard', source: 'Global', enabled: true },
  { id: 'ext-mock-pi-tools', agentKind: 'pi', name: 'workspace-tools', source: 'Package', enabled: false },
  { id: 'ext-mock-prime-review', agentKind: 'prime-agent', name: 'review-workers', source: 'Global', enabled: true },
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

export const mockClient: HostClient = {
  async bootstrap() {
    return { appVersion: '0.1.0-dev', safeMode: false, preferences: mockPreferences, projects: mockState.projects };
  },
  async updatePreferences(preferences) {
    mockPreferences = { ...preferences };
    return mockPreferences;
  },
  async listExtensions(agentKind) {
    return mockExtensions
      .filter((extension) => extension.agentKind === agentKind)
      .map((extension) => ({ ...extension }));
  },
  async setExtensionEnabled(agentKind, extensionId, enabled) {
    if (!mockExtensions.some((extension) => extension.agentKind === agentKind && extension.id === extensionId)) {
      throw new Error('Extension not found.');
    }
    mockExtensions = mockExtensions.map((extension) =>
      extension.agentKind === agentKind && extension.id === extensionId
        ? { ...extension, enabled }
        : extension,
    );
    return mockExtensions
      .filter((extension) => extension.agentKind === agentKind)
      .map((extension) => ({ ...extension }));
  },
  async pickAndAddProject() {
    return undefined;
  },
  async addProject(path, agentKind) {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
      throw new Error('A folder path is required.');
    }
    const name = trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project';
    const id = `project-${crypto.randomUUID()}`;
    const project: ProjectSummary = { id, name, displayPath: trimmed, agentKind, trustState: 'restricted', pinned: false, missing: false };
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
      runtime: { runtimeId: 'fake-runtime', agentKind: 'pi', state: failed ? 'failed' : 'ready', revision: 3, capabilities: { rpc: true, 'session.tree.read': true, 'session.tree.navigate': false, 'auth.headless': false, 'ui.standardDialogs': true, 'prime.activity': false, 'runtime.liveAttach': false, 'runtime.residentSessions': false, 'runtime.eventReplay': false, 'runtime.multiClient': false, 'thinking.catalog': true }, safeSummary: 'Mock fake scenario completed.' },
      blocks,
      ephemeral: true,
    };
  },
  async startFakeRuntime() {
    return { runtimeId: 'fake-runtime', agentKind: 'pi', state: 'ready', revision: 1, capabilities: { rpc: true, 'session.tree.read': true, 'session.tree.navigate': false, 'auth.headless': false, 'ui.standardDialogs': true, 'prime.activity': false, 'runtime.liveAttach': false, 'runtime.residentSessions': false, 'runtime.eventReplay': false, 'runtime.multiClient': false, 'thinking.catalog': true }, safeSummary: 'Deterministic fake runtime ready.' };
  },
  async stopRuntime() {
    return { runtimeId: 'fake-runtime', agentKind: 'pi', state: 'dormant', revision: 2, capabilities: { rpc: true, 'session.tree.read': true, 'session.tree.navigate': false, 'auth.headless': false, 'ui.standardDialogs': true, 'prime.activity': false, 'runtime.liveAttach': false, 'runtime.residentSessions': false, 'runtime.eventReplay': false, 'runtime.multiClient': false, 'thinking.catalog': true }, safeSummary: 'Runtime stopped.' };
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
    return { runtimeId: 'live-runtime', agentKind: 'pi', state: 'dormant', revision: 0, capabilities: { rpc: true, 'session.tree.read': true, 'session.tree.navigate': false, 'auth.headless': false, 'ui.standardDialogs': true, 'prime.activity': false, 'runtime.liveAttach': false, 'runtime.residentSessions': false, 'runtime.eventReplay': false, 'runtime.multiClient': false, 'thinking.catalog': true }, safeSummary: 'Mock: live runtime stopped.' };
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
  async getRuntimeCommands() {
    return [];
  },
  async listPiUiContributions() {
    return { commands: [], composerActions: [] };
  },
  async respondExtensionUi() {
    /* not available in mock */
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

