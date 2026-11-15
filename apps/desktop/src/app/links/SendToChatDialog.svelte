<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { Button, Dialog, Field, Textarea, toasts } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import { MAX_LINK_MESSAGE, validLinkMessage } from './linkCandidates';
  import { liveChats } from './liveChats';
  import { sessionLinks } from './sessionLinks.svelte';

  /** Sends a person's message from this chat to one of its linked chats. */
  interface Props {
    sessionId: string;
    onClose: () => void;
  }
  let { sessionId, onClose }: Props = $props();
  const store = useWorkspace();

  const targets = $derived(liveChats(sessionLinks.peek(sessionId) ?? [], store.catalog.sessions));
  // The chat shown first is chosen when the dialog opens, so the message never goes to a chat the person did not pick.
  let chosen = $state<string | undefined>(untrack(() => sessionLinks.peek(sessionId)?.[0]?.sessionId));
  let text = $state('');
  let busy = $state(false);
  let error = $state('');

  // A chosen chat that gets unlinked meanwhile is not replaced by another one: the person picks again.
  const gone = $derived(chosen !== undefined && !targets.some((chat) => chat.sessionId === chosen));
  const targetId = $derived(gone ? undefined : (chosen ?? targets[0]?.sessionId));
  const target = $derived(targets.find((chat) => chat.sessionId === targetId));
  const valid = $derived(validLinkMessage(text));
  const tooLong = $derived([...text].length > MAX_LINK_MESSAGE);
  const selectId = `send-target-${untrack(() => sessionId)}`;
  const textId = `send-text-${untrack(() => sessionId)}`;

  async function submit(): Promise<void> {
    if (busy || !target || !valid || store.safeMode) return;
    busy = true;
    error = '';
    const title = target.title;
    const result = await sessionLinks.send(sessionId, target.sessionId, text);
    busy = false;
    if (result.ok) {
      toasts.success(result.queued ? $t('Queued for {0}. It is delivered when that chat can take it.', [title]) : $t('Sent to {0}', [title]));
      onClose();
    } else {
      error = result.error;
    }
  }
</script>

<Dialog
  open
  title={$t('Send to chat')}
  size="md"
  closeLabel={$t('Close')}
  onOpenChange={(open) => {
    if (!open && !busy) onClose();
  }}
>
  <form
    id="send-to-chat-form"
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <Field label={$t('To')} for={selectId}>
      <select id={selectId} value={targetId ?? ''} disabled={busy} onchange={(event) => (chosen = event.currentTarget.value)}>
        {#if !targetId}<option value="" disabled>{$t('Choose a chat')}</option>{/if}
        {#each targets as chat (chat.sessionId)}
          <option value={chat.sessionId}>{chat.title}</option>
        {/each}
      </select>
    </Field>
    <Field label={$t('Message')} for={textId} error={tooLong ? $t('The message is too long.') : undefined}>
      <Textarea id={textId} bind:value={text} minRows={4} maxRows={12} disabled={busy} invalid={tooLong} />
    </Field>
  </form>
  {#if gone}<p class="error" role="alert">{$t('That chat is no longer linked. Choose another chat.')}</p>{/if}
  {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose} disabled={busy}>{$t('Cancel')}</Button>
    <Button variant="primary" type="submit" form="send-to-chat-form" loading={busy} disabled={!target || !valid || store.safeMode}>{$t('Send')}</Button>
  {/snippet}
</Dialog>

<style>
  form {
    display: grid;
    gap: var(--piui-space-3);
  }
  select {
    width: 100%;
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    font: inherit;
  }
  .error {
    margin: var(--piui-space-2) 0 0;
    color: var(--piui-danger);
  }
</style>
