<script lang="ts">
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Folder from '@lucide/svelte/icons/folder';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Shield from '@lucide/svelte/icons/shield';
  import Zap from '@lucide/svelte/icons/zap';
  import Brain from '@lucide/svelte/icons/brain';
  import { t } from '../../features/locale/language';
  import { harnessModels } from '../../host-api/harnessModels';
  import type { HarnessCatalogModel } from '../../../../../contracts/harness-models-v18';
  import type { HarnessKind, PermissionMode, WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { Picker, Segmented, Spinner, Switch, Textarea, toasts, type PickerItem } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import { errorMessage } from '../workspaceStore.svelte';
  import HarnessMark from './HarnessMark.svelte';
  import { useWorkspace } from './context';

  interface Props {
    onTrust: (workspace: WorkspaceSummary) => void;
  }
  let { onTrust }: Props = $props();
  const store = useWorkspace();
  const DRAFT_KEY = 'new-chat';
  const CHOICE_KEY = 'piui.shell.newchat.v1';

  interface Choice {
    harness?: HarnessKind;
    modelKey?: string;
    thinkingLevel?: string;
    fast?: boolean;
    permissionMode?: PermissionMode;
  }
  function readChoices(): Record<string, Choice> {
    try {
      return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') as Record<string, Choice>;
    } catch {
      return {};
    }
  }
  const saved = readChoices();

  let text = $state(store.draftFor(DRAFT_KEY));
  let workspaceId = $state(store.selectedWorkspaceId);
  let harness = $state<HarnessKind | ''>('');
  let modelKey = $state('');
  let thinkingLevel = $state('');
  let fast = $state(false);
  let permissionMode = $state<PermissionMode>('native');
  let models = $state.raw<HarnessCatalogModel[]>([]);
  let modelsLoading = $state(false);
  let modelsError = $state('');
  let busy = $state(false);
  let textarea = $state<HTMLTextAreaElement | null>(null);

  const workspaces = $derived(store.catalog.workspaces.filter((workspace) => !workspace.missing));
  const workspace = $derived(workspaces.find((item) => item.id === workspaceId));
  const available = $derived(store.catalog.harnesses.filter((item) => item.status === 'available'));
  const model = $derived(models.find((item) => JSON.stringify([item.provider, item.id]) === modelKey));
  const levels = $derived(model?.thinkingLevels ?? []);

  // Follow the sidebar selection until the user picks a project here.
  $effect(() => {
    if (!workspaceId || !workspaces.some((item) => item.id === workspaceId)) {
      workspaceId = store.selectedWorkspaceId || workspaces[0]?.id || '';
    }
  });

  // Restore per-project choices, falling back to the first available harness.
  $effect(() => {
    const choice = saved[workspaceId] ?? {};
    const preferred = choice.harness && available.some((item) => item.kind === choice.harness) ? choice.harness : undefined;
    harness = preferred ?? available[0]?.kind ?? '';
    permissionMode = choice.permissionMode ?? 'native';
    thinkingLevel = choice.thinkingLevel ?? '';
    fast = choice.fast ?? false;
    modelKey = choice.modelKey ?? '';
  });

  $effect(() => {
    const id = workspaceId;
    const kind = harness;
    models = [];
    modelsError = '';
    if (!id || !kind) return;
    if (workspace && !workspace.personal && workspace.trust !== 'trusted') return;
    let cancelled = false;
    modelsLoading = true;
    harnessModels({ workspaceId: id, harness: kind })
      .then((result) => {
        if (cancelled) return;
        models = result.models;
        if (modelKey && !result.models.some((item) => JSON.stringify([item.provider, item.id]) === modelKey)) modelKey = '';
      })
      .catch((error: unknown) => {
        if (!cancelled) modelsError = errorMessage(error);
      })
      .finally(() => {
        if (!cancelled) modelsLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (thinkingLevel && !levels.includes(thinkingLevel)) thinkingLevel = '';
    if (fast && !model?.supportsFast) fast = false;
  });

  function remember(): void {
    const all = readChoices();
    all[workspaceId] = { harness: harness || undefined, modelKey, thinkingLevel, fast, permissionMode };
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(all));
    } catch {
      // Remembered choices are a convenience only.
    }
  }

  const workspaceItems = $derived<PickerItem[]>(
    workspaces.map((item) => ({
      value: item.id,
      label: item.personal ? $t('Personal chats') : item.name,
      description: item.personal
        ? $t('Not tied to a project folder')
        : item.trust === 'trusted'
          ? $t('Trusted folder')
          : $t('Restricted — trust required'),
      group: item.personal ? $t('Personal') : $t('Projects'),
    })),
  );
  const harnessItems = $derived<PickerItem[]>(
    store.catalog.harnesses.map((item) => ({
      value: item.kind,
      label: item.name,
      description: item.version ? `v${item.version}` : undefined,
      disabled: item.status !== 'available',
      disabledReason: item.reason ?? $t('Not available'),
    })),
  );
  const modelItems = $derived<PickerItem[]>([
    { value: '', label: $t('Harness default'), description: $t('Use the model configured in the harness') },
    ...models.map((item) => ({
      value: JSON.stringify([item.provider, item.id]),
      label: item.name,
      description: item.id,
      group: item.provider ?? $t('Models'),
      badges: [...(item.thinkingLevels?.length ? [$t('reasoning')] : []), ...(item.supportsFast ? [$t('fast')] : [])],
    })),
  ]);
  const permissionItems = $derived<PickerItem<PermissionMode>[]>([
    { value: 'native', label: $t('Harness settings'), description: $t('Use the permissions configured in the harness') },
    { value: 'read-only', label: $t('Read only'), description: $t('The agent can read but not change files') },
    { value: 'workspace-write', label: $t('Edit project'), description: $t('Changes limited to the project folder') },
    { value: 'full-access', label: $t('Full access'), description: $t('No native restrictions — use with care') },
  ]);

  const canSend = $derived(
    Boolean(text.trim()) && Boolean(workspaceId) && Boolean(harness) && !busy && !store.safeMode,
  );

  async function send(): Promise<void> {
    if (!canSend || !harness) return;
    if (workspace && !workspace.personal && workspace.trust !== 'trusted') {
      onTrust(workspace);
      return;
    }
    busy = true;
    remember();
    const message = text;
    try {
      await store.startChat({
        workspaceId,
        harness,
        model,
        permissionMode,
        thinkingLevel: thinkingLevel || undefined,
        serviceTier: model?.supportsFast ? (fast ? 'fast' : undefined) : undefined,
        text: message,
      });
      text = '';
      store.updateDraft(DRAFT_KEY, '');
    } catch (error) {
      toasts.error($t('Could not start the chat'), errorMessage(error));
    } finally {
      busy = false;
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  export function focus(): void {
    textarea?.focus();
  }
</script>

<div class="composer" class:composer--busy={busy}>
  <Textarea
    bind:ref={textarea}
    bind:value={text}
    oninput={() => store.updateDraft(DRAFT_KEY, text)}
    onkeydown={keydown}
    minRows={3}
    maxRows={14}
    placeholder={$t('Describe a task, ask a question or @mention a file…')}
    aria-label={$t('Message')}
    class="composer__input"
    disabled={store.safeMode}
  />
  <div class="composer__bar">
    <div class="chips">
      <Picker items={workspaceItems} value={workspaceId} label={$t('Project')} searchPlaceholder={$t('Search projects')} onSelect={(value) => (workspaceId = value)}>
        {#snippet trigger(props)}
          <button type="button" class="chip" {...props}>
            {#if workspace?.personal}<MessagesSquare size={14} />{:else}<Folder size={14} />{/if}
            <span>{workspace ? (workspace.personal ? $t('Personal chats') : workspace.name) : $t('Choose project')}</span>
            <ChevronDown size={12} />
          </button>
        {/snippet}
      </Picker>

      <Picker items={harnessItems} value={harness} label={$t('Harness')} searchPlaceholder={$t('Search harnesses')} width={300} onSelect={(value) => (harness = value as HarnessKind)}>
        {#snippet trigger(props)}
          <button type="button" class="chip" {...props} disabled={available.length === 0}>
            {#if harness}<HarnessMark kind={harness} size={16} />{/if}
            <span>{harness ? harnessMeta(harness).label : $t('No harness available')}</span>
            <ChevronDown size={12} />
          </button>
        {/snippet}
      </Picker>

      {#if harness}
        <Picker
          items={modelItems}
          value={modelKey}
          label={$t('Model')}
          searchPlaceholder={$t('Search models')}
          emptyText={modelsError ? $t('Could not load models') : $t('No models found')}
          width={340}
          onSelect={(value) => (modelKey = value)}
        >
          {#snippet trigger(props)}
            <button type="button" class="chip" {...props}>
              {#if modelsLoading}<Spinner size={12} />{:else}<Brain size={14} />{/if}
              <span>{model?.name ?? $t('Default model')}</span>
              {#if thinkingLevel}<span class="chip__sub">{thinkingLevel}</span>{/if}
              {#if fast}<Zap size={12} />{/if}
              <ChevronDown size={12} />
            </button>
          {/snippet}
          {#snippet footer()}
            {#if levels.length}
              <div class="tuning">
                <span class="tuning__label">{$t('Reasoning')}</span>
                <Segmented
                  size="sm"
                  label={$t('Reasoning')}
                  value={thinkingLevel || '__default'}
                  options={[{ value: '__default', label: $t('Default') }, ...levels.map((level) => ({ value: level, label: level }))]}
                  onValueChange={(value) => (thinkingLevel = value === '__default' ? '' : value)}
                />
              </div>
            {/if}
            {#if model?.supportsFast}
              <div class="tuning">
                <Switch bind:checked={fast} label={$t('Fast mode')} />
              </div>
            {/if}
            {#if !levels.length && !model?.supportsFast}
              <p class="tuning__hint">{model ? $t('This model has no reasoning options.') : $t('Pick a model to tune reasoning.')}</p>
            {/if}
          {/snippet}
        </Picker>
      {/if}

      <Picker items={permissionItems} value={permissionMode} label={$t('Permissions')} searchPlaceholder={$t('Search')} width={320} onSelect={(value) => (permissionMode = value)}>
        {#snippet trigger(props)}
          <button type="button" class="chip" class:chip--warn={permissionMode === 'full-access'} {...props}>
            <Shield size={14} />
            <span>{permissionItems.find((item) => item.value === permissionMode)?.label}</span>
            <ChevronDown size={12} />
          </button>
        {/snippet}
      </Picker>
    </div>
    <button type="button" class="send" onclick={() => void send()} disabled={!canSend} aria-label={$t('Start chat')}>
      {#if busy}<Spinner size={14} />{:else}<ArrowUp size={16} />{/if}
    </button>
  </div>
</div>
{#if workspace && !workspace.personal && workspace.trust !== 'trusted'}
  <p class="notice">
    {$t('This folder is restricted. Trust it to let agents work on its files.')}
    <button type="button" class="link" onclick={() => onTrust(workspace)}>{$t('Review trust…')}</button>
  </p>
{:else if modelsError}
  <p class="notice notice--error">{modelsError}</p>
{/if}

<style>
  .composer {
    border: 1px solid var(--piui-border);
    border-radius: 14px;
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-1);
    transition: border-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .composer:focus-within {
    border-color: var(--piui-border-strong);
  }
  .composer :global(.composer__input) {
    padding: 14px 16px 6px;
    border: 0;
    background: transparent;
    font-size: var(--piui-chat-composer-font-size);
    resize: none;
  }
  .composer :global(.composer__input:focus-visible) {
    box-shadow: none;
  }
  .composer__bar {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 6px 8px 8px 10px;
  }
  .chips {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip:hover:not(:disabled),
  .chip[data-state='open'] {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .chip__sub {
    color: var(--piui-text-disabled);
  }
  .chip--warn {
    color: var(--piui-warning);
  }
  .send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 50%;
    background: var(--piui-action);
    color: var(--piui-action-ink);
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  .send:hover:not(:disabled) {
    background: var(--piui-action-hover);
  }
  .send:disabled {
    background: var(--piui-surface-3);
    color: var(--piui-text-disabled);
    opacity: 1;
  }
  .tuning {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
    padding: 4px 0;
  }
  .tuning__label {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .tuning__hint {
    margin: 2px 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .notice {
    margin: var(--piui-space-2) 4px 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .notice--error {
    color: var(--piui-danger);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
  }
</style>
