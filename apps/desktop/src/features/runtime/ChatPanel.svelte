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
  import type { ModelLite, ProjectSummary, RuntimeEventEnvelope, RuntimeState, SessionStateLite, SurfaceEvent, TimelineBlock } from '../../host-api/types';
  import { initialRuntimeSelection, rememberSessionRuntimePreference, runtimeSessionKey } from './runtimeSelection';

  export let projectId: string | undefined;
  export let sessionId: string | undefined;
  export let trusted: boolean;
  export let safeMode: boolean;
  export let personal: boolean = false;
  export let draft = '';
  export let projects: ProjectSummary[] = [];
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
  let persistedSessionResolutionFailed = false;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let composerTextarea: HTMLTextAreaElement | undefined;
  let publishFrame: number | undefined;
  let mounted = false;

  $: surfaceAvailable = !safeMode && (personal || projectId !== undefined);
  $: runtimeAllowed = personal || trusted;
  $: enabled = surfaceAvailable && runtimeAllowed;
  $: canSend = surfaceAvailable && !startBusy && !sendBusy && settleTask === undefined && draft.trim().length > 0;
  $: running = phase === 'running';
  $: syncSessionPreferenceKey(personal, projectId, sessionId);
  $: if (phase === 'ready' && mounted) void focusComposer();

  onMount(() => {
    mounted = true;
  });

  onDestroy(() => {
    disposed = true;
    abandonNewSessionResolution();
    if (publishFrame !== undefined) cancelAnimationFrame(publishFrame);
    publishFrame = undefined;
    void onBlocksChanged([]);
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
        cachedModelSelectionExplicit = false;
        persistCatalog();
      }
      if (sessionPreferenceKey === undefined && pendingThinkingLevel === undefined && result.sessionState.thinkingLevel.length > 0) {
        cachedThinkingSelection = result.sessionState.thinkingLevel;
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
      const [modelsResult, thinkingLevelsResult] = await Promise.allSettled([
        host.getRuntimeModels(result.runtimeId),
        host.getRuntimeThinkingLevels(result.runtimeId),
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

  function beginNewSessionResolution(): void {
    if (sessionId !== undefined || newSessionResolutionActive) return;
    newSessionResolutionActive = true;
    persistedSessionResolutionFailed = false;
    onNewSessionStarting();
  }

  function abandonNewSessionResolution(): void {
    if (!newSessionResolutionActive) return;
    newSessionResolutionActive = false;
    persistedSessionResolutionFailed = false;
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
      case 'extensionUiRequest':
        upsert({ id: `ext-${event.id}`, kind: 'system', text: '', status: 'complete', safeSummary: event.safeSummary ?? `Extension request: ${event.method}` });
        break;
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
    try {
      await onTurnCompleted();
      persistedSessionResolutionFailed = false;
      if (disposed) return;
      // A queued turn may begin while the persisted page is refreshing. Remove
      // only blocks that belonged to the completed turn; never erase newer
      // streaming evidence that arrived during that await.
      blocks = blocks.filter((block) => !completedBlockIds.has(block.id));
      publishBlocks();
    } catch (refreshError) {
      persistedSessionResolutionFailed = newSessionResolutionActive;
      error = messageFor(refreshError);
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
    try {
      models = await host.getRuntimeModels(runtimeId);
      thinkingLevels = await host.getRuntimeThinkingLevels(runtimeId);
      cachedModels = [...models];
      cachedThinkingLevels = [...thinkingLevels];
      persistCatalog();
    } catch (catalogError) {
      error = messageFor(catalogError);
    }
  }

  async function changeModel(event: Event): Promise<void> {
    const value = (event.currentTarget as HTMLSelectElement).value;
    const parts = value.split('\u0000');
    if (parts.length !== 2) return;
    const [provider, id] = parts;
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === id);
    if (model === undefined) return;
    pendingModel = model;
    if (sessionPreferenceKey === undefined) {
      cachedModelSelection = model;
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

  function selectedModelKey(): string {
    const newChatDefault = sessionPreferenceKey === undefined ? cachedModelSelection : undefined;
    const model = sessionState?.model ?? pendingModel ?? rememberedModel ?? newChatDefault ?? models[0];
    return model === undefined ? '' : modelKey(model);
  }

  function selectedThinkingLevel(): string {
    const newChatDefault = sessionPreferenceKey === undefined ? cachedThinkingSelection : undefined;
    return sessionState?.thinkingLevel
      ?? pendingThinkingLevel
      ?? rememberedThinkingLevel
      ?? newChatDefault
      ?? thinkingLevels[0]
      ?? '';
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

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (canSend) void send();
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
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
    {#if error}<div class="chat-error-banner" role="alert">{error}{#if persistedSessionResolutionFailed && onRetryPersistedSession}<button type="button" onclick={onRetryPersistedSession}>Retry discovery</button>{/if}<button type="button" onclick={() => (error = undefined)}>Dismiss</button></div>{/if}
    {#if compactionActive}<div class="chat-compaction-banner" role="status">Pi is compacting the context…</div>{/if}

    {#if personal}<p class="chat-personal-note">No user folder is attached. Pi persists this chat after its first assistant response.</p>{/if}

    <form class="composer" onsubmit={onSubmit}>
      <label class="visually-hidden" for="chat-draft">Message</label>
      <textarea id="chat-draft" bind:this={composerTextarea} bind:value={draft} rows="2" placeholder={running ? 'Queue a follow-up with Enter, or steer below' : 'Message Pi…'} onkeydown={handleComposerKeydown}></textarea>
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
              <select aria-label="Model" value={selectedModelKey()} onchange={(event) => void changeModel(event)} disabled={startBusy}>
                {#each models as model}
                  <option value={modelKey(model)}>{model.provider}/{model.id}{model.label ? ` — ${model.label}` : ''}</option>
                {/each}
              </select>
            {/if}
          </div>
          <div class="composer-picker">
            <span class="picker-label">Thinking</span>
            {#if thinkingLevels.length === 0}
              <button type="button" class="catalog-load" onclick={() => void loadCatalogFromCurrentRuntime()} disabled={startBusy} aria-label="Load thinking levels from Pi">{startBusy ? 'Loading…' : 'Load thinking…'}</button>
            {:else}
              <select aria-label="Thinking" value={selectedThinkingLevel()} onchange={(event) => void changeThinking(event)} disabled={startBusy}>
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
  {/if}
</section>

<style>
  .chat-panel { display: flex; flex-direction: column; width: min(100%, var(--piui-chat-column-width)); gap: var(--piui-space-3); margin: 0 auto var(--piui-space-4); padding: 0 var(--piui-chat-inline-padding); }
  .chat-notice { padding: var(--piui-space-4); border: 1px dashed var(--piui-border); border-radius: var(--piui-radius-md); background: var(--piui-surface-1); color: var(--piui-text-muted); font-size: 12px; }
  .chat-notice p { margin: 0; }
  .chat-trust-note { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-3); color: var(--piui-warning); font-size: 11px; }
  .chat-trust-note button { flex: 0 0 auto; min-height: 28px; padding: 0 var(--piui-space-2); border: 1px solid var(--piui-warning-border); border-radius: 8px; background: transparent; color: inherit; font-size: 11px; font-weight: 700; }
  .chat-trust-note button:hover { background: var(--piui-surface-2); color: var(--piui-text); }
  .chat-personal-note { margin: 0; color: var(--piui-text-muted); font-size: 12px; line-height: 1.45; }
  .chat-error-banner { display: flex; align-items: baseline; gap: var(--piui-space-2); padding: 8px var(--piui-space-3); border: 1px solid var(--piui-danger-border); border-radius: var(--piui-radius-sm); background: var(--piui-danger-surface); color: var(--piui-danger-text); font-size: 12px; }
  .chat-error-banner button { margin-left: auto; background: transparent; color: inherit; text-decoration: underline; }
  .chat-compaction-banner { padding: 6px var(--piui-space-3); border-radius: var(--piui-radius-sm); background: var(--piui-warning-surface); color: var(--piui-warning-text); font-size: 12px; }
  .composer { display: flex; flex-direction: column; gap: var(--piui-space-2); padding: 14px 16px 10px; border: 1px solid var(--piui-border); border-radius: 24px; background: var(--piui-surface-2); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--piui-text) 4%, transparent); }
  .composer:focus-within { border-color: color-mix(in srgb, var(--piui-accent) 58%, var(--piui-border)); }
  .composer textarea { width: 100%; resize: vertical; min-height: 64px; max-height: 160px; padding: 0; border: 0; background: transparent; color: var(--piui-text); font-size: var(--piui-chat-composer-font-size); line-height: 1.5; outline: 0; }
  .composer textarea::placeholder { color: var(--piui-text-faint); }
  .composer-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-3); min-width: 0; }
  .composer-options, .composer-actions { display: flex; align-items: center; gap: var(--piui-space-2); min-width: 0; }
  .composer-options { flex: 1 1 auto; overflow: hidden; }
  .composer-picker { display: flex; align-items: center; min-width: 0; color: var(--piui-text-muted); font-size: 11px; font-weight: 700; }
  .composer-picker > .picker-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  .composer-picker select, .catalog-load { min-width: 0; max-width: 182px; height: 28px; padding: 0 22px 0 8px; border: 0; border-radius: 8px; background: color-mix(in srgb, var(--piui-text) 6%, transparent); color: var(--piui-text-muted); font-size: 11px; font-weight: 650; text-overflow: ellipsis; }
  .catalog-load { padding-right: 8px; }
  .composer-picker select:focus-visible { outline-offset: 1px; }
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
  @media (max-width: 700px) { .chat-panel { width: 100%; margin-bottom: var(--piui-space-3); padding-right: 14px; padding-left: 14px; }.composer { border-radius: 20px; }.composer-options { gap: 4px; }.composer-picker select { max-width: 112px; }.composer-runtime-state { display: none; }.composer-steer { padding: 0 6px; } }
</style>