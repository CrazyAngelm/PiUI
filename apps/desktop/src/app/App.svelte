<script lang="ts">
  import { onMount, tick } from 'svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import CommandPalette from '../features/navigation/CommandPalette.svelte';
  import ProjectSidebar from '../features/projects/ProjectSidebar.svelte';
  import ProjectSettingsDialog from '../features/projects/ProjectSettingsDialog.svelte';
  import TrustDialog from '../features/projects/TrustDialog.svelte';
  import ChatPanel from '../features/runtime/ChatPanel.svelte';
  import Timeline from '../features/sessions/Timeline.svelte';
  import { acceptsCatalogSnapshot } from '../features/sessions/catalogView';
  import SettingsView from '../features/settings/SettingsView.svelte';
  import ReadOnlyTree from '../features/tree/ReadOnlyTree.svelte';
  import { hasNativeFolderPicker, host, isHostConflict } from '../host-api/client';
  import type {
    ExtensionSummary,
    Preferences,
    ProjectSummary,
    SessionCatalogEvent,
    SessionCatalogFreshness,
    SessionCatalogSnapshot,
    SessionRootHint,
    SessionSummary,
    SessionTree,
    TimelineBlock,
    TimelinePage,
  } from '../host-api/types';
  import { initialAppState, reduceAppState, type AppState } from './state';

  let state: AppState = initialAppState;
  let timeline: TimelineBlock[] = [];
  let liveTimeline: TimelineBlock[] = [];
  let timelineLoaded = false;
  let timelineOlderCursor: string | undefined;
  let timelineTotalBlocks = 0;
  let timelinePageBusy = false;
  let timelineWindowNotice: string | undefined;
  let historyScroller: HTMLDivElement | undefined;
  let expandedProjectId: string | undefined;
  let loadedSessionProjectId: string | undefined;
  let sessionsLoading = false;
  let sessionsFreshness: SessionCatalogFreshness = 'cached';
  let sessionsRefreshError: string | undefined;
  let sessionCatalogs: Record<string, SessionCatalogSnapshot> = {};
  let catalogStatusSequences: Record<string, number> = {};
  interface CatalogInvalidation {
    sequence: number;
    epoch: number;
  }

  // Identity-conflict watermarks reject delayed pre-conflict catalog snapshots
  // until a command issued after the conflict obtains a replacement snapshot.
  let nextCatalogInvalidationEpoch = 0;
  let invalidatedProjectCatalogs: Record<string, CatalogInvalidation> = {};
  let personalCatalog: SessionCatalogSnapshot | undefined;
  let personalCatalogInvalidation: CatalogInvalidation | undefined;
  let personalCatalogStatusSequence = 0;
  let personalCatalogRefreshError: string | undefined;
  let pendingProjectSessionResolution: { projectId: string; epoch: number } | undefined;
  let pendingPersonalSessionResolution = false;
  let pendingProjectResolutionRetry: ReturnType<typeof setTimeout> | undefined;
  let pendingPersonalResolutionRetry: ReturnType<typeof setTimeout> | undefined;
  let pendingProjectResolutionRetryCount = 0;
  let pendingPersonalResolutionRetryCount = 0;
  let pendingProjectResolutionLastCatalogSequence = 0;
  let pendingPersonalResolutionLastCatalogSequence = 0;
  let resolvingPendingProjectSession = false;
  let resolvingPendingPersonalSession = false;
  let pendingProjectSessionCompletionObserved = false;
  let pendingPersonalSessionCompletionObserved = false;
  let newProjectSessionBaseline: ReadonlySet<string> | undefined;
  let newPersonalSessionBaseline: ReadonlySet<string> | undefined;
  let rootHintSequence = 0;
  let rootHintPending = false;
  let rootHintTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackPollTimer: ReturnType<typeof setTimeout> | undefined;
  let tree: SessionTree | undefined;
  let addProjectOpen = false;
  let projectPath = '';
  let addProjectBusy = false;
  let trustOpen = false;
  let trustBusy = false;
  let projectSettingsOpen = false;
  let projectSettingsTargetId: string | undefined;
  let projectActionBusy = false;
  let projectActionError: string | undefined;
  let projectNameDraft = '';
  let treeOpen = false;
  let settingsOpen = false;
  let preferences: Preferences = {
    theme: 'system',
    density: 'comfortable',
    reducedMotion: 'system',
    fontSize: 'medium',
    chatWidth: 'wide',
  };
  let preferencesBusy = false;
  let preferencesError: string | undefined;
  let extensions: ExtensionSummary[] = [];
  let extensionsLoading = false;
  let extensionsError: string | undefined;
  let extensionBusyId: string | undefined;
  let extensionRequestEpoch = 0;
  let searchOpen = false;
  let searchQuery = '';
  let searchResults: SessionSummary[] = [];
  let searchBusy = false;
  let searchError: string | undefined;
  let searchRequestEpoch = 0;
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  let personalSessions: SessionSummary[] = [];
  let personalSelected = false;
  let selectedPersonalSessionId: string | undefined;
  let personalChatEpoch = 0;

  const MAX_RETAINED_TIMELINE_BLOCKS = 500;
  // Monotonic local epochs prevent a delayed host response from rendering a
  // prior project/session after the user selected a newer one.
  let projectRequestEpoch = 0;
  let sessionRequestEpoch = 0;

  $: selectedProject = state.projects.find((project) => project.id === state.selectedProjectId);
  $: projectSettingsProject = state.projects.find((project) => project.id === projectSettingsTargetId);
  $: selectedSession = state.sessions.find((session) => session.id === state.selectedSessionId);
  $: selectedPersonalSession = personalSessions.find((session) => session.id === selectedPersonalSessionId);

  onMount(() => {
    let unlistenCatalog: (() => void) | undefined;
    let unlistenRoots: (() => void) | undefined;
    let mounted = true;
    void (async () => {
      try {
        unlistenCatalog = await host.listenSessionCatalogEvents((event) => {
          if (mounted) applySessionCatalogEvent(event);
        });
        unlistenRoots = await host.listenSessionRootHints((hint) => {
          if (mounted) applySessionRootHint(hint);
        });
      } catch {
        // A snapshot response remains the recovery path if an event channel
        // cannot be installed; avoid turning a catalog refresh into startup
        // failure.
        // Periodic polling below remains the recovery path.
      }
      // Watcher hints are lossy and registration can fail after startup, so
      // bounded polling is always the correctness backstop.
      scheduleFallbackCatalogPoll();
      if (mounted) await boot();
    })();
    return () => {
      mounted = false;
      unlistenCatalog?.();
      unlistenRoots?.();
      if (rootHintTimer !== undefined) clearTimeout(rootHintTimer);
      if (fallbackPollTimer !== undefined) clearTimeout(fallbackPollTimer);
      if (pendingProjectResolutionRetry !== undefined) clearTimeout(pendingProjectResolutionRetry);
      if (pendingPersonalResolutionRetry !== undefined) clearTimeout(pendingPersonalResolutionRetry);
    };
  });

  async function boot(): Promise<void> {
    try {
      const snapshot = await host.bootstrap();
      state = reduceAppState(state, { type: 'booted', snapshot });
      applyPreferences(snapshot.preferences);
      const initialProject = snapshot.projects.find((project) => project.id === snapshot.selectedProjectId) ?? snapshot.projects[0];
      // Do not serialize the personal catalog behind project discovery. Both
      // calls paint SQLite snapshots first and reconcile independently.
      if (initialProject !== undefined) void selectProject(initialProject);
      void refreshPersonalSessions();
    } catch (error) {
      state = reduceAppState(state, { type: 'failed', message: messageFor(error) });
    }
  }

  function projectRecoveryEpoch(projectId: string): number | undefined {
    return invalidatedProjectCatalogs[projectId]?.epoch;
  }

  function personalRecoveryEpoch(): number | undefined {
    return personalCatalogInvalidation?.epoch;
  }

  function applyProjectCatalog(
    snapshot: SessionCatalogSnapshot,
    hydrateSelection: boolean,
    recoveryEpoch: number | undefined,
  ): boolean {
    if (snapshot.scope !== 'project' || snapshot.projectId === undefined) return false;
    const invalidation = invalidatedProjectCatalogs[snapshot.projectId];
    if (
      invalidation !== undefined
      && (recoveryEpoch !== invalidation.epoch || snapshot.sequence <= invalidation.sequence)
    ) return false;
    const knownStatusSequence = catalogStatusSequences[snapshot.projectId] ?? 0;
    if (snapshot.sequence < knownStatusSequence) return false;
    const current = sessionCatalogs[snapshot.projectId];
    if (!acceptsCatalogSnapshot(current, snapshot)) return false;
    if (invalidation !== undefined) {
      const { [snapshot.projectId]: _recovered, ...remaining } = invalidatedProjectCatalogs;
      invalidatedProjectCatalogs = remaining;
    }
    sessionCatalogs = { ...sessionCatalogs, [snapshot.projectId]: snapshot };
    const statusSequence = Math.max(catalogStatusSequences[snapshot.projectId] ?? 0, snapshot.sequence);
    catalogStatusSequences = {
      ...catalogStatusSequences,
      [snapshot.projectId]: statusSequence,
    };
    if (state.selectedProjectId === snapshot.projectId) {
      const previousSessionId = state.selectedSessionId;
      // Catalog refreshes never silently choose a different transcript. The
      // caller explicitly hydrates a replacement after clearing the old page.
      state = reduceAppState(state, {
        type: 'sessions-loaded',
        projectId: snapshot.projectId,
        sessions: snapshot.sessions,
        selectFirst: false,
      });
      const selectionWasRemoved = previousSessionId !== undefined && state.selectedSessionId === undefined;
      if (selectionWasRemoved) {
        sessionRequestEpoch += 1;
        resetTimeline();
        tree = undefined;
      }
      loadedSessionProjectId = snapshot.projectId;
      sessionsFreshness = snapshot.sequence < statusSequence ? 'refreshing' : snapshot.freshness;
      sessionsLoading = sessionsFreshness === 'refreshing';
      if (snapshot.freshness !== 'degraded') sessionsRefreshError = undefined;
      if (pendingProjectSessionResolution?.projectId === snapshot.projectId) {
        const isNewCatalogSnapshot = snapshot.sequence > pendingProjectResolutionLastCatalogSequence;
        pendingProjectResolutionLastCatalogSequence = Math.max(
          pendingProjectResolutionLastCatalogSequence,
          snapshot.sequence,
        );
        if (
          pendingProjectSessionCompletionObserved
          && !resolvingPendingProjectSession
          && isNewCatalogSnapshot
        ) {
          pendingProjectResolutionRetryCount = 0;
          schedulePendingProjectSessionResolution();
        }
      }
      if (
        hydrateSelection
        && state.selectedSessionId === undefined
        && snapshot.sessions[0] !== undefined
        && pendingProjectSessionResolution?.projectId !== snapshot.projectId
      ) {
        void selectSession(snapshot.sessions[0], projectRequestEpoch);
      }
    }
    return true;
  }

  function applyPersonalCatalog(
    snapshot: SessionCatalogSnapshot,
    hydrateSelection: boolean,
    recoveryEpoch: number | undefined,
  ): boolean {
    if (
      snapshot.scope !== 'personal'
      || (
        personalCatalogInvalidation !== undefined
        && (
          recoveryEpoch !== personalCatalogInvalidation.epoch
          || snapshot.sequence <= personalCatalogInvalidation.sequence
        )
      )
      || snapshot.sequence < personalCatalogStatusSequence
      || !acceptsCatalogSnapshot(personalCatalog, snapshot)
    ) return false;
    if (personalCatalogInvalidation !== undefined) personalCatalogInvalidation = undefined;
    const previousSessionId = selectedPersonalSessionId;
    personalCatalog = snapshot;
    personalCatalogStatusSequence = Math.max(personalCatalogStatusSequence, snapshot.sequence);
    personalSessions = snapshot.sessions;
    const selectionWasRemoved = personalSelected
      && previousSessionId !== undefined
      && !snapshot.sessions.some((session) => session.id === previousSessionId);
    if (selectionWasRemoved) {
      sessionRequestEpoch += 1;
      resetTimeline();
      tree = undefined;
      selectedPersonalSessionId = undefined;
    }
    if (pendingPersonalSessionResolution) {
      const isNewCatalogSnapshot = snapshot.sequence > pendingPersonalResolutionLastCatalogSequence;
      pendingPersonalResolutionLastCatalogSequence = Math.max(
        pendingPersonalResolutionLastCatalogSequence,
        snapshot.sequence,
      );
      if (
        pendingPersonalSessionCompletionObserved
        && !resolvingPendingPersonalSession
        && isNewCatalogSnapshot
      ) {
        pendingPersonalResolutionRetryCount = 0;
        schedulePendingPersonalSessionResolution();
      }
    }
    if (
      hydrateSelection
      && personalSelected
      && selectedPersonalSessionId === undefined
      && snapshot.sessions[0] !== undefined
      && !pendingPersonalSessionResolution
    ) {
      void selectPersonalSession(snapshot.sessions[0]);
    }
    if (snapshot.freshness !== 'degraded') personalCatalogRefreshError = undefined;
    return true;
  }

  function applySessionCatalogEvent(event: SessionCatalogEvent): void {
    switch (event.kind) {
      case 'refreshStarted': {
        if (event.scope === 'project' && event.projectId !== undefined) {
          const knownSequence = catalogStatusSequences[event.projectId] ?? 0;
          if (event.sequence <= knownSequence) return;
          catalogStatusSequences = { ...catalogStatusSequences, [event.projectId]: event.sequence };
          if (event.projectId === state.selectedProjectId) {
            sessionsLoading = true;
            sessionsFreshness = 'refreshing';
            sessionsRefreshError = undefined;
          }
        } else if (event.scope === 'personal' && event.sequence > personalCatalogStatusSequence) {
          personalCatalogStatusSequence = event.sequence;
        }
        return;
      }
      case 'snapshot':
        if (event.snapshot.scope === 'project') applyProjectCatalog(event.snapshot, true, undefined);
        else applyPersonalCatalog(event.snapshot, true, undefined);
        return;
      case 'refreshFailed': {
        if (event.scope === 'project' && event.projectId !== undefined) {
          const knownSequence = catalogStatusSequences[event.projectId] ?? 0;
          if (event.sequence <= knownSequence) return;
          catalogStatusSequences = { ...catalogStatusSequences, [event.projectId]: event.sequence };
          if (event.projectId === state.selectedProjectId) {
            sessionsLoading = false;
            sessionsFreshness = 'degraded';
            sessionsRefreshError = event.safeSummary;
          }
        } else if (event.scope === 'personal' && event.sequence > personalCatalogStatusSequence) {
          personalCatalogStatusSequence = event.sequence;
          personalCatalogRefreshError = event.safeSummary;
        }
        return;
      }
      default:
        return assertNeverCatalogEvent(event);
    }
  }

  function assertNeverCatalogEvent(value: never): never {
    throw new Error(`Unhandled catalog event: ${JSON.stringify(value)}`);
  }

  function applySessionRootHint(hint: SessionRootHint): void {
    if (hint.protocol !== 7 || hint.sequence <= rootHintSequence) return;
    rootHintSequence = hint.sequence;
    if (hint.kind === 'unavailable') {
      scheduleFallbackCatalogPoll();
      return;
    }
    rootHintPending = true;
    scheduleRootHintReconcile(hint.kind === 'overflow' ? 0 : 225);
  }

  function scheduleRootHintReconcile(delay: number): void {
    if (rootHintTimer !== undefined) clearTimeout(rootHintTimer);
    rootHintTimer = setTimeout(() => {
      rootHintTimer = undefined;
      if (!rootHintPending) return;
      if (sessionsLoading) {
        scheduleRootHintReconcile(225);
        return;
      }
      rootHintPending = false;
      const projectId = state.selectedProjectId;
      if (projectId !== undefined) {
        void refreshProjectCatalog(projectId, projectRequestEpoch);
      }
      // Chats remain visible in the sidebar even while a project is selected.
      // Refresh both independent catalogs from the opaque root hint.
      void refreshPersonalCatalog();
    }, delay);
  }

  function scheduleFallbackCatalogPoll(): void {
    if (fallbackPollTimer !== undefined) return;
    fallbackPollTimer = setTimeout(() => {
      fallbackPollTimer = undefined;
      const projectId = state.selectedProjectId;
      if (projectId !== undefined && !sessionsLoading) {
        void refreshProjectCatalog(projectId, projectRequestEpoch);
      }
      void refreshPersonalCatalog();
      scheduleFallbackCatalogPoll();
    }, 15_000);
  }

  async function refreshProjectCatalog(projectId: string, expectedProjectEpoch: number): Promise<SessionCatalogSnapshot | undefined> {
    if (state.selectedProjectId === projectId) {
      sessionsLoading = true;
      sessionsFreshness = 'refreshing';
      sessionsRefreshError = undefined;
    }
    const recoveryEpoch = projectRecoveryEpoch(projectId);
    try {
      const snapshot = await host.refreshSessionCatalog(projectId);
      if (expectedProjectEpoch !== projectRequestEpoch) return undefined;
      const applied = applyProjectCatalog(
        snapshot,
        pendingProjectSessionResolution?.projectId !== projectId,
        recoveryEpoch,
      );
      if (applied && snapshot.freshness === 'degraded' && sessionsRefreshError === undefined) {
        sessionsRefreshError = 'Some local sessions could not be verified. Showing the last indexed catalog.';
      }
      return applied ? snapshot : sessionCatalogs[projectId];
    } catch (error) {
      if (expectedProjectEpoch === projectRequestEpoch) {
        if (isHostConflict(error)) invalidateProjectCatalog(projectId);
        if (state.selectedProjectId === projectId) {
          sessionsLoading = false;
          sessionsFreshness = 'degraded';
          sessionsRefreshError = messageFor(error);
        }
      }
      return undefined;
    }
  }

  async function refreshPersonalCatalog(): Promise<SessionCatalogSnapshot | undefined> {
    const recoveryEpoch = personalRecoveryEpoch();
    try {
      const snapshot = await host.refreshPersonalSessionCatalog();
      const applied = applyPersonalCatalog(snapshot, !pendingPersonalSessionResolution, recoveryEpoch);
      if (applied && snapshot.freshness === 'degraded' && personalCatalogRefreshError === undefined) {
        personalCatalogRefreshError = 'Some local sessions could not be verified. Showing the last indexed catalog.';
      }
      return applied ? snapshot : personalCatalog;
    } catch (error) {
      if (isHostConflict(error)) invalidatePersonalCatalog();
      personalCatalogRefreshError = messageFor(error);
      return undefined;
    }
  }

  function waitForCatalogTick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 100));
  }

  async function waitForCurrentProjectCatalog(
    projectId: string,
    expectedProjectEpoch: number,
  ): Promise<SessionCatalogSnapshot | undefined> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (expectedProjectEpoch !== projectRequestEpoch || state.selectedProjectId !== projectId) return undefined;
      const cached = sessionCatalogs[projectId];
      if (
        cached?.freshness === 'current'
        && cached.sequence >= (catalogStatusSequences[projectId] ?? 0)
      ) {
        return cached;
      }
      await waitForCatalogTick();
      const recoveryEpoch = projectRecoveryEpoch(projectId);
      try {
        const snapshot = await host.getSessionCatalog(projectId);
        applyProjectCatalog(snapshot, false, recoveryEpoch);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async function waitForCurrentPersonalCatalog(): Promise<SessionCatalogSnapshot | undefined> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (
        personalCatalog?.freshness === 'current'
        && personalCatalog.sequence >= personalCatalogStatusSequence
      ) {
        return personalCatalog;
      }
      await waitForCatalogTick();
      const recoveryEpoch = personalRecoveryEpoch();
      try {
        const snapshot = await host.getPersonalSessionCatalog();
        applyPersonalCatalog(snapshot, false, recoveryEpoch);
      } catch {
        return undefined;
      }
    }
    return undefined;
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

  async function savePreferences(next: Preferences): Promise<void> {
    const previous = preferences;
    // Keep the controlled select, root data attributes, and visible preview in
    // sync while the local host write is in flight. A failure below performs a
    // real state transition back to the last confirmed values.
    applyPreferences(next);
    preferencesBusy = true;
    preferencesError = undefined;
    try {
      applyPreferences(await host.updatePreferences(next));
    } catch (error) {
      applyPreferences(previous);
      preferencesError = messageFor(error);
    } finally {
      preferencesBusy = false;
    }
  }

  function openSettings(): void {
    settingsOpen = true;
    treeOpen = false;
  }

  async function refreshExtensions(): Promise<void> {
    const requestEpoch = ++extensionRequestEpoch;
    extensionsLoading = true;
    extensionsError = undefined;
    try {
      const discovered = await host.listExtensions();
      if (requestEpoch === extensionRequestEpoch) extensions = discovered;
    } catch (error) {
      if (requestEpoch === extensionRequestEpoch) extensionsError = messageFor(error);
    } finally {
      if (requestEpoch === extensionRequestEpoch) extensionsLoading = false;
    }
  }

  async function toggleExtension(extension: ExtensionSummary, enabled: boolean): Promise<void> {
    if (extensionBusyId !== undefined) return;
    extensionBusyId = extension.id;
    extensionsError = undefined;
    try {
      extensions = await host.setExtensionEnabled(extension.id, enabled);
    } catch (error) {
      extensionsError = messageFor(error);
    } finally {
      extensionBusyId = undefined;
    }
  }

  function updateTheme(event: Event): void {
    void savePreferences({ ...preferences, theme: (event.currentTarget as HTMLSelectElement).value as Preferences['theme'] });
  }

  function updateDensity(event: Event): void {
    void savePreferences({ ...preferences, density: (event.currentTarget as HTMLSelectElement).value as Preferences['density'] });
  }

  function updateReducedMotion(event: Event): void {
    void savePreferences({ ...preferences, reducedMotion: (event.currentTarget as HTMLSelectElement).value as Preferences['reducedMotion'] });
  }

  function updateFontSize(event: Event): void {
    void savePreferences({ ...preferences, fontSize: (event.currentTarget as HTMLSelectElement).value as Preferences['fontSize'] });
  }

  function updateChatWidth(event: Event): void {
    void savePreferences({ ...preferences, chatWidth: (event.currentTarget as HTMLSelectElement).value as Preferences['chatWidth'] });
  }

  function resetTimeline(clearLive = true): void {
    timeline = [];
    if (clearLive) liveTimeline = [];
    timelineLoaded = false;
    timelineOlderCursor = undefined;
    timelineTotalBlocks = 0;
    timelinePageBusy = false;
    timelineWindowNotice = undefined;
  }

  function nextBrowserFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function scrollHistoryToLatest(): Promise<void> {
    await tick();
    if (historyScroller !== undefined) {
      historyScroller.scrollTop = historyScroller.scrollHeight;
    }
  }

  async function updateLiveTimeline(next: TimelineBlock[]): Promise<void> {
    const scroller = historyScroller;
    const shouldFollow = scroller === undefined || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 120;
    liveTimeline = next;
    await tick();
    if (shouldFollow && historyScroller !== undefined) historyScroller.scrollTop = historyScroller.scrollHeight;
  }

  function captureNewProjectSessionBaseline(): void {
    const projectId = state.selectedProjectId;
    if (projectId !== undefined && state.selectedSessionId === undefined) {
      newProjectSessionBaseline ??= new Set(state.sessions.map((session) => session.id));
      if (pendingProjectSessionResolution === undefined) {
        pendingProjectSessionResolution = { projectId, epoch: projectRequestEpoch };
        pendingProjectResolutionRetryCount = 0;
        pendingProjectResolutionLastCatalogSequence = sessionCatalogs[projectId]?.sequence ?? 0;
        pendingProjectSessionCompletionObserved = false;
      }
    }
  }

  function schedulePendingProjectSessionResolution(): void {
    // Four bounded retries cover normal Pi flush lag without turning an
    // ambiguous external catalog into a permanent hashing loop. The visible
    // Retry discovery action explicitly resets this budget.
    const pending = pendingProjectSessionResolution;
    if (
      pending === undefined
      || pendingProjectResolutionRetry !== undefined
      || pendingProjectResolutionRetryCount >= 4
    ) return;
    const delay = 500 * (2 ** pendingProjectResolutionRetryCount);
    pendingProjectResolutionRetryCount += 1;
    pendingProjectResolutionRetry = setTimeout(() => {
      pendingProjectResolutionRetry = undefined;
      if (
        pendingProjectSessionResolution?.projectId === pending.projectId
        && pendingProjectSessionResolution.epoch === pending.epoch
        && state.selectedProjectId === pending.projectId
      ) {
        void refreshTimelineAfterTurn().catch(() => undefined);
      }
    }, delay);
  }

  function abandonNewProjectSessionResolution(): void {
    const pending = pendingProjectSessionResolution;
    pendingProjectSessionResolution = undefined;
    newProjectSessionBaseline = undefined;
    pendingProjectResolutionRetryCount = 0;
    pendingProjectResolutionLastCatalogSequence = 0;
    pendingProjectSessionCompletionObserved = false;
    if (pendingProjectResolutionRetry !== undefined) {
      clearTimeout(pendingProjectResolutionRetry);
      pendingProjectResolutionRetry = undefined;
    }
    if (pending !== undefined && state.selectedProjectId === pending.projectId) {
      void refreshProjectCatalog(pending.projectId, pending.epoch);
    }
  }

  function captureNewPersonalSessionBaseline(): void {
    if (personalSelected && selectedPersonalSessionId === undefined) {
      newPersonalSessionBaseline ??= new Set(personalSessions.map((session) => session.id));
      if (!pendingPersonalSessionResolution) {
        pendingPersonalResolutionRetryCount = 0;
        pendingPersonalResolutionLastCatalogSequence = personalCatalog?.sequence ?? 0;
        pendingPersonalSessionCompletionObserved = false;
      }
      pendingPersonalSessionResolution = true;
    }
  }

  function schedulePendingPersonalSessionResolution(): void {
    if (
      !pendingPersonalSessionResolution
      || pendingPersonalResolutionRetry !== undefined
      || pendingPersonalResolutionRetryCount >= 4
    ) return;
    const delay = 500 * (2 ** pendingPersonalResolutionRetryCount);
    pendingPersonalResolutionRetryCount += 1;
    pendingPersonalResolutionRetry = setTimeout(() => {
      pendingPersonalResolutionRetry = undefined;
      if (pendingPersonalSessionResolution && personalSelected) {
        void refreshTimelineAfterTurn().catch(() => undefined);
      }
    }, delay);
  }

  function abandonNewPersonalSessionResolution(): void {
    const wasPending = pendingPersonalSessionResolution;
    pendingPersonalSessionResolution = false;
    newPersonalSessionBaseline = undefined;
    pendingPersonalResolutionRetryCount = 0;
    pendingPersonalResolutionLastCatalogSequence = 0;
    pendingPersonalSessionCompletionObserved = false;
    if (pendingPersonalResolutionRetry !== undefined) {
      clearTimeout(pendingPersonalResolutionRetry);
      pendingPersonalResolutionRetry = undefined;
    }
    if (wasPending && personalSelected) void refreshPersonalCatalog();
  }

  function retryPersistedSessionDiscovery(): void {
    if (personalSelected) {
      if (pendingPersonalSessionResolution) {
        pendingPersonalResolutionRetryCount = 0;
        void refreshTimelineAfterTurn().catch(() => undefined);
      } else {
        void refreshPersonalCatalog();
      }
      return;
    }
    const projectId = state.selectedProjectId;
    if (projectId === undefined) return;
    if (pendingProjectSessionResolution?.projectId === projectId) {
      pendingProjectResolutionRetryCount = 0;
      void refreshTimelineAfterTurn().catch(() => undefined);
    } else {
      void refreshProjectCatalog(projectId, projectRequestEpoch);
    }
  }

  async function refreshTimelineAfterTurn(): Promise<void> {
    if (personalSelected) {
      const expectedSessionId = selectedPersonalSessionId;
      const expectedSessionEpoch = sessionRequestEpoch;
      pendingPersonalSessionCompletionObserved = true;
      const resolvingNewSession = pendingPersonalSessionResolution || expectedSessionId === undefined;
      const knownSessionIds = expectedSessionId === undefined
        ? newPersonalSessionBaseline ?? new Set(personalSessions.map((session) => session.id))
        : new Set<string>();
      if (resolvingNewSession && expectedSessionId === undefined) {
        if (!pendingPersonalSessionResolution) {
          pendingPersonalResolutionRetryCount = 0;
          pendingPersonalResolutionLastCatalogSequence = personalCatalog?.sequence ?? 0;
        }
        pendingPersonalSessionResolution = true;
      }
      let resolved = false;
      if (resolvingNewSession) resolvingPendingPersonalSession = true;
      try {
        const refreshed = await refreshPersonalCatalog();
        const catalog = refreshed?.freshness === 'current'
          ? refreshed
          : await waitForCurrentPersonalCatalog();
        if (catalog === undefined) throw new Error('Pi has not persisted the completed personal turn yet.');
        const session = expectedSessionId === undefined
          ? onlyNewCatalogSession(catalog.sessions, knownSessionIds)
          : catalog.sessions.find((candidate) => candidate.id === expectedSessionId);
        if (session === undefined) throw new Error('Pi has not persisted the completed personal turn yet.');
        let page: TimelinePage;
        try {
          page = await host.getPersonalTimelinePage(session.id);
        } catch (error) {
          if (isHostConflict(error)) invalidatePersonalCatalog();
          throw error;
        }
        const stillExpected = expectedSessionId === undefined
          ? selectedPersonalSessionId === undefined
          : selectedPersonalSessionId === expectedSessionId;
        if (expectedSessionEpoch !== sessionRequestEpoch || !personalSelected || !stillExpected) return;
        personalSessions = catalog.sessions;
        if (expectedSessionId === undefined) selectedPersonalSessionId = session.id;
        await applyCompletedTurnPage(page);
        resolved = true;
      } finally {
        if (resolvingNewSession) {
          resolvingPendingPersonalSession = false;
          if (resolved) {
            pendingPersonalSessionResolution = false;
            newPersonalSessionBaseline = undefined;
            pendingPersonalResolutionRetryCount = 0;
            pendingPersonalResolutionLastCatalogSequence = 0;
            pendingPersonalSessionCompletionObserved = false;
            if (pendingPersonalResolutionRetry !== undefined) {
              clearTimeout(pendingPersonalResolutionRetry);
              pendingPersonalResolutionRetry = undefined;
            }
          } else {
            schedulePendingPersonalSessionResolution();
          }
        }
      }
      return;
    }

    const projectId = state.selectedProjectId;
    if (projectId === undefined) return;
    const expectedSessionId = state.selectedSessionId;
    const expectedProjectEpoch = projectRequestEpoch;
    const expectedSessionEpoch = sessionRequestEpoch;
    pendingProjectSessionCompletionObserved = true;
    const pendingResolution = pendingProjectSessionResolution;
    const resolvingNewSession = (
      pendingResolution?.projectId === projectId
      && pendingResolution.epoch === expectedProjectEpoch
    ) || expectedSessionId === undefined;
    const knownSessionIds = expectedSessionId === undefined
      ? newProjectSessionBaseline ?? new Set(state.sessions.map((session) => session.id))
      : new Set<string>();
    if (resolvingNewSession && expectedSessionId === undefined) {
      if (pendingProjectSessionResolution === undefined) {
        pendingProjectResolutionRetryCount = 0;
        pendingProjectResolutionLastCatalogSequence = sessionCatalogs[projectId]?.sequence ?? 0;
      }
      pendingProjectSessionResolution = { projectId, epoch: expectedProjectEpoch };
    }
    let resolved = false;
    if (resolvingNewSession) resolvingPendingProjectSession = true;
    try {
      const refreshed = await refreshProjectCatalog(projectId, expectedProjectEpoch);
      const catalog = refreshed?.freshness === 'current'
        ? refreshed
        : await waitForCurrentProjectCatalog(projectId, expectedProjectEpoch);
      if (catalog === undefined) throw new Error('Pi has not persisted the completed project turn yet.');
      const session = expectedSessionId === undefined
        ? onlyNewCatalogSession(catalog.sessions, knownSessionIds)
        : catalog.sessions.find((candidate) => candidate.id === expectedSessionId);
      if (session === undefined) throw new Error('Pi has not persisted the completed project turn yet.');
      let page: TimelinePage;
      try {
        page = await host.getTimelinePage(projectId, session.id);
      } catch (error) {
        if (isHostConflict(error)) invalidateProjectCatalog(projectId);
        throw error;
      }
      const stillExpected = expectedSessionId === undefined
        ? state.selectedSessionId === undefined
        : state.selectedSessionId === expectedSessionId;
      if (
        expectedProjectEpoch !== projectRequestEpoch
        || expectedSessionEpoch !== sessionRequestEpoch
        || state.selectedProjectId !== projectId
        || !stillExpected
      ) return;
      if (expectedSessionId === undefined) {
        state = reduceAppState(state, {
          type: 'sessions-loaded',
          projectId,
          sessions: catalog.sessions,
          selectFirst: false,
        });
        state = reduceAppState(state, { type: 'selected-session', sessionId: session.id });
        loadedSessionProjectId = projectId;
      }
      await applyCompletedTurnPage(page);
      resolved = true;
    } finally {
      if (resolvingNewSession) {
        resolvingPendingProjectSession = false;
        if (resolved) {
          if (pendingProjectSessionResolution?.projectId === projectId) {
            pendingProjectSessionResolution = undefined;
          }
          newProjectSessionBaseline = undefined;
          pendingProjectResolutionRetryCount = 0;
          pendingProjectResolutionLastCatalogSequence = 0;
          pendingProjectSessionCompletionObserved = false;
          if (pendingProjectResolutionRetry !== undefined) {
            clearTimeout(pendingProjectResolutionRetry);
            pendingProjectResolutionRetry = undefined;
          }
        } else {
          schedulePendingProjectSessionResolution();
        }
      }
    }
  }

  function onlyNewCatalogSession(
    sessions: SessionSummary[],
    knownSessionIds: ReadonlySet<string>,
  ): SessionSummary | undefined {
    const newSessions = sessions.filter((session) => !knownSessionIds.has(session.id));
    return newSessions.length === 1 ? newSessions[0] : undefined;
  }

  async function applyCompletedTurnPage(page: TimelinePage): Promise<void> {
    if (page.staleCursor) throw new Error('The session changed while the completed turn was being synchronized.');
    const scroller = historyScroller;
    const shouldFollow = scroller === undefined || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 120;
    timeline = page.blocks;
    timelineLoaded = true;
    timelineOlderCursor = page.olderCursor;
    timelineTotalBlocks = page.totalBlocks;
    tree = page.tree;
    await tick();
    if (shouldFollow && historyScroller !== undefined) historyScroller.scrollTop = historyScroller.scrollHeight;
  }

  function requestOlderHistory(scroller: HTMLDivElement): void {
    if (scroller.scrollTop <= 96 && timelineOlderCursor !== undefined && !timelinePageBusy) {
      void loadOlderTimeline();
    }
  }

  function findTimelineAnchor(scroller: HTMLDivElement, blockId: string): HTMLElement | undefined {
    const direct = Array.from(scroller.querySelectorAll<HTMLElement>('[data-timeline-block]'))
      .find((element) => element.dataset.timelineBlock === blockId);
    if (direct !== undefined) return direct;
    return Array.from(scroller.querySelectorAll<HTMLElement>('[data-timeline-blocks]'))
      .find((element) => element.dataset.timelineBlocks?.split(' ').includes(blockId));
  }

  function handleHistoryScroll(event: Event): void {
    requestOlderHistory(event.currentTarget as HTMLDivElement);
  }

  function handleHistoryWheel(event: WheelEvent): void {
    if (event.deltaY < 0) requestOlderHistory(event.currentTarget as HTMLDivElement);
  }

  function handleHistoryKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
      requestOlderHistory(event.currentTarget as HTMLDivElement);
    }
  }

  function clearSessionProjection(): void {
    sessionRequestEpoch += 1;
    resetTimeline();
    tree = undefined;
    state = { ...state, sessions: [], selectedSessionId: undefined };
  }

  async function syncProjectRegistry(): Promise<void> {
    const snapshot = await host.bootstrap();
    state = reduceAppState(state, { type: 'projects-loaded', projects: snapshot.projects });
    applyPreferences(snapshot.preferences);
    if (expandedProjectId !== undefined && !snapshot.projects.some((project) => project.id === expandedProjectId)) {
      expandedProjectId = undefined;
      loadedSessionProjectId = undefined;
      sessionsLoading = false;
    }
    if (projectSettingsTargetId !== undefined && !snapshot.projects.some((project) => project.id === projectSettingsTargetId) && !projectActionBusy) {
      projectSettingsOpen = false;
      projectSettingsTargetId = undefined;
    }
  }

  async function syncProjectRegistryBestEffort(): Promise<void> {
    try {
      await syncProjectRegistry();
    } catch {
      // Preserve the original actionable error instead of replacing it with a
      // secondary synchronization failure.
    }
  }

  function applyProjectMutation(updated: ProjectSummary): void {
    const projects = state.projects
      .map((project) => project.id === updated.id ? updated : project)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned));
    state = reduceAppState(state, { type: 'projects-loaded', projects });
  }

  function toggleProject(project: ProjectSummary): void {
    settingsOpen = false;
    if (expandedProjectId === project.id) {
      // Closing is local presentation state. Invalidate an in-flight refresh so
      // a late response cannot reopen a group the user explicitly collapsed.
      expandedProjectId = undefined;
      sessionsLoading = false;
      projectRequestEpoch += 1;
      return;
    }
    // Reopen an already loaded projection immediately. Refresh remains an
    // explicit action, so toggling cannot repeatedly rescan a large archive.
    if (state.selectedProjectId === project.id && loadedSessionProjectId === project.id) {
      expandedProjectId = project.id;
      return;
    }
    void selectProject(project);
  }

  function requestProjectRefresh(project: ProjectSummary): void {
    if (state.selectedProjectId !== project.id) {
      void selectProject(project);
      return;
    }
    void refreshProjectCatalog(project.id, projectRequestEpoch);
  }

  async function hydrateProjectAfterCatalog(
    projectId: string,
    initialSession: SessionSummary | undefined,
    requestEpoch: number,
  ): Promise<void> {
    // Return control to the WebView compositor before a large transcript can
    // issue its blocking host read. This makes the cache-first sidebar both
    // visible and keyboard-reachable independently of session size.
    await tick();
    await nextBrowserFrame();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (requestEpoch !== projectRequestEpoch || state.selectedProjectId !== projectId) return;
    if (initialSession !== undefined) await selectSession(initialSession, requestEpoch);
    if (requestEpoch !== projectRequestEpoch || state.selectedProjectId !== projectId) return;
    const refreshed = await refreshProjectCatalog(projectId, requestEpoch);
    if (refreshed === undefined || requestEpoch !== projectRequestEpoch || state.selectedProjectId !== projectId) return;
    if (
      state.selectedSessionId === undefined
      && pendingProjectSessionResolution?.projectId !== projectId
    ) {
      const first = refreshed.sessions[0];
      if (first !== undefined) await selectSession(first, requestEpoch);
    }
  }

  function invalidatePersonalCatalog(): void {
    pendingPersonalSessionResolution = false;
    newPersonalSessionBaseline = undefined;
    pendingPersonalResolutionRetryCount = 0;
    pendingPersonalResolutionLastCatalogSequence = 0;
    if (pendingPersonalResolutionRetry !== undefined) {
      clearTimeout(pendingPersonalResolutionRetry);
      pendingPersonalResolutionRetry = undefined;
    }
    personalCatalogInvalidation = {
      sequence: Math.max(personalCatalogStatusSequence, personalCatalog?.sequence ?? 0),
      epoch: ++nextCatalogInvalidationEpoch,
    };
    personalCatalog = undefined;
    personalSessions = [];
    if (!personalSelected) return;
    sessionRequestEpoch += 1;
    selectedPersonalSessionId = undefined;
    resetTimeline();
    tree = undefined;
  }

  function invalidateProjectCatalog(projectId: string): void {
    const { [projectId]: _discarded, ...remainingCatalogs } = sessionCatalogs;
    sessionCatalogs = remainingCatalogs;
    invalidatedProjectCatalogs = {
      ...invalidatedProjectCatalogs,
      [projectId]: {
        sequence: Math.max(
          invalidatedProjectCatalogs[projectId]?.sequence ?? 0,
          catalogStatusSequences[projectId] ?? 0,
          sessionCatalogs[projectId]?.sequence ?? 0,
        ),
        epoch: ++nextCatalogInvalidationEpoch,
      },
    };
    if (pendingProjectSessionResolution?.projectId === projectId) {
      pendingProjectSessionResolution = undefined;
      newProjectSessionBaseline = undefined;
      pendingProjectResolutionRetryCount = 0;
      pendingProjectResolutionLastCatalogSequence = 0;
      if (pendingProjectResolutionRetry !== undefined) {
        clearTimeout(pendingProjectResolutionRetry);
        pendingProjectResolutionRetry = undefined;
      }
    }
    if (state.selectedProjectId !== projectId) return;
    sessionRequestEpoch += 1;
    resetTimeline();
    tree = undefined;
    loadedSessionProjectId = undefined;
    state = { ...state, sessions: [], selectedSessionId: undefined };
  }

  async function selectProject(project: ProjectSummary): Promise<void> {
    settingsOpen = false;
    personalSelected = false;
    pendingPersonalSessionResolution = false;
    newPersonalSessionBaseline = undefined;
    pendingPersonalResolutionRetryCount = 0;
    selectedPersonalSessionId = undefined;
    expandedProjectId = project.id;
    const requestEpoch = ++projectRequestEpoch;
    pendingProjectSessionResolution = undefined;
    pendingProjectResolutionRetryCount = 0;
    const retainedSessionId = state.selectedProjectId === project.id ? state.selectedSessionId : undefined;
    const retainedCatalog = sessionCatalogs[project.id];
    // Invalidate a pending timeline/tree response immediately, but retain any
    // known catalog rows. A slow filesystem reconciliation must never create a
    // blank sidebar for a project we have indexed before.
    sessionRequestEpoch += 1;
    newProjectSessionBaseline = undefined;
    resetTimeline();
    tree = undefined;
    sessionsFreshness = retainedCatalog?.freshness ?? 'cached';
    sessionsRefreshError = undefined;
    sessionsLoading = retainedCatalog === undefined;
    state = {
      ...state,
      error: undefined,
      selectedProjectId: project.id,
      selectedSessionId: retainedSessionId,
      sessions: retainedCatalog?.sessions ?? [],
    };
    const recoveryEpoch = projectRecoveryEpoch(project.id);
    try {
      const catalog = await host.getSessionCatalog(project.id);
      if (requestEpoch !== projectRequestEpoch) return;
      const accepted = applyProjectCatalog(catalog, false, recoveryEpoch);
      const initialSession = accepted
        ? catalog.sessions.find((session) => session.id === state.selectedSessionId) ?? catalog.sessions[0]
        : undefined;
      void hydrateProjectAfterCatalog(project.id, initialSession, requestEpoch);
    } catch (error) {
      if (requestEpoch !== projectRequestEpoch) return;
      if (isHostConflict(error)) invalidateProjectCatalog(project.id);
      // Preserve cache only for transient failures; identity conflict has
      // already purged it so a replacement folder cannot inherit previews.
      sessionsLoading = false;
      sessionsFreshness = 'degraded';
      sessionsRefreshError = messageFor(error);
      await syncProjectRegistryBestEffort();
    }
  }

  async function selectSession(session: SessionSummary, expectedProjectEpoch = projectRequestEpoch, preserveLive = false): Promise<void> {
    settingsOpen = false;
    const projectId = state.selectedProjectId;
    if (projectId === undefined) return;
    if (pendingProjectSessionResolution?.projectId === projectId) {
      pendingProjectSessionResolution = undefined;
      newProjectSessionBaseline = undefined;
      pendingProjectResolutionRetryCount = 0;
    }
    const requestEpoch = ++sessionRequestEpoch;
    state = reduceAppState(state, { type: 'selected-session', sessionId: session.id });
    resetTimeline(!preserveLive);
    try {
      const page = await host.getTimelinePage(projectId, session.id);
      if (requestEpoch !== sessionRequestEpoch || expectedProjectEpoch !== projectRequestEpoch || state.selectedProjectId !== projectId) return;
      if (page.staleCursor) {
        // A fresh latest-page request has no cursor; this is defensive and
        // avoids ever combining two file revisions in one rendered timeline.
        throw new Error('The local session changed while it was being opened. Refresh and try again.');
      }
      timeline = page.blocks;
      timelineLoaded = true;
      timelineOlderCursor = page.olderCursor;
      timelineTotalBlocks = page.totalBlocks;
      tree = page.tree;
      await scrollHistoryToLatest();
    } catch (error) {
      if (requestEpoch !== sessionRequestEpoch || expectedProjectEpoch !== projectRequestEpoch || state.selectedProjectId !== projectId) return;
      if (isHostConflict(error)) invalidateProjectCatalog(projectId);
      else clearSessionProjection();
      await syncProjectRegistryBestEffort();
      if (expectedProjectEpoch !== projectRequestEpoch) return;
      state = reduceAppState(state, { type: 'failed', message: messageFor(error) });
    }
  }

  async function refreshPersonalSessions(): Promise<void> {
    const recoveryEpoch = personalRecoveryEpoch();
    try {
      const catalog = await host.getPersonalSessionCatalog();
      applyPersonalCatalog(catalog, false, recoveryEpoch);
      void refreshPersonalCatalog();
    } catch (error) {
      if (isHostConflict(error)) invalidatePersonalCatalog();
      // Personal history is auxiliary to the active project surface; retain
      // its prior cache only for transient failures.
      personalCatalogRefreshError = messageFor(error);
    }
  }

  async function openNewChat(): Promise<void> {
    settingsOpen = false;
    projectRequestEpoch += 1;
    sessionRequestEpoch += 1;
    personalChatEpoch += 1;
    pendingProjectSessionResolution = undefined;
    pendingProjectResolutionRetryCount = 0;
    newProjectSessionBaseline = undefined;
    newPersonalSessionBaseline = undefined;
    expandedProjectId = undefined;
    loadedSessionProjectId = undefined;
    sessionsLoading = false;
    personalSelected = true;
    selectedPersonalSessionId = undefined;
    treeOpen = false;
    tree = undefined;
    resetTimeline();
    state = { ...state, selectedProjectId: undefined, selectedSessionId: undefined, sessions: [] };
    await refreshPersonalSessions();
  }

  async function selectPersonalSession(session: SessionSummary, preserveLive = false): Promise<void> {
    settingsOpen = false;
    const requestEpoch = ++sessionRequestEpoch;
    expandedProjectId = undefined;
    loadedSessionProjectId = undefined;
    sessionsLoading = false;
    pendingProjectSessionResolution = undefined;
    pendingProjectResolutionRetryCount = 0;
    newProjectSessionBaseline = undefined;
    personalSelected = true;
    pendingPersonalSessionResolution = false;
    pendingPersonalResolutionRetryCount = 0;
    newPersonalSessionBaseline = undefined;
    selectedPersonalSessionId = session.id;
    treeOpen = false;
    tree = undefined;
    resetTimeline(!preserveLive);
    state = { ...state, selectedProjectId: undefined, selectedSessionId: undefined, sessions: [] };
    try {
      const page = await host.getPersonalTimelinePage(session.id);
      if (requestEpoch !== sessionRequestEpoch || !personalSelected || selectedPersonalSessionId !== session.id) return;
      if (page.staleCursor) {
        throw new Error('The local chat changed while it was being opened. Refresh and try again.');
      }
      timeline = page.blocks;
      timelineLoaded = true;
      timelineOlderCursor = page.olderCursor;
      timelineTotalBlocks = page.totalBlocks;
      tree = page.tree;
      await scrollHistoryToLatest();
    } catch (error) {
      if (requestEpoch !== sessionRequestEpoch || !personalSelected || selectedPersonalSessionId !== session.id) return;
      if (isHostConflict(error)) invalidatePersonalCatalog();
      else {
        resetTimeline();
        tree = undefined;
      }
      state = reduceAppState(state, { type: 'failed', message: messageFor(error) });
    }
  }

  async function loadOlderTimeline(): Promise<void> {
    const personal = personalSelected;
    const projectId = state.selectedProjectId;
    const sessionId = personal ? selectedPersonalSessionId : state.selectedSessionId;
    const cursor = timelineOlderCursor;
    if (sessionId === undefined || cursor === undefined || timelinePageBusy || (!personal && projectId === undefined)) return;
    const requestEpoch = sessionRequestEpoch;
    timelinePageBusy = true;
    try {
      const page = personal
        ? await host.getPersonalTimelinePage(sessionId, cursor)
        : await host.getTimelinePage(projectId as string, sessionId, cursor);
      const stillSelected = personal
        ? personalSelected && selectedPersonalSessionId === sessionId
        : state.selectedProjectId === projectId && state.selectedSessionId === sessionId;
      if (requestEpoch !== sessionRequestEpoch || !stillSelected) return;
      if (page.staleCursor) {
        const session = personal
          ? personalSessions.find((item) => item.id === sessionId)
          : state.sessions.find((item) => item.id === sessionId);
        if (session !== undefined) {
          if (personal) await selectPersonalSession(session);
          else await selectSession(session, projectRequestEpoch);
        }
        return;
      }
      const combined = [...page.blocks, ...timeline];
      const scroller = historyScroller;
      const anchorId = timeline[0]?.id;
      const anchorBefore = anchorId === undefined || scroller === undefined
        ? undefined
        : findTimelineAnchor(scroller, anchorId)?.getBoundingClientRect().top;
      const previousScrollHeight = scroller?.scrollHeight;
      const previousScrollTop = scroller?.scrollTop;
      if (combined.length > MAX_RETAINED_TIMELINE_BLOCKS) {
        // Keep the older side of the bounded window, including the current
        // visual anchor, and release only unseen newest blocks at the bottom.
        timeline = combined.slice(0, MAX_RETAINED_TIMELINE_BLOCKS);
        timelineWindowNotice = 'Showing an older bounded window. Select this session again to return to the latest entries.';
      } else {
        timeline = combined;
      }
      await tick();
      if (scroller !== undefined) {
        const anchorAfter = anchorId === undefined
          ? undefined
          : findTimelineAnchor(scroller, anchorId)?.getBoundingClientRect().top;
        if (anchorBefore !== undefined && anchorAfter !== undefined) {
          scroller.scrollTop += anchorAfter - anchorBefore;
        } else if (previousScrollHeight !== undefined && previousScrollTop !== undefined) {
          scroller.scrollTop = previousScrollTop + scroller.scrollHeight - previousScrollHeight;
        }
      }
      timelineOlderCursor = page.olderCursor;
      timelineTotalBlocks = page.totalBlocks;
    } catch (error) {
      if (requestEpoch !== sessionRequestEpoch) return;
      if (isHostConflict(error)) {
        if (personal) invalidatePersonalCatalog();
        else if (projectId !== undefined) invalidateProjectCatalog(projectId);
      }
      state = reduceAppState(state, { type: 'failed', message: messageFor(error) });
    } finally {
      if (requestEpoch === sessionRequestEpoch) timelinePageBusy = false;
    }
  }

  function openSearch(): void {
    searchRequestEpoch += 1;
    searchQuery = '';
    searchResults = [];
    searchError = undefined;
    searchBusy = false;
    searchOpen = true;
  }

  function closeSearch(): void {
    searchRequestEpoch += 1;
    if (searchDebounce !== undefined) clearTimeout(searchDebounce);
    searchDebounce = undefined;
    searchOpen = false;
  }

  function handleGlobalShortcut(event: KeyboardEvent): void {
    if (searchOpen || trustOpen || projectSettingsOpen || settingsOpen || addProjectOpen) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      void openNewChat();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    } else if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      preferencesError = undefined;
      settingsOpen = true;
    }
  }

  function searchSessions(query: string): void {
    searchQuery = query;
    const requestEpoch = ++searchRequestEpoch;
    const normalized = query.trim();
    if (searchDebounce !== undefined) clearTimeout(searchDebounce);
    if (normalized.length === 0) {
      searchBusy = false;
      searchResults = [];
      searchError = undefined;
      return;
    }
    searchBusy = true;
    searchError = undefined;
    searchDebounce = setTimeout(() => void executeSearch(normalized, requestEpoch), 120);
  }

  async function executeSearch(query: string, requestEpoch: number): Promise<void> {
    try {
      const results = await host.searchSessions(query);
      if (requestEpoch !== searchRequestEpoch || !searchOpen) return;
      searchResults = results;
    } catch (error) {
      if (requestEpoch !== searchRequestEpoch || !searchOpen) return;
      searchResults = [];
      searchError = messageFor(error);
    } finally {
      if (requestEpoch === searchRequestEpoch) searchBusy = false;
    }
  }

  async function openSearchResult(result: SessionSummary): Promise<void> {
    const projectId = result.projectId;
    const project = projectId === undefined ? undefined : state.projects.find((item) => item.id === projectId);
    if (project === undefined) {
      searchError = 'That local session is no longer available. Refresh the project list and try again.';
      return;
    }
    closeSearch();
    await selectProject(project);
    const loaded = state.sessions.find((session) => session.id === result.id);
    if (state.selectedProjectId === project.id && loaded !== undefined) await selectSession(loaded);
  }

  async function openAddProject(): Promise<void> {
    settingsOpen = false;
    if (hasNativeFolderPicker) {
      try {
        const project = await host.pickAndAddProject();
        if (project !== undefined) await adoptAddedProject(project);
      } catch (error) {
        state = reduceAppState(state, { type: 'failed', message: messageFor(error) });
      }
      return;
    }
    projectPath = '';
    addProjectOpen = true;
  }

  async function addProject(): Promise<void> {
    if (projectPath.trim().length === 0) return;
    addProjectBusy = true;
    try {
      const project = await host.addProject(projectPath);
      await adoptAddedProject(project);
      addProjectOpen = false;
    } catch (error) {
      state = reduceAppState(state, { type: 'failed', message: messageFor(error) });
    } finally {
      addProjectBusy = false;
    }
  }

  async function adoptAddedProject(project: ProjectSummary): Promise<void> {
    const existing = state.projects.findIndex((item) => item.id === project.id);
    const projects = existing >= 0
      ? state.projects.map((item) => item.id === project.id ? project : item)
      : [...state.projects, project];
    state = reduceAppState(state, { type: 'projects-loaded', projects });
    await selectProject(project);
  }

  function openProjectSettings(project: ProjectSummary): void {
    projectSettingsTargetId = project.id;
    projectNameDraft = project.name;
    projectActionError = undefined;
    projectSettingsOpen = true;
  }

  function closeProjectSettings(): void {
    if (projectActionBusy) return;
    projectSettingsOpen = false;
    projectSettingsTargetId = undefined;
    projectActionError = undefined;
  }

  async function renameProject(): Promise<void> {
    const projectId = projectSettingsTargetId;
    if (projectId === undefined) return;
    projectActionBusy = true;
    projectActionError = undefined;
    try {
      const renamed = await host.renameProject(projectId, projectNameDraft);
      applyProjectMutation(renamed);
      projectNameDraft = renamed.name;
    } catch (error) {
      projectActionError = messageFor(error);
    } finally {
      projectActionBusy = false;
    }
  }

  async function toggleProjectPin(): Promise<void> {
    const project = projectSettingsProject;
    if (project === undefined) return;
    projectActionBusy = true;
    projectActionError = undefined;
    try {
      const updated = await host.setProjectPinned(project.id, !project.pinned);
      applyProjectMutation(updated);
    } catch (error) {
      projectActionError = messageFor(error);
    } finally {
      projectActionBusy = false;
    }
  }

  async function removeProject(): Promise<void> {
    const projectId = projectSettingsTargetId;
    if (projectId === undefined) return;
    // Invalidate all pending project/session loads before the registry mutation
    // so an old Refresh cannot restore a project that was just removed.
    projectRequestEpoch += 1;
    const removedWasSelected = state.selectedProjectId === projectId;
    if (expandedProjectId === projectId) {
      expandedProjectId = undefined;
      loadedSessionProjectId = undefined;
      sessionsLoading = false;
    }
    projectActionBusy = true;
    projectActionError = undefined;
    try {
      await host.removeProject(projectId);
      if (removedWasSelected) clearSessionProjection();
      state = reduceAppState(state, {
        type: 'projects-loaded',
        projects: state.projects.filter((project) => project.id !== projectId),
      });
      projectSettingsOpen = false;
      projectSettingsTargetId = undefined;
    } catch (error) {
      projectActionError = messageFor(error);
    } finally {
      projectActionBusy = false;
    }
  }

  async function trustProject(): Promise<void> {
    if (selectedProject === undefined) return;
    trustBusy = true;
    try {
      const trusted = await host.setProjectTrust(selectedProject.id, 'trusted');
      state = reduceAppState(state, {
        type: 'projects-loaded',
        projects: state.projects.map((project) => project.id === trusted.id ? trusted : project),
      });
      trustOpen = false;
    } catch (error) {
      await syncProjectRegistryBestEffort();
      state = reduceAppState(state, { type: 'failed', message: messageFor(error) });
    } finally {
      trustBusy = false;
    }
  }

  function messageFor(error: unknown): string {
    return error instanceof Error ? error.message : 'The host returned an unknown safe failure.';
  }
