<script lang="ts">
  import { t } from '../../features/locale/language';
  import { Button, Dialog, Input, toasts } from '../../lib/ui';
  import { fusionMembership } from '../fusion/fusionMembership.svelte';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { useWorkspace } from '../shell/context';
  import { linkCandidates } from './linkCandidates';
  import { sessionLinks } from './sessionLinks.svelte';

  /** Links this chat to another chat of the same project as peers. */
  interface Props {
    sessionId: string;
    onClose: () => void;
  }
  let { sessionId, onClose }: Props = $props();
  const store = useWorkspace();

  let query = $state('');
  let choice = $state<string | undefined>(undefined);
  let busy = $state(false);
  let error = $state('');

  const current = $derived(store.catalog.sessions.find((session) => session.id === sessionId));
  const linked = $derived(new Set((sessionLinks.peek(sessionId) ?? []).map((chat) => chat.sessionId)));
  const candidates = $derived(
    current === undefined
      ? []
      : linkCandidates(store.sessionsFor(current.workspaceId), { current: sessionId, linked, excluded: (id) => fusionMembership.isSidekick(id), query }),
  );
  const target = $derived(candidates.find((session) => session.id === choice));

  async function confirm(): Promise<void> {
    if (busy || !target || store.safeMode) return;
    busy = true;
    error = '';
    // Once linked, the chat leaves the candidates, and `target` with it.
    const chosen = target;
    const result = await sessionLinks.link(sessionId, chosen.id);
    busy = false;
    if (result.ok) {
      toasts.success($t('Linked to {0}', [chosen.title]));
      onClose();
    } else {
      error = result.error;
    }
  }
</script>

<Dialog
  open
  title={$t('Link chat')}
  size="sm"
  closeLabel={$t('Close')}
  onOpenChange={(open) => {
    if (!open && !busy) onClose();
  }}
>
  <form
    id="link-chat-form"
    onsubmit={(event) => {
      event.preventDefault();
      void confirm();
    }}
  >
    <Input bind:value={query} type="search" aria-label={$t('Search chats')} placeholder={$t('Search chats')} disabled={busy} />
    <div class="list" role="radiogroup" aria-label={$t('Chats')}>
      {#each candidates as session (session.id)}
        <label class="pick" class:pick--chosen={choice === session.id}>
          <input type="radio" name="link-chat" value={session.id} bind:group={choice} disabled={busy} />
          <HarnessMark kind={session.harness} size={16} />
          <span class="pick__title">{session.title}</span>
        </label>
      {:else}
        <p class="empty">{$t('No chats to link')}</p>
      {/each}
    </div>
  </form>
  {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose} disabled={busy}>{$t('Cancel')}</Button>
    <Button variant="primary" type="submit" form="link-chat-form" loading={busy} disabled={!target || store.safeMode}>{$t('Link')}</Button>
  {/snippet}
</Dialog>

<style>
  form {
    display: grid;
    gap: var(--piui-space-2);
  }
  form :global(.input) {
    width: 100%;
  }
  .list {
    display: grid;
    align-content: start;
    gap: 1px;
    max-height: 240px;
    overflow-y: auto;
  }
  .pick {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 30px;
    padding: 0 var(--piui-space-2);
    border-radius: var(--piui-radius-sm);
    cursor: pointer;
  }
  .pick:hover {
    background: var(--piui-hover);
  }
  .pick--chosen {
    background: var(--piui-selected);
  }
  .pick:has(input:focus-visible) {
    outline: 2px solid var(--piui-focus);
    outline-offset: -2px;
  }
  .pick input {
    flex: none;
    margin: 0;
    accent-color: var(--piui-accent);
  }
  .pick__title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    margin: 0;
    padding: var(--piui-space-2);
    color: var(--piui-text-muted);
  }
  .error {
    margin: var(--piui-space-2) 0 0;
    color: var(--piui-danger);
  }
</style>
