<script module lang="ts">
  import type { ModelLite as CachedModelLite } from '../../host-api/types';
  import type { SessionRuntimePreference } from './runtimeSelection';

  const CATALOG_STORAGE_KEY = 'piui.runtime-catalog.v1';
  const DEFAULT_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const MAX_CACHED_MODELS = 512;
  const MAX_SESSION_RUNTIME_PREFERENCES = 256;

  interface PersistedCatalog {
    version: 2;
    models: CachedModelLite[];
    modelSelection?: CachedModelLite;
    modelSelectionExplicit?: boolean;
    thinkingSelection?: string;
    thinkingSelectionExplicit?: boolean;
    sessionPreferences: SessionRuntimePreference[];
  }

  function validModel(value: unknown): value is CachedModelLite {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.provider === 'string'
      && candidate.provider.length > 0
      && candidate.provider.length <= 128
      && typeof candidate.id === 'string'
      && candidate.id.length > 0
      && candidate.id.length <= 256
      && (candidate.label === undefined || (typeof candidate.label === 'string' && candidate.label.length <= 256));
  }

  function validSessionPreference(value: unknown): value is SessionRuntimePreference {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.key === 'string'
      && candidate.key.length > 0
      && candidate.key.length <= 1024
      && (candidate.model === undefined || validModel(candidate.model))
      && (candidate.thinkingLevel === undefined || (typeof candidate.thinkingLevel === 'string' && DEFAULT_THINKING_LEVELS.includes(candidate.thinkingLevel)))
      && typeof candidate.updatedAt === 'number'
      && Number.isFinite(candidate.updatedAt);
  }

  function readPersistedCatalog(): PersistedCatalog | undefined {
    if (typeof localStorage === 'undefined') return undefined;
    try {
      const raw = localStorage.getItem(CATALOG_STORAGE_KEY);
      if (raw === null || raw.length > 256 * 1024) return undefined;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const candidate = parsed as Record<string, unknown>;
      if ((candidate.version !== 1 && candidate.version !== 2) || !Array.isArray(candidate.models) || candidate.models.length > MAX_CACHED_MODELS) return undefined;
      const models = candidate.models.filter(validModel);
      const modelSelection = validModel(candidate.modelSelection) ? candidate.modelSelection : undefined;
      const thinkingSelection = typeof candidate.thinkingSelection === 'string' && DEFAULT_THINKING_LEVELS.includes(candidate.thinkingSelection)
        ? candidate.thinkingSelection
        : undefined;
      const sessionPreferences = candidate.version === 2 && Array.isArray(candidate.sessionPreferences)
        ? candidate.sessionPreferences.filter(validSessionPreference).slice(-MAX_SESSION_RUNTIME_PREFERENCES)
        : [];
      return {
        version: 2,
        models,
        modelSelection,
        modelSelectionExplicit: candidate.modelSelectionExplicit === true,
        thinkingSelection,
        thinkingSelectionExplicit: candidate.thinkingSelectionExplicit === true,
        sessionPreferences,
      };
    } catch {
      return undefined;
    }
  }

  function persistCatalog(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const value: PersistedCatalog = {
        version: 2,
        models: cachedModels.slice(0, MAX_CACHED_MODELS),
        modelSelection: cachedModelSelection,
        modelSelectionExplicit: cachedModelSelectionExplicit,
        thinkingSelection: cachedThinkingSelection,
        thinkingSelectionExplicit: cachedThinkingSelectionExplicit,
        sessionPreferences: cachedSessionPreferences.slice(-MAX_SESSION_RUNTIME_PREFERENCES),
      };
      localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // The catalog remains an in-memory optimization when storage is denied.
    }
  }

  const persistedCatalog = readPersistedCatalog();
  // Session navigation is presentation-only. Reuse the latest display-safe Pi
  // catalog and user selection across keyed panels; never start a process just
  // to repopulate controls while the user browses history.
  let cachedModels: CachedModelLite[] = persistedCatalog?.models ?? [];
  let cachedThinkingLevels: string[] = cachedModels.length > 0 ? [...DEFAULT_THINKING_LEVELS] : [];
  let cachedModelSelection: CachedModelLite | undefined = cachedModels.find((model) => model.provider === persistedCatalog?.modelSelection?.provider && model.id === persistedCatalog.modelSelection.id);
  let cachedModelSelectionExplicit = persistedCatalog?.modelSelectionExplicit === true;
  let cachedThinkingSelection: string | undefined = persistedCatalog?.thinkingSelection;
  let cachedThinkingSelectionExplicit = persistedCatalog?.thinkingSelectionExplicit === true;
  let cachedSessionPreferences: SessionRuntimePreference[] = persistedCatalog?.sessionPreferences ?? [];
  // A keyed session switch destroys the old panel before creating the next
  // one. Serialize the new lazy start behind the previous owned-runtime stop
  // so the host's single live slot cannot be raced by a fast Send click.
  let runtimeHandoff: Promise<void> = Promise.resolve();
</script>