</script>

<svelte:window onkeydown={handleGlobalShortcut} />

<div class:with-tree={treeOpen} class="app-shell">
  <ProjectSidebar
    projects={state.projects}
    sessions={state.sessions}
    personalSessions={personalSessions}
    personalSelected={personalSelected}
    selectedPersonalSessionId={selectedPersonalSessionId}
    selectedProjectId={state.selectedProjectId}
    expandedProjectId={expandedProjectId}
    selectedSessionId={state.selectedSessionId}
    sessionsLoading={sessionsLoading}
    sessionsFreshness={sessionsFreshness}
    sessionsRefreshError={sessionsRefreshError}
    onAddProject={openAddProject}
    onNewChat={() => void openNewChat()}
    onSelectProject={toggleProject}
    onSelectSession={selectSession}
    onSelectPersonalSession={selectPersonalSession}
    onRefreshProject={requestProjectRefresh}
    onManageProject={openProjectSettings}
    settingsSelected={settingsOpen}
    onSettings={openSettings}
    onSearch={openSearch}
  />

  <main class="workspace">
    {#if state.loading}
      <section class="booting" aria-label="Loading PiUI"><span class="skeleton title"></span><span class="skeleton copy"></span><span class="skeleton copy copy--short"></span></section>
    {:else if settingsOpen}
      <SettingsView
        {preferences}
        {preferencesBusy}
        {preferencesError}
        {extensions}
        {extensionsLoading}
        {extensionsError}
        {extensionBusyId}
        onTheme={updateTheme}
        onDensity={updateDensity}
        onMotion={updateReducedMotion}
        onFontSize={updateFontSize}
        onChatWidth={updateChatWidth}
        onToggleExtension={(extension, enabled) => void toggleExtension(extension, enabled)}
        onRefreshExtensions={() => void refreshExtensions()}
        onClose={() => settingsOpen = false}
      />
    {:else if personalSelected}
      {#if state.safeMode}
        <div class="safe-mode-banner" role="status"><strong>Safe mode.</strong><span>Extensions and runtime actions are disabled. Your local history remains read only.</span></div>
      {/if}
      {#if state.error}
        <div class="error-banner" role="alert"><strong>Recovery needed.</strong><span>{state.error}</span><button type="button" onclick={() => state = { ...state, error: undefined }}>Dismiss</button></div>
      {/if}

      {#if selectedPersonalSession || liveTimeline.length > 0}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
        <div class="history-scroll" bind:this={historyScroller} onscroll={handleHistoryScroll} onwheel={handleHistoryWheel} onkeydown={handleHistoryKeydown} tabindex="0" role="feed" aria-label="Session history; scroll upward to load older messages">
          {#if timelinePageBusy}<p class="history-load-status" role="status">Loading older history…</p>{/if}
          {#if timelineWindowNotice}
            <p class="timeline-window-notice" role="status">{timelineWindowNotice}</p>
          {/if}
          <Timeline
            blocks={[...timeline, ...liveTimeline]}
            sessionKey={selectedPersonalSessionId}
            loading={selectedPersonalSession !== undefined && !timelineLoaded && liveTimeline.length === 0}
          />
        </div>
      {:else}
        <EmptyState eyebrow="Chats" title="New chat" description="No user folder is attached. Pi keeps an empty chat in memory and saves its JSONL history after the first assistant response." />
      {/if}

      {#key `personal:${selectedPersonalSessionId ?? 'new'}:${personalChatEpoch}`}
        <ChatPanel
          personal={true}
          projectId={undefined}
          sessionId={selectedPersonalSession?.id}
          trusted={true}
          safeMode={state.safeMode}
          onTurnCompleted={refreshTimelineAfterTurn}
          onNewSessionStarting={captureNewPersonalSessionBaseline}
          onNewSessionStartAborted={abandonNewPersonalSessionResolution}
          onRetryPersistedSession={retryPersistedSessionDiscovery}
          onBlocksChanged={updateLiveTimeline}
        />
      {/key}
    {:else if state.projects.length === 0}
      <EmptyState eyebrow="Chats" title="Start a new chat" description="Talk to Pi without attaching a user folder. Add a project later when you want Pi session history from that folder." actionLabel="New chat" action={() => void openNewChat()} />
    {:else if selectedProject === undefined}
      <EmptyState eyebrow="Projects" title="Select a project" description="Choose a folder in the sidebar to inspect its local Pi session history." />
    {:else}
      {#if selectedProject.missing}
        <div class="offline-banner" role="status"><strong>Folder unavailable.</strong><span>Reconnect the folder and use Refresh. PiUI has not changed any Pi session files.</span></div>
      {/if}
      {#if state.safeMode}
        <div class="safe-mode-banner" role="status"><strong>Safe mode.</strong><span>Extensions and runtime actions are disabled. Your local history remains read only.</span></div>
      {/if}
      {#if state.error}
        <div class="error-banner" role="alert"><strong>Recovery needed.</strong><span>{state.error}</span><button type="button" onclick={() => state = { ...state, error: undefined }}>Dismiss</button></div>
      {/if}

      {#if selectedSession || liveTimeline.length > 0}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
        <div class="history-scroll" bind:this={historyScroller} onscroll={handleHistoryScroll} onwheel={handleHistoryWheel} onkeydown={handleHistoryKeydown} tabindex="0" role="feed" aria-label="Session history; scroll upward to load older messages">
          {#if timelinePageBusy}<p class="history-load-status" role="status">Loading older history…</p>{/if}
          {#if timelineWindowNotice}
            <p class="timeline-window-notice" role="status">{timelineWindowNotice}</p>
          {/if}
          <Timeline
            blocks={[...timeline, ...liveTimeline]}
            sessionKey={state.selectedSessionId}
            loading={selectedSession !== undefined && !timelineLoaded && liveTimeline.length === 0}
          />
        </div>
      {:else if sessionsLoading}
        <section class="session-scan-state" aria-live="polite">
          <p class="eyebrow">Session history</p>
          <p>Scanning local Pi sessions…</p>
        </section>
      {:else}
        <EmptyState eyebrow="Session history" title="No Pi sessions here yet" description="Trust this project, then start a new Pi chat below. PiUI discovers the authoritative Pi JSONL session after the runtime stops." />
      {/if}

      {#if selectedSession}
        {#key state.selectedProjectId + ':' + selectedSession.id}
          <ChatPanel
            projectId={state.selectedProjectId}
            sessionId={selectedSession.id}
            trusted={selectedProject.trustState === 'trusted'}
            safeMode={state.safeMode}
            onRequestTrust={() => trustOpen = true}
            onTurnCompleted={refreshTimelineAfterTurn}
            onNewSessionStarting={captureNewProjectSessionBaseline}
            onNewSessionStartAborted={abandonNewProjectSessionResolution}
            onRetryPersistedSession={retryPersistedSessionDiscovery}
            onBlocksChanged={updateLiveTimeline}
          />
        {/key}
      {:else if selectedProject}
        <ChatPanel
          projectId={state.selectedProjectId}
          sessionId={undefined}
          trusted={selectedProject.trustState === 'trusted'}
          safeMode={state.safeMode}
          onRequestTrust={() => trustOpen = true}
          onTurnCompleted={refreshTimelineAfterTurn}
          onNewSessionStarting={captureNewProjectSessionBaseline}
          onNewSessionStartAborted={abandonNewProjectSessionResolution}
          onRetryPersistedSession={retryPersistedSessionDiscovery}
          onBlocksChanged={updateLiveTimeline}
        />
      {/if}

    {/if}
  </main>

  <ReadOnlyTree tree={tree} open={treeOpen} onClose={() => treeOpen = false} />
</div>

{#if addProjectOpen}
  <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !addProjectBusy) addProjectOpen = false; }}>
    <form class="add-dialog" aria-labelledby="add-project-title" onsubmit={(event) => { event.preventDefault(); void addProject(); }}>
      <p class="eyebrow">Local project</p>
      <h2 id="add-project-title">Add an existing folder</h2>
      <label for="project-path">Folder path</label>
      <input id="project-path" bind:value={projectPath} autocomplete="off" placeholder="D:\\work\\project" disabled={addProjectBusy} />
      <p class="helper">The host canonicalizes this path and prevents duplicate project entries. Project-local code stays blocked in this foundation build.</p>
      <div class="dialog-actions"><button type="button" class="quiet" onclick={() => addProjectOpen = false} disabled={addProjectBusy}>Cancel</button><button type="submit" class="primary" disabled={addProjectBusy || projectPath.trim().length === 0}>{addProjectBusy ? 'Adding…' : 'Add restricted'}</button></div>
    </form>
  </div>
{/if}

<TrustDialog project={selectedProject} open={trustOpen} busy={trustBusy} onClose={() => trustOpen = false} onTrust={trustProject} />
<CommandPalette
  open={searchOpen}
  query={searchQuery}
  results={searchResults}
  busy={searchBusy}
  error={searchError}
  onClose={closeSearch}
  onQuery={searchSessions}
  onOpenResult={openSearchResult}
/>
<ProjectSettingsDialog
  project={projectSettingsProject}
  bind:draftName={projectNameDraft}
  open={projectSettingsOpen}
  busy={projectActionBusy}
  error={projectActionError}
  onClose={closeProjectSettings}
  onRename={renameProject}
  onTogglePin={toggleProjectPin}
  onRemove={removeProject}
/>

<style>
  .app-shell { display: grid; grid-template-columns: minmax(220px, 272px) minmax(0, 1fr); height: 100dvh; min-height: 0; overflow: hidden; background: var(--piui-bg); }
  .app-shell.with-tree { grid-template-columns: minmax(220px, 272px) minmax(0, 1fr) minmax(230px, 320px); }
  .workspace { display: flex; flex-direction: column; min-width: 0; height: 100dvh; min-height: 0; overflow: hidden; }
  .booting { display: grid; align-content: center; gap: var(--piui-space-3); max-width: 620px; padding: var(--piui-space-8); margin: auto; width: 100%; }.booting span { display: block; height: 14px; border-radius: 4px; }.booting .title { width: 42%; height: 30px; }.booting .copy { width: 90%; }.booting .copy--short { width: 60%; }
  .history-scroll { flex: 1 1 0; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }.history-load-status { position: sticky; top: var(--piui-space-2); z-index: 1; width: max-content; margin: var(--piui-space-2) auto; padding: 5px 10px; border-radius: 999px; background: var(--piui-surface-2); color: var(--piui-text-muted); font-size: 10px; }.session-scan-state { flex: 1 1 0; display: grid; align-content: center; justify-items: center; gap: var(--piui-space-2); padding: var(--piui-space-8); color: var(--piui-text-muted); text-align: center; }.session-scan-state p:not(.eyebrow) { margin: 0; font-size: 13px; }.timeline-window-notice { width: min(100%, var(--piui-chat-column-width)); margin: var(--piui-space-4) auto 0; padding: 0 var(--piui-chat-inline-padding); color: var(--piui-warning); font-size: 11px; line-height: 1.5; }.safe-mode-banner, .offline-banner, .error-banner { display: flex; align-items: baseline; gap: var(--piui-space-2); padding: 10px var(--piui-space-6); border-bottom: 1px solid; font-size: 12px; }.safe-mode-banner { border-color: var(--piui-warning-border); background: var(--piui-warning-surface); color: var(--piui-warning-text); }.offline-banner { border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.error-banner { border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.error-banner button { margin-left: auto; background: transparent; color: inherit; font-size: 12px; text-decoration: underline; }
  .modal-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: var(--piui-space-4); background: rgba(10, 13, 10, .72); }.add-dialog { width: min(100%, 510px); max-height: min(86dvh, 760px); overflow: auto; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-lg); background: var(--piui-bg-raised); padding: clamp(24px, 5vw, 40px); box-shadow: 0 24px 72px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.04); }.eyebrow { margin: 0 0 var(--piui-space-3); color: var(--piui-accent); font-size: 11px; font-weight: 720; letter-spacing: .11em; text-transform: uppercase; }.add-dialog h2 { margin: 0; font-size: 26px; letter-spacing: -.035em; }.add-dialog label { display: block; margin-top: var(--piui-space-6); color: var(--piui-text); font-size: 12px; font-weight: 700; }.add-dialog input { width: 100%; min-height: 42px; margin-top: var(--piui-space-2); padding: 0 var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); }.helper { margin: var(--piui-space-3) 0 0; color: var(--piui-text-muted); font-size: 12px; line-height: 1.55; }.dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--piui-space-2); margin-top: var(--piui-space-6); }.dialog-actions button { min-height: 38px; padding: 0 var(--piui-space-3); border-radius: var(--piui-radius-sm); font-size: 13px; font-weight: 700; }.quiet { background: transparent; color: var(--piui-text-muted); }.quiet:hover { background: var(--piui-surface-1); color: var(--piui-text); }.primary { background: var(--piui-accent); color: var(--piui-accent-ink); }.primary:disabled { opacity: .55; }
  @media (max-width: 900px) { .app-shell, .app-shell.with-tree { grid-template-columns: minmax(200px, 240px) minmax(0, 1fr); }.app-shell.with-tree > :last-child { position: fixed; inset: 0 0 0 auto; width: min(88vw, 320px); z-index: 10; box-shadow: -18px 0 44px rgba(0,0,0,.25); } }
  @media (max-width: 650px) { .app-shell, .app-shell.with-tree { grid-template-columns: 1fr; }.app-shell > :first-child { display: none; }.error-banner { padding: 10px var(--piui-space-4); } }
</style>
