<script module lang="ts">
  import { SvelteMap } from 'svelte/reactivity';

  const operations = new SvelteMap<string, 'send' | 'settings'>();
</script>

<script lang="ts">
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import X from '@lucide/svelte/icons/x';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Square from '@lucide/svelte/icons/square';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Check from '@lucide/svelte/icons/check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Brain from '@lucide/svelte/icons/brain';
  import Zap from '@lucide/svelte/icons/zap';
  import { tick, untrack } from 'svelte';
  import { t } from '../../../features/locale/language';
  import MarkdownContent from '../../../components/MarkdownContent.svelte';
  import { graphToSystemFile } from '../../../features/orchestration/systemFile';
  import { composerRequest } from '../../../host-api/composerClient';
  import { workspaceModel } from '../../../host-api/harnessModels';
  import { runtimeSettings } from '../../../host-api/runtimeSettings';
  import type { RuntimeSettings, RuntimeSettingsCommand } from '../../../../../../contracts/workspace-settings-v16';
  import type { HarnessKind } from '../../../../../../contracts/workspace-v15';
  import { Button, IconButton, Picker, Spinner, Textarea, toasts, type PickerItem } from '../../../lib/ui';
  import ApprovalCard from '../../shell/ApprovalCard.svelte';
  import ModelPicker, { type ModelOption } from '../../shell/ModelPicker.svelte';
  import { modelSelectionKey as keyOf, resolveModelSelection } from '../../../host-api/modelSelection';
  import HarnessMark from '../../shell/HarnessMark.svelte';
  import { useWorkspace } from '../../shell/context';
  import { errorMessage } from '../../workspaceStore.svelte';
  import { nanoAccount } from '../../nano/nanoAccount.svelte';
  import { harnessMeta } from '../../harnessMeta';
  import type { PipelineEditorStore } from '../editorStore.svelte';
  import { applyProposal, builderEnvelope, isEmptyChange, readProposal, stripEnvelope, summarizeChange, type HarnessChoice } from './builderPrompt';

  interface Props {
    editor: PipelineEditorStore;
    workspaceId: string;
    onClose: () => void;
  }
  let { editor, workspaceId, onClose }: Props = $props();
  const store = useWorkspace();

  // Claude Code first once the host offers it; any available harness works.
  const PREFERRED: readonly string[] = ['claude-code', 'codex', 'pi', 'prime-agent', 'hermes', 'nano'];
  const storageKey = $derived(`piui.pipeline.assistant.v1.${workspaceId}.${editor.graph.id}`);
  // The last model picked per harness; empty means the harness default.
  const MODEL_KEY = 'piui.pipeline.assistant.model.v1';

  let sessionId = $state('');
  let draftHarness = $state<HarnessKind | ''>('');
  let text = $state('');
  const sending = $derived(operations.get(storageKey) === 'send');
  let error = $state('');
  let list = $state<HTMLDivElement | null>(null);
  let input = $state<HTMLTextAreaElement | null>(null);
  let applied = $state<Record<string, boolean>>({});
  let draftModelKey = $state('');
  const modelBusy = $derived(operations.get(storageKey) === 'settings');
  let draftLevel = $state('');
  let draftFast = $state(false);
  let settings = $state.raw<RuntimeSettings>();
  let settingsLoading = $state(false);

  const snapshot = $derived(sessionId ? store.snapshots[sessionId] : undefined);
  const session = $derived(snapshot?.session ?? store.catalog.sessions.find((item) => item.id === sessionId));
  const harness = $derived(sessionId ? (session?.harness ?? '') : draftHarness);
  const currentSettings = $derived(settings?.sessionId === sessionId ? settings : undefined);
  const nativeModel = $derived(currentSettings?.model ?? session?.model);

  const available = $derived(store.catalog.harnesses.filter((item) => item.status === 'available'));
  const harnessItems = $derived<PickerItem<HarnessKind>[]>(
    available.map((item) => ({ value: item.kind, label: harnessMeta(item.kind).label, description: item.version ? `v${item.version}` : undefined })),
  );
  const models = $derived(harness ? (editor.catalogs[harness]?.models ?? []) : []);
  const modelsError = $derived(harness ? (editor.catalogErrors[harness] ?? '') : '');
  const modelsLoading = $derived(Boolean(harness) && !editor.safeMode && !modelsError && !(harness && editor.catalogs[harness]));
  const harnessVersion = $derived(store.catalog.harnesses.find((item) => item.kind === harness)?.version);
  const modelKey = $derived(sessionId ? (nativeModel ? keyOf(nativeModel) : '') : draftModelKey);
  const listedModel = $derived(sessionId ? models.find((item) => keyOf(item) === modelKey) : resolveModelSelection(models, modelKey, harness));
  const model = $derived(sessionId ? nativeModel : listedModel);
  const level = $derived(sessionId
    ? (currentSettings?.thinkingLevel ?? '')
    : (listedModel?.thinkingLevels?.includes(draftLevel) ? draftLevel : ''));
  const fast = $derived(sessionId ? currentSettings?.serviceTier === 'fast' : Boolean(listedModel?.supportsFast && draftFast));
  $effect(() => {
    if (sessionId || !listedModel) return;
    if (draftLevel !== level) draftLevel = level;
    if (draftFast !== fast) draftFast = fast;
  });
  const levels = $derived(currentSettings?.models.find((entry) => keyOf(entry) === modelKey)?.thinkingLevels ?? listedModel?.thinkingLevels ?? model?.thinkingLevels ?? []);
  const fastAvailable = $derived(Boolean(listedModel?.supportsFast ?? currentSettings?.serviceTier));
  const pickerModels = $derived(
    currentSettings
      ? currentSettings.models.map((entry) => ({ ...entry, supportsFast: models.find((item) => keyOf(item) === keyOf(entry))?.supportsFast }))
      : models,
  );
  const modelOptions = $derived<ModelOption[]>(
    [
      ...(nativeModel && !pickerModels.some((entry) => keyOf(entry) === keyOf(nativeModel)) ? [nativeModel] : []),
      ...pickerModels,
    ].map((item) => ({
      key: keyOf(item),
      name: item.name,
      id: item.id,
      ...(item.provider ? { provider: item.provider } : {}),
      reasoning: Boolean(item.thinkingLevels?.length),
      fast: Boolean('supportsFast' in item && item.supportsFast),
    })),
  );
  const running = $derived(Boolean(session && ['starting', 'running', 'stopping'].includes(session.status)));
  const canSend = $derived(Boolean(harness) && !editor.safeMode && !sending && !modelBusy && Boolean(sessionId || !modelKey || listedModel));
  const canTune = $derived(!editor.safeMode && !sending && !modelBusy && !settingsLoading && (!sessionId || session?.status === 'idle'));

  interface Message {
    id: string;
    role: 'user' | 'assistant' | 'activity';
    text: string;
    streaming: boolean;
  }
  const messages = $derived.by<Message[]>(() => {
    const out: Message[] = [];
    for (const block of snapshot?.blocks ?? []) {
      if (block.kind === 'user') out.push({ id: block.id, role: 'user', text: stripEnvelope(block.text ?? ''), streaming: false });
      else if (block.kind === 'assistant') out.push({ id: block.id, role: 'assistant', text: block.text ?? '', streaming: block.status === 'streaming' });
      else if ((block.kind === 'tool' || block.kind === 'thinking') && block.status === 'streaming') {
        out.push({ id: block.id, role: 'activity', text: block.kind === 'thinking' ? $t('Thinking…') : (block.title ?? block.toolName ?? $t('Using a tool…')), streaming: true });
      }
    }
    return out;
  });

  // Restore this draft's conversation, or pick a harness for a new one.
  let restoredFor = '';
  $effect(() => {
    const key = storageKey;
    if (restoredFor !== key) {
      restoredFor = key;
      sessionId = '';
      applied = {};
    }
    if (sending) return;
    let saved = '';
    try {
      saved = localStorage.getItem(key) ?? '';
    } catch {
      saved = '';
    }
    if (saved && (store.snapshots[saved] || store.catalog.sessions.some((session) => session.id === saved))) {
      sessionId = saved;
      if (!store.snapshots[saved]) void store.reconcileSession(saved);
    }
  });
  $effect(() => {
    if (sessionId || sending || modelBusy || draftHarness || !available.length) return;
    chooseHarness(PREFERRED.map((kind) => available.find((item) => item.kind === kind)).find(Boolean)?.kind ?? available[0]!.kind);
  });
  $effect(() => {
    const kind = harness;
    const version = harnessVersion;
    if (kind === 'nano') void nanoAccount.catalogRevision;
    if (kind && !editor.safeMode) untrack(() => void editor.loadCatalog(kind, false, version));
  });
  // Only live runtimes expose tuning. Closed history still carries the native model.
  $effect(() => {
    const id = sessionId;
    const live = session?.status === 'idle';
    if (!id || !live || modelBusy || editor.safeMode) {
      settingsLoading = false;
      return;
    }
    let active = true;
    settingsLoading = true;
    void runtimeSettings({ type: 'get', sessionId: id })
      .then((result) => {
        if (active) settings = result;
      })
      .catch(() => {
        // The snapshot still identifies the model if runtime tuning is unavailable.
      })
      .finally(() => {
        if (active) settingsLoading = false;
      });
    return () => {
      active = false;
    };
  });
  $effect(() => {
    void messages.length;
    void messages.at(-1)?.text.length;
    void tick().then(() => {
      if (list) list.scrollTop = list.scrollHeight;
    });
  });

  function remember(key: string, id: string): void {
    if (key === storageKey) sessionId = id;
    try {
      localStorage.setItem(key, id);
    } catch {
      // The conversation stays reachable from the project's chats.
    }
  }

  function readModels(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  function chooseHarness(value: HarnessKind): void {
    draftHarness = value;
    draftModelKey = readModels()[value] ?? '';
    draftLevel = '';
    draftFast = false;
  }

  function rememberModel(kind: HarnessKind, value: string): void {
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify({ ...readModels(), [kind]: value }));
    } catch {
      // The choice lasts for this panel only.
    }
  }

  async function updateSettings(command: Extract<RuntimeSettingsCommand, { type: 'set' }>, clearFast = false): Promise<boolean> {
    const oldModel = nativeModel;
    const key = storageKey;
    operations.set(key, 'settings');
    error = '';
    try {
      if (clearFast && oldModel) {
        const result = await runtimeSettings({ type: 'set', sessionId: command.sessionId, model: workspaceModel(oldModel), serviceTier: 'standard' });
        if (key === storageKey && sessionId === command.sessionId) settings = result;
      }
      const result = await runtimeSettings(command);
      if (key === storageKey && sessionId === command.sessionId) settings = result;
      return true;
    } catch (cause) {
      if (key === storageKey && sessionId === command.sessionId) error = errorMessage(cause);
      return false;
    } finally {
      operations.delete(key);
    }
  }

  async function selectModel(value: string): Promise<void> {
    const kind = harness;
    if (!canTune || !kind || value === modelKey) return;
    const next = value ? pickerModels.find((item) => keyOf(item) === value) : undefined;
    if (value && !next) return;
    const nextFast = Boolean(next?.supportsFast && fast);
    if (sessionId && next) {
      if (!await updateSettings({
        type: 'set', sessionId, model: workspaceModel(next), ...(nextFast ? { serviceTier: 'fast' } : {}),
      }, fast && !nextFast)) return;
    } else {
      if (sessionId) reset(); // The runtime has no "no override" setting.
      draftModelKey = value;
      draftLevel = '';
      draftFast = nextFast;
    }
    rememberModel(kind, value);
  }

  async function selectLevel(value: string): Promise<void> {
    if (!canTune || value === level || !model) return;
    if (sessionId) {
      if (value) await updateSettings({ type: 'set', sessionId, model: workspaceModel(model), thinkingLevel: value, ...(fast ? { serviceTier: 'fast' } : {}) });
    } else draftLevel = value;
  }

  async function selectFast(value: boolean): Promise<void> {
    if (!canTune || value === fast || !model || !fastAvailable) return;
    if (sessionId) {
      await updateSettings({ type: 'set', sessionId, model: workspaceModel(model), serviceTier: value ? 'fast' : 'standard' });
    } else draftFast = value;
  }

  function reset(): void {
    if (sending || modelBusy) return;
    if (harness) chooseHarness(harness);
    sessionId = '';
    applied = {};
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Nothing to forget.
    }
  }

  function choices(): HarnessChoice[] {
    return available.map((item) => ({
      harness: item.kind,
      label: harnessMeta(item.kind).label,
      models: editor.catalogs[item.kind]?.models.map((entry) => entry.id),
    }));
  }

  async function send(request = text): Promise<void> {
    const message = request.trim();
    if (!message || !canSend || !harness) return;
    const key = storageKey;
    operations.set(key, 'send');
    error = '';
    try {
      const envelope = builderEnvelope({
        first: !sessionId,
        draftJson: JSON.stringify(graphToSystemFile(editor.graph, editor.systems), null, 1),
        problems: [...editor.issues.map((issue) => issue.message), ...editor.preflight.map((issue) => issue.message)],
        harnesses: choices(),
        text: message,
      });
      if (!sessionId) {
        const outcome = await store.createChat(
          {
            workspaceId,
            harness,
            ...(listedModel ? { model: listedModel, ...(level ? { thinkingLevel: level } : {}) } : {}),
            ...(listedModel?.supportsFast && fast ? { serviceTier: 'fast' } : {}),
            permissionMode: 'read-only',
            text: envelope,
          },
          { open: false, title: $t('Pipeline assistant: {0}', [editor.graph.name || $t('Untitled pipeline')]) },
        );
        remember(key, outcome.sessionId);
        if (outcome.error) {
          if (key === storageKey) error = outcome.error;
          return;
        }
      } else {
        await composerRequest({ type: 'send', sessionId, requestId: crypto.randomUUID(), text: envelope, mode: running ? 'follow-up' : 'prompt' });
      }
      if (key === storageKey && request === text) text = '';
    } catch (cause) {
      if (key === storageKey) error = errorMessage(cause);
    } finally {
      operations.delete(key);
      void tick().then(() => input?.focus());
    }
  }

  function apply(messageId: string, answer: string): void {
    const proposal = readProposal(answer);
    if (!proposal?.ok) return;
    const next = applyProposal(editor.graph, proposal.file, editor.systems);
    editor.replaceGraph(next);
    applied = { ...applied, [messageId]: true };
    toasts.success($t('Proposal applied to the draft'), $t('Undo with Ctrl+Z. Save to keep it.'));
    void editor.runCheck();
  }

  const SUGGESTIONS = [
    'Build a loop: a developer implements the task, a tester checks it, a reviewer approves or sends it back (at most 3 rounds).',
    'An orchestrator splits the task and decides how many workers and testers to start.',
    'Explain this pipeline and suggest how to improve it.',
  ];
