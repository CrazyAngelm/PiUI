<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { Button, Dialog, Input } from '../../lib/ui';
  import { useWorkspace } from './context';

  interface Props {
    sessionId: string;
    title: string;
    onClose: () => void;
  }
  let { sessionId, title, onClose }: Props = $props();
  const store = useWorkspace();

  let name = $state(untrack(() => title));
  let busy = $state(false);
  let error = $state('');
  const trimmed = $derived(name.trim());

  async function save(): Promise<void> {
    if (busy || !trimmed || trimmed === title) return;
    busy = true;
    error = '';
    const failure = await store.renameChat(sessionId, trimmed);
    busy = false;
    if (failure === undefined) onClose();
    else error = failure;
  }
</script>

<Dialog
  open
  title={$t('Rename chat')}
  size="sm"
  closeLabel={$t('Close')}
  onOpenChange={(open) => {
    if (!open && !busy) onClose();
  }}
>
  <form
    id="rename-chat-form"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <Input bind:value={name} aria-label={$t('Chat title')} maxlength={120} disabled={busy} invalid={!trimmed} />
  </form>
  {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose} disabled={busy}>{$t('Cancel')}</Button>
    <Button variant="primary" type="submit" form="rename-chat-form" loading={busy} disabled={!trimmed || trimmed === title}>{$t('Save name')}</Button>
  {/snippet}
</Dialog>

<style>
  form :global(.input) {
    width: 100%;
  }
  .error {
    margin: var(--piui-space-2) 0 0;
    color: var(--piui-danger);
  }
</style>
