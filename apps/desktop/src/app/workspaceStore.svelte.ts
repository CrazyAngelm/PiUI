/**
 * Application state for the workbench shell: native catalog, session
 * snapshots, selection/routing, drafts and host actions.
 *
 * The algorithms for snapshot acceptance, event gaps and close reconciliation
 * are the ones proven in the previous shell (see features/workspace/workspaceState.ts);
 * this store adds per-frame event batching so streaming no longer re-renders
 * the whole transcript for every token.
 */
import { projectsHost as host } from '../host-api/projectsClient';
import type { Preferences, ProjectSummary } from '../host-api/types';
import { composerRequest } from '../host-api/composerClient';
import { runtimeSettings } from '../host-api/runtimeSettings';
import { deleteWorkspaceSession } from '../host-api/workspaceLifecycle';
import {
  workspaceHost,
  WorkspaceOperationError,
  type SessionSnapshot,
  type WorkspaceCatalog,
  type WorkspaceEvent,
} from '../host-api/workspaceClient';
import type {
  ApprovalDecision,
  HarnessKind,
  PermissionMode,
  WorkspaceApproval,
  WorkspaceModel,
  WorkspaceSession,
  WorkspaceSummary,
} from '../../../../contracts/workspace-v15';
import {
  acceptWorkspaceSnapshot,
  applyWorkspaceEvent,
  mergeCatalogSession,
  protectClosedCatalogSessions,
  resolveCloseAfterCatalog,
  sortedSessions,
} from '../features/workspace/workspaceState';

export type PipelineSection = 'systems' | 'runs' | 'schedules' | 'agents' | 'teams' | 'pipelines';
export type SettingsSection = 'general' | 'harnesses' | 'extensions' | 'projects' | 'shortcuts' | 'about';

export type Route =
  | { name: 'home' }
  | { name: 'chat'; sessionId: string }
  | { name: 'inbox' }
  | { name: 'pipelines'; section: PipelineSection; runId?: string }
  | { name: 'settings'; section: SettingsSection }
  /** Read-only native session history of one folder (or personal chats). */
  | { name: 'history'; workspaceId: string; sessionId?: string };

export interface InboxApproval {
  approval: WorkspaceApproval;
  session: WorkspaceSession;
}

export interface NewChatRequest {
  workspaceId: string;
  harness: HarnessKind;
  model?: WorkspaceModel;
  permissionMode: PermissionMode;
  /** Applied through native runtime settings before the first message. */
  thinkingLevel?: string;
  serviceTier?: 'standard' | 'fast';
  text: string;
}

const EMPTY_CATALOG: WorkspaceCatalog = { protocol: 15, safeMode: false, workspaces: [], sessions: [], harnesses: [] };
const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  density: 'comfortable',
  reducedMotion: 'system',
  fontSize: 'medium',
  chatWidth: 'wide',
};
const ROUTE_KEY = 'piui.shell.route.v1';
const SELECTION_KEY = 'piui.shell.workspace.v1';
const DRAFTS_KEY = 'piui.shell.drafts.v1';
const COLLAPSED_KEY = 'piui.shell.collapsed.v1';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The workspace operation could not be completed.';
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // UI metadata is optional; native sessions stay host-owned.
  }
}

const PIPELINE_SECTIONS: readonly PipelineSection[] = ['systems', 'runs', 'schedules', 'agents', 'teams', 'pipelines'];
const SETTINGS_SECTIONS: readonly SettingsSection[] = ['general', 'harnesses', 'extensions', 'projects', 'shortcuts', 'about'];

function isRoute(value: unknown): value is Route {
  if (typeof value !== 'object' || value === null || !('name' in value)) return false;
  switch ((value as Route).name) {
    case 'home':
    case 'inbox':
      return true;
    case 'chat':
      return typeof (value as { sessionId?: unknown }).sessionId === 'string';
    case 'pipelines': {
      const { section, runId } = value as { section?: unknown; runId?: unknown };
      return PIPELINE_SECTIONS.includes(section as PipelineSection) && (runId === undefined || typeof runId === 'string');
    }
    case 'settings':
      return SETTINGS_SECTIONS.includes((value as { section?: unknown }).section as SettingsSection);
    case 'history': {
      const { workspaceId, sessionId } = value as { workspaceId?: unknown; sessionId?: unknown };
      return typeof workspaceId === 'string' && (sessionId === undefined || typeof sessionId === 'string');
    }
    default:
      return false;
  }
}

