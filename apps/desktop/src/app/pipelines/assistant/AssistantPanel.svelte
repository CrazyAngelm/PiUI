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
  import { tick } from 'svelte';
  import { t } from '../../../features/locale/language';
  import MarkdownContent from '../../../components/MarkdownContent.svelte';
  import { graphToSystemFile } from '../../../features/orchestration/systemFile';
  import { composerRequest } from '../../../host-api/composerClient';
  import { workspaceModel } from '../../../host-api/harnessModels';
  import { runtimeSettings } from '../../../host-api/runtimeSettings';
  import type { HarnessKind } from '../../../../../../contracts/workspace-v15';
  import { Button, IconButton, Picker, Spinner, Textarea, toasts, type PickerItem } from '../../../lib/ui';
  import ApprovalCard from '../../shell/ApprovalCard.svelte';
  import ModelPicker, { type ModelOption } from '../../shell/ModelPicker.svelte';
  import HarnessMark from '../../shell/HarnessMark.svelte';
  import { useWorkspace } from '../../shell/context';
  import { errorMessage } from '../../workspaceStore.svelte';
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
  const PREFERRED: readonly string[] = ['claude-code', 'codex', 'pi', 'prime-agent', 'hermes'];
  const storageKey = $derived(`piui.pipeline.assistant.v1.${workspaceId}.${editor.graph.id}`);
  // The last model picked per harness; empty means the harness default.
  const MODEL_KEY = 'piui.pipeline.assistant.model.v1';

  let sessionId = $state('');
  let harness = $state<HarnessKind | ''>('');
  let text = $state('');
  let sending = $state(false);
  let error = $state('');
  let list = $state<HTMLDivElement | null>(null);
  let input = $state<HTMLTextAreaElement | null>(null);
  let applied = $state<Record<string, boolean>>({});
  let modelKey = $state('');
  let modelBusy = $state(false);
  let level = $state('');

  const available = $derived(store.catalog.harnesses.filter((item) => item.status === 'available'));
  const harnessItems = $derived<PickerItem<HarnessKind>[]>(
    available.map((item) => ({ value: item.kind, label: harnessMeta(item.kind).label, description: item.version ? `v${item.version}` : undefined })),
  );
  const keyOf = (value: { provider?: string | null; id: string }) => JSON.stringify([value.provider ?? null, value.id]);
  const models = $derived(harness ? (editor.catalogs[harness]?.models ?? []) : []);
  const modelsError = $derived(harness ? Boolean(editor.catalogErrors[harness]) : false);
  const modelsLoading = $derived(Boolean(harness) && !editor.safeMode && !modelsError && !(harness && editor.catalogs[harness]));
  const model = $derived(modelKey ? models.find((item) => keyOf(item) === modelKey) : undefined);
  const levels = $derived(model?.thinkingLevels ?? []);
  const modelOptions = $derived<ModelOption[]>(
    models.map((item) => ({
      key: keyOf(item),
      name: item.name,
      id: item.id,
      ...(item.provider ? { provider: item.provider } : {}),
      reasoning: Boolean(item.thinkingLevels?.length),
      fast: Boolean(item.supportsFast),
    })),
  );
  const snapshot = $derived(sessionId ? store.snapshots[sessionId] : undefined);
  const running = $derived(snapshot ? ['starting', 'running', 'stopping'].includes(snapshot.session.status) : false);

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
  $effect(() => {
    let saved = '';
    try {
      saved = localStorage.getItem(storageKey) ?? '';
    } catch {
      saved = '';
    }
    if (saved && store.catalog.sessions.some((session) => session.id === saved)) {
      sessionId = saved;
      if (!store.snapshots[saved]) void store.reconcileSession(saved);
    }
  });
  $effect(() => {
    if (harness || !available.length) return;
    harness = PREFERRED.map((kind) => available.find((item) => item.kind === kind)).find(Boolean)?.kind ?? available[0]!.kind;
  });
  // Load the harness's models and restore the model last picked for it.
  $effect(() => {
    const kind = harness;
    if (!kind) return;
    modelKey = readModels()[kind] ?? '';
    if (!editor.catalogs[kind]) void editor.loadCatalog(kind);
  });
  // A remembered model the harness no longer offers falls back to its default.
  $effect(() => {
    const catalog = harness ? editor.catalogs[harness] : undefined;
    if (modelKey && catalog && !catalog.models.some((item) => keyOf(item) === modelKey)) modelKey = '';
  });
  $effect(() => {
    void messages.length;
    void messages.at(-1)?.text.length;
    void tick().then(() => {
      if (list) list.scrollTop = list.scrollHeight;
    });
  });

  function remember(id: string): void {
    sessionId = id;
    try {
      localStorage.setItem(storageKey, id);
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

  async function selectModel(value: string): Promise<void> {
    if (value === modelKey || !harness) return;
    const next = value ? models.find((item) => keyOf(item) === value) : undefined;
    if (value && !next) return;
    if (sessionId && next) {
      // A live conversation switches model natively and keeps its history.
      modelBusy = true;
      error = '';
      try {
        await runtimeSettings({ type: 'set', sessionId, model: workspaceModel(next) });
      } catch (cause) {
        error = errorMessage(cause);
        return;
      } finally {
        modelBusy = false;
      }
    } else if (sessionId) {
      // A native session cannot return to "no override": start a new one.
      reset();
    }
    modelKey = value;
    level = '';
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify({ ...readModels(), [harness]: value }));
    } catch {
      // The choice lasts for this panel only.
    }
  }

  async function selectLevel(value: string): Promise<void> {
    if (value === level) return;
    if (sessionId && model && value) {
      modelBusy = true;
      error = '';
      try {
        await runtimeSettings({ type: 'set', sessionId, model: workspaceModel(model), thinkingLevel: value });
      } catch (cause) {
        error = errorMessage(cause);
        return;
      } finally {
        modelBusy = false;
      }
    }
    level = value;
  }

  function reset(): void {
    sessionId = '';
    applied = {};
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Nothing to forget.
    }
  }

  async function choices(): Promise<HarnessChoice[]> {
    // Model lists let the assistant pick real models instead of inventing them.
    await Promise.all(available.map((item) => (editor.catalogs[item.kind] ? undefined : editor.loadCatalog(item.kind))));
    return available.map((item) => ({
      harness: item.kind,
      label: harnessMeta(item.kind).label,
      models: (editor.catalogs[item.kind]?.models ?? []).map((model) => model.id).slice(0, 24),
    }));
  }

  async function send(request = text): Promise<void> {
    const message = request.trim();
    if (!message || sending || !harness) return;
    sending = true;
    error = '';
    try {
      const envelope = builderEnvelope({
        first: !sessionId,
        draftJson: JSON.stringify(graphToSystemFile(editor.graph), null, 1),
        problems: [...editor.issues.map((issue) => issue.message), ...editor.preflight.map((issue) => issue.message)],
        harnesses: await choices(),
        text: message,
      });
      if (!sessionId) {
        const outcome = await store.createChat(
          { workspaceId, harness, ...(model ? { model, ...(level ? { thinkingLevel: level } : {}) } : {}), permissionMode: 'read-only', text: envelope },
          { open: false, title: $t('Pipeline assistant: {0}', [editor.graph.name || $t('Untitled pipeline')]) },
        );
        remember(outcome.sessionId);
        if (outcome.error) error = outcome.error;
      } else {
        await composerRequest({ type: 'send', sessionId, requestId: crypto.randomUUID(), text: envelope, mode: running ? 'follow-up' : 'prompt' });
      }
      if (request === text) text = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      sending = false;
      void tick().then(() => input?.focus());
    }
  }

  function apply(messageId: string, answer: string): void {
    const proposal = readProposal(answer);
    if (!proposal?.ok) return;
    const next = applyProposal(editor.graph, proposal.file);
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
    <Picker items={harnessItems} value={harness || undefined} label={$t('Harness')} onSelect={(value) => { if (value !== harness) { harness = value; reset(); } }}>
      {#snippet trigger(props)}
        <button type="button" class="chip" {...props} disabled={sending}>
          {#if harness}<HarnessMark kind={harness} size={16} />{/if}
          <span>{harness ? harnessMeta(harness).label : $t('No harness')}</span>
          <ChevronDown size={12} />
        </button>
      {/snippet}
    </Picker>
    {#if harness}
      <ModelPicker
        models={modelOptions}
        value={modelKey}
        defaultOption={true}
        loading={modelsLoading}
        error={modelsError ? $t('Could not load models') : ''}
        {levels}
        {level}
        levelDefault={true}
        busy={modelBusy}
        width={340}
        hint={model ? $t('This model has no reasoning options.') : $t('Pick a model to tune reasoning.')}
        onModel={(value) => void selectModel(value)}
        onLevel={(value) => void selectLevel(value)}
      >
        {#snippet trigger(props)}
          <button type="button" class="chip chip--model" {...props} disabled={sending || running || modelBusy}>
            {#if modelBusy || modelsLoading}<Spinner size={12} />{:else}<Brain size={13} />{/if}
            <span>{model?.name ?? $t('Default model')}</span>
            {#if level}<span class="chip__sub">{level}</span>{/if}
            <ChevronDown size={12} />
          </button>
        {/snippet}
      </ModelPicker>
    {/if}
    <span class="spacer"></span>
    <IconButton size="sm" label={$t('New conversation')} disabled={!sessionId || sending} onclick={reset}><RotateCcw /></IconButton>
    <IconButton size="sm" label={$t('Close assistant')} onclick={onClose}><X /></IconButton>
  </header>

  <div class="list" bind:this={list} role="log" aria-live="polite" aria-label={$t('Assistant conversation')}>
    {#if messages.length === 0}
      <div class="intro">
        <p>{$t('Describe what the pipeline should achieve. The assistant proposes agents and links; you review and apply them to this draft.')}</p>
        <div class="suggestions">
          {#each SUGGESTIONS as suggestion (suggestion)}
            <button type="button" onclick={() => void send($t(suggestion))} disabled={sending || !harness}>{$t(suggestion)}</button>
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
            {@const summary = summarizeChange(editor.graph, applyProposal(editor.graph, proposal.file))}
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
              <Button size="sm" disabled={sending || running} onclick={() => void send(`${$t('Your JSON did not pass PiUI validation. Fix these errors and send the complete system again:')}\n${proposal.error}`)}>{$t('Ask to fix')}</Button>
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
  {#if editor.problemCount() > 0 && messages.length > 0 && !running}
    <button type="button" class="fix" onclick={() => void send($t('Check found problems in the draft. Fix them and send the complete system again.'))} disabled={sending}>
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
      disabled={!harness}
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
      <IconButton size="sm" label={$t('Send')} disabled={!text.trim() || sending || !harness} onclick={() => void send()}>
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
    margin: 0;
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
  }
  .chip--model {
    min-width: 0;
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
