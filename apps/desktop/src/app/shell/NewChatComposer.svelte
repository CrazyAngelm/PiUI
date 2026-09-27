<script lang="ts">
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Folder from '@lucide/svelte/icons/folder';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Shield from '@lucide/svelte/icons/shield';
  import Zap from '@lucide/svelte/icons/zap';
  import Brain from '@lucide/svelte/icons/brain';
  import { onMount, tick, untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { harnessModels } from '../../host-api/harnessModels';
  import ModelPicker, { type ModelOption } from './ModelPicker.svelte';
  import type { HarnessCatalogModel, HarnessResource } from '../../../../../contracts/harness-models-v18';
  import type { HarnessKind, PermissionMode, WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { composerSupport, imageSupport } from '../../harness-adapters/composer';
  import { Picker, Spinner, Textarea, toasts, type PickerItem } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import { errorMessage } from '../workspaceStore.svelte';
  import { workspaceError } from '../../host-api/workspaceClient';
  import AttachButton from '../chat/composer/AttachButton.svelte';
  import { ComposerAttachments } from '../chat/composer/composerAttachments.svelte';
  import { FileMentions } from '../chat/composer/composerLookups.svelte';
  import { composerDropTargets } from '../chat/composer/dropTargets.svelte';
  import { activeMention, fileMention, rankFiles, rankNamed, replaceMention } from '../chat/composer/mentions';
  import type { ComposerMenuItem } from '../chat/composer/menuItems';
  import HarnessMark from './HarnessMark.svelte';
  import WorktreeChip from '../worktrees/WorktreeChip.svelte';
  import { useWorkspace } from './context';
  import { reconcileSelection, restoredSelection, type NewChatChoice, type NewChatSelection } from './newChatChoice';

  interface Props {
    onTrust: (workspace: WorkspaceSummary) => void;
  }
  let { onTrust }: Props = $props();
  const store = useWorkspace();
  const DRAFT_KEY = 'new-chat';
  const CHOICE_KEY = 'piui.shell.newchat.v1';

  function readChoices(): Record<string, NewChatChoice> {
    try {
      return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') as Record<string, NewChatChoice>;
    } catch {
      return {};
    }
  }
  const saved = readChoices();

  let text = $state(store.draftFor(DRAFT_KEY));
  let caret = $state(store.draftFor(DRAFT_KEY).length);
  let workspaceId = $state(store.selectedWorkspaceId);
  let harness = $state<HarnessKind | ''>('');
  let modelKey = $state('');
  let thinkingLevel = $state('');
  let fast = $state(false);
  let permissionMode = $state<PermissionMode>('native');
  let models = $state.raw<HarnessCatalogModel[]>([]);
  let skills = $state.raw<HarnessResource[]>([]);
  let modelsLoading = $state(false);
  let modelsError = $state('');
  let busy = $state(false);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let menuIndex = $state(0);
  let menuDismissed = $state(false);
  let htmlDragging = $state(false);
  const attachments = new ComposerAttachments(store.attachmentsFor(DRAFT_KEY), (images) => store.updateAttachments(DRAFT_KEY, images));
  const fileMentions = new FileMentions();

  const workspaces = $derived(store.catalog.workspaces.filter((workspace) => !workspace.missing));
  const workspace = $derived(workspaces.find((item) => item.id === workspaceId));
  const available = $derived(store.catalog.harnesses.filter((item) => item.status === 'available'));
  const model = $derived(models.find((item) => JSON.stringify([item.provider, item.id]) === modelKey));
  const levels = $derived(model?.thinkingLevels ?? []);
  // Before a session exists only the manifest is known; the host decides at send.
  const imageState = $derived(imageSupport(harness, undefined));
  const trusted = $derived(Boolean(workspace && (workspace.personal || workspace.trust === 'trusted')));
  // Harness-native `$` mentions from the harness catalog (Codex skills).
  const skillMentions = $derived(
    harness && composerSupport(harness).skillMentions
      ? skills
          .filter((item) => item.kind === 'skill' && item.enabled && /^[A-Za-z0-9._:-]+$/.test(item.name))
          .map((item) => ({ name: item.name, mention: `$${item.name}` }))
      : [],
  );
  const mention = $derived(
    menuDismissed || store.safeMode
      ? undefined
      : activeMention(text, caret, { slash: false, at: Boolean(workspaceId), dollar: skillMentions.length > 0 }),
  );
  type Menu = { kind: 'file'; items: ComposerMenuItem[]; paths: string[] } | { kind: 'skill'; items: ComposerMenuItem[]; mentions: string[] };
  const menu = $derived.by((): Menu | undefined => {
    if (!mention) return undefined;
    if (mention.trigger === '@') {
      const paths = trusted ? rankFiles(fileMentions.files, mention.query) : [];
      return { kind: 'file', paths, items: paths.map((path) => ({ key: `file:${path}`, title: path })) };
    }
    const found = rankNamed(skillMentions, mention.query);
    return {
      kind: 'skill',
      mentions: found.map((item) => item.mention),
      items: found.map((item) => ({ key: `skill:${item.name}`, title: item.mention, badge: harness ? harnessMeta(harness).short : undefined })),
    };
  });
  const activeIndex = $derived(menu && menu.items.length ? menuIndex % menu.items.length : 0);
  const menuEmpty = $derived(
    menu?.kind === 'file'
      ? !trusted
        ? $t('Trust this project to mention its files.')
        : fileMentions.loading
          ? $t('Loading project files…')
          : fileMentions.error
            ? $t(fileMentions.error)
            : $t('No matching files')
      : $t('No matches'),
  );

  // Follow the sidebar selection until the user picks a project here.
  $effect(() => {
    if (!workspaceId || !workspaces.some((item) => item.id === workspaceId)) {
      workspaceId = store.selectedWorkspaceId || workspaces[0]?.id || '';
    }
  });

  // Restore a project's remembered choice when the project changes. A catalog
  // refresh (any session event replaces it) only replaces a harness that is
  // no longer available; it never undoes the user's picks.
  let restoredFor: string | undefined;
  $effect(() => {
    const id = workspaceId;
    const kinds = available.map((item) => item.kind);
    untrack(() => {
      const current: NewChatSelection = { harness, modelKey, thinkingLevel, fast, permissionMode };
      const next = restoredFor === id ? reconcileSelection(current, kinds, saved[id]) : restoredSelection(saved[id], kinds);
      restoredFor = id;
      if (next === current) return;
      harness = next.harness;
      modelKey = next.modelKey;
      thinkingLevel = next.thinkingLevel;
      fast = next.fast;
      permissionMode = next.permissionMode;
    });
  });

  $effect(() => {
    const id = workspaceId;
    const kind = harness;
    models = [];
    skills = [];
    modelsError = '';
    if (!id || !kind) return;
    if (workspace && !workspace.personal && workspace.trust !== 'trusted') return;
    let cancelled = false;
    modelsLoading = true;
    harnessModels({ workspaceId: id, harness: kind })
      .then((result) => {
        if (cancelled) return;
        models = result.models;
        skills = result.resources.items;
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

  // Project file names for `@`, only for a trusted project.
  $effect(() => {
    if (mention?.trigger === '@' && trusted) fileMentions.update(workspaceId, mention.query);
  });

  onMount(() => {
    const unregister = composerDropTargets.register((dropId) => {
      if (workspaceId && trusted) void attachments.redeem(workspaceId, dropId, imageState);
    });
    return () => {
      unregister();
      fileMentions.dispose();
    };
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
  const modelOptions = $derived<ModelOption[]>(
    models.map((item) => ({
      key: JSON.stringify([item.provider, item.id]),
      name: item.name,
      id: item.id,
      ...(item.provider ? { provider: item.provider } : {}),
      reasoning: Boolean(item.thinkingLevels?.length),
      fast: Boolean(item.supportsFast),
    })),
  );
  const permissionItems = $derived<PickerItem<PermissionMode>[]>([
    { value: 'native', label: $t('Harness settings'), description: $t('Use the permissions configured in the harness') },
    { value: 'read-only', label: $t('Read only'), description: $t('The agent can read but not change files') },
    { value: 'workspace-write', label: $t('Edit project'), description: $t('Changes limited to the project folder') },
    { value: 'full-access', label: $t('Full access'), description: $t('No native restrictions — use with care') },
  ]);

  const canSend = $derived(
    Boolean(text.trim()) && Boolean(workspaceId) && Boolean(harness) && !busy && !store.safeMode,
  );

  function setText(value: string): void {
    text = value;
    store.updateDraft(DRAFT_KEY, value);
  }

  async function place(value: string, position: number): Promise<void> {
    setText(value);
    caret = position;
    menuIndex = 0;
    await tick();
    textarea?.focus();
    textarea?.setSelectionRange(position, position);
  }

  function syncCaret(): void {
    caret = textarea?.selectionStart ?? text.length;
  }

  function choose(index: number): void {
    const current = menu;
    if (!current || !mention) return;
    const replacement = current.kind === 'file' ? (current.paths[index] ? fileMention(current.paths[index]) : undefined) : current.mentions[index];
    if (!replacement) return;
    const next = replaceMention(text, mention, replacement);
    void place(next.text, next.caret);
  }

  async function send(): Promise<void> {
    if (!canSend || !harness) return;
    if (workspace && !workspace.personal && workspace.trust !== 'trusted') {
      onTrust(workspace);
      return;
    }
    busy = true;
    remember();
    const message = text;
    // The images move to the new chat: to its queued message, or to its draft if sending fails.
    const images = attachments.images;
    try {
      await store.startChat({
        workspaceId,
        harness,
        model,
        permissionMode,
        thinkingLevel: thinkingLevel || undefined,
        serviceTier: model?.supportsFast ? (fast ? 'fast' : undefined) : undefined,
        text: message,
        ...(images.length ? { attachments: images } : {}),
      });
      attachments.handOver();
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
    const items = menu?.items ?? [];
    if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      menuIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    } else if (event.key === 'Escape' && menu) {
      event.preventDefault();
      menuDismissed = true;
    } else if (items.length && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function pasted(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || !workspaceId) return;
    event.preventDefault();
    void attachments.paste(workspaceId, files, imageState);
  }

  const carriesFiles = (event: DragEvent): boolean => Boolean(event.dataTransfer?.types.includes('Files'));

  function dropped(event: DragEvent): void {
    htmlDragging = false;
    if (!carriesFiles(event) || !workspaceId) return;
    event.preventDefault();
    void attachments.paste(workspaceId, [...(event.dataTransfer?.files ?? [])], imageState);
  }

  function pick(): void {
    if (workspace && !trusted) {
      onTrust(workspace);
      return;
    }
    if (workspaceId) void attachments.pick(workspaceId, imageState);
  }

  function insertReferences(): void {
    const references = attachments.confirmReferences();
    if (!references) return;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const lead = before && !/\s$/u.test(before) ? ' ' : '';
    const trail = after.startsWith(' ') ? '' : ' ';
    void place(`${before}${lead}${references}${trail}${after}`, before.length + lead.length + references.length + trail.length);
  }

  export function focus(): void {
    textarea?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (Drop target for files; the paperclip is the keyboard path.) -->
<div
  class="composer"
  class:composer--busy={busy}
  class:composer--drop={htmlDragging || composerDropTargets.dragging}
  ondragover={(event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    htmlDragging = true;
  }}
  ondragleave={() => (htmlDragging = false)}
  ondrop={dropped}
>
  <!-- Menus, chips, notices and the reference dialog load on first use: the Home composer is on the first paint. -->
  {#if menu}
    {#await import('../chat/composer/MentionMenu.svelte') then view}
      <view.default
        id="new-chat-menu"
        label={menu.kind === 'file' ? $t('Project files') : $t('Skills')}
        items={menu.items}
        active={activeIndex}
        loading={menu.kind === 'file' && fileMentions.loading}
        emptyText={menuEmpty}
        onPick={choose}
      />
    {/await}
  {/if}
  {#if attachments.images.length}
    {#await import('../chat/composer/AttachmentChips.svelte') then view}
      <view.default images={attachments.images} disabled={busy} onRemove={(id: string) => void attachments.remove(id)} />
    {/await}
  {/if}
  {#if attachments.images.length && !imageState.supported}
    <p class="composer__warning" role="alert">{$t(imageState.reason ?? '')} {$t('Remove the images to send this message.')}</p>
  {/if}
  {#if attachments.notices.length}
    {#await import('../chat/composer/AttachmentNotices.svelte') then view}
      <view.default notices={attachments.notices} onDismiss={() => attachments.dismissNotices()} />
    {/await}
  {/if}
  <Textarea
    bind:ref={textarea}
    value={text}
    oninput={(event) => {
      setText(event.currentTarget.value);
      syncCaret();
      menuDismissed = false;
      menuIndex = 0;
    }}
    onkeydown={keydown}
    onkeyup={(event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) syncCaret();
    }}
    onclick={syncCaret}
    onpaste={pasted}
    minRows={3}
    maxRows={14}
    placeholder={$t('Describe a task, ask a question or @mention a file…')}
    aria-label={$t('Message')}
    aria-autocomplete="list"
    aria-controls={menu ? 'new-chat-menu' : undefined}
    aria-activedescendant={menu && menu.items.length ? `new-chat-menu-${activeIndex}` : undefined}
    class="composer__input"
    disabled={store.safeMode}
  />
  <div class="composer__bar">
    <div class="chips">
      <AttachButton images={imageState} busy={attachments.busy} disabled={busy || store.safeMode || !workspaceId} onPick={pick} />
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
        <ModelPicker
          models={modelOptions}
          value={modelKey}
          defaultOption={true}
          loading={modelsLoading}
          error={modelsError}
          {levels}
          level={thinkingLevel}
          levelDefault={true}
          fastAvailable={Boolean(model?.supportsFast)}
          {fast}
          hint={model ? $t('This model has no reasoning options.') : $t('Pick a model to tune reasoning.')}
          onModel={(value) => (modelKey = value)}
          onLevel={(value) => (thinkingLevel = value)}
          onFast={(value) => (fast = value)}
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
        </ModelPicker>
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

      <WorktreeChip {workspace} disabled={store.safeMode} />
    </div>
    <button type="button" class="send" onclick={() => void send()} disabled={!canSend} aria-label={$t('Start chat')}>
      {#if busy}<Spinner size={14} />{:else}<ArrowUp size={16} />{/if}
    </button>
  </div>
  {#if htmlDragging || composerDropTargets.dragging}
    <div class="composer__drop" aria-hidden="true">{$t('Drop images or files to attach')}</div>
  {/if}
</div>
{#if harness === 'claude-code' && workspaceId}{#await import('../chat/ClaudeSignInStatus.svelte') then status}<status.default {workspaceId} observe />{/await}{/if}
{#if workspace && !workspace.personal && workspace.trust !== 'trusted'}
  <p class="notice">
    {$t('This folder is restricted. Trust it to let agents work on its files.')}
    <button type="button" class="link" onclick={() => onTrust(workspace)}>{$t('Review trust…')}</button>
  </p>
{:else if modelsError && modelsError !== workspaceError({ code: 'SIGN_IN_REQUIRED' }).message}
  <p class="notice notice--error">{modelsError}</p>
{/if}
{#if attachments.references.length}
  {#await import('../chat/composer/ReferenceDialog.svelte') then view}
    <view.default references={attachments.references} onConfirm={insertReferences} onCancel={() => attachments.cancelReferences()} />
  {/await}
{/if}

<style>
  .composer {
    position: relative;
    border: 1px solid var(--piui-border);
    border-radius: 14px;
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-1);
    transition: border-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .composer:focus-within {
    border-color: var(--piui-border-strong);
  }
  .composer--drop {
    border-color: var(--piui-focus);
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
  .composer__warning {
    margin: 8px 12px 0;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .composer__bar {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 6px 8px 8px 10px;
  }
  .composer__drop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 14px;
    background: color-mix(in srgb, var(--piui-surface-1) 88%, transparent);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    pointer-events: none;
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
