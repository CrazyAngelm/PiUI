<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import Pencil from '@lucide/svelte/icons/pencil';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { IconButton } from '../../lib/ui';
  import { useTranslation } from '../../features/locale/context';
  import { messageActionKey } from './conversationController.svelte';
  import type { ConversationMessageControls, ConversationMessageAction } from '../../../../../contracts/conversation-presentation-v1';

  let { controls, createdAt, available, busyActions, error, onAction }: {
    controls: ConversationMessageControls;
    createdAt: string | undefined;
    available: boolean;
    busyActions: Readonly<Record<string, boolean>>;
    error: string;
    onAction: ((id: string, action: ConversationMessageAction) => Promise<void>) | undefined;
  } = $props();
  const t = useTranslation();
  // The parent keys this component by control ID. Capture its target and bound
  // owner once, so an old connected button cannot resample newer props.
  const controlId = untrack(() => controls.id);
  const dispatch = untrack(() => onAction);
  const labels = { copy: 'Copy message', edit: 'Edit and send again', branch: 'Branch into a new chat', repeat: 'Repeat request', refresh: 'Refresh conversation' };
  const icons = { copy: Copy, edit: Pencil, branch: GitBranch, repeat: RotateCcw, refresh: RefreshCw };
  let localError = $state('');
  let disposed = false;
  onDestroy(() => { disposed = true; });
  $effect(() => { controls.id; localError = ''; });

  async function perform(action: ConversationMessageAction): Promise<void> {
    const id = controlId;
    localError = '';
    try { await dispatch?.(id, action); }
    catch {
      if (!disposed && controls.id === id) localError = 'Could not complete the message action.';
    }
  }
</script>

{#if controls.actions.length || controls.usage || createdAt}
  <div class="message-controls" role="group" aria-label={$t('Message actions')}>
    {#if createdAt}<time datetime={createdAt}>{new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{/if}
    {#if controls.usage}<span class="usage" title={controls.usage.description}>{controls.usage.label}</span>{/if}
    {#each controls.actions as action (action.kind)}
      {@const busy = action.busy || busyActions[messageActionKey(controls.id, action.kind)]}
      {@const Icon = action.kind === 'copy' && controls.copied ? Check : icons[action.kind]}
      <IconButton size="sm" label={$t(action.kind === 'copy' && controls.copied ? 'Copied' : labels[action.kind])}
        disabled={!available || action.disabled || busy} aria-busy={busy ? 'true' : undefined}
        onclick={() => void perform(action.kind)}><Icon size={14} /></IconButton>
    {/each}
  </div>
{/if}
{#if error || localError}<p class="message-error" role="alert">{$t(error || localError)}</p>{/if}

<style>
  .message-controls { display: flex; align-items: center; flex-wrap: wrap; gap: var(--piui-space-2); color: var(--piui-text-muted); padding: var(--piui-space-1) 0; }
  time, .usage { font-size: var(--piui-text-xs); }
  .message-error { color: var(--piui-danger); font-size: var(--piui-text-sm); margin: var(--piui-space-1) 0; }
</style>