</script>

<aside class="assistant" aria-label={$t('Pipeline assistant')}>
  <header class="head">
    <Sparkles size={15} />
    <h2>{$t('Assistant')}</h2>
    <Picker items={harnessItems} value={harness || undefined} label={$t('Harness')} onSelect={(value) => { if (!sending && !modelBusy && value !== harness) { reset(); chooseHarness(value); } }}>
      {#snippet trigger(props)}
        <button type="button" class="chip" {...props} disabled={sending || modelBusy}>
          {#if harness}<HarnessMark kind={harness} size={16} />{/if}
          <span>{harness ? harnessMeta(harness).label : $t('No harness')}</span>
          <ChevronDown size={12} />
        </button>
      {/snippet}
    </Picker>
    {#if harness}
      <ModelPicker
        models={modelOptions}
        {harness}
        value={model ? keyOf(model) : modelKey}
        defaultOption={true}
        loading={modelsLoading || settingsLoading}
        error={modelsError ? $t(modelsError) : ''}
        {levels}
        {level}
        levelDefault={!sessionId}
        {fastAvailable}
        {fast}
        busy={!canTune}
        width={340}
        hint={model ? $t('This model has no reasoning options.') : $t('Pick a model to tune reasoning.')}
        onModel={(value) => void selectModel(value)}
        onLevel={(value) => void selectLevel(value)}
        onFast={(value) => void selectFast(value)}
      >
        {#snippet trigger(props)}
          <button type="button" class="chip chip--model" {...props} disabled={!canTune}>
            {#if modelBusy || modelsLoading || settingsLoading}<Spinner size={12} />{:else}<Brain size={13} />{/if}
            <span>{model?.name ?? (modelKey ? $t('Choose a model') : $t('Default model'))}</span>
            {#if level}<span class="chip__sub">{level}</span>{/if}
            {#if fast}<Zap size={12} />{/if}
            <ChevronDown size={12} />
          </button>
        {/snippet}
      </ModelPicker>
    {/if}
    <span class="spacer"></span>
    <IconButton size="sm" label={$t('New conversation')} disabled={!sessionId || sending || modelBusy} onclick={reset}><RotateCcw /></IconButton>
    <IconButton size="sm" label={$t('Close assistant')} onclick={onClose}><X /></IconButton>
  </header>

  <div class="list" bind:this={list} role="log" aria-live="polite" aria-label={$t('Assistant conversation')}>
    {#if messages.length === 0}
      <div class="intro">
        <p>{$t('Describe what the pipeline should achieve. The assistant proposes agents and links; you review and apply them to this draft.')}</p>
        <div class="suggestions">
          {#each SUGGESTIONS as suggestion (suggestion)}
            <button type="button" onclick={() => void send($t(suggestion))} disabled={!canSend}>{$t(suggestion)}</button>
          {/each}
        </div>
        {#if !available.length}<p class="warn">{$t('No agent harness is ready yet.')}</p>{/if}
      </div>
    {/if}
    {#each messages as message (message.id)}
      {#if message.role === 'user'}
        <div class="user"><MarkdownContent source={message.text} compact={true} /></div>
      {:else if message.role === 'activity'}
        <div class="activity"><Spinner size={11} /> {message.text}</div>
      {:else}
        {@const proposal = message.streaming ? undefined : readProposal(message.text)}
        <div class="answer">
          <MarkdownContent source={proposal ? proposal.prose : message.text} compact={true} />
          {#if message.streaming}<span class="caret" aria-hidden="true"></span>{/if}
          {#if proposal?.ok}
            {@const summary = summarizeChange(editor.graph, applyProposal(editor.graph, proposal.file, editor.systems))}
            <div class="proposal">
              <strong>{$t('Proposed pipeline')}: {proposal.file.name}</strong>
              {#if isEmptyChange(summary) || applied[message.id]}
                <span class="muted"><Check size={13} /> {$t('The draft matches this proposal.')}</span>
              {:else}
                <ul>
                  {#if summary.added.length}<li class="plus">+ {summary.added.join(', ')}</li>{/if}
                  {#if summary.changed.length}<li>~ {summary.changed.join(', ')}</li>{/if}
                  {#if summary.removed.length}<li class="minus">− {summary.removed.join(', ')}</li>{/if}
                  {#if summary.connectionsAdded || summary.connectionsRemoved}
                    <li class="muted">{$t('Links: +{0} / −{1}', [summary.connectionsAdded, summary.connectionsRemoved])}</li>
                  {/if}
                </ul>
                <Button size="sm" variant="primary" disabled={editor.readOnly} onclick={() => apply(message.id, message.text)}>{$t('Apply to draft')}</Button>
              {/if}
            </div>
          {:else if proposal && !proposal.ok}
            <div class="proposal proposal--bad">
              <strong><TriangleAlert size={13} /> {$t('The proposal did not pass validation')}</strong>
              <pre>{proposal.error}</pre>
              <Button size="sm" disabled={!canSend || running} onclick={() => void send(`${$t('Your JSON did not pass Nano Desktop validation. Fix these errors and send the complete system again:')}\n${proposal.error}`)}>{$t('Ask to fix')}</Button>
            </div>
          {/if}
        </div>
      {/if}
    {/each}
    {#each snapshot?.approvals ?? [] as approval (approval.id)}
      {#if snapshot}<ApprovalCard {approval} session={snapshot.session} />{/if}
    {/each}
  </div>

  {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  {#if modelsError}
    <p class="error" role="status">
      {$t(modelsError)}
      <Button size="sm" onclick={() => harness && void editor.loadCatalog(harness, true, harnessVersion)}>{$t('Retry')}</Button>
    </p>
  {:else if !sessionId && modelKey && !listedModel && !modelsLoading}
    <p class="error" role="status">{$t('Choose a model')}</p>
  {/if}
  {#if editor.problemCount() > 0 && messages.length > 0 && !running}
    <button type="button" class="fix" onclick={() => void send($t('Check found problems in the draft. Fix them and send the complete system again.'))} disabled={!canSend}>
      <TriangleAlert size={13} /> {$t('Ask the assistant to fix {0} problems', [editor.problemCount()])}
    </button>
  {/if}

  <form class="composer" onsubmit={(event) => { event.preventDefault(); void send(); }}>
    <Textarea
      bind:ref={input}
      bind:value={text}
      minRows={2}
      maxRows={8}
      placeholder={$t('Ask for a pipeline or a change…')}
      aria-label={$t('Message to the assistant')}
      disabled={!harness && !sending}
      onkeydown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          void send();
        }
      }}
    />
    <div class="composer__actions">
      <span class="muted small">{$t('Read-only: the assistant cannot change files or start runs.')}</span>
      {#if running}
        <IconButton size="sm" label={$t('Stop')} onclick={() => void store.interrupt(sessionId)}><Square /></IconButton>
      {/if}
      <IconButton size="sm" label={$t('Send')} disabled={!text.trim() || !canSend} onclick={() => void send()}>
        {#if sending}<Spinner size={12} />{:else}<ArrowUp />{/if}
      </IconButton>
    </div>
  </form>
</aside>

<style>
  .assistant {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 44px;
    padding: 0 var(--piui-space-2) 0 var(--piui-space-3);
    border-bottom: 1px solid var(--piui-border-subtle);
    color: var(--piui-accent);
  }
  h2 {
    flex-shrink: 0;
    margin: 0;
    white-space: nowrap;
    color: var(--piui-text);
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .spacer {
    flex: 1;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-full);
    background: transparent;
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .chip--model {
    flex-shrink: 1;
    min-width: 88px;
    max-width: 150px;
  }
  .chip__sub {
    color: var(--piui-text-disabled);
  }
  .chip--model span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip:hover:not(:disabled) {
    background: var(--piui-hover);
  }
  .list {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--piui-space-3);
    min-height: 0;
    padding: var(--piui-space-3);
    overflow-y: auto;
  }
  .intro {
    display: grid;
    gap: var(--piui-space-3);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .intro p {
    margin: 0;
  }
  .suggestions {
    display: grid;
    gap: var(--piui-space-2);
  }
  .suggestions button {
    padding: 8px 10px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    text-align: left;
  }
  .suggestions button:hover:not(:disabled) {
    border-color: var(--piui-border);
    background: var(--piui-hover);
  }
  .user {
    align-self: flex-end;
    max-width: 88%;
    padding: 8px 12px;
    border-radius: 12px;
    background: var(--piui-user-surface);
  }
  .answer {
    display: grid;
    gap: var(--piui-space-2);
  }
  .activity {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .caret {
    display: inline-block;
    width: 6px;
    height: 14px;
    border-radius: 1px;
    background: var(--piui-accent);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .proposal {
    display: grid;
    justify-items: start;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--piui-accent) 40%, var(--piui-border));
    border-radius: var(--piui-radius-md);
    background: color-mix(in srgb, var(--piui-accent) 6%, var(--piui-surface-1));
    font-size: var(--piui-text-sm);
  }
  .proposal--bad {
    border-color: var(--piui-danger-border);
    background: var(--piui-danger-surface);
  }
  .proposal strong {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .proposal ul {
    margin: 0;
    padding-left: 2px;
    list-style: none;
  }
  .proposal pre {
    max-height: 140px;
    margin: 0;
    overflow: auto;
    font-size: var(--piui-text-xs);
    white-space: pre-wrap;
  }
  .plus {
    color: var(--piui-success);
  }
  .minus {
    color: var(--piui-danger);
  }
  .muted {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--piui-text-muted);
  }
  .small {
    font-size: var(--piui-text-xs);
  }
  .warn,
  .error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
  .error {
    padding: 0 var(--piui-space-3) var(--piui-space-2);
  }
  .fix {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0 var(--piui-space-3) var(--piui-space-2);
    padding: 6px 10px;
    border: 1px dashed var(--piui-warning);
    border-radius: var(--piui-radius-md);
    background: transparent;
    color: var(--piui-warning);
    font-size: var(--piui-text-sm);
  }
  .composer {
    display: grid;
    gap: 6px;
    padding: var(--piui-space-2) var(--piui-space-3) var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .composer__actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--piui-space-1);
  }
  .composer__actions .muted {
    margin-right: auto;
  }
</style>