<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { host } from '../../host-api/client';
  import type { ExtensionUiResponse, ModelLite, PiUiComposerActionContribution, ProjectSummary, RuntimeCommand, RuntimeEventEnvelope, RuntimeState, SessionStateLite, SurfaceEvent, TimelineBlock } from '../../host-api/types';
  import ExtensionUiDialog from './ExtensionUiDialog.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import {
    applyEditorSuggestion,
    discardEditorSuggestion,
    dismissExtensionNotification,
    emptyExtensionUiViewState,
    reduceExtensionUiState,
    removeExtensionDialog,
  } from './extensionUiState';
  import { commandDraft, filterRuntimeCommands, runtimeCommandKey, runtimeCommandProvenance, slashCommandQuery } from './runtimeCommands';
  import { initialRuntimeSelection, rememberSessionRuntimePreference, runtimeSessionKey } from './runtimeSelection';
  import {
    SESSION_PERSISTENCE_FEEDBACK_DELAY_MS,
    didResolveNewSession,
    isPendingSessionPersistenceError,
    withoutPersistedLiveBlocks,
  } from './sessionPersistenceFeedback';

  export let projectId: string | undefined;
  export let sessionId: string | undefined;
  export let trusted: boolean;
  export let safeMode: boolean;
  export let personal: boolean = false;
  export let draft = '';
  export let projects: ProjectSummary[] = [];
  export let piUiComposerActions: PiUiComposerActionContribution[] = [];
  export let onNewChatProjectChange: (projectId: string | undefined) => void = () => {};
  export let onRequestTrust: (() => void) | undefined = undefined;
  export let onTurnCompleted: () => void | Promise<void> = () => {};
  // The catalog is eventually consistent with Pi's first session write. Let
  // the owner capture and hold pre-start rows before a new runtime can create
  // one; release that guard if startup/prompt submission cannot continue.
  export let onNewSessionStarting: () => void = () => {};
  export let onNewSessionStartAborted: () => void = () => {};
  export let onRetryPersistedSession: (() => void) | undefined = undefined;
  export let onBlocksChanged: (blocks: TimelineBlock[]) => void | Promise<void> = () => {};
  export let onCommandsChanged: (commands: RuntimeCommand[]) => void = () => {};

  type LiveKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error' | 'compaction';
  type LiveStatus = 'streaming' | 'complete' | 'failed' | 'interrupted';

  interface LiveBlock {
    id: string;
    kind: LiveKind;
    text: string;
    status: LiveStatus;
    toolName?: string;
    safeSummary?: string;
  }

  let phase: RuntimeState = 'dormant';
  let blocks: LiveBlock[] = [];
  let sendBusy = false;
  let startBusy = false;
  let abortBusy = false;
  let sessionPreferenceKey = runtimeSessionKey(personal, projectId, sessionId);
  const initialSelection = initialRuntimeSelection(
    sessionPreferenceKey,
    cachedSessionPreferences,
    cachedModelSelection,
    cachedModelSelectionExplicit,
    cachedThinkingSelection,
    cachedThinkingSelectionExplicit,
  );
  let models: ModelLite[] = [...cachedModels];
  let thinkingLevels: string[] = [...cachedThinkingLevels];
  let pendingModel: ModelLite | undefined = initialSelection.pendingModel;
  let pendingThinkingLevel: string | undefined = initialSelection.pendingThinkingLevel;
  let newChatDefaultModel: ModelLite | undefined = cachedModelSelection;
  let newChatDefaultThinkingLevel: string | undefined = cachedThinkingSelection;
  let rememberedModel: ModelLite | undefined = initialSelection.rememberedModel;
  let rememberedThinkingLevel: string | undefined = initialSelection.rememberedThinkingLevel;
  let sessionState: SessionStateLite | undefined;
  let queue: { steering: number; followUp: number } | undefined;
  let compactionActive = false;
  let error: string | undefined;
  let runtimeId: string | undefined;
  let runtimeOwned = false;
  let startupTask: Promise<boolean> | undefined;
  let settleTask: Promise<void> | undefined;
  let newSessionResolutionActive = false;
  let persistenceResolutionError: string | undefined;
  let persistenceFeedbackPending = false;
  let persistenceFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPersistedBlockIds: Set<string> | undefined;
  let observedSessionId = sessionId;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let composerTextarea: HTMLTextAreaElement | undefined;
  let publishFrame: number | undefined;
  let mounted = false;
  let runtimeCommands: RuntimeCommand[] = [];
  let slashCommandSelection = 0;
  let observedSlashDraft = '';
  let slashSuggestionsDismissed = false;
  let extensionUi = emptyExtensionUiViewState();
  let extensionUiRuntimeId: string | undefined;
  let observedExtensionDialogId: string | undefined;
  let extensionResponseBusy = false;
  let extensionResponseError: string | undefined;

  $: surfaceAvailable = !safeMode && (personal || projectId !== undefined);
  $: runtimeAllowed = personal || trusted;
  $: enabled = surfaceAvailable && runtimeAllowed;
  $: canSend = surfaceAvailable && !startBusy && !sendBusy && settleTask === undefined && draft.trim().length > 0;
  $: running = phase === 'running';
  $: effectiveModel = sessionState?.model
    ?? pendingModel
    ?? rememberedModel
    ?? (sessionPreferenceKey === undefined ? newChatDefaultModel : undefined)
    ?? models[0];
  $: effectiveThinkingLevel = sessionState?.thinkingLevel
    ?? pendingThinkingLevel
    ?? rememberedThinkingLevel
    ?? (sessionPreferenceKey === undefined ? newChatDefaultThinkingLevel : undefined)
    ?? thinkingLevels[0]
    ?? '';
  $: syncSessionPreferenceKey(personal, projectId, sessionId);
  $: reconcilePersistedSession(sessionId);
  $: slashQuery = slashCommandQuery(draft);
  $: if (draft !== observedSlashDraft) {
    observedSlashDraft = draft;
    slashCommandSelection = 0;
    slashSuggestionsDismissed = false;
  }
  $: slashCommands = slashQuery === undefined || slashSuggestionsDismissed
    ? []
    : filterRuntimeCommands(runtimeCommands, `/${slashQuery}`, 8);
  $: if (slashCommandSelection >= slashCommands.length) slashCommandSelection = 0;
  $: activePiUiComposerActions = piUiComposerActions
    .filter((action) => runtimeCommands.length === 0 || matchingExtensionCommands(action).length === 1)
    .slice(0, 3);
  $: activeExtensionDialog = extensionUi.dialogs[0];
  $: if (activeExtensionDialog?.id !== observedExtensionDialogId) {
    observedExtensionDialogId = activeExtensionDialog?.id;
    extensionResponseBusy = false;
    extensionResponseError = undefined;
  }
  $: if (phase === 'ready' && mounted) void focusComposer();

  onMount(() => {
    mounted = true;
  });

  onDestroy(() => {
    disposed = true;
    abandonNewSessionResolution();
    clearPersistenceFeedback();
    pendingPersistedBlockIds = undefined;
    if (publishFrame !== undefined) cancelAnimationFrame(publishFrame);
    publishFrame = undefined;
    void onBlocksChanged([]);
    onCommandsChanged([]);
    resetExtensionTitle();
    const predecessor = runtimeHandoff;
    const pendingStartup = startupTask;
    // Append instead of overwrite: an A → B → C switch must retain A's stop
    // even when B never owned a runtime. A startup already in flight is part
    // of the same barrier before this instance performs its final teardown.
    runtimeHandoff = predecessor
      .catch(() => undefined)
      .then(async () => {
        if (pendingStartup !== undefined) await pendingStartup.catch(() => false);
        await teardown(true);
      });
  });

  function start(continueSession: boolean): Promise<boolean> {
    if (!enabled || (!personal && projectId === undefined) || startBusy) return Promise.resolve(false);
    startBusy = true;
    const predecessor = runtimeHandoff;
    const task = startInternal(continueSession, predecessor);
    startupTask = task;
    void task.then(
      () => { if (startupTask === task) startupTask = undefined; },
      () => { if (startupTask === task) startupTask = undefined; },
    );
    return task;
  }

  async function startInternal(continueSession: boolean, predecessor: Promise<void>): Promise<boolean> {
    try {
      await predecessor;
      if (disposed) return false;
      if (runtimeOwned) await teardown(true);
      error = undefined;
      blocks = [];
      publishBlocks();
      phase = 'starting';
      // Subscribe before the host launches Pi: startup state/model events are
      // otherwise fast enough to be lost between `startRuntime` and `listen`.
      unlisten = await host.listenRuntimeEvents(handleEvent);
      const startSessionId = continueSession ? sessionId : undefined;
      const result = personal
        ? await host.startPersonalChat(startSessionId)
        : await host.startRuntime(projectId!, startSessionId);
      runtimeId = result.runtimeId;
      sessionState = result.sessionState;
      rememberCurrentSessionPreference(result.sessionState.model, result.sessionState.thinkingLevel);
      if (sessionPreferenceKey === undefined && pendingModel === undefined && result.sessionState.model !== undefined) {
        cachedModelSelection = result.sessionState.model;
        newChatDefaultModel = result.sessionState.model;
        cachedModelSelectionExplicit = false;
        persistCatalog();
      }
      if (sessionPreferenceKey === undefined && pendingThinkingLevel === undefined && result.sessionState.thinkingLevel.length > 0) {
        cachedThinkingSelection = result.sessionState.thinkingLevel;
        newChatDefaultThinkingLevel = result.sessionState.thinkingLevel;
        cachedThinkingSelectionExplicit = false;
        persistCatalog();
      }
      // A terminal state event can arrive before the invoke promise resolves.
      // Never overwrite that evidence with the stale start response or retain
      // a UI ownership flag for the host-retired runtime.
      if (runtimeHasFailed()) {
        runtimeOwned = false;
        unlisten?.();
        unlisten = undefined;
        return false;
      }
      runtimeOwned = true;
      phase = result.runtime.state;
      const [modelsResult, thinkingLevelsResult, commandsResult] = await Promise.allSettled([
        host.getRuntimeModels(result.runtimeId),
        host.getRuntimeThinkingLevels(result.runtimeId),
        host.getRuntimeCommands(result.runtimeId),
      ]);
      if (modelsResult.status === 'fulfilled') {
        models = modelsResult.value;
        cachedModels = [...modelsResult.value];
        persistCatalog();
      }
      if (thinkingLevelsResult.status === 'fulfilled') {
        thinkingLevels = thinkingLevelsResult.value;
        cachedThinkingLevels = [...thinkingLevelsResult.value];
        persistCatalog();
      }
      if (commandsResult.status === 'fulfilled') {
        runtimeCommands = commandsResult.value;
        onCommandsChanged([...runtimeCommands]);
      }
      // A terminal event can arrive while model metadata is loading. The host
      // has already retired that slot, so never report a stale successful start
      // to the pending Send action.
      if (runtimeHasFailed() || !runtimeOwned) return false;
      if (disposed) {
        await teardown(true);
        return false;
      }
      await applyPendingRuntimePreferences(result.runtimeId);
      return !runtimeHasFailed() && runtimeOwned;
    } catch (startError) {
      unlisten?.();
      unlisten = undefined;
      error = messageFor(startError);
      phase = 'failed';
      return false;
    } finally {
      startBusy = false;
    }
  }

  function clearPersistenceFeedback(): void {
    if (persistenceFeedbackTimer !== undefined) {
      clearTimeout(persistenceFeedbackTimer);
      persistenceFeedbackTimer = undefined;
    }
    persistenceResolutionError = undefined;
    persistenceFeedbackPending = false;
  }

  function schedulePersistenceFeedback(message: string): void {
    clearPersistenceFeedback();
    persistenceFeedbackTimer = setTimeout(() => {
      persistenceFeedbackTimer = undefined;
      if (!disposed && sessionId === undefined) {
        persistenceResolutionError = message;
        persistenceFeedbackPending = true;
      }
    }, SESSION_PERSISTENCE_FEEDBACK_DELAY_MS);
  }

  function reconcilePersistedSession(nextSessionId: string | undefined): void {
    const previousSessionId = observedSessionId;
    observedSessionId = nextSessionId;
    if (
      !didResolveNewSession(previousSessionId, nextSessionId)
      || (
        !newSessionResolutionActive
        && persistenceFeedbackTimer === undefined
        && persistenceResolutionError === undefined
        && pendingPersistedBlockIds === undefined
      )
    ) return;
    clearPersistenceFeedback();
    newSessionResolutionActive = false;
    if (pendingPersistedBlockIds !== undefined) {
      blocks = withoutPersistedLiveBlocks(blocks, pendingPersistedBlockIds);
      pendingPersistedBlockIds = undefined;
      publishBlocks();
    }
  }

  function trackPendingPersistedBlocks(blockIds: ReadonlySet<string>): void {
    pendingPersistedBlockIds ??= new Set<string>();
    for (const blockId of blockIds) pendingPersistedBlockIds.add(blockId);
  }

  function releasePendingPersistedBlocks(blockIds: ReadonlySet<string>): void {
    if (pendingPersistedBlockIds === undefined) return;
    for (const blockId of blockIds) pendingPersistedBlockIds.delete(blockId);
    if (pendingPersistedBlockIds.size === 0) pendingPersistedBlockIds = undefined;
  }

  function beginNewSessionResolution(): void {
    if (sessionId !== undefined || newSessionResolutionActive) return;
    newSessionResolutionActive = true;
    clearPersistenceFeedback();
    onNewSessionStarting();
  }

  function abandonNewSessionResolution(): void {
    if (!newSessionResolutionActive) return;
    newSessionResolutionActive = false;
    clearPersistenceFeedback();
    onNewSessionStartAborted();
  }

  async function send(): Promise<void> {
    if (!canSend) return;
    if (!runtimeAllowed) {
      onRequestTrust?.();
      return;
    }
    const text = draft;
    beginNewSessionResolution();
    sendBusy = true;
    try {
      if (runtimeId === undefined || (phase !== 'ready' && phase !== 'running')) {
        const continueSession = sessionId !== undefined;
        const started = await start(continueSession);
        if (!started || runtimeId === undefined) {
          abandonNewSessionResolution();
          return;
        }
      }
      if (!await applyPendingRuntimePreferences(runtimeId)) {
        abandonNewSessionResolution();
        return;
      }
      draft = '';
      // The host emits Pi's single atomic `prompt` command with follow-up
      // behavior, so this cannot lose a message if streaming settles between
      // this UI observation and Pi receiving it.
      await host.sendPrompt(runtimeId, text);
    } catch (sendError) {
      if (!disposed) {
        draft = text;
        error = messageFor(sendError);
      }
      abandonNewSessionResolution();
    } finally {
      sendBusy = false;
    }
  }

  async function steer(): Promise<void> {
    if (!running || draft.trim().length === 0 || runtimeId === undefined) return;
    const text = draft;
    draft = '';
    sendBusy = true;
    try {
      await host.sendSteer(runtimeId, text);
    } catch (steerError) {
      if (!disposed) {
        draft = text;
        error = messageFor(steerError);
      }
    } finally {
      sendBusy = false;
    }
  }

  async function abort(): Promise<void> {
    if (runtimeId === undefined || abortBusy) return;
    abortBusy = true;
    try {
      await host.abortRuntime(runtimeId);
    } catch (abortError) {
      error = messageFor(abortError);
    } finally {
      abortBusy = false;
    }
  }

  async function teardown(stopProcess: boolean): Promise<void> {
    const hadRuntime = runtimeOwned;
    unlisten?.();
    unlisten = undefined;
    if (stopProcess && hadRuntime && runtimeId !== undefined) {
      try {
        await host.stopLiveRuntime(runtimeId);
      } catch (stopError) {
        error = messageFor(stopError);
      }
    }
    runtimeOwned = false;
    phase = 'dormant';
    abortBusy = false;
    blocks = [];
    publishBlocks();
    models = [];
    thinkingLevels = [];
    sessionState = undefined;
    queue = undefined;
    compactionActive = false;
    clearRuntimeExtensionSurfaces();
    runtimeId = undefined;
  }

  function handleEvent(event: RuntimeEventEnvelope): void {
    if (runtimeId !== undefined && event.runtimeId !== runtimeId) return;
    if (personal) {
      if (event.scope !== 'personal') return;
    } else if (event.scope !== 'project' || projectId === undefined || event.projectId !== projectId) {
      return;
    }
    switch (event.kind) {
      case 'state': {
        const wasRunning = phase === 'running';
        phase = event.state;
        if (event.state === 'ready' && wasRunning) scheduleSettledProjection();
        if (event.state === 'failed') {
          if (event.safeSummary) error = event.safeSummary;
          // The host retires a terminally failed slot before emitting any more
          // data. Release the UI ownership too, so a user can start again
          // rather than being stranded behind a stale End button.
          runtimeOwned = false;
          abandonNewSessionResolution();
          clearRuntimeExtensionSurfaces();
          unlisten?.();
          unlisten = undefined;
        }
        break;
      }
      case 'stateSnapshot':
        sessionState = event.state;
        rememberCurrentSessionPreference(event.state.model, event.state.thinkingLevel);
        if (event.state.isStreaming) phase = 'running';
        else if (phase === 'running') {
          phase = 'ready';
          scheduleSettledProjection();
        }
        break;
      case 'modelsAvailable':
        models = event.models;
        break;
      case 'userMessage':
        upsert({ id: event.blockId, kind: 'user', text: event.text, status: 'complete' });
        break;
      case 'assistantTextStarted':
        upsert({ id: event.blockId, kind: 'assistant', text: '', status: 'streaming' });
        break;
      case 'assistantTextDelta':
        appendText(event.blockId, event.delta, 'assistant');
        break;
      case 'assistantMessageCompleted':
        finalizeBlock(event.blockId, event.isError, event.safeSummary);
        break;
      case 'thinkingStarted':
        upsert({ id: event.blockId, kind: 'thinking', text: '', status: 'streaming' });
        break;
      case 'thinkingDelta':
        appendText(event.blockId, event.delta, 'thinking');
        break;
      case 'toolStarted':
        upsert({ id: event.blockId, kind: 'tool', text: '', status: 'streaming', toolName: event.toolName, safeSummary: 'Running…' });
        break;
      case 'toolUpdated':
        updateBlock(event.blockId, { toolName: event.toolName, safeSummary: event.safeSummary ?? 'Working…' });
        break;
      case 'toolCompleted':
        updateBlock(event.blockId, {
          status: event.isError ? 'failed' : 'complete',
          toolName: event.toolName,
          safeSummary: event.safeSummary ?? (event.isError ? 'Tool reported an error.' : 'Tool completed.'),
        });
        break;
      case 'entryAppended':
        upsertEntry(event);
        break;
      case 'turnStarted':
        // The first delta already creates the assistant block; nothing to do.
        break;
      case 'turnCompleted':
        // `turn_end` is not an idle boundary: Pi may immediately dispatch a
        // retry, compaction, steering message, or queued follow-up. Reconcile
        // only when the documented `agent_settled` transition reaches Ready.
        break;
      case 'queueUpdate':
        queue = { steering: event.steering, followUp: event.followUp };
        if (event.steering === 0 && event.followUp === 0) queue = undefined;
        break;
      case 'compaction':
        compactionActive = event.active;
        if (event.active) {
          upsert({ id: `compaction-${Date.now()}`, kind: 'compaction', text: '', status: 'streaming', safeSummary: event.safeSummary ?? 'Compacting context…' });
        } else {
          for (let index = blocks.length - 1; index >= 0; index -= 1) {
            const block = blocks[index];
            if (block.kind === 'compaction' && block.status === 'streaming') {
              updateBlock(block.id, { status: 'complete', safeSummary: event.safeSummary ?? 'Context compacted.' });
              break;
            }
          }
        }
        break;
      case 'thinkingLevelChanged':
        if (sessionState) sessionState = { ...sessionState, thinkingLevel: event.level };
        rememberCurrentSessionPreference(sessionState?.model, event.level);
        break;
      case 'sessionInfoChanged':
        if (sessionState) sessionState = { ...sessionState, sessionName: event.name };
        break;
      case 'extensionUi': {
        extensionUiRuntimeId = event.runtimeId;
        const reduction = reduceExtensionUiState(extensionUi, event.action, draft);
        extensionUi = reduction.state;
        draft = reduction.draft;
        if (event.action.action === 'title') updateExtensionTitle(event.action.title);
        break;
      }
      case 'runtimeError':
        error = event.safeSummary;
        upsert({ id: `err-${Date.now()}`, kind: 'error', text: '', status: 'failed', safeSummary: event.safeSummary });
        break;
    }
  }

  function upsert(block: LiveBlock): void {
    const existing = blocks.find((item) => item.id === block.id);
    if (existing) {
      Object.assign(existing, block);
      blocks = blocks;
    } else {
      blocks = [...blocks, block];
    }
    publishBlocks();
  }

  function updateBlock(id: string, patch: Partial<LiveBlock>): void {
    const block = blocks.find((item) => item.id === id);
    if (block) Object.assign(block, patch);
    blocks = blocks;
    publishBlocks();
  }

  function appendText(id: string, delta: string, fallbackKind: LiveKind): void {
    const existing = blocks.find((item) => item.id === id);
    if (existing) {
      existing.text += delta;
      blocks = blocks;
      publishBlocks();
      return;
    }
    upsert({ id, kind: fallbackKind, text: delta, status: 'streaming' });
  }

  function publishBlocks(): void {
    if (disposed || publishFrame !== undefined) return;
    // Pi can emit token deltas faster than a WebView frame. Coalesce them so
    // Markdown parsing and layout happen at most once per paint.
    publishFrame = requestAnimationFrame(() => {
      publishFrame = undefined;
      if (!disposed) void onBlocksChanged(blocks.map(projectLiveBlock));
    });
  }

  function projectLiveBlock(block: LiveBlock): TimelineBlock {
    const kind: TimelineBlock['kind'] = block.kind === 'system' ? 'custom' : block.kind;
    return {
      id: `live:${block.id}`,
      kind,
      text: block.text || undefined,
      label: blockLabel(block),
      safeSummary: block.safeSummary,
      title: block.kind === 'tool' ? (block.toolName ? `${block.toolName}` : 'Tool activity') : undefined,
      toolName: block.toolName,
      collapsible: block.kind === 'tool' || block.kind === 'thinking' || block.kind === 'system',
      fallback: block.kind === 'system',
      status: block.status,
    };
  }

  function scheduleSettledProjection(): void {
    if (settleTask !== undefined || disposed) return;
    const task = settleCompletedTurn();
    settleTask = task;
    void task.finally(() => {
      if (settleTask === task) settleTask = undefined;
    });
  }

  async function settleCompletedTurn(): Promise<void> {
    const completedBlockIds = new Set(blocks.map((block) => block.id));
    const resolvingNewSession = newSessionResolutionActive && sessionId === undefined;
    if (resolvingNewSession) trackPendingPersistedBlocks(completedBlockIds);
    try {
      await onTurnCompleted();
      clearPersistenceFeedback();
      if (disposed) return;
      // A queued turn may begin while the persisted page is refreshing. Remove
      // only blocks that belonged to the completed turn; never erase newer
      // streaming evidence that arrived during that await.
      blocks = withoutPersistedLiveBlocks(blocks, completedBlockIds);
      releasePendingPersistedBlocks(completedBlockIds);
      publishBlocks();
    } catch (refreshError) {
      if (resolvingNewSession) {
        const message = messageFor(refreshError);
        if (isPendingSessionPersistenceError(refreshError)) schedulePersistenceFeedback(message);
        else {
          clearPersistenceFeedback();
          persistenceResolutionError = message;
          persistenceFeedbackPending = false;
        }
      } else {
        error = messageFor(refreshError);
      }
    } finally {
      newSessionResolutionActive = false;
    }
  }

  function finalizeBlock(id: string | undefined, isError: boolean, safeSummary: string | undefined): void {
    if (id !== undefined) {
      updateBlock(id, { status: isError ? 'failed' : 'complete', safeSummary });
      return;
    }
    // No explicit id: finalize the most recent streaming assistant block.
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.kind === 'assistant' && block.status === 'streaming') {
        updateBlock(block.id, { status: isError ? 'failed' : 'complete', safeSummary });
        break;
      }
    }
  }

  function upsertEntry(event: Extract<SurfaceEvent, { kind: 'entryAppended' }>): void {
    const kind: LiveKind = event.entryKind === 'compaction' ? 'compaction' : event.entryKind === 'thinking' ? 'thinking' : 'system';
    upsert({
      id: event.blockId,
      kind,
      text: event.text ?? '',
      status: 'complete',
      safeSummary: event.text ?? entryLabel(event.entryKind),
    });
  }

  function entryLabel(entryKind: string): string {
    switch (entryKind) {
      case 'compaction':
        return 'Context was compacted.';
      case 'thinking':
        return 'Thinking level changed.';
      case 'custom':
        return 'An extension recorded a custom entry.';
      default:
        return `A ${entryKind} session entry was recorded.`;
    }
  }

  // Kept as a function so TypeScript does not narrow phase across asynchronous
  // Tauri event delivery during startup.
  function runtimeHasFailed(): boolean {
    return phase === 'failed';
  }

  function messageFor(error: unknown): string {
    return error instanceof Error ? error.message : 'The host returned an unknown safe failure.';
  }

  function blockLabel(block: LiveBlock): string {
    switch (block.kind) {
      case 'user':
        return 'You';
      case 'assistant':
        return 'Pi';
      case 'thinking':
        return 'Reasoning';
      case 'tool':
        return block.toolName ? `Tool: ${block.toolName}` : 'Tool activity';
      case 'compaction':
        return 'Context compacted';
      case 'error':
        return 'Runtime notice';
      default:
        return 'Session event';
    }
  }

  async function applyPendingRuntimePreferences(targetRuntimeId: string): Promise<boolean> {
    try {
      const desiredModel = pendingModel;
      if (desiredModel !== undefined && (!sessionState?.model || modelKey(sessionState.model) !== modelKey(desiredModel))) {
        if (!models.some((candidate) => modelKey(candidate) === modelKey(desiredModel))) {
          error = 'The previously selected model is no longer available in Pi.';
          return false;
        }
        await host.setRuntimeModel(targetRuntimeId, desiredModel.provider, desiredModel.id);
        if (sessionState) sessionState = { ...sessionState, model: desiredModel };
        thinkingLevels = await host.getRuntimeThinkingLevels(targetRuntimeId);
        cachedThinkingLevels = [...thinkingLevels];
      }
      if (pendingThinkingLevel !== undefined && sessionState?.thinkingLevel !== pendingThinkingLevel) {
        if (!thinkingLevels.includes(pendingThinkingLevel)) {
          error = 'The previously selected thinking level is unavailable for this model.';
          return false;
        }
        await host.setRuntimeThinking(targetRuntimeId, pendingThinkingLevel);
        if (sessionState) sessionState = { ...sessionState, thinkingLevel: pendingThinkingLevel };
      }
      rememberCurrentSessionPreference(sessionState?.model, sessionState?.thinkingLevel);
      return true;
    } catch (preferenceError) {
      error = messageFor(preferenceError);
      return false;
    }
  }

  async function loadCatalogFromCurrentRuntime(): Promise<void> {
    if (!enabled) return;
    if (runtimeId === undefined || (phase !== 'ready' && phase !== 'running')) {
      await start(sessionId !== undefined);
      return;
    }
    const [modelsResult, thinkingLevelsResult, commandsResult] = await Promise.allSettled([
      host.getRuntimeModels(runtimeId),
      host.getRuntimeThinkingLevels(runtimeId),
      host.getRuntimeCommands(runtimeId),
    ]);
    if (modelsResult.status === 'fulfilled') {
      models = modelsResult.value;
      cachedModels = [...models];
    }
    if (thinkingLevelsResult.status === 'fulfilled') {
      thinkingLevels = thinkingLevelsResult.value;
      cachedThinkingLevels = [...thinkingLevels];
    }
    if (commandsResult.status === 'fulfilled') {
      runtimeCommands = commandsResult.value;
      onCommandsChanged([...runtimeCommands]);
    }
    if (modelsResult.status === 'fulfilled' || thinkingLevelsResult.status === 'fulfilled') {
      persistCatalog();
    }
    const requiredFailure = [modelsResult, thinkingLevelsResult]
      .find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (requiredFailure !== undefined) error = messageFor(requiredFailure.reason);
  }

  async function changeModel(model: ModelLite): Promise<void> {
    if (!models.some((candidate) => modelKey(candidate) === modelKey(model))) return;
    pendingModel = model;
    if (sessionPreferenceKey === undefined) {
      cachedModelSelection = model;
      newChatDefaultModel = model;
      cachedModelSelectionExplicit = true;
      persistCatalog();
    } else {
      rememberCurrentSessionPreference(model, sessionState?.thinkingLevel ?? pendingThinkingLevel ?? rememberedThinkingLevel);
    }
    if (runtimeId !== undefined) await applyPendingRuntimePreferences(runtimeId);
  }

  async function changeThinking(event: Event): Promise<void> {
    const level = (event.currentTarget as HTMLSelectElement).value;
    if (!thinkingLevels.includes(level)) return;
    pendingThinkingLevel = level;
    if (sessionPreferenceKey === undefined) {
      cachedThinkingSelection = level;
      newChatDefaultThinkingLevel = level;
      cachedThinkingSelectionExplicit = true;
      persistCatalog();
    } else {
      rememberCurrentSessionPreference(sessionState?.model ?? pendingModel ?? rememberedModel, level);
    }
    if (runtimeId !== undefined) await applyPendingRuntimePreferences(runtimeId);
  }

  async function focusComposer(): Promise<void> {
    await tick();
    if (!disposed && phase === 'ready') composerTextarea?.focus();
  }

  function modelKey(model: ModelLite): string {
    return `${model.provider}\u0000${model.id}`;
  }

  function syncSessionPreferenceKey(
    nextPersonal: boolean,
    nextProjectId: string | undefined,
    nextSessionId: string | undefined,
  ): void {
    const nextKey = runtimeSessionKey(nextPersonal, nextProjectId, nextSessionId);
    if (nextKey === sessionPreferenceKey) return;
    sessionPreferenceKey = nextKey;
    if (nextKey === undefined) return;
    if (sessionState !== undefined) {
      rememberCurrentSessionPreference(sessionState.model, sessionState.thinkingLevel);
      return;
    }
    const restored = initialRuntimeSelection(
      nextKey,
      cachedSessionPreferences,
      cachedModelSelection,
      cachedModelSelectionExplicit,
      cachedThinkingSelection,
      cachedThinkingSelectionExplicit,
    );
    rememberedModel = restored.rememberedModel;
    rememberedThinkingLevel = restored.rememberedThinkingLevel;
  }

  function rememberCurrentSessionPreference(model: ModelLite | undefined, thinkingLevel: string | undefined): void {
    if (sessionPreferenceKey === undefined || (model === undefined && thinkingLevel === undefined)) return;
    rememberedModel = model ?? rememberedModel;
    rememberedThinkingLevel = thinkingLevel ?? rememberedThinkingLevel;
    cachedSessionPreferences = rememberSessionRuntimePreference(cachedSessionPreferences, {
      key: sessionPreferenceKey,
      model: rememberedModel,
      thinkingLevel: rememberedThinkingLevel,
      updatedAt: Date.now(),
    });
    persistCatalog();
  }

  function changeNewChatProject(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    onNewChatProjectChange(value.length > 0 ? value : undefined);
  }

  async function respondToExtension(response: ExtensionUiResponse): Promise<void> {
    const request = activeExtensionDialog;
    const targetRuntimeId = extensionUiRuntimeId ?? runtimeId;
    if (request === undefined || targetRuntimeId === undefined || extensionResponseBusy) return;
    extensionResponseBusy = true;
    extensionResponseError = undefined;
    try {
      await host.respondExtensionUi(targetRuntimeId, request.id, response);
      extensionUi = removeExtensionDialog(extensionUi, request.id);
    } catch (responseError) {
      if (extensionUi.dialogs[0]?.id === request.id) {
        extensionResponseError = messageFor(responseError);
      }
    } finally {
      if (extensionUi.dialogs[0]?.id === request.id) extensionResponseBusy = false;
    }
  }

  function dismissNotification(notificationId: string): void {
    extensionUi = dismissExtensionNotification(extensionUi, notificationId);
  }

  function acceptEditorSuggestion(): void {
    const result = applyEditorSuggestion(extensionUi);
    extensionUi = result.state;
    draft = result.draft;
    void focusComposer();
  }

  function rejectEditorSuggestion(): void {
    extensionUi = discardEditorSuggestion(extensionUi);
  }

  function clearRuntimeExtensionSurfaces(): void {
    runtimeCommands = [];
    onCommandsChanged([]);
    extensionUi = emptyExtensionUiViewState();
    extensionUiRuntimeId = undefined;
    observedExtensionDialogId = undefined;
    extensionResponseBusy = false;
    extensionResponseError = undefined;
    resetExtensionTitle();
  }

  function selectRuntimeCommand(command: RuntimeCommand): void {
    draft = commandDraft(command);
    void focusComposer();
  }

  function matchingExtensionCommands(action: PiUiComposerActionContribution): RuntimeCommand[] {
    const sameName = runtimeCommands.filter((command) => command.name === action.commandName);
    return sameName.length === 1 && sameName[0]?.source === 'extension' ? sameName : [];
  }

  async function ensureRuntimeCommandCatalog(): Promise<boolean> {
    if (runtimeCommands.length > 0) return true;
    if (runtimeId === undefined || (phase !== 'ready' && phase !== 'running')) {
      if (!await start(sessionId !== undefined)) return false;
    } else {
      try {
        runtimeCommands = await host.getRuntimeCommands(runtimeId);
        onCommandsChanged([...runtimeCommands]);
      } catch (commandError) {
        error = messageFor(commandError);
        return false;
      }
    }
    if (runtimeCommands.length === 0) {
      error = 'No Pi extension commands are available in the active runtime.';
      return false;
    }
    return true;
  }

  async function selectPiUiComposerAction(action: PiUiComposerActionContribution): Promise<void> {
    if (!enabled || draft.trim().length > 0) return;
    if (!await ensureRuntimeCommandCatalog()) return;
    if (draft.trim().length > 0) return;
    if (matchingExtensionCommands(action).length !== 1) {
      error = 'This extension command is unavailable or ambiguous in the active Pi runtime.';
      return;
    }
    draft = `/${action.commandName} `;
    await focusComposer();
  }

  function updateExtensionTitle(title: string): void {
    if (typeof document === 'undefined') return;
    document.title = title.length > 0 ? `${title} — PiUI` : 'PiUI';
  }

  function resetExtensionTitle(): void {
    if (typeof document !== 'undefined') document.title = 'PiUI';
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (canSend) void send();
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (slashCommands.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        slashCommandSelection = (slashCommandSelection + direction + slashCommands.length) % slashCommands.length;
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        const command = slashCommands[slashCommandSelection];
        if (command !== undefined) selectRuntimeCommand(command);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        slashSuggestionsDismissed = true;
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (canSend) void send();
  }

  function submitOrAbort(): void {
    if (running) void abort();
    else void send();
  }
</script>

<section class="chat-panel" aria-label="Live Pi conversation">
  {#if !surfaceAvailable}
    <div class="chat-notice"><p>Safe mode is on. Runtime actions are disabled.</p></div>
  {:else}
    {#if !runtimeAllowed}
      <div class="chat-trust-note" role="status">
        <span>Trust this project before Pi can read files or run tools.</span>
        {#if onRequestTrust}<button type="button" onclick={onRequestTrust}>Review trust</button>{/if}
      </div>
    {/if}
    {#if persistenceResolutionError && persistenceFeedbackPending}
      <div class="chat-sync-banner" role="status">
        <span><span class="sync-dot" aria-hidden="true"></span>Finishing history sync…</span>
        {#if onRetryPersistedSession}<button type="button" onclick={onRetryPersistedSession}>Try again</button>{/if}
        <button type="button" class="sync-dismiss" aria-label="Hide history sync status" onclick={clearPersistenceFeedback}>×</button>
      </div>
    {:else if persistenceResolutionError}
      <div class="chat-error-banner" role="alert">{persistenceResolutionError}<button type="button" onclick={clearPersistenceFeedback}>Dismiss</button></div>
    {:else if error}
      <div class="chat-error-banner" role="alert">{error}<button type="button" onclick={() => (error = undefined)}>Dismiss</button></div>
    {/if}
    {#if compactionActive}<div class="chat-compaction-banner" role="status">Pi is compacting the context…</div>{/if}

    {#if extensionUi.notifications.length > 0}
      <div class="extension-notifications" aria-live="polite" aria-label="Extension notifications">
        {#each extensionUi.notifications as notification (notification.id)}
          <div class={`extension-notification extension-notification--${notification.level}`} role={notification.level === 'error' ? 'alert' : 'status'}>
            <span>{notification.message}</span>
            <button type="button" aria-label="Dismiss extension notification" onclick={() => dismissNotification(notification.id)}>Dismiss</button>
          </div>
        {/each}
      </div>
    {/if}

    {#if extensionUi.statuses.length > 0}
      <div class="extension-statuses" aria-label="Extension status">
        {#each extensionUi.statuses as status (status.key)}<span>{status.text}</span>{/each}
      </div>
    {/if}

    {#each extensionUi.widgets.filter((widget) => widget.placement === 'aboveEditor') as widget (widget.key)}
      <aside class="extension-widget" aria-label="Extension widget">
        {#each widget.lines as line}<p>{line}</p>{/each}
      </aside>
    {/each}

    {#if extensionUi.editorSuggestion !== undefined}
      <div class="extension-draft-suggestion" role="status">
        <span>An extension prepared composer text. Your current draft was not overwritten.</span>
        <button type="button" onclick={rejectEditorSuggestion}>Discard</button>
        <button type="button" class="extension-draft-apply" onclick={acceptEditorSuggestion}>Replace draft</button>
      </div>
    {/if}

    <form class="composer" onsubmit={onSubmit}>
      {#if activePiUiComposerActions.length > 0}
        <div class="piui-composer-actions" aria-label="Extension composer actions">
          <span class="piui-composer-actions-label">Extensions</span>
          {#each activePiUiComposerActions as action (action.id)}
            <button
              type="button"
              title={action.description ?? `${action.title} — ${action.extensionName}`}
              aria-label={`${action.title} from ${action.extensionName}`}
              disabled={!enabled || draft.trim().length > 0 || startBusy || sendBusy}
              onclick={() => void selectPiUiComposerAction(action)}
            >
              <span aria-hidden="true">↗</span>
              {action.title}
            </button>
          {/each}
        </div>
      {/if}
      {#if slashCommands.length > 0}
        <div id="pi-command-suggestions" class="slash-command-menu" role="listbox" aria-label="Pi commands">
          {#each slashCommands as command, index (runtimeCommandKey(command))}
            <button
              id={`pi-command-suggestion-${index}`}
              type="button"
              role="option"
              aria-selected={index === slashCommandSelection}
              tabindex="-1"
              onclick={() => selectRuntimeCommand(command)}
            >
              <span class="slash-command-name">/{command.name}</span>
              {#if command.description}<span class="slash-command-description">{command.description}</span>{/if}
              <span class="slash-command-source">{runtimeCommandProvenance(command)}</span>
            </button>
          {/each}
        </div>
      {/if}
      <label class="visually-hidden" for="chat-draft">Message</label>
      <textarea
        id="chat-draft"
        bind:this={composerTextarea}
        bind:value={draft}
        rows="2"
        placeholder={running ? 'Queue a follow-up with Enter, or steer below' : 'Message Pi…'}
        aria-autocomplete="list"
        aria-controls={slashCommands.length > 0 ? 'pi-command-suggestions' : undefined}
        aria-activedescendant={slashCommands.length > 0 ? `pi-command-suggestion-${slashCommandSelection}` : undefined}
        onkeydown={handleComposerKeydown}
      ></textarea>
      <div class="composer-footer">
        <div class="composer-options" aria-label="Runtime options">
          {#if sessionId === undefined}
            <div class="composer-picker">
              <span class="picker-label">Project</span>
              <select aria-label="Project" value={personal ? '' : projectId ?? ''} onchange={changeNewChatProject} disabled={startBusy || sendBusy || running}>
                <option value="">No project</option>
                {#each projects as project}
                  <option value={project.id} disabled={project.missing}>{project.name}{project.missing ? ' — unavailable' : ''}</option>
                {/each}
              </select>
            </div>
          {/if}
          <div class="composer-picker">
            <span class="picker-label">Model</span>
            {#if models.length === 0}
              <button type="button" class="catalog-load" onclick={() => void loadCatalogFromCurrentRuntime()} disabled={startBusy} aria-label="Load available models from Pi">{startBusy ? 'Loading models…' : 'Load models…'}</button>
            {:else}
              <ModelPicker
                {models}
                currentModel={effectiveModel}
                disabled={startBusy}
                onSelect={(model) => void changeModel(model)}
              />
            {/if}
          </div>
          <div class="composer-picker">
            <span class="picker-label">Thinking</span>
            {#if thinkingLevels.length === 0}
              <button type="button" class="catalog-load" onclick={() => void loadCatalogFromCurrentRuntime()} disabled={startBusy} aria-label="Load thinking levels from Pi">{startBusy ? 'Loading…' : 'Load thinking…'}</button>
            {:else}
              <select aria-label="Thinking" value={effectiveThinkingLevel} onchange={(event) => void changeThinking(event)} disabled={startBusy}>
                {#each thinkingLevels as level}<option value={level}>{level}</option>{/each}
              </select>
            {/if}
          </div>
          {#if queue}
            <span class="composer-runtime-state">{queue.steering} steer / {queue.followUp} queued</span>
          {/if}
        </div>
        <div class="composer-actions">
          {#if running && draft.trim().length > 0}
            <button type="button" class="composer-steer" onclick={() => void steer()} disabled={!canSend}>{sendBusy ? 'Sending…' : 'Steer'}</button>
          {/if}
          <button
            type="button"
            class="composer-submit"
            class:composer-submit--stop={running}
            onclick={submitOrAbort}
            disabled={running ? abortBusy : !canSend}
            aria-label={running ? 'Stop current turn' : 'Send message'}
            title={running ? 'Stop current turn' : 'Send message'}
          >
            {#if running}
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
            {:else}
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V6M7.5 10.5 12 6l4.5 4.5"/></svg>
            {/if}
          </button>
        </div>
      </div>
    </form>

    {#each extensionUi.widgets.filter((widget) => widget.placement === 'belowEditor') as widget (widget.key)}
      <aside class="extension-widget extension-widget--below" aria-label="Extension widget">
        {#each widget.lines as line}<p>{line}</p>{/each}
      </aside>
    {/each}
  {/if}
</section>

{#if activeExtensionDialog !== undefined}
  <ExtensionUiDialog
    request={activeExtensionDialog}
    busy={extensionResponseBusy}
    error={extensionResponseError}
    onRespond={(response) => void respondToExtension(response)}
  />
{/if}

<style>
  .chat-panel { display: flex; flex-direction: column; width: min(100%, var(--piui-chat-column-width)); gap: var(--piui-space-3); margin: 0 auto var(--piui-space-4); padding: 0 var(--piui-chat-inline-padding); }
  .chat-notice { padding: var(--piui-space-4); border: 1px dashed var(--piui-border); border-radius: var(--piui-radius-md); background: var(--piui-surface-1); color: var(--piui-text-muted); font-size: 12px; }
  .chat-notice p { margin: 0; }
  .chat-trust-note { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-3); color: var(--piui-warning); font-size: 11px; }
  .chat-trust-note button { flex: 0 0 auto; min-height: 28px; padding: 0 var(--piui-space-2); border: 1px solid var(--piui-warning-border); border-radius: 8px; background: transparent; color: inherit; font-size: 11px; font-weight: 700; }
  .chat-trust-note button:hover { background: var(--piui-surface-2); color: var(--piui-text); }
  .extension-notifications { position: fixed; top: 18px; right: 18px; z-index: 24; display: grid; width: min(380px, calc(100vw - 36px)); gap: 8px; pointer-events: none; }
  .extension-notification { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: var(--piui-space-3); padding: 11px 12px; border: 1px solid var(--piui-border); border-left-width: 3px; border-radius: 10px; background: var(--piui-bg-raised); color: var(--piui-text); box-shadow: 0 16px 44px rgba(0, 0, 0, .24); font-size: 12px; line-height: 1.45; pointer-events: auto; }
  .extension-notification--info { border-left-color: var(--piui-accent); }
  .extension-notification--warning { border-left-color: var(--piui-warning); }
  .extension-notification--error { border-left-color: var(--piui-danger); }
  .extension-notification span { overflow-wrap: anywhere; white-space: pre-wrap; }
  .extension-notification button { background: transparent; color: var(--piui-text-muted); font-size: 11px; text-decoration: underline; }
  .extension-statuses { display: flex; flex-wrap: wrap; gap: 6px; min-height: 20px; color: var(--piui-text-muted); font-size: 10px; }
  .extension-statuses span { padding: 3px 7px; border: 1px solid var(--piui-border); border-radius: 999px; background: var(--piui-surface-1); }
  .extension-widget { padding: 9px 0 9px var(--piui-space-3); border-left: 2px solid var(--piui-border-strong); color: var(--piui-text-muted); font-size: 11px; line-height: 1.45; }
  .extension-widget--below { margin-top: -4px; }
  .extension-widget p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .extension-draft-suggestion { display: flex; align-items: center; gap: var(--piui-space-2); padding: 7px 0; border-top: 1px solid var(--piui-border); border-bottom: 1px solid var(--piui-border); color: var(--piui-text-muted); font-size: 11px; }
  .extension-draft-suggestion span { min-width: 0; margin-right: auto; }
  .extension-draft-suggestion button { flex: 0 0 auto; min-height: 28px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--piui-text-muted); font-size: 11px; font-weight: 700; }
  .extension-draft-suggestion .extension-draft-apply { background: var(--piui-accent); color: var(--piui-accent-ink); }
  .chat-sync-banner { display: flex; align-items: center; gap: var(--piui-space-2); min-height: 32px; padding: 5px 7px 5px 10px; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text-muted); font-size: 11px; }
  .chat-sync-banner > span { display: inline-flex; align-items: center; gap: 8px; margin-right: auto; }
  .sync-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--piui-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--piui-accent) 12%, transparent); }
  .chat-sync-banner button { min-height: 24px; padding: 0 6px; border-radius: 6px; background: transparent; color: var(--piui-text-muted); font-size: 10px; font-weight: 700; }
  .chat-sync-banner button:hover { background: var(--piui-surface-2); color: var(--piui-text); }
  .chat-sync-banner .sync-dismiss { width: 24px; padding: 0; font-size: 16px; font-weight: 500; line-height: 1; }
  .chat-error-banner { display: flex; align-items: baseline; gap: var(--piui-space-2); padding: 8px var(--piui-space-3); border: 1px solid var(--piui-danger-border); border-radius: var(--piui-radius-sm); background: var(--piui-danger-surface); color: var(--piui-danger-text); font-size: 12px; }
  .chat-error-banner button { margin-left: auto; background: transparent; color: inherit; text-decoration: underline; }
  .chat-compaction-banner { padding: 6px var(--piui-space-3); border-radius: var(--piui-radius-sm); background: var(--piui-warning-surface); color: var(--piui-warning-text); font-size: 12px; }
  .composer { position: relative; display: flex; flex-direction: column; gap: var(--piui-space-2); padding: 14px 16px 10px; border: 1px solid var(--piui-border); border-radius: 24px; background: var(--piui-surface-2); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--piui-text) 4%, transparent); }
  .piui-composer-actions { display: flex; align-items: center; gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .piui-composer-actions::-webkit-scrollbar { display: none; }
  .piui-composer-actions-label { flex: 0 0 auto; color: var(--piui-text-faint); font-size: 9px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  .piui-composer-actions button { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; min-height: 26px; padding: 0 8px; border: 1px solid var(--piui-border); border-radius: 8px; background: transparent; color: var(--piui-text-muted); font-size: 10px; font-weight: 700; }
  .piui-composer-actions button:hover:not(:disabled), .piui-composer-actions button:focus-visible { border-color: color-mix(in srgb, var(--piui-accent) 45%, var(--piui-border)); color: var(--piui-text); }
  .piui-composer-actions button:disabled { cursor: not-allowed; opacity: .42; }
  .slash-command-menu { position: absolute; right: 0; bottom: calc(100% + 8px); left: 0; z-index: 8; max-height: 280px; overflow: auto; border: 1px solid var(--piui-border); border-radius: 14px; background: var(--piui-bg-raised); box-shadow: 0 18px 50px rgba(0, 0, 0, .28); }
  .slash-command-menu button { display: grid; grid-template-columns: minmax(120px, .7fr) minmax(0, 1.3fr) auto; align-items: center; gap: var(--piui-space-3); width: 100%; min-height: 40px; padding: 8px 11px; border-bottom: 1px solid var(--piui-border); background: transparent; color: var(--piui-text); text-align: left; }
  .slash-command-menu button:last-child { border-bottom: 0; }
  .slash-command-menu button:hover, .slash-command-menu button:focus-visible, .slash-command-menu button[aria-selected="true"] { background: var(--piui-surface-2); }
  .slash-command-name { overflow: hidden; font-family: var(--piui-font-mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .slash-command-description { overflow: hidden; color: var(--piui-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .slash-command-source { color: var(--piui-text-faint); font-size: 9px; letter-spacing: .06em; text-transform: uppercase; }
  .composer:focus-within { border-color: color-mix(in srgb, var(--piui-accent) 58%, var(--piui-border)); }
  .composer textarea { width: 100%; resize: vertical; min-height: 64px; max-height: 160px; padding: 0; border: 0; background: transparent; color: var(--piui-text); font-size: var(--piui-chat-composer-font-size); line-height: 1.5; outline: 0; }
  .composer textarea::placeholder { color: var(--piui-text-faint); }
  .composer-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-3); min-width: 0; }
  .composer-options, .composer-actions { display: flex; align-items: center; gap: var(--piui-space-2); min-width: 0; }
  .composer-options { flex: 1 1 auto; overflow: visible; }
  .composer-picker { display: flex; align-items: center; min-width: 0; color: var(--piui-text-muted); font-size: 11px; font-weight: 700; }
  .composer-picker > .picker-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  .composer-picker select, .catalog-load { min-width: 0; max-width: 182px; height: 28px; padding: 0 22px 0 8px; border: 0; border-radius: 8px; background: color-mix(in srgb, var(--piui-text) 6%, transparent); color: var(--piui-text-muted); font-size: 11px; font-weight: 650; text-overflow: ellipsis; }
  .catalog-load { padding-right: 8px; }
  .composer-picker select:focus-visible { outline-offset: 1px; }
  .composer-picker select option { background: var(--piui-bg-raised); color: var(--piui-text); }
  .composer-runtime-state { display: inline-flex; align-items: center; gap: 6px; overflow: hidden; color: var(--piui-text-faint); font-size: 10px; font-weight: 650; white-space: nowrap; }
  .composer-actions { flex: 0 0 auto; }
  .composer-steer { min-height: 30px; padding: 0 9px; border: 0; border-radius: 8px; background: transparent; color: var(--piui-warning); font-size: 11px; font-weight: 700; }
  .composer-steer:hover:not(:disabled) { background: rgba(255, 255, 255, .055); color: var(--piui-text); }
  .composer-submit { display: inline-grid; width: 40px; height: 40px; place-items: center; flex: 0 0 auto; border: 0; border-radius: 50%; background: var(--piui-accent); color: var(--piui-accent-ink); transition: transform 140ms ease, background 140ms ease, opacity 140ms ease; }
  .composer-submit:hover:not(:disabled) { transform: translateY(-1px); background: #b2cf97; }
  .composer-submit:active:not(:disabled) { transform: translateY(0) scale(.96); }
  .composer-submit:disabled { cursor: not-allowed; opacity: .38; }
  .composer-submit--stop { background: #e8eadf; color: #252824; }
  .composer-submit--stop:hover:not(:disabled) { background: #f4f5ee; }
  .composer-submit svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .composer-submit--stop svg { fill: currentColor; stroke: none; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 700px) { .chat-panel { width: 100%; margin-bottom: var(--piui-space-3); padding-right: 14px; padding-left: 14px; }.extension-notifications { top: 10px; right: 10px; width: calc(100vw - 20px); }.extension-draft-suggestion { align-items: flex-start; flex-wrap: wrap; }.extension-draft-suggestion span { flex-basis: 100%; }.composer { border-radius: 20px; }.slash-command-menu button { grid-template-columns: minmax(100px, .8fr) minmax(0, 1.2fr); }.slash-command-source { display: none; }.composer-options { gap: 4px; }.composer-picker select { max-width: 112px; }.composer-runtime-state { display: none; }.composer-steer { padding: 0 6px; } }
</style>