const nextFrame: (callback: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (callback) => requestAnimationFrame(() => callback())
    : (callback) => setTimeout(callback, 16);

export class WorkspaceStore {
  catalog = $state.raw<WorkspaceCatalog>(EMPTY_CATALOG);
  catalogLoading = $state(true);
  catalogError = $state<string>();
  snapshots = $state.raw<Record<string, SessionSnapshot>>({});
  route = $state<Route>({ name: 'home' });
  selectedWorkspaceId = $state('');
  sessionLoading = $state(false);
  sessionError = $state<string>();
  drafts = $state.raw<Record<string, string>>({});
  collapsedProjects = $state.raw<string[]>([]);
  preferences = $state.raw<Preferences>(DEFAULT_PREFERENCES);
  /** Registry rows (agent kind, pin) that the v15 workspace catalog does not carry. */
  projectSummaries = $state.raw<ProjectSummary[]>([]);
  preferencesError = $state<string>();
  preferencesBusy = $state(false);
  interruptBusy = $state(false);
  sessionActionBusy = $state(false);
  approvalBusy = $state('');
  approvalErrors = $state.raw<Record<string, string>>({});
  addingProject = $state(false);
  /** Set by the pipeline editor; navigation away asks before discarding. */
  pipelineDirty = $state(false);
  pendingNavigation = $state<(() => void) | undefined>(undefined);

  private catalogRequest = 0;
  private sessionRequest = 0;
  private pendingAcceptedSessionId = '';
  private reconciling = new Set<string>();
  private reconcileAgain = new Set<string>();
  private reopenReconcile = new Set<string>();
  private pendingEvents = new Map<string, WorkspaceEvent[]>();
  private queuedEvents: WorkspaceEvent[] = [];
  private flushScheduled = false;
  private deleted = new Set<string>();
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: (() => void) | undefined;
  private disposed = false;

  // ---- derived views -------------------------------------------------------

  get safeMode(): boolean {
    return this.catalog.safeMode;
  }

  get selectedSessionId(): string {
    return this.route.name === 'chat' ? this.route.sessionId : '';
  }

  get selectedSession(): WorkspaceSession | undefined {
    const id = this.selectedSessionId;
    return id ? this.catalog.sessions.find((session) => session.id === id) : undefined;
  }

  get selectedSnapshot(): SessionSnapshot | undefined {
    const id = this.selectedSessionId;
    return id ? this.snapshots[id] : undefined;
  }

  get selectedWorkspace(): WorkspaceSummary | undefined {
    return this.catalog.workspaces.find((workspace) => workspace.id === this.selectedWorkspaceId);
  }

  sessionsFor(workspaceId: string): WorkspaceSession[] {
    return sortedSessions(this.catalog.sessions.filter((session) => session.workspaceId === workspaceId && !session.runId));
  }

  workspaceName(workspace: WorkspaceSummary | undefined, personalLabel: string): string {
    if (!workspace) return '';
    return workspace.personal ? personalLabel : workspace.name;
  }

  get inboxApprovals(): InboxApproval[] {
    const items: InboxApproval[] = [];
    for (const snapshot of Object.values(this.snapshots)) {
      for (const approval of snapshot.approvals) items.push({ approval, session: snapshot.session });
    }
    return items;
  }

  get runningSessions(): WorkspaceSession[] {
    return sortedSessions(this.catalog.sessions.filter((session) => ['starting', 'running', 'stopping'].includes(session.status)));
  }

  modelsFor(kind: HarnessKind): WorkspaceModel[] {
    const byId = new Map<string, WorkspaceModel>();
    for (const snapshot of Object.values(this.snapshots)) {
      if (snapshot.session.harness !== kind) continue;
      for (const model of snapshot.models) byId.set(JSON.stringify([model.provider, model.id]), model);
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  // ---- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    this.restoreUiState();
    void this.loadPreferences();
    try {
      this.unlisten = await workspaceHost.listen((event) => this.enqueueEvent(event));
      if (this.disposed) {
        this.unlisten();
        return;
      }
      const restored = this.selectedSessionId;
      const next = await this.loadCatalog();
      if (this.disposed) return;
      if (restored && next?.sessions.some((session) => session.id === restored)) {
        await this.openSession(restored, { navigate: false });
      } else if (restored) {
        this.route = { name: 'home' };
      }
    } catch (error) {
      if (!this.disposed) this.catalogError = errorMessage(error);
    }
  }

  dispose(): void {
    this.persistDraftsNow();
    this.disposed = true;
    this.unlisten?.();
  }

  // ---- navigation -----------------------------------------------------------

  /** Runs `action` now, or after the user confirms discarding pipeline edits. */
  guard(action: () => void): void {
    if (this.pipelineDirty && this.route.name === 'pipelines') {
      this.pendingNavigation = action;
      return;
    }
    action();
  }

  confirmPendingNavigation(): void {
    const action = this.pendingNavigation;
    this.pendingNavigation = undefined;
    this.pipelineDirty = false;
    action?.();
  }

  cancelPendingNavigation(): void {
    this.pendingNavigation = undefined;
  }

  navigate(route: Route): void {
    this.guard(() => {
      this.route = route;
      this.sessionError = undefined;
      writeJson(ROUTE_KEY, route);
    });
  }

  /** Open a pipeline run in its own project, e.g. from a run's chat. */
  openRun(workspaceId: string, runId: string | undefined): void {
    this.guard(() => {
      this.selectWorkspace(workspaceId);
      this.route = runId ? { name: 'pipelines', section: 'runs', runId } : { name: 'pipelines', section: 'runs' };
      this.sessionError = undefined;
      writeJson(ROUTE_KEY, this.route);
    });
  }

  goHome(workspaceId?: string): void {
    this.guard(() => {
      if (workspaceId) this.selectWorkspace(workspaceId);
      this.route = { name: 'home' };
      writeJson(ROUTE_KEY, this.route);
    });
  }

  selectWorkspace(id: string): void {
    this.selectedWorkspaceId = id;
    writeJson(SELECTION_KEY, id);
  }

  toggleProject(id: string): void {
    this.collapsedProjects = this.collapsedProjects.includes(id)
      ? this.collapsedProjects.filter((value) => value !== id)
      : [...this.collapsedProjects, id];
    writeJson(COLLAPSED_KEY, this.collapsedProjects);
  }

  // ---- drafts ---------------------------------------------------------------

  draftFor(key: string): string {
    return this.drafts[key] ?? '';
  }

  updateDraft(key: string, text: string): void {
    const next = { ...this.drafts };
    if (text) next[key] = text;
    else delete next[key];
    this.drafts = next;
    if (this.draftTimer !== undefined) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.persistDraftsNow(), 400);
  }

  private persistDraftsNow(): void {
    if (this.draftTimer !== undefined) clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    writeJson(DRAFTS_KEY, this.drafts);
  }

  private restoreUiState(): void {
    const route = readJson<unknown>(ROUTE_KEY);
    if (isRoute(route)) this.route = route;
    const workspace = readJson<unknown>(SELECTION_KEY);
    if (typeof workspace === 'string') this.selectedWorkspaceId = workspace;
    const drafts = readJson<unknown>(DRAFTS_KEY);
    if (drafts && typeof drafts === 'object') {
      this.drafts = Object.fromEntries(
        Object.entries(drafts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    }
    const collapsed = readJson<unknown>(COLLAPSED_KEY);
    if (Array.isArray(collapsed)) this.collapsedProjects = collapsed.filter((id): id is string => typeof id === 'string');
  }

  // ---- preferences ----------------------------------------------------------

  private applyPreferences(next: Preferences): void {
    this.preferences = next;
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset.theme = next.theme;
    root.dataset.density = next.density;
    root.dataset.reducedMotion = next.reducedMotion;
    root.dataset.fontSize = next.fontSize;
    root.dataset.chatWidth = next.chatWidth;
  }

  async loadPreferences(): Promise<void> {
    try {
      const bootstrap = await host.bootstrap();
      if (!this.disposed) {
        this.applyPreferences(bootstrap.preferences);
        this.projectSummaries = bootstrap.projects;
      }
    } catch (error) {
      if (!this.disposed) this.preferencesError = errorMessage(error);
    }
  }

  async savePreferences(next: Preferences): Promise<void> {
    const previous = this.preferences;
    this.applyPreferences(next);
    this.preferencesBusy = true;
    this.preferencesError = undefined;
    try {
      this.applyPreferences(await host.updatePreferences(next));
    } catch (error) {
      this.applyPreferences(previous);
      this.preferencesError = errorMessage(error);
    } finally {
      this.preferencesBusy = false;
    }
  }

  // ---- catalog and snapshots -----------------------------------------------

  async loadCatalog(preferredWorkspaceId?: string): Promise<WorkspaceCatalog | undefined> {
    const request = ++this.catalogRequest;
    this.catalogLoading = this.catalog.sessions.length === 0;
    this.catalogError = undefined;
    try {
      const received = await workspaceHost.catalog();
      if (this.disposed || request !== this.catalogRequest) return undefined;
      const next = protectClosedCatalogSessions(received, this.snapshots);
      next.sessions = next.sessions.filter((session) => !this.deleted.has(session.id));
      this.catalog = next;
      const candidate = preferredWorkspaceId ?? this.selectedWorkspaceId;
      const workspaceId = next.workspaces.some((workspace) => workspace.id === candidate)
        ? candidate
        : (next.workspaces.find((workspace) => !workspace.missing && !workspace.personal)?.id ??
          next.workspaces.find((workspace) => !workspace.missing)?.id ??
          '');
      this.selectWorkspace(workspaceId);
      // Listeners may have been absent while the shell was closed. Reconcile
      // every non-closed session without blocking first paint.
      for (const session of next.sessions) if (session.status !== 'closed') void this.reconcileSession(session.id);
      return next;
    } catch (error) {
      if (!this.disposed && request === this.catalogRequest) this.catalogError = errorMessage(error);
      return undefined;
    } finally {
      if (!this.disposed && request === this.catalogRequest) this.catalogLoading = false;
    }
  }

  private storeSnapshot(next: SessionSnapshot, allowClosedReopen = false): void {
    if (this.deleted.has(next.session.id)) return;
    const current = this.snapshots[next.session.id];
    const accepted = acceptWorkspaceSnapshot(current, next, allowClosedReopen);
    if (accepted !== next) return;
    this.snapshots = { ...this.snapshots, [next.session.id]: next };
    if (this.pendingAcceptedSessionId === next.session.id) this.pendingAcceptedSessionId = '';
    this.catalog = mergeCatalogSession(this.catalog, next.session);
    const queued = allowClosedReopen ? [] : (this.pendingEvents.get(next.session.id) ?? []);
    this.pendingEvents.delete(next.session.id);
    if (queued.length > 0) {
      this.applyEvents([...queued].sort((left, right) => left.revision - right.revision));
    }
  }

  async reconcileSession(sessionId: string, allowClosedReopen = false): Promise<void> {
    if (this.reconciling.has(sessionId)) {
      this.reconcileAgain.add(sessionId);
      if (allowClosedReopen) this.reopenReconcile.add(sessionId);
      return;
    }
    const beforeRevision = this.snapshots[sessionId]?.revision ?? -1;
    let receivedRevision = beforeRevision;
    this.reconciling.add(sessionId);
    try {
      const snapshot = await workspaceHost.snapshot(sessionId);
      receivedRevision = snapshot.revision;
      this.storeSnapshot(snapshot, allowClosedReopen);
    } catch (error) {
      if (this.selectedSessionId === sessionId) this.sessionError = errorMessage(error);
    } finally {
      this.reconciling.delete(sessionId);
      if (this.reconcileAgain.has(sessionId)) {
        this.reconcileAgain.delete(sessionId);
        const reopen = this.reopenReconcile.delete(sessionId);
        if (reopen || receivedRevision > beforeRevision) void this.reconcileSession(sessionId, reopen);
        else if (this.selectedSessionId === sessionId) {
          this.sessionError = 'Session events changed while reconnecting. Check status to refresh from the host.';
        }
      }
    }
  }

  /** Events are applied once per animation frame; token streams coalesce. */
  private enqueueEvent(event: WorkspaceEvent): void {
    this.queuedEvents.push(event);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    nextFrame(() => {
      this.flushScheduled = false;
      const batch = this.queuedEvents;
      this.queuedEvents = [];
      this.applyEvents(batch);
    });
  }

  private applyEvents(events: WorkspaceEvent[]): void {
    let snapshots = this.snapshots;
    let catalog = this.catalog;
    let changed = false;
    for (const incoming of events) {
      if (this.deleted.has(incoming.sessionId)) continue;
      const current = snapshots[incoming.sessionId];
      if (!current) {
        this.queuePending(incoming);
        continue;
      }
      const result = applyWorkspaceEvent(current, incoming);
      if (result.type === 'applied') {
        snapshots = { ...snapshots, [incoming.sessionId]: result.snapshot };
        if (incoming.event.type === 'session') catalog = mergeCatalogSession(catalog, result.snapshot.session);
        if (incoming.event.type === 'error' && incoming.sessionId === this.selectedSessionId) {
          this.sessionError = incoming.event.message;
        }
        changed = true;
      } else if (result.type === 'gap') {
        this.queuePending(incoming);
      }
    }
    if (changed) {
      this.snapshots = snapshots;
      this.catalog = catalog;
    }
  }

  private queuePending(incoming: WorkspaceEvent): void {
    const queued = this.pendingEvents.get(incoming.sessionId) ?? [];
    if (!queued.some((event) => event.revision === incoming.revision)) queued.push(incoming);
    this.pendingEvents.set(incoming.sessionId, queued);
    void this.reconcileSession(incoming.sessionId);
  }

  // ---- session actions ------------------------------------------------------

  async openSession(sessionId: string, options: { navigate?: boolean } = {}): Promise<void> {
    const navigate = options.navigate ?? true;
    if (navigate) {
      this.guard(() => void this.openSession(sessionId, { navigate: false }));
      return;
    }
    const session = this.catalog.sessions.find((item) => item.id === sessionId);
    if (session) this.selectWorkspace(session.workspaceId);
    this.route = { name: 'chat', sessionId };
    writeJson(ROUTE_KEY, this.route);
    this.sessionError = undefined;
    const request = ++this.sessionRequest;
    this.sessionLoading = true;
    try {
      if (this.catalog.safeMode || session?.runId) {
        await this.reconcileSession(sessionId);
        return;
      }
      const result = await workspaceHost.request({ type: 'openSession', sessionId });
      if (this.disposed || request !== this.sessionRequest || this.selectedSessionId !== sessionId) return;
      if (result.type === 'session') this.storeSnapshot(result.snapshot, true);
      else if (result.type === 'accepted') await this.reconcileSession(sessionId, true);
    } catch (error) {
      if (!this.disposed && request === this.sessionRequest && this.selectedSessionId === sessionId) {
        this.sessionError = errorMessage(error);
      }
    } finally {
      if (!this.disposed && request === this.sessionRequest) this.sessionLoading = false;
    }
  }

  /**
   * Creates a native session and queues the first message through the durable
   * composer outbox, so the prompt is delivered once the harness is idle.
   */
  async startChat(request: NewChatRequest): Promise<string> {
    const outcome = await this.createChat(request, { open: true });
    if (outcome.error) this.sessionError = outcome.error;
    return outcome.sessionId;
  }

  /**
   * Create a native chat and send its first message. `open: false` keeps the
   * current screen, e.g. for the pipeline assistant beside the editor; the
   * caller then reports `error` itself. Unsent text is kept as the draft.
   */
  async createChat(request: NewChatRequest, options: { open: boolean; title?: string }): Promise<{ sessionId: string; error?: string }> {
    const { open } = options;
    const harness = this.catalog.harnesses.find((item) => item.kind === request.harness);
    if (!harness || harness.status !== 'available') {
      throw new WorkspaceOperationError('UNAVAILABLE', harness?.reason ?? 'The selected harness is not available.');
    }
    const result = await workspaceHost.request({
      type: 'createSession',
      workspaceId: request.workspaceId,
      harness: request.harness,
      permissionMode: request.permissionMode,
      ...(request.model ? { model: request.model } : {}),
      ...(options.title ? { title: options.title } : {}),
    });
    if (result.type !== 'session' && result.type !== 'accepted') {
      throw new WorkspaceOperationError('CONFLICT', 'The host returned an unexpected create-session result.');
    }
    const sessionId = result.type === 'session' ? result.snapshot.session.id : result.sessionId;
    if (open) {
      this.pendingAcceptedSessionId = result.type === 'accepted' ? sessionId : '';
      this.selectWorkspace(request.workspaceId);
      this.route = { name: 'chat', sessionId };
      writeJson(ROUTE_KEY, this.route);
    }
    if (result.type === 'session') this.storeSnapshot(result.snapshot);
    else await this.reconcileSession(sessionId);
    void this.loadCatalog(request.workspaceId);
    let error: string | undefined;
    if (request.model && (request.thinkingLevel || request.serviceTier)) {
      try {
        await runtimeSettings({
          type: 'set',
          sessionId,
          model: request.model,
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
          ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
        });
      } catch (cause) {
        // The chat still works with native defaults; report instead of hiding it.
        error = errorMessage(cause);
      }
    }
    const text = request.text.trim();
    if (text) {
      try {
        await composerRequest({ type: 'send', sessionId, requestId: crypto.randomUUID(), text: request.text, mode: 'prompt' });
      } catch (cause) {
        // The chat exists; keep the unsent text as its draft so nothing is lost.
        this.updateDraft(sessionId, request.text);
        error = errorMessage(cause);
      }
    }
    return error ? { sessionId, error } : { sessionId };
  }

  async interrupt(sessionId = this.selectedSessionId): Promise<boolean> {
    if (!sessionId || this.interruptBusy) return false;
    this.interruptBusy = true;
    try {
      const result = await workspaceHost.request({ type: 'interrupt', sessionId });
      if (result.type === 'session') this.storeSnapshot(result.snapshot);
      else if (result.type === 'accepted') void this.reconcileSession(sessionId);
      return true;
    } catch (error) {
      this.sessionError = errorMessage(error);
      return false;
    } finally {
      this.interruptBusy = false;
    }
  }

  async rename(sessionId: string, title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed || this.sessionActionBusy) return false;
    this.sessionActionBusy = true;
    try {
      const result = await workspaceHost.request({ type: 'renameSession', sessionId, title: trimmed });
      if (result.type === 'session') this.storeSnapshot(result.snapshot);
      else if (result.type === 'accepted') await this.reconcileSession(sessionId);
      return true;
    } catch (error) {
      this.sessionError = errorMessage(error);
      return false;
    } finally {
      this.sessionActionBusy = false;
    }
  }

  async close(sessionId: string): Promise<void> {
    if (this.sessionActionBusy) return;
    const closing = this.catalog.sessions.find((session) => session.id === sessionId);
    if (!closing) return;
    this.sessionActionBusy = true;
    try {
      const result = await workspaceHost.request({ type: 'closeSession', sessionId });
      if (result.type === 'session') this.storeSnapshot(result.snapshot);
      else if (result.type === 'accepted') await this.resolveClose(closing, undefined);
    } catch (error) {
      await this.resolveClose(closing, errorMessage(error));
    } finally {
      this.sessionActionBusy = false;
    }
  }

  private async resolveClose(closing: WorkspaceSession, commandError: string | undefined): Promise<void> {
    const refreshed = await this.loadCatalog(closing.workspaceId);
    const catalogSession = refreshed?.sessions.find((session) => session.id === closing.id);
    const retained = this.snapshots[closing.id];
    if (retained) {
      const resolution = resolveCloseAfterCatalog(retained, catalogSession, commandError);
      this.snapshots = { ...this.snapshots, [closing.id]: resolution.snapshot };
      if (resolution.error) this.sessionError = resolution.error;
    } else if (commandError) {
      this.sessionError = commandError;
    } else if (!catalogSession) {
      this.sessionError = 'Close was accepted, but its final status is not available yet. Refresh to check status.';
    }
  }

  async deleteChat(sessionId: string): Promise<void> {
    await deleteWorkspaceSession(sessionId);
    this.deleted.add(sessionId);
    const { [sessionId]: _snapshot, ...snapshots } = this.snapshots;
    this.snapshots = snapshots;
    const { [sessionId]: _draft, ...drafts } = this.drafts;
    this.drafts = drafts;
    this.persistDraftsNow();
    this.catalog = { ...this.catalog, sessions: this.catalog.sessions.filter((session) => session.id !== sessionId) };
    if (this.selectedSessionId === sessionId) {
      this.route = { name: 'home' };
      writeJson(ROUTE_KEY, this.route);
    }
  }

  approvalKey(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
  }

  async respond(sessionId: string, approval: WorkspaceApproval, decision: ApprovalDecision, text?: string): Promise<boolean> {
    const key = this.approvalKey(sessionId, approval.id);
    if (this.approvalBusy) return false;
    this.approvalBusy = key;
    this.approvalErrors = { ...this.approvalErrors, [key]: '' };
    try {
      const result = await workspaceHost.request({
        type: 'respond',
        sessionId,
        requestId: approval.id,
        decision,
        ...(text && text.trim() ? { text } : {}),
      });
      if (result.type === 'session') this.storeSnapshot(result.snapshot);
      return true;
    } catch (error) {
      this.approvalErrors = { ...this.approvalErrors, [key]: errorMessage(error) };
      return false;
    } finally {
      this.approvalBusy = '';
    }
  }

  // ---- projects -------------------------------------------------------------

  async addProject(): Promise<void> {
    if (this.addingProject) return;
    this.addingProject = true;
    this.catalogError = undefined;
    try {
      const project = await host.pickAndAddProject();
      if (project) await Promise.all([this.loadCatalog(project.id), this.loadProjects()]);
    } catch (error) {
      this.catalogError = errorMessage(error);
    } finally {
      this.addingProject = false;
    }
  }

  async trustProject(workspaceId: string): Promise<void> {
    await host.setProjectTrust(workspaceId, 'trusted');
    await this.loadCatalog(workspaceId);
  }

  /** Registry rows for agent kind and pin state; the catalog carries names and trust. */
  async loadProjects(): Promise<void> {
    try {
      const bootstrap = await host.bootstrap();
      if (!this.disposed) this.projectSummaries = bootstrap.projects;
    } catch {
      // Menus keep the last rows; the next load refreshes pin labels.
    }
  }

  /** Renames PiUI's label only; the folder on disk keeps its name. */
  async renameProject(workspaceId: string, name: string): Promise<void> {
    await host.renameProject(workspaceId, name);
    await Promise.all([this.loadCatalog(workspaceId), this.loadProjects()]);
  }

  /** Pinned folders sort first in the host registry order. */
  async setProjectPinned(workspaceId: string, pinned: boolean): Promise<void> {
    await host.setProjectPinned(workspaceId, pinned);
    await Promise.all([this.loadCatalog(), this.loadProjects()]);
  }

  /**
   * Forgets a folder in PiUI. The host stops that folder's agents first; the
   * folder, its files and every harness's own history stay on disk.
   */
  async removeProject(workspaceId: string): Promise<void> {
    await host.removeProject(workspaceId);
    const route = this.route;
    const affected =
      (route.name === 'chat' && this.catalog.sessions.find((session) => session.id === route.sessionId)?.workspaceId === workspaceId) ||
      (route.name === 'history' && route.workspaceId === workspaceId) ||
      (route.name === 'pipelines' && this.selectedWorkspaceId === workspaceId);
    if (affected) {
      this.pipelineDirty = false;
      this.route = { name: 'home' };
      writeJson(ROUTE_KEY, this.route);
    }
    await Promise.all([this.loadCatalog(), this.loadProjects()]);
  }
}
