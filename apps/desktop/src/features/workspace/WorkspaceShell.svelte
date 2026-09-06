<script lang="ts">
  import { t } from '../locale/language';
  import { onMount, tick } from 'svelte';
  import ConversationViewport from './ConversationViewport.svelte';
  import { host } from '../../host-api/client';
  import type { Preferences } from '../../host-api/types';
  import {
    workspaceHost,
    WorkspaceOperationError,
    type SessionSnapshot,
    type WorkspaceCatalog,
    type WorkspaceEvent,
  } from '../../host-api/workspaceClient';
  import type {
    ApprovalDecision,
    HarnessKind,
    PermissionMode,
    WorkspaceApproval,
    WorkspaceModel,
    WorkspaceSession,
    WorkspaceSummary,
  } from '../../../../../contracts/workspace-v11';
  import WorkspaceSettings from './WorkspaceSettings.svelte';
  import { modalFocus, sessionForProject, shortcutModifier } from './workspaceUx';
  import { acceptWorkspaceSnapshot, applyWorkspaceEvent, harnessLabel, mergeCatalogSession, protectClosedCatalogSessions, resolveCloseAfterCatalog, sortedSessions, statusLabel } from './workspaceState';


  type MainView = 'sessions' | 'workspace' | 'settings';
  type WorkspaceSection = 'systems' | 'agents' | 'teams' | 'pipelines' | 'runs';
  type Inspector = 'approvals' | 'activity' | 'details' | undefined;
  type OrchestrationComponent = typeof import('../orchestration/OrchestrationPanel.svelte').default;

  const emptyCatalog: WorkspaceCatalog = { protocol: 11, safeMode: false, workspaces: [], sessions: [], harnesses: [] };
  const defaultPreferences: Preferences = {
    theme: 'system', density: 'comfortable', reducedMotion: 'system', fontSize: 'medium', chatWidth: 'wide',
  };
  const uiStateKey = 'piui.workspace.ui.v11';
  interface PersistedUiState {
    selectedWorkspaceId?: string;
    selectedSessionId?: string;
    drafts?: Record<string, string>;
    workspaceSection?: WorkspaceSection;
  }

  let catalog = emptyCatalog;
  let catalogLoading = true;
  let catalogError: string | undefined;
  let catalogRequest = 0;
  let selectedWorkspaceId = '';
  let selectedSessionId = '';
  let snapshots: Record<string, SessionSnapshot> = {};
  let sessionLoading = false;
  let sessionError: string | undefined;
  let sessionRequest = 0;
  let pendingAcceptedSessionId = '';
  let reconciling = new Set<string>();
  let reconcileAgain = new Set<string>();
  let reopenReconcile = new Set<string>();
  let pendingEvents: Record<string, WorkspaceEvent[]> = {};
  let mainView: MainView = 'sessions';
  let previousMainView: Exclude<MainView, 'settings'> = 'sessions';
  let workspaceSection: WorkspaceSection = 'systems';
  let requestedWorkspaceSection: WorkspaceSection | undefined;
  let requestedMainView: MainView | undefined;
  let orchestrationDirty = false;
  let orchestrationEpoch = 0;
  let OrchestrationPanel: OrchestrationComponent | undefined;
  let orchestrationLoading = false;
  let orchestrationError: string | undefined;
  let inspector: Inspector;
  let navigationOpen = false;
  let search = '';
  let harnessFilter: HarnessKind | 'all' = 'all';
  let newSessionOpen = false;
  let newWorkspaceId = '';
  let newHarness: HarnessKind | '' = '';
  let newModelId = '';
  let permissionMode: PermissionMode = 'native';
  let createBusy = false;
  let createError: string | undefined;
  let drafts: Record<string, string> = {};
  let sendMode: 'prompt' | 'steer' | 'follow-up' = 'prompt';
  let sendBusy = false;
  let sendError: string | undefined;
  let interruptBusy = false;
  let sessionActionBusy = false;
  let renameDraft = '';
  let approvalBusy = '';
  let approvalErrors: Record<string, string> = {};
  let approvalStatus: Record<string, string> = {};
  let approvalInput: Record<string, string> = {};
  let trustTarget: WorkspaceSummary | undefined;
  let trustBusy = false;
  let trustError: string | undefined;
  let addingProject = false;
  let preferences = defaultPreferences;
  let preferencesBusy = false;
  let preferencesError: string | undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let inspectorTrigger: HTMLElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let modifier = 'Ctrl+';
  let narrow = false;
  let pendingNavigation: (() => void) | undefined;

  function guardNavigation(action: () => void): boolean {
    if (!orchestrationDirty) return false;
    pendingNavigation = action;
    return true;
  }

  function selectProject(id: string): void {
    if (id === selectedWorkspaceId) return;
    if (guardNavigation(() => selectProject(id))) return;
    selectedWorkspaceId = id;
    selectedSessionId = sessionForProject(catalog.sessions, id, selectedSessionId);
    sessionRequest += 1;
    sessionLoading = false;
    sessionError = undefined;
    search = '';
    newWorkspaceId = id;
    persistUiState();
  }

  $: selectedWorkspace = catalog.workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  $: selectedSession = catalog.sessions.find((session) => session.id === selectedSessionId);
  $: selectedSnapshot = selectedSessionId ? snapshots[selectedSessionId] : undefined;
  $: if (selectedSession && renameDraft === '') renameDraft = selectedSession.title;
  $: visibleSessions = sortedSessions(catalog.sessions.filter((session) => {
    if (session.workspaceId !== selectedWorkspaceId) return false;
    if (harnessFilter !== 'all' && session.harness !== harnessFilter) return false;
    const query = search.trim().toLocaleLowerCase();
    return query === '' || session.title.toLocaleLowerCase().includes(query) || harnessLabel(session.harness).toLocaleLowerCase().includes(query);
  }));
  $: knownModels = modelChoices(newHarness);
  $: allApprovals = Object.values(snapshots).flatMap((snapshot) => snapshot.approvals.map((approval) => ({ approval, snapshot })));
  $: attentionCount = allApprovals.length;
  $: activeSessions = sortedSessions(catalog.sessions.filter((session) => ['starting', 'running', 'stopping', 'failed'].includes(session.status)));

  function restoreUiState(): void {
    try {
      const raw = sessionStorage.getItem(uiStateKey);
      if (!raw) return;
      const value = JSON.parse(raw) as PersistedUiState;
      if (typeof value.selectedWorkspaceId === 'string') selectedWorkspaceId = value.selectedWorkspaceId;
      if (typeof value.selectedSessionId === 'string') selectedSessionId = value.selectedSessionId;
      if (value.workspaceSection && ['systems', 'agents', 'teams', 'pipelines', 'runs'].includes(value.workspaceSection)) workspaceSection = value.workspaceSection;
      if (value.drafts && typeof value.drafts === 'object') {
        drafts = Object.fromEntries(Object.entries(value.drafts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      }
    } catch {
      // Invalid session-local UI metadata is ignored. Native sessions remain host-owned.
    }
  }

  function persistUiState(): void {
    try {
      const value: PersistedUiState = { selectedWorkspaceId, selectedSessionId, drafts, workspaceSection };
      sessionStorage.setItem(uiStateKey, JSON.stringify(value));
    } catch {
      // Draft persistence failure must not block native session controls.
    }
  }

  function updateDraft(sessionId: string, text: string): void {
    drafts = { ...drafts, [sessionId]: text };
    persistUiState();
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The workspace operation could not be completed.';
  }

  function applyPreferences(next: Preferences): void {
    preferences = next;
    const root = document.documentElement;
    root.dataset.theme = next.theme;
    root.dataset.density = next.density;
    root.dataset.reducedMotion = next.reducedMotion;
    root.dataset.fontSize = next.fontSize;
    root.dataset.chatWidth = next.chatWidth;
  }

  async function loadPreferences(): Promise<void> {
    try {
      const bootstrap = await host.bootstrap();
      if (!disposed) applyPreferences(bootstrap.preferences);
    } catch (error) {
      if (!disposed) preferencesError = errorMessage(error);
    }
  }

  async function savePreferences(next: Preferences): Promise<void> {
    const previous = preferences;
    applyPreferences(next);
    preferencesBusy = true;
    preferencesError = undefined;
    try {
      applyPreferences(await host.updatePreferences(next));
    } catch (error) {
      applyPreferences(previous);
      preferencesError = errorMessage(error);
    } finally {
      preferencesBusy = false;
    }
  }

  async function loadCatalog(preferredWorkspaceId: string | undefined = undefined): Promise<WorkspaceCatalog | undefined> {
    const request = ++catalogRequest;
    catalogLoading = catalog.sessions.length === 0;
    catalogError = undefined;
    try {
      const received = await workspaceHost.catalog();
      if (disposed || request !== catalogRequest) return;
      const next = protectClosedCatalogSessions(received, snapshots);
      catalog = next;
      const candidate = preferredWorkspaceId ?? selectedWorkspaceId;
      selectedWorkspaceId = next.workspaces.some((workspace) => workspace.id === candidate)
        ? candidate
        : (next.workspaces.find((workspace) => !workspace.missing)?.id ?? '');
      if (selectedSessionId && !next.sessions.some((session) => session.id === selectedSessionId) && snapshots[selectedSessionId] === undefined && selectedSessionId !== pendingAcceptedSessionId) selectedSessionId = '';
      if (!newWorkspaceId || !next.workspaces.some((workspace) => workspace.id === newWorkspaceId)) newWorkspaceId = selectedWorkspaceId;
      if (!newHarness) newHarness = next.harnesses.find((harness) => harness.status === 'available')?.kind ?? '';
      // A listener may have been absent while the shell was unmounted.
      // Reconcile every non-closed native session without blocking first paint;
      // snapshot is read-only and never adopts, starts, or disposes a runtime.
      for (const session of next.sessions) if (session.status !== 'closed') void reconcileSession(session.id);
      return next;
    } catch (error) {
      if (!disposed && request === catalogRequest) catalogError = errorMessage(error);
    } finally {
      if (!disposed && request === catalogRequest) catalogLoading = false;
    }
  }

  function storeSnapshot(next: SessionSnapshot, allowClosedReopen = false): void {
    const current = snapshots[next.session.id];
    const accepted = acceptWorkspaceSnapshot(current, next, allowClosedReopen);
    if (accepted !== next) return;
    snapshots = { ...snapshots, [next.session.id]: next };
    if (pendingAcceptedSessionId === next.session.id) pendingAcceptedSessionId = '';
    catalog = mergeCatalogSession(catalog, next.session);
    const queued = allowClosedReopen ? [] : (pendingEvents[next.session.id] ?? []);
    pendingEvents = { ...pendingEvents, [next.session.id]: [] };
    if (queued.length > 0) {
      for (const incoming of [...queued].sort((left, right) => left.revision - right.revision)) handleEvent(incoming);
    }
  }

  async function reconcileSession(sessionId: string, allowClosedReopen = false): Promise<void> {
    if (reconciling.has(sessionId)) {
      reconcileAgain = new Set(reconcileAgain).add(sessionId);
      if (allowClosedReopen) reopenReconcile = new Set(reopenReconcile).add(sessionId);
      return;
    }
    const beforeRevision = snapshots[sessionId]?.revision ?? -1;
    let receivedRevision = beforeRevision;
    reconciling = new Set(reconciling).add(sessionId);
    try {
      const nextSnapshot = await workspaceHost.snapshot(sessionId);
      receivedRevision = nextSnapshot.revision;
      storeSnapshot(nextSnapshot, allowClosedReopen);
    } catch (error) {
      if (selectedSessionId === sessionId) sessionError = errorMessage(error);
    } finally {
      const next = new Set(reconciling);
      next.delete(sessionId);
      reconciling = next;
      if (reconcileAgain.has(sessionId)) {
        const remaining = new Set(reconcileAgain);
        remaining.delete(sessionId);
        reconcileAgain = remaining;
        const reopen = reopenReconcile.has(sessionId);
        if (reopen) {
          const reopenRemaining = new Set(reopenReconcile);
          reopenRemaining.delete(sessionId);
          reopenReconcile = reopenRemaining;
        }
        if (reopen || receivedRevision > beforeRevision) void reconcileSession(sessionId, reopen);
        else if (selectedSessionId === sessionId) sessionError = 'Session events changed while reconnecting. Check status to refresh from the host.';
      }
    }
  }

  function handleEvent(incoming: WorkspaceEvent): void {
    const current = snapshots[incoming.sessionId];
    if (!current) {
      const queued = pendingEvents[incoming.sessionId] ?? [];
      if (!queued.some((event) => event.revision === incoming.revision)) {
        pendingEvents = { ...pendingEvents, [incoming.sessionId]: [...queued, incoming] };
      }
      void reconcileSession(incoming.sessionId);
      return;
    }
    const result = applyWorkspaceEvent(current, incoming);
    if (result.type === 'applied') {
      storeSnapshot(result.snapshot);
      if (incoming.event.type === 'error' && incoming.sessionId === selectedSessionId) sessionError = incoming.event.message;
    } else if (result.type === 'gap') {
      const queued = pendingEvents[incoming.sessionId] ?? [];
      if (!queued.some((event) => event.revision === incoming.revision)) {
        pendingEvents = { ...pendingEvents, [incoming.sessionId]: [...queued, incoming] };
      }
      void reconcileSession(incoming.sessionId);
    }
  }

  async function openSession(sessionId: string): Promise<void> {
    if (guardNavigation(() => { void openSession(sessionId); })) return;
    const session = catalog.sessions.find((item) => item.id === sessionId);
    if (session) selectedWorkspaceId = session.workspaceId;
    selectedSessionId = sessionId;
    persistUiState();
    navigationOpen = false;
    mainView = 'sessions';
    newSessionOpen = false;
    sendError = undefined;
    sessionError = undefined;
    renameDraft = catalog.sessions.find((session) => session.id === sessionId)?.title ?? '';
    const request = ++sessionRequest;
    sessionLoading = snapshots[sessionId] === undefined;
    try {
      const result = await workspaceHost.request({ type: 'openSession', sessionId });
      if (disposed || request !== sessionRequest || selectedSessionId !== sessionId) return;
      if (result.type === 'session') storeSnapshot(result.snapshot, true);
      else if (result.type === 'accepted') await reconcileSession(sessionId, true);
    } catch (error) {
      if (!disposed && request === sessionRequest && selectedSessionId === sessionId) sessionError = errorMessage(error);
    } finally {
      if (!disposed && request === sessionRequest) sessionLoading = false;
    }
  }

  function startNewSession(): void {
    if (guardNavigation(startNewSession)) return;
    mainView = 'sessions';
    selectedSessionId = '';
    persistUiState();
    newSessionOpen = true;
    newWorkspaceId = selectedWorkspaceId;
    createError = undefined;
    navigationOpen = false;
    void tick().then(() => document.querySelector<HTMLSelectElement>('.new-session select')?.focus());
  }

  function modelChoices(kind: HarnessKind | ''): WorkspaceModel[] {
    if (!kind) return [];
    const byId = new Map<string, WorkspaceModel>();
    for (const snapshot of Object.values(snapshots)) {
      if (snapshot.session.harness === kind) for (const model of snapshot.models) byId.set(model.id, model);
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async function createSession(): Promise<void> {
    if (!newWorkspaceId || !newHarness) {
      createError = 'Choose a project and an available harness.';
      return;
    }
    const harness = catalog.harnesses.find((item) => item.kind === newHarness);
    if (!harness || harness.status !== 'available') {
      createError = harness?.reason ?? 'The selected harness is not available.';
      return;
    }
    const model = knownModels.find((item) => item.id === newModelId);
    createBusy = true;
    createError = undefined;
    try {
      const result = await workspaceHost.request({
        type: 'createSession', workspaceId: newWorkspaceId, harness: newHarness,
        permissionMode, ...(model ? { model } : {}),
      });
      if (result.type !== 'session' && result.type !== 'accepted') throw new WorkspaceOperationError('CONFLICT', 'The host returned an unexpected create-session result.');
      selectedWorkspaceId = newWorkspaceId;
      selectedSessionId = result.type === 'session' ? result.snapshot.session.id : result.sessionId;
      pendingAcceptedSessionId = result.type === 'accepted' ? result.sessionId : '';
      persistUiState();
      newSessionOpen = false;
      if (result.type === 'session') storeSnapshot(result.snapshot);
      else await reconcileSession(result.sessionId);
      await loadCatalog(newWorkspaceId);
    } catch (error) {
      createError = errorMessage(error);
    } finally {
      createBusy = false;
    }
  }

  async function send(): Promise<void> {
    if (!selectedSnapshot || sendBusy) return;
    const text = drafts[selectedSnapshot.session.id] ?? '';
    if (text.trim() === '') return;
    const sessionId = selectedSnapshot.session.id;
    const submitted = text;
    sendBusy = true;
    sendError = undefined;
    try {
      const effectiveMode = selectedSnapshot.session.status === 'running' ? sendMode : 'prompt';
      const result = await workspaceHost.request({ type: 'send', sessionId, text: submitted, mode: effectiveMode });
      if (result.type === 'session') storeSnapshot(result.snapshot);
      else if (result.type === 'accepted') void reconcileSession(sessionId);
      if ((drafts[sessionId] ?? '') === submitted) updateDraft(sessionId, '');
    } catch (error) {
      sendError = errorMessage(error);
    } finally {
      sendBusy = false;
    }
  }

  function composerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function interruptSession(): Promise<void> {
    if (!selectedSession || interruptBusy) return;
    interruptBusy = true;
    sendError = undefined;
    try {
      const result = await workspaceHost.request({ type: 'interrupt', sessionId: selectedSession.id });
      if (result.type === 'session') storeSnapshot(result.snapshot);
      else if (result.type === 'accepted') void reconcileSession(selectedSession.id);
    } catch (error) {
      sendError = errorMessage(error);
    } finally {
      interruptBusy = false;
    }
  }

  async function renameSession(): Promise<void> {
    if (!selectedSession || renameDraft.trim() === '' || sessionActionBusy) return;
    sessionActionBusy = true;
    sessionError = undefined;
    try {
      const result = await workspaceHost.request({ type: 'renameSession', sessionId: selectedSession.id, title: renameDraft.trim() });
      if (result.type === 'session') storeSnapshot(result.snapshot);
      else if (result.type === 'accepted') await reconcileSession(selectedSession.id);
    } catch (error) {
      sessionError = errorMessage(error);
    } finally {
      sessionActionBusy = false;
    }
  }

  async function setModel(event: Event): Promise<void> {
    if (!selectedSnapshot || sessionActionBusy) return;
    const id = (event.currentTarget as HTMLSelectElement).value;
    const model = selectedSnapshot.models.find((item) => item.id === id);
    if (!model) return;
    sessionActionBusy = true;
    sessionError = undefined;
    try {
      const result = await workspaceHost.request({ type: 'setModel', sessionId: selectedSnapshot.session.id, model });
      if (result.type === 'session') storeSnapshot(result.snapshot);
      else if (result.type === 'accepted') await reconcileSession(selectedSnapshot.session.id);
    } catch (error) {
      sessionError = errorMessage(error);
    } finally {
      sessionActionBusy = false;
    }
  }

  async function closeSession(): Promise<void> {
    if (!selectedSession || sessionActionBusy) return;
    const closingSession = selectedSession;
    sessionActionBusy = true;
    sessionError = undefined;
    try {
      const result = await workspaceHost.request({ type: 'closeSession', sessionId: closingSession.id });
      if (result.type === 'session') storeSnapshot(result.snapshot);
      else if (result.type === 'accepted') {
        // A deliberately closed native runtime may no longer have a live
        // snapshot. The catalog is authoritative for its terminal status.
        const refreshed = await loadCatalog(closingSession.workspaceId);
        const catalogSession = refreshed?.sessions.find((session) => session.id === closingSession.id);
        const retained = snapshots[closingSession.id];
        if (catalogSession && retained) {
          const resolution = resolveCloseAfterCatalog(retained, catalogSession, undefined);
          snapshots = { ...snapshots, [closingSession.id]: resolution.snapshot };
        } else if (!catalogSession) {
          sessionError = 'Close was accepted, but its final status is not available yet. Refresh to check status.';
        }
      }
    } catch (error) {
      // Native disposal can finish before the command reports its post-close
      // snapshot error. Preserve that honest error, but still reconcile the
      // authoritative catalog instead of leaving an Idle row on screen.
      const commandError = errorMessage(error);
      const refreshed = await loadCatalog(closingSession.workspaceId);
      const catalogSession = refreshed?.sessions.find((session) => session.id === closingSession.id);
      const retained = snapshots[closingSession.id];
      if (retained) {
        const resolution = resolveCloseAfterCatalog(retained, catalogSession, commandError);
        snapshots = { ...snapshots, [closingSession.id]: resolution.snapshot };
        sessionError = resolution.error;
      } else {
        sessionError = commandError;
      }
    } finally {
      sessionActionBusy = false;
    }
  }

  function approvalKey(sessionId: string, requestId: string): string { return `${sessionId}:${requestId}`; }

  async function respond(snapshot: SessionSnapshot, approval: WorkspaceApproval, decision: ApprovalDecision): Promise<void> {
    const key = approvalKey(snapshot.session.id, approval.id);
    if (approvalBusy) return;
    approvalBusy = key;
    approvalErrors = { ...approvalErrors, [key]: '' };
    approvalStatus = { ...approvalStatus, [key]: 'Sending decision…' };
    try {
      const text = approval.kind === 'input' ? approvalInput[key] : undefined;
      const result = await workspaceHost.request({
        type: 'respond', sessionId: snapshot.session.id, requestId: approval.id, decision,
        ...(text && text.trim() ? { text } : {}),
      });
      if (result.type === 'session') storeSnapshot(result.snapshot);
      approvalStatus = { ...approvalStatus, [key]: 'Decision sent. Waiting for native resolution.' };
    } catch (error) {
      approvalErrors = { ...approvalErrors, [key]: errorMessage(error) };
      approvalStatus = { ...approvalStatus, [key]: '' };
    } finally {
      approvalBusy = '';
    }
  }

  function decisionLabel(decision: ApprovalDecision): string {
    switch (decision) {
      case 'approve-once': return 'Approve once';
      case 'approve-session': return 'Approve for session';
      case 'deny': return 'Deny';
      case 'cancel': return 'Cancel request';
      default: return assertApprovalDecision(decision);
    }
  }

  function assertApprovalDecision(value: never): never {
    throw new Error(`Unexpected approval decision: ${String(value)}`);
  }

  async function openInspector(next: Exclude<Inspector, undefined>, trigger: Event): Promise<void> {
    inspectorTrigger = trigger.currentTarget as HTMLElement;
    inspector = next;
    await tick();
    document.querySelector<HTMLElement>('.inspector')?.focus();
  }

  async function closeInspector(): Promise<void> {
    inspector = undefined;
    await tick();
    inspectorTrigger?.focus();
  }

  async function addProject(): Promise<void> {
    if (guardNavigation(() => { void addProject(); })) return;
    if (addingProject) return;
    addingProject = true;
    catalogError = undefined;
    try {
      const project = await host.pickAndAddProject('pi');
      if (project) {
        selectedSessionId = '';
        await loadCatalog(project.id);
      }
    } catch (error) {
      catalogError = errorMessage(error);
    } finally {
      addingProject = false;
    }
  }

  async function trustProject(): Promise<void> {
    if (!trustTarget || trustBusy) return;
    trustBusy = true;
    trustError = undefined;
    try {
      await host.setProjectTrust(trustTarget.id, 'trusted');
      const workspaceId = trustTarget.id;
      trustTarget = undefined;
      await loadCatalog(workspaceId);
    } catch (error) {
      trustError = errorMessage(error);
    } finally {
      trustBusy = false;
    }
  }

  async function showWorkspace(): Promise<void> {
    if (mainView !== 'workspace' && orchestrationDirty) {
      requestedMainView = 'workspace';
      return;
    }
    mainView = 'workspace';
    if (OrchestrationPanel || orchestrationLoading) return;
    orchestrationLoading = true;
    orchestrationError = undefined;
    try {
      OrchestrationPanel = (await import('../orchestration/OrchestrationPanel.svelte')).default;
    } catch (error) {
      orchestrationError = errorMessage(error);
    } finally {
      orchestrationLoading = false;
    }
  }

  function requestSection(section: WorkspaceSection): void {
    if (section === workspaceSection) return;
    if (orchestrationDirty) requestedWorkspaceSection = section;
    else { workspaceSection = section; persistUiState(); }
  }

  function requestMainView(next: Exclude<MainView, 'settings'>): void {
    if (next === mainView) return;
    if (mainView === 'workspace' && orchestrationDirty) { requestedMainView = next; return; }
    if (next === 'workspace') void showWorkspace();
    else mainView = next;
  }

  function confirmDiscardWorkspace(): void {
    orchestrationDirty = false;
    orchestrationEpoch += 1;
    if (requestedWorkspaceSection && requestedWorkspaceSection !== workspaceSection) workspaceSection = requestedWorkspaceSection;
    if (requestedMainView) {
      const destination = requestedMainView;
      if (destination === 'settings') previousMainView = 'workspace';
      requestedMainView = undefined;
      if (destination === 'workspace') void showWorkspace();
      else mainView = destination;
    }
    requestedWorkspaceSection = undefined;
    const navigate = pendingNavigation;
    pendingNavigation = undefined;
    navigate?.();
    persistUiState();
  }

  function keepEditingWorkspace(): void {
    pendingNavigation = undefined;
    requestedWorkspaceSection = undefined;
    requestedMainView = undefined;
  }

  function showSettings(): void {
    if (mainView === 'workspace' && orchestrationDirty) { requestedMainView = 'settings'; return; }
    previousMainView = mainView === 'settings' ? previousMainView : mainView;
    mainView = 'settings';
    navigationOpen = false;
  }

  function closeSettings(): void { mainView = previousMainView; }

  function globalKeydown(event: KeyboardEvent): void {
    if (trustTarget || requestedMainView || requestedWorkspaceSection || pendingNavigation) return;
    if (event.key === 'Escape') {
      if (navigationOpen) { navigationOpen = false; void tick().then(() => document.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')?.focus()); }
      else if (inspector) void closeInspector();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLocaleLowerCase() === 'n') { event.preventDefault(); startNewSession(); }
    else if (event.key === ',') { event.preventDefault(); showSettings(); }
    else if (event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); navigationOpen = true; void tick().then(() => searchInput?.focus()); }
    else if (event.key === '.' && selectedSession?.status === 'running') { event.preventDefault(); void interruptSession(); }
    else if (event.key.toLocaleLowerCase() === 'b') { event.preventDefault(); navigationOpen = !navigationOpen; }
  }

  onMount(() => {
    restoreUiState();
    modifier = shortcutModifier(navigator.platform);
    const narrowQuery = window.matchMedia('(max-width: 760px)');
    const updateNarrow = () => narrow = narrowQuery.matches;
    updateNarrow();
    narrowQuery.addEventListener('change', updateNarrow);
    window.addEventListener('keydown', globalKeydown);
    void loadPreferences();
    void (async () => {
      try {
        unlisten = await workspaceHost.listen(handleEvent);
        if (disposed) unlisten();
        else if (selectedSessionId) await reconcileSession(selectedSessionId);
      } catch (error) {
        if (!disposed) catalogError = errorMessage(error);
      }
    })();
    void loadCatalog();
    return () => {
      persistUiState();
      narrowQuery.removeEventListener('change', updateNarrow);
      disposed = true;
      window.removeEventListener('keydown', globalKeydown);
      unlisten?.();
      // Native sessions are host-owned. View teardown only releases this event listener.
    };
  });
</script>

<div class="shell" class:with-inspector={inspector !== undefined} inert={Boolean(trustTarget || requestedWorkspaceSection || requestedMainView || pendingNavigation)}>
  <a class="skip-link" href="#workspace-main">{$t('Skip to main content')}</a>
  {#if catalog.safeMode}<div class="safe-mode" role="status">{$t('Safe mode. Runtime actions and extensions are disabled. Local history remains read-only.')}</div>{/if}

  <aside class:open={navigationOpen} inert={narrow && !navigationOpen} aria-label={$t('Workspace navigation')}>
    <div class="brand-row"><div class="brand"><span class="brand-mark" aria-hidden="true">π</span><strong>{$t('PiUI')}</strong></div><button class="icon narrow-only" type="button" onclick={() => navigationOpen = false} aria-label={$t('Close navigation')}>×</button></div>
    <div class="primary-actions">
      <button type="button" class="accent" onclick={startNewSession}><span class="action-label"><span class="action-icon" aria-hidden="true">＋</span><span>{$t('New chat')}</span></span><kbd>{modifier}N</kbd></button>
      <button type="button" onclick={addProject} disabled={addingProject}>{$t(addingProject ? 'Opening picker…' : 'Add project')}</button>
    </div>
    <div class="view-switch" aria-label={$t('Workspace view')}>
      <button type="button" class:active={mainView === 'sessions'} aria-current={mainView === 'sessions' ? 'page' : undefined} onclick={() => requestMainView('sessions')}>{$t('Sessions')}</button>
      <button type="button" class:active={mainView === 'workspace'} aria-current={mainView === 'workspace' ? 'page' : undefined} onclick={() => requestMainView('workspace')}>{$t('Workspace')}</button>
    </div>
    {#if mainView === 'sessions'}
    <label class="search-label" aria-label={$t('Search sessions')}>
      <span aria-hidden="true">⌕</span><input bind:this={searchInput} bind:value={search} placeholder={$t('Search this project')} />
    </label>
    {#if new Set(catalog.sessions.map(session => session.harness)).size > 1}
    <label class="filter-label"><span>{$t('Harness')}</span><select bind:value={harnessFilter}>
      <option value="all">{$t('All harnesses')}</option><option value="pi">{$t('Pi')}</option><option value="prime-agent">{$t('Prime Agent')}</option><option value="codex">{$t('Codex')}</option>
    </select></label>
    {/if}
    {/if}

    <div class="list-heading"><span>{$t('Projects')}</span><span>{catalog.workspaces.length || ''}</span></div>
    <nav class="project-list" aria-label={$t('Projects and native sessions')}>
      {#if catalogLoading}<p class="muted" role="status">{$t('Loading local workspace…')}</p>
      {:else if catalog.workspaces.length === 0}<p class="muted">{$t('No projects registered.')}</p>
      {:else}
        {#each catalog.workspaces as workspace (workspace.id)}
          <section class:current-project={workspace.id === selectedWorkspaceId}>
            <div class="project-row">
              <button type="button" onclick={() => selectProject(workspace.id)} aria-current={workspace.id === selectedWorkspaceId ? 'true' : undefined}>
                <span title={workspace.personal ? $t('Chats') : workspace.name}>{workspace.personal ? $t('Chats') : workspace.name}</span>{#if workspace.missing}<small>{$t('Missing')}</small>{:else if workspace.trust === 'restricted'}<small>{$t('Restricted')}</small>{/if}
              </button>
              {#if !workspace.personal && workspace.trust === 'restricted'}<button class="more" type="button" onclick={() => { trustTarget = workspace; trustError = undefined; }} aria-label={`Review trust for ${workspace.personal ? $t('Chats') : workspace.name}`}>⌾</button>{/if}
            </div>
            {#if workspace.id === selectedWorkspaceId && mainView === 'sessions'}
              <div class="session-list">
                {#each visibleSessions as session (session.id)}
                  <button type="button" class:selected={session.id === selectedSessionId} onclick={() => openSession(session.id)} aria-current={session.id === selectedSessionId ? 'page' : undefined}>
                    <span class="session-title" title={session.title}>{session.title}</span>
                    <span class="session-meta"><span aria-label={harnessLabel(session.harness)}>{session.harness === 'prime-agent' ? 'Prime' : harnessLabel(session.harness)}</span><span class={`status status--${session.status}`}>{statusLabel(session.status)}</span></span>
                  </button>
                {/each}
                {#if visibleSessions.length === 0}<div class="session-empty"><p>{search || harnessFilter !== 'all' ? 'No matching chats.' : 'No chats yet.'}</p>{#if search || harnessFilter !== 'all'}<button type="button" onclick={() => { search = ''; harnessFilter = 'all'; }}>{$t('Clear filters')}</button>{:else}<button type="button" onclick={startNewSession}>{$t('Start a chat')}</button>{/if}</div>{/if}
              </div>
            {/if}
          </section>
        {/each}
      {/if}
    </nav>
    <div class="utilities">
      {#if attentionCount}<button type="button" onclick={(event) => openInspector('approvals', event)}><span>{$t('Approvals')}</span><strong>{attentionCount}</strong></button>{/if}
      {#if activeSessions.length}<button type="button" onclick={(event) => openInspector('activity', event)}><span>{$t('Activity')}</span><strong>{activeSessions.length}</strong></button>{/if}
      <button type="button" class:current-utility={mainView === 'settings'} onclick={showSettings}>{$t('Settings ')}<kbd>{modifier},</kbd></button>
    </div>
  </aside>
  {#if navigationOpen}<button class="nav-scrim" type="button" onclick={() => navigationOpen = false} aria-label={$t('Close navigation')}></button>{/if}

  <main id="workspace-main" tabindex="-1" inert={narrow && navigationOpen}>
    <div class="narrow-context">
      <button class="icon" type="button" onclick={() => navigationOpen = true} aria-label={$t('Open navigation')}>☰</button>
      <div><strong>{mainView === 'settings' ? 'Settings' : mainView === 'workspace' ? selectedWorkspace?.name ?? 'Workspace' : newSessionOpen ? 'New chat' : selectedSession?.title ?? selectedWorkspace?.name ?? 'Workspace'}</strong>{#if selectedSession}<small>{harnessLabel(selectedSession.harness)} · {statusLabel(selectedSession.status)}</small>{/if}</div>
      {#if selectedSession}<button class="icon" type="button" onclick={(event) => openInspector('details', event)} aria-label={$t('Open session details')}>ⓘ</button>{/if}
    </div>

    {#if catalogError}<div class="top-error" role="alert"><span>{catalogError}</span><button type="button" onclick={() => loadCatalog()}>{$t('Refresh')}</button></div>{/if}

    {#if mainView === 'settings'}
      <WorkspaceSettings {preferences} busy={preferencesBusy} error={preferencesError} onChange={savePreferences} onClose={closeSettings} />
    {:else if mainView === 'workspace'}
      <section class="workspace-view" aria-labelledby="workspace-view-title">
        <header class="workspace-header">
          <div><small>{$t('Workspace')}</small><h1 id="workspace-view-title">{selectedWorkspace?.name ?? 'Select a project'}</h1></div>
          <nav aria-label={$t('Workspace sections')}>
            {#each ['systems', 'runs'] as section}
              <button type="button" class:active={workspaceSection === section} aria-current={workspaceSection === section ? 'page' : undefined} onclick={() => requestSection(section as WorkspaceSection)}>{$t(section[0]?.toUpperCase() + section.slice(1))}</button>
            {/each}
            <details><summary>{$t('Advanced')}</summary>{#each ['agents', 'teams', 'pipelines'] as section}<button type="button" onclick={() => requestSection(section as WorkspaceSection)}>{$t(section[0]?.toUpperCase() + section.slice(1))}</button>{/each}</details>
          </nav>
        </header>
        <div class="orchestration-host">
          {#if !selectedWorkspaceId}<div class="state"><h2>{$t('Select a project')}</h2><p>{$t('Agents, teams, pipelines, and runs always show their project scope.')}</p></div>
          {:else if orchestrationLoading}<div class="state" role="status"><h2>{$t('Loading workspace…')}</h2></div>
          {:else if orchestrationError}<div class="state"><h2>{$t('Workspace unavailable')}</h2><p>{orchestrationError}</p><button type="button" onclick={showWorkspace}>{$t('Try again')}</button></div>
          {:else if OrchestrationPanel}{#key orchestrationEpoch}<OrchestrationPanel workspaceId={selectedWorkspaceId} section={workspaceSection} onSectionChange={(section: WorkspaceSection) => workspaceSection = section} safeMode={catalog.safeMode} onOpenSession={openSession} onDirtyChange={(dirty: boolean) => orchestrationDirty = dirty} />{/key}
          {:else}<div class="state"><h2>{$t('Workspace unavailable')}</h2><p>{$t('This optional contribution is not available. Native session history remains accessible.')}</p></div>{/if}
        </div>
      </section>
    {:else if newSessionOpen}
      <section class="new-session" aria-labelledby="new-session-title">
        <div class="new-session-card">
          <small>{selectedWorkspace?.name ?? 'Your workspace'}</small><h1 id="new-session-title">{$t('Create a new chat')}</h1>
          <p>{$t('Choose where to work and which agent to use.')}</p>
          <label>{$t('Project')}<select id="new-session-project" bind:value={newWorkspaceId} disabled={createBusy}><option value="">{$t('Choose project')}</option>{#each catalog.workspaces.filter((workspace) => !workspace.missing) as workspace}<option value={workspace.id}>{workspace.personal ? $t('Chats') : workspace.name}{workspace.personal ? ' · Personal' : ''}</option>{/each}</select></label>
          <label>{$t('Harness')}<select id="new-session-harness" bind:value={newHarness} onchange={() => newModelId = ''} disabled={createBusy}><option value="">{$t('Choose harness')}</option>{#each catalog.harnesses as harness}<option value={harness.kind} disabled={harness.status !== 'available'}>{harness.name} · {harness.status === 'available' ? 'Available' : harness.status === 'unverified' ? 'Setup or verification required' : 'Unavailable'}</option>{/each}</select></label>
          {#if newHarness && catalog.harnesses.find((item) => item.kind === newHarness)?.reason}<p class="field-note">{catalog.harnesses.find((item) => item.kind === newHarness)?.reason}</p>{/if}
          <details class="setup-details"><summary>{$t('Availability and setup')}</summary>
          <ul class="harness-readiness" aria-label={$t('Native harness readiness')}>
            {#each catalog.harnesses as harness}<li><strong>{harness.name}</strong><span>{harness.status === 'available' ? 'Available' : harness.status === 'unverified' ? 'Setup or verification required' : 'Unavailable'}{harness.reason ? ` — ${harness.reason}` : ''}</span></li>{/each}
          </ul></details>
          <details class="session-options"><summary>{$t('Model and permissions')}</summary>
          <label>{$t('Model')}<select bind:value={newModelId} disabled={createBusy}><option value="">{$t('Native default')}</option>{#each knownModels as model}<option value={model.id}>{model.name}{model.provider ? ` · ${model.provider}` : ''}</option>{/each}</select></label>
          {#if knownModels.length === 0}<p class="field-note">{$t('The agent will use its configured model.')}</p>{/if}
          <label>{$t('Permission mode')}<select bind:value={permissionMode} disabled={createBusy}>
            <option value="native">{$t('Native permissions')}</option><option value="read-only">{$t('Read-only')}</option><option value="workspace-write">{$t('Workspace write')}</option><option value="full-access">{$t('Full access')}</option>
          </select></label>
          <p class:warning={permissionMode === 'full-access'} class="permission-copy">{permissionMode === 'native' ? "Uses the agent’s configured permissions. Project trust is separate; this is not a sandbox." : permissionMode === 'read-only' ? 'Requests a strict read-only native policy. The host rejects it when the harness cannot enforce it.' : permissionMode === 'workspace-write' ? 'Requests writes limited to the workspace. This is not a sandbox guarantee; the host must enforce it.' : 'Requests the harness native full-access policy. This does not grant project trust or access to other harnesses.'}</p>
          </details>
          {#if createError}<p class="error" role="alert">{createError}</p>{/if}
          <div class="form-actions"><button type="button" onclick={() => newSessionOpen = false} disabled={createBusy}>{$t('Cancel')}</button><button class="accent" type="button" onclick={createSession} disabled={createBusy || catalog.safeMode || !newWorkspaceId || !newHarness || catalog.harnesses.find((item) => item.kind === newHarness)?.status !== 'available'}>{createBusy ? `Starting ${newHarness ? harnessLabel(newHarness) : 'session'}…` : 'Create session'}</button></div>
        </div>
      </section>
    {:else if selectedSnapshot}
      <section class="session-view" aria-labelledby="session-title">
        <header class="session-context">
          <div><span class="session-project">{catalog.workspaces.find((item) => item.id === selectedSnapshot.session.workspaceId)?.name ?? 'Project'}</span><span aria-label={harnessLabel(selectedSnapshot.session.harness)}>{harnessLabel(selectedSnapshot.session.harness)}</span><strong id="session-title">{selectedSnapshot.session.title}</strong><span class={`status status--${selectedSnapshot.session.status}`}>{statusLabel(selectedSnapshot.session.status)}</span></div>
          <button type="button" onclick={(event) => openInspector('details', event)}>{$t('Session details')}</button>
        </header>
        {#if sessionError}<div class="inline-error" role="alert"><span>{sessionError}</span><button type="button" onclick={() => reconcileSession(selectedSnapshot.session.id)}>{$t('Check status')}</button></div>{/if}
        <ConversationViewport blocks={selectedSnapshot.blocks} loading={sessionLoading} sessionKey={selectedSnapshot.session.id} agentLabel={harnessLabel(selectedSnapshot.session.harness)} />
        <div class="composer-shell">
          {#if catalog.safeMode}<p class="composer-notice">{$t('Runtime actions are disabled in safe mode. Your draft is preserved.')}</p>
          {:else if selectedSnapshot.session.status === 'closed'}<p class="composer-notice">{$t('This native session is closed. Its transcript remains readable.')}</p>
          {:else if !selectedSnapshot.capabilities.prompt.supported}<p class="composer-notice">{selectedSnapshot.capabilities.prompt.reason ?? `${harnessLabel(selectedSnapshot.session.harness)} is read-only in this mode.`}</p>
          {:else}
            <div class="composer">
              <label class="sr-only" for="session-draft">Message {harnessLabel(selectedSnapshot.session.harness)}</label>
              <textarea id="session-draft" value={drafts[selectedSnapshot.session.id] ?? ''} oninput={(event) => updateDraft(selectedSnapshot.session.id, (event.currentTarget as HTMLTextAreaElement).value)} onkeydown={composerKeydown} placeholder={selectedSnapshot.session.status === 'running' ? 'Follow up while this turn runs…' : `Message ${harnessLabel(selectedSnapshot.session.harness)}…`} rows="2"></textarea>
              <div class="composer-actions">
                <div class="runtime-options">
                  <span>{harnessLabel(selectedSnapshot.session.harness)} · {selectedSnapshot.session.model?.name ?? 'Native model'}</span>
                  {#if selectedSnapshot.session.status === 'running'}<label>{$t('Send mode')}<select bind:value={sendMode}><option value="follow-up">{$t('Follow up')}</option><option value="steer">{$t('Steer')}</option><option value="prompt">{$t('Prompt')}</option></select></label>{/if}
                </div>
                {#if selectedSnapshot.session.status === 'running' || selectedSnapshot.session.status === 'stopping'}<button class="stop" type="button" onclick={interruptSession} disabled={interruptBusy || selectedSnapshot.session.status === 'stopping'}>{interruptBusy || selectedSnapshot.session.status === 'stopping' ? 'Stopping…' : 'Stop turn'}</button>{/if}
                <button class="accent" type="button" onclick={send} disabled={sendBusy || (drafts[selectedSnapshot.session.id] ?? '').trim() === ''}>{$t(sendBusy ? 'Sending…' : selectedSnapshot.session.status === 'running' && sendMode === 'steer' ? 'Steer' : selectedSnapshot.session.status === 'running' && sendMode === 'follow-up' ? 'Follow up' : 'Send')}</button>
              </div>
            </div>
          {/if}
          {#if !catalog.safeMode && selectedSnapshot.session.status !== 'closed' && selectedSnapshot.capabilities.prompt.supported}<p class="composer-hint">{$t('Enter to send ')}<span>·</span> Shift+Enter for a new line</p>{/if}
          {#if sendError}<p class="error composer-error" role="alert">{sendError}</p>{/if}
        </div>
      </section>
    {:else if sessionLoading}
      <div class="state" role="status"><h1>{$t('Opening chat…')}</h1><p>{$t('Your conversation is loading.')}</p></div>
    {:else}
      <div class="state empty">
        <span class="welcome-mark" aria-hidden="true">π</span>
        <p class="welcome-project">{selectedWorkspace?.name ?? 'PiUI'}</p>
        <h1>{catalogLoading ? 'Opening your workspace…' : 'What are we working on?'}</h1>
        <p>{catalog.safeMode ? 'Browse your conversations in read-only safe mode.' : 'Start a chat, or pick up a conversation from the sidebar.'}</p>
        <div><button class="accent" type="button" onclick={startNewSession} disabled={catalog.safeMode || catalogLoading}>{$t('New chat ')}<kbd>{modifier}N</kbd></button></div>
        {#if sessionError}<p class="error" role="alert">{sessionError}</p>{/if}
      </div>
    {/if}
  </main>

  {#if inspector}
    <aside class="inspector" tabindex="-1" aria-label={inspector === 'approvals' ? 'Approvals' : inspector === 'activity' ? 'Activity' : 'Session details'}>
      <header><div><small>{$t('Inspector')}</small><h2>{inspector === 'approvals' ? 'Approvals' : inspector === 'activity' ? 'Activity' : 'Session details'}</h2></div><button class="icon" type="button" onclick={closeInspector} aria-label={$t('Close inspector')}>×</button></header>
      {#if inspector === 'approvals'}
        <div class="inspector-body approval-list">
          {#if allApprovals.length === 0}<div class="state compact"><h3>{$t('You’re all caught up')}</h3><p>{$t('Requests from all projects appear here when they need your attention.')}</p></div>{/if}
          {#each allApprovals as item (approvalKey(item.snapshot.session.id, item.approval.id))}
            {@const key = approvalKey(item.snapshot.session.id, item.approval.id)}
            {@const workspace = catalog.workspaces.find((value) => value.id === item.snapshot.session.workspaceId)}
            <article class="approval">
              <p class="origin"><strong>{harnessLabel(item.snapshot.session.harness)}</strong><span>·</span><span>{workspace?.name ?? 'Unknown project'}</span><span>·</span><span>{item.snapshot.session.title}</span>{#if item.snapshot.session.runId}<span>·</span><span>Run {item.snapshot.session.runId}</span>{/if}{#if item.snapshot.session.memberId}<span>·</span><span>Member {item.snapshot.session.memberId}</span>{/if}</p>
              <span class="request-kind">{item.approval.kind === 'input' ? 'Input request' : item.approval.kind.replace('-', ' ')}</span>
              <h3>{item.approval.title}</h3><p>{item.approval.description}</p>
              {#if item.approval.inputLabel}<label>{item.approval.inputLabel}<textarea rows="2" value={approvalInput[key] ?? ''} oninput={(event) => approvalInput = { ...approvalInput, [key]: (event.currentTarget as HTMLTextAreaElement).value }} disabled={approvalBusy === key}></textarea></label>{/if}
              {#if approvalStatus[key]}<p class="muted" role="status">{approvalStatus[key]}</p>{/if}
              {#if approvalErrors[key]}<p class="error" role="alert">{approvalErrors[key]}</p>{/if}
              <div class="decision-row">{#each item.approval.decisions as decision}<button class:danger={decision === 'deny' || decision === 'cancel'} type="button" onclick={() => respond(item.snapshot, item.approval, decision)} disabled={approvalBusy !== ''}>{decisionLabel(decision)}</button>{/each}</div>
            </article>
          {/each}
        </div>
      {:else if inspector === 'activity'}
        <div class="inspector-body">
          {#if activeSessions.length === 0}<div class="state compact"><h3>{$t('Nothing running')}</h3><p>{$t('Active and failed chats from all projects appear here.')}</p></div>
          {:else}<ul class="activity-list">{#each activeSessions as session}<li><span class={`status-dot status--${session.status}`}></span><div><strong>{session.title}</strong><small>{harnessLabel(session.harness)} · {statusLabel(session.status)}</small></div><button type="button" onclick={() => openSession(session.id)}>{$t('Open')}</button></li>{/each}</ul>{/if}
        </div>
      {:else if selectedSnapshot}
        <div class="inspector-body details">
          <dl><div><dt>{$t('Harness')}</dt><dd>{harnessLabel(selectedSnapshot.session.harness)}</dd></div><div><dt>{$t('Status')}</dt><dd>{statusLabel(selectedSnapshot.session.status)}</dd></div><div><dt>{$t('History revision')}</dt><dd>{selectedSnapshot.revision}</dd></div><div><dt>{$t('Model')}</dt><dd>{selectedSnapshot.session.model?.name ?? 'Native default'}</dd></div></dl>
          <label>{$t('Session title')}<input bind:value={renameDraft} disabled={sessionActionBusy} /></label><button type="button" onclick={renameSession} disabled={sessionActionBusy || renameDraft.trim() === '' || renameDraft.trim() === selectedSnapshot.session.title}>{$t('Rename session')}</button>
          {#if selectedSnapshot.capabilities.models.supported}<label>{$t('Model')}<select value={selectedSnapshot.session.model?.id ?? ''} onchange={setModel} disabled={sessionActionBusy}><option value="">{$t('Native default')}</option>{#each selectedSnapshot.models as model}<option value={model.id}>{model.name}{model.provider ? ` · ${model.provider}` : ''}</option>{/each}</select></label>{:else}<p class="muted">{selectedSnapshot.capabilities.models.reason ?? 'Model changes are not supported by this harness.'}</p>{/if}
          <section class="capabilities"><h3>{$t('Native capabilities')}</h3><ul>{#each Object.entries(selectedSnapshot.capabilities) as [name, capability]}<li><span>{name}</span><span>{capability.supported ? capability.enforcement : 'Unavailable'}</span></li>{/each}</ul></section>
          {#if selectedSnapshot.session.status !== 'closed'}<button class="danger-zone" type="button" onclick={closeSession} disabled={sessionActionBusy}>{$t('Close native session')}</button>{/if}
          {#if sessionError}<p class="error" role="alert">{sessionError}</p>{/if}
        </div>
      {:else}<div class="state compact"><h3>{$t('No session selected')}</h3><p>{$t('Select a session to inspect its native capabilities.')}</p></div>{/if}
    </aside>
  {/if}
</div>

{#if trustTarget}
  <div class="modal-backdrop" role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="trust-title" tabindex="-1" use:modalFocus={() => { if (!trustBusy) trustTarget = undefined; }}>
      <small>{$t('Project resources')}</small><h2 id="trust-title">Trust {trustTarget.name}?</h2>
      <p>{$t('This lets supported native harnesses use project resources within the permissions selected for each session.')}</p>
      <p><strong>{$t('Trust is not a sandbox.')}</strong> Native processes can have operating-system access beyond this folder unless their selected policy is enforced by the harness.</p>
      {#if trustError}<p class="error" role="alert">{trustError}</p>{/if}
      <div class="form-actions"><button type="button" onclick={() => trustTarget = undefined} disabled={trustBusy}>{$t('Cancel')}</button><button class="accent" type="button" onclick={trustProject} disabled={trustBusy}>{trustBusy ? 'Saving trust…' : `Trust ${trustTarget.name}`}</button></div>
    </div>
  </div>
{/if}

{#if requestedWorkspaceSection || requestedMainView || pendingNavigation}
  <div class="modal-backdrop" role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="discard-title" tabindex="-1" use:modalFocus={keepEditingWorkspace}>
      <small>{$t('Unsaved workspace changes')}</small><h2 id="discard-title">{$t('Leave this editor?')}</h2><p>{$t('Keep editing, or discard the unsaved definition before changing views.')}</p>
      <div class="form-actions"><button type="button" onclick={keepEditingWorkspace}>{$t('Keep editing')}</button><button class="danger" type="button" onclick={confirmDiscardWorkspace}>{$t('Discard changes')}</button></div>
    </div>
  </div>
{/if}

<style>
  :global(*) { box-sizing: border-box; }
  .shell { position:relative; display:grid; grid-template-columns:252px minmax(0,1fr); height:100dvh; overflow:hidden; grid-template-rows:minmax(0,1fr); background:var(--piui-bg); color:var(--piui-text); font-family:var(--piui-font-ui); }
  .shell:has(> .safe-mode) { grid-template-rows:auto minmax(0,1fr); }
  .shell.with-inspector { grid-template-columns:252px minmax(0,1fr) 342px; }
  button, input, select, textarea { font:inherit; color:inherit; }
  button { cursor:pointer; }
  button:disabled { cursor:not-allowed; opacity:.55; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .skip-link { position:fixed; z-index:80; top:8px; left:8px; padding:8px 12px; border-radius:6px; background:var(--piui-text); color:var(--piui-bg); transform:translateY(-160%); }
  .skip-link:focus { transform:none; }
  .safe-mode { grid-column:1/-1; padding:8px 16px; background:var(--piui-warning-surface); border-bottom:1px solid var(--piui-warning-border); color:var(--piui-warning-text); font-size:13px; }
  aside[aria-label="Workspace navigation"] { min-height:0; display:flex; flex-direction:column; border-right:1px solid var(--piui-border-subtle); background:var(--piui-bg-raised); }
  .brand-row { height:58px; padding:0 14px; display:flex; align-items:center; justify-content:space-between; }
  .brand-row strong { letter-spacing:-.02em; }
  .primary-actions { padding:0 9px 10px; display:grid; gap:3px; border-bottom:1px solid var(--piui-border-subtle); }
  .primary-actions button, .utilities button { border:0; border-radius:7px; padding:8px 9px; display:flex; align-items:center; justify-content:space-between; background:transparent; text-align:left; }
  .primary-actions button:hover, .utilities button:hover { background:var(--piui-surface-1); }
  .primary-actions button.accent { border:1px solid var(--piui-accent); background:var(--piui-accent); color:var(--piui-accent-ink); font-weight:650; }
  .primary-actions button.accent:hover { background:var(--piui-accent); box-shadow:inset 0 0 0 1px currentColor; }
  .primary-actions button.accent kbd { color:currentColor; }
  .action-label { display:flex; align-items:center; gap:7px; }
  .action-icon { font-size:16px; line-height:1; }
  kbd { color:var(--piui-text-faint); font:11px var(--piui-font-mono); }
  .view-switch { margin:10px 9px 8px; padding:3px; display:grid; grid-template-columns:1fr 1fr; background:var(--piui-surface-1); border-radius:8px; }
  .view-switch button { padding:6px; border:0; border-radius:6px; background:transparent; color:var(--piui-text-muted); }
  .view-switch button.active { background:var(--piui-bg-raised); color:var(--piui-text); box-shadow:0 0 0 1px var(--piui-border-subtle); }
  .search-label { margin:0 9px 7px; height:34px; padding:0 9px; display:flex; align-items:center; gap:7px; border:1px solid var(--piui-border-subtle); border-radius:7px; background:var(--piui-bg); color:var(--piui-text-muted); }
  .search-label input { width:100%; min-width:0; border:0; outline:0; background:transparent; }
  .filter-label { margin:0 10px 7px; display:flex; align-items:center; justify-content:space-between; color:var(--piui-text-muted); font-size:12px; }
  .filter-label select { max-width:135px; padding:4px 5px; border:1px solid var(--piui-border-subtle); border-radius:6px; background:var(--piui-bg-raised); }
  .project-list { flex:1; min-height:0; overflow:auto; padding:4px 8px; }
  .project-list section { margin-bottom:5px; }
  .project-list section.current-project { padding-bottom:5px; }
  .project-row { display:flex; gap:2px; }
  .project-row > button:first-child { flex:1; min-width:0; padding:7px 8px; border:0; border-radius:6px; background:transparent; display:flex; justify-content:space-between; gap:7px; text-align:left; }
  .project-row > button:first-child:hover, .project-list section.current-project > .project-row > button:first-child { background:var(--piui-surface-1); }
  .project-row span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .project-row small { color:var(--piui-text-muted); }
  .more { width:30px; flex-shrink:0; border:0; border-radius:6px; background:transparent; color:var(--piui-text-muted); }
  .session-list { display:grid; gap:1px; margin:2px 0 0 8px; padding-left:6px; border-left:1px solid var(--piui-border-subtle); }
  .session-list > button { padding:7px 8px; display:grid; gap:3px; border:0; border-radius:6px; background:transparent; text-align:left; }
  .session-list > button:hover { background:var(--piui-surface-1); }
  .session-list > button.selected { background:var(--piui-accent-soft); box-shadow:inset 2px 0 var(--piui-accent); }
  .session-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  .session-meta { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--piui-text-muted); font-size:11px; }
  .status { color:var(--piui-text-muted); font-size:12px; }
  .status--running, .status--idle { color:var(--piui-success); }
  .status--failed { color:var(--piui-danger); }
  .status--starting, .status--stopping { color:var(--piui-warning); }
  .muted { color:var(--piui-text-muted); line-height:1.45; }
  .utilities { padding:8px; border-top:1px solid var(--piui-border-subtle); display:grid; gap:2px; }
  .utilities strong { min-width:22px; padding:2px 6px; border-radius:10px; background:var(--piui-accent-soft); color:var(--piui-accent); font-size:11px; text-align:center; }
  main { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; position:relative; background:var(--piui-bg); }
  .narrow-context { display:none; }
  .top-error, .inline-error { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 14px; background:var(--piui-danger-surface); border-bottom:1px solid var(--piui-danger-border); color:var(--piui-danger-text); font-size:13px; }
  .top-error button, .inline-error button { border:1px solid currentColor; border-radius:6px; padding:5px 8px; background:transparent; }
  .session-view { flex:1; min-height:0; display:flex; flex-direction:column; }
  .session-context { min-height:48px; padding:0 16px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--piui-border-subtle); }
  .session-context div { display:flex; align-items:center; gap:9px; min-width:0; }
  .session-context div > span:first-child { padding:3px 6px; border-radius:5px; background:var(--piui-surface-1); color:var(--piui-text-muted); font-size:11px; }
  .session-context strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  .session-context button { border:0; background:transparent; color:var(--piui-text-muted); font-size:12px; }
  .composer-shell { flex-shrink:0; padding:10px var(--piui-chat-inline-padding) 12px; background:linear-gradient(transparent, var(--piui-bg) 20%); }
  .composer { width:min(100%, var(--piui-chat-column-width)); margin:0 auto; overflow:hidden; border:1px solid var(--piui-border); border-radius:12px; background:var(--piui-bg-raised); box-shadow:0 6px 22px rgba(0,0,0,.08); }
  .composer textarea { width:100%; min-height:64px; max-height:30dvh; resize:vertical; font-size:var(--piui-chat-composer-font-size); padding:13px 14px 6px; border:0; outline:0; background:transparent; line-height:1.5; }
  .composer-actions { padding:7px; display:flex; align-items:center; gap:7px; }
  .runtime-options { flex:1; min-width:0; display:flex; align-items:center; gap:12px; color:var(--piui-text-muted); font-size:12px; }
  .runtime-options > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .runtime-options label { display:flex; align-items:center; gap:6px; }
  .runtime-options select { padding:4px; border:1px solid var(--piui-border-subtle); border-radius:5px; background:var(--piui-bg); }
  .composer-actions button, .form-actions button, .state button, .details > button, .decision-row button { padding:8px 12px; border:1px solid var(--piui-border); border-radius:7px; background:var(--piui-bg-raised); }
  button.accent, .composer-actions button.accent { border-color:var(--piui-accent); background:var(--piui-accent); color:var(--piui-accent-ink); }
  button.stop { border-color:var(--piui-danger-border); color:var(--piui-danger); }
  .composer-notice { width:min(100%,var(--piui-chat-column-width)); margin:0 auto; padding:12px 14px; border:1px solid var(--piui-border); border-radius:10px; background:var(--piui-bg-raised); color:var(--piui-text-muted); }
  .composer-error { width:min(100%,var(--piui-chat-column-width)); margin:6px auto 0; }
  .error { color:var(--piui-danger); line-height:1.45; }
  .state { flex:1; min-height:0; overflow:auto; padding:40px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
  .state h1, .state h2, .state h3 { margin:0 0 8px; font-size:20px; }
  .state p { max-width:54ch; margin:0 0 18px; color:var(--piui-text-muted); line-height:1.5; }
  .state > div { display:flex; gap:8px; }
  .state.compact { min-height:0; padding:28px 12px; }
  .state.compact h3 { font-size:15px; }
  .new-session { flex:1; min-height:0; padding:clamp(28px,8vh,82px) 24px; overflow:auto; }
  .new-session-card { width:min(100%,570px); margin:0 auto; }
  .new-session-card > small, .workspace-header small, .inspector header small, .modal > small { color:var(--piui-text-muted); font-size:11px; letter-spacing:.08em; text-transform:uppercase; }
  .new-session-card h1 { margin:7px 0 9px; font-size:24px; }
  .new-session-card > p { color:var(--piui-text-muted); line-height:1.5; }
  .new-session-card > label, .session-options label, .details > label, .approval label { margin-top:15px; display:grid; gap:6px; font-size:13px; font-weight:600; }
  .new-session-card select, .details input, .details select, .approval textarea { width:100%; padding:10px; border:1px solid var(--piui-border); border-radius:7px; background:var(--piui-bg-raised); }
  .field-note { margin:6px 0 0 !important; font-size:12px; }
  .harness-readiness { list-style:none; margin:8px 0 0; padding:0; display:grid; gap:4px; }
  .harness-readiness li { display:flex; justify-content:space-between; gap:14px; color:var(--piui-text-muted); font-size:11px; }
  .harness-readiness strong { color:var(--piui-text); font-weight:600; }
  .harness-readiness span { text-align:right; }
  .permission-copy { padding:10px 12px; border-left:2px solid var(--piui-border); background:var(--piui-bg-raised); font-size:12px; }
  .permission-copy.warning { border-color:var(--piui-warning); color:var(--piui-warning-text); }
  .form-actions { margin-top:20px; display:flex; justify-content:flex-end; gap:8px; }
  .workspace-view { flex:1; min-height:0; display:grid; grid-template-rows:auto minmax(0,1fr); }
  .workspace-header { min-height:67px; padding:10px 18px; display:flex; align-items:center; justify-content:space-between; gap:20px; border-bottom:1px solid var(--piui-border-subtle); }
  .workspace-header h1 { margin:2px 0 0; font-size:16px; }
  .workspace-header nav { display:flex; gap:2px; }
  .workspace-header nav button { padding:7px 9px; border:0; border-radius:6px; background:transparent; color:var(--piui-text-muted); }
  .workspace-header nav button.active { background:var(--piui-surface-1); color:var(--piui-text); }
  .orchestration-host { min-height:0; overflow:auto; }
  .inspector { min-width:0; min-height:0; border-left:1px solid var(--piui-border-subtle); background:var(--piui-bg-raised); overflow:hidden; display:grid; grid-template-rows:auto minmax(0,1fr); }
  .inspector > header { height:58px; padding:0 12px 0 16px; border-bottom:1px solid var(--piui-border-subtle); display:flex; align-items:center; justify-content:space-between; }
  .inspector h2 { margin:2px 0 0; font-size:15px; }
  .icon { width:34px; height:34px; padding:0; border:0; border-radius:6px; background:transparent; }
  .icon:hover { background:var(--piui-surface-1); }
  .inspector-body { min-height:0; overflow:auto; padding:14px; }
  .approval { padding:14px 0 18px; border-bottom:1px solid var(--piui-border-subtle); }
  .approval:first-child { padding-top:0; }
  .origin { margin:0 0 10px; display:flex; flex-wrap:wrap; gap:4px; color:var(--piui-text-muted); font-size:11px; }
  .request-kind { color:var(--piui-warning); font-size:11px; text-transform:capitalize; }
  .approval h3 { margin:5px 0; font-size:14px; }
  .approval > p:not(.origin) { margin:5px 0 10px; color:var(--piui-text-muted); line-height:1.45; font-size:13px; }
  .decision-row { margin-top:12px; display:flex; flex-wrap:wrap; gap:6px; }
  .decision-row button { font-size:12px; }
  button.danger { color:var(--piui-danger); }
  .activity-list { list-style:none; margin:0; padding:0; }
  .activity-list li { padding:10px 0; display:grid; grid-template-columns:8px minmax(0,1fr) auto; align-items:center; gap:9px; border-bottom:1px solid var(--piui-border-subtle); }
  .status-dot { width:7px; height:7px; border-radius:50%; background:var(--piui-text-faint); }
  .status-dot.status--running { background:var(--piui-success); }
  .status-dot.status--failed { background:var(--piui-danger); }
  .status-dot.status--starting, .status-dot.status--stopping { background:var(--piui-warning); }
  .activity-list div { min-width:0; display:grid; gap:3px; }
  .activity-list strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  .activity-list small { color:var(--piui-text-muted); }
  .activity-list button { border:0; background:transparent; color:var(--piui-accent); }
  .details { display:grid; align-content:start; gap:12px; }
  .details dl { margin:0; }
  .details dl div { padding:8px 0; display:flex; justify-content:space-between; gap:12px; border-bottom:1px solid var(--piui-border-subtle); }
  .details dt { color:var(--piui-text-muted); }
  .details dd { margin:0; text-align:right; }
  .capabilities { margin-top:6px; }
  .capabilities h3 { font-size:13px; }
  .capabilities ul { list-style:none; margin:0; padding:0; }
  .capabilities li { padding:6px 0; display:flex; justify-content:space-between; gap:8px; color:var(--piui-text-muted); font-size:12px; text-transform:capitalize; }
  .danger-zone { margin-top:12px; color:var(--piui-danger); }
  .modal-backdrop { position:fixed; z-index:60; inset:0; padding:20px; display:grid; place-items:center; background:rgba(0,0,0,.48); }
  .modal { width:min(100%,470px); padding:22px; border:1px solid var(--piui-border); border-radius:12px; background:var(--piui-bg-raised); box-shadow:0 20px 70px rgba(0,0,0,.3); }
  .modal h2 { margin:7px 0 10px; font-size:19px; }
  .modal p { color:var(--piui-text-muted); line-height:1.5; }
  .modal strong { color:var(--piui-text); }
  .nav-scrim, .narrow-only { display:none; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  @media (max-width: 1040px) {
    .shell, .shell.with-inspector { grid-template-columns:230px minmax(0,1fr); }
    .inspector { position:fixed; z-index:35; top:0; right:0; bottom:0; width:min(370px, calc(100vw - 52px)); box-shadow:-18px 0 50px rgba(0,0,0,.2); }
  }
  @media (max-width: 760px) {
    .shell, .shell.with-inspector { display:flex; flex-direction:column; }
    main { flex:1; }
    aside[aria-label="Workspace navigation"] { position:fixed; z-index:45; inset:0 auto 0 0; width:min(290px, calc(100vw - 46px)); transform:translateX(-102%); transition:transform .16s ease-out; box-shadow:16px 0 45px rgba(0,0,0,.22); }
    aside[aria-label="Workspace navigation"].open { transform:none; }
    .nav-scrim { display:block; position:fixed; z-index:40; inset:0; width:100%; border:0; background:rgba(0,0,0,.35); }
    .narrow-only { display:block; }
    .narrow-context { min-height:52px; padding:0 9px; display:grid; grid-template-columns:38px minmax(0,1fr) 38px; align-items:center; gap:5px; border-bottom:1px solid var(--piui-border-subtle); }
    .narrow-context div { min-width:0; display:grid; gap:2px; }
    .narrow-context strong, .narrow-context small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .narrow-context strong { font-size:13px; }
    .narrow-context small { color:var(--piui-text-muted); font-size:11px; }
    .session-view, .workspace-view { flex:1; min-height:0; }
    .session-context { display:none; }
    .workspace-header { align-items:flex-start; flex-direction:column; }
    .workspace-header nav { max-width:100%; overflow:auto; }
    .runtime-options > span { display:none; }
  }
  @media (prefers-reduced-motion: reduce) { aside[aria-label="Workspace navigation"] { transition:none; } }
  :global(:root[data-reduced-motion="reduce"]) aside[aria-label="Workspace navigation"] { transition:none; }
  @media (forced-colors: active) { button, input, select, textarea, .composer, .modal { forced-color-adjust:auto; } }
  .brand { display:flex; align-items:center; gap:8px; }
  .brand-mark { font:600 22px Georgia, serif; color:var(--piui-accent); }
  .list-heading { display:flex; justify-content:space-between; padding:10px 16px 5px; color:var(--piui-text-faint); font-size:11px; font-weight:600; }
  .utilities .current-utility { background:var(--piui-surface-1); }
  .session-empty { padding:8px; font-size:12px; color:var(--piui-text-muted); }
  .session-empty p { margin:0 0 6px; }
  .session-empty button { border:0; padding:3px 0; background:transparent; color:var(--piui-accent); text-decoration:underline; text-underline-offset:3px; }
  .session-options { margin-top:16px; padding:14px 0; border-block:1px solid var(--piui-border-subtle); color:var(--piui-text-muted); font-size:13px; }
  .session-options summary { cursor:pointer; color:var(--piui-text); }
  .new-session-card > .error { color:var(--piui-danger); }
  .setup-details { margin:12px 0; padding:10px 0; border-bottom:1px solid var(--piui-border-subtle); color:var(--piui-text-muted); font-size:12px; }
  .setup-details summary { width:fit-content; cursor:pointer; }
  .setup-details summary:focus-visible { outline:2px solid var(--piui-focus); outline-offset:3px; }
  .welcome-mark { display:grid; place-items:center; width:58px; height:58px; margin-bottom:24px; border:1px solid var(--piui-border-subtle); border-radius:var(--piui-radius-lg); background:var(--piui-bg-raised); color:var(--piui-accent); font:32px Georgia, serif; }
  .empty .welcome-project { margin:0 0 10px; font-size:12px; }
  .empty h1 { font-size:clamp(24px,3vw,34px); font-weight:600; letter-spacing:-.035em; text-wrap:balance; }
  .empty > p { font-size:14px; }
  .empty button { display:flex; align-items:center; gap:24px; }
  .empty kbd { color:inherit; }
  .composer:focus-within { border-color:var(--piui-accent); }
  .composer-hint { margin:7px auto 0; color:var(--piui-text-faint); text-align:center; font-size:11px; }
  .composer-hint span { padding:0 5px; }
  .session-project { max-width:22ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .session-context { flex-shrink:0; gap:12px; }
  .session-context button { flex-shrink:0; }
  .narrow-context, .top-error { flex-shrink:0; }
  button:not(:disabled):hover { filter:brightness(.97); }
  :global(:root[data-density="compact"]) .session-list > button { padding-block:4px; }
  :global(:root[data-density="compact"]) .primary-actions button,
  :global(:root[data-density="compact"]) .utilities button { padding-block:6px; }
  @media (max-width:760px) {
    .state { padding:24px; }
    .new-session { padding:24px 18px; }
    .composer-actions { flex-wrap:wrap; }
    .runtime-options { flex-basis:100%; }
    .composer-actions > button:first-of-type { margin-left:auto; }
    .form-actions { flex-wrap:wrap; }
  }
</style>
