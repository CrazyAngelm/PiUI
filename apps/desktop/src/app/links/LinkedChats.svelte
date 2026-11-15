<script lang="ts">
  import Columns2 from '@lucide/svelte/icons/columns-2';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Link2 from '@lucide/svelte/icons/link-2';
  import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
  import Unlink from '@lucide/svelte/icons/unlink';
  import { untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { sessionsToolNotice, type SessionNoticeCode } from '../../features/workspace/sessionNotices';
  import type { HarnessKind } from '../../../../../contracts/workspace-v15';
  import type { LinkedChatV1 } from '../../host-api/sessionLinksClient';
  import { Badge, Button, IconButton, Menu, toasts, type MenuEntry } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { useWorkspace } from '../shell/context';
  import { liveChats } from './liveChats';
  import { sessionLinks } from './sessionLinks.svelte';

  /** Chat details: the chats this chat is linked to, with their latest report and what waits for delivery. */
  interface Props {
    sessionId: string;
    harness: HarnessKind;
    notices: readonly SessionNoticeCode[];
  }
  let { sessionId, harness, notices }: Props = $props();
  const store = useWorkspace();

  $effect(() => {
    const id = sessionId;
    untrack(() => void sessionLinks.load(id));
  });

  // The state and title come from the catalog, which follows every chat; the cache is read again only on link changes.
  const chats = $derived(liveChats(sessionLinks.peek(sessionId) ?? [], store.catalog.sessions));
  const cannotUse = $derived(sessionsToolNotice(harness, notices) !== undefined);
  let busy = $state<string | undefined>(undefined);

  const titleOf = (chat: LinkedChatV1): string => chat.title || harnessMeta(chat.harness).label;

  function badge(chat: LinkedChatV1): { tone: 'accent' | 'danger'; label: string } | undefined {
    switch (chat.state) {
      case 'starting':
        return { tone: 'accent', label: $t('Starting') };
      case 'running':
        return { tone: 'accent', label: $t('Running') };
      case 'failed':
        return { tone: 'danger', label: $t('Failed') };
      default:
        return undefined;
    }
  }

  /** Shows the chat in a pane beside this one, like the sidebar's "Open to the side". */
  function openBeside(chat: LinkedChatV1): void {
    void import('../shell/panes/workbench.svelte')
      .then(({ workbench }) => {
        if (workbench.openBeside(chat.sessionId)) void store.openSession(chat.sessionId);
        else if (workbench.full) toasts.error($t('Four chats are on screen. Close one first.'));
      })
      .catch(() => undefined);
  }

  async function deliver(chat: LinkedChatV1): Promise<void> {
    busy = chat.sessionId;
    const result = await sessionLinks.deliver(sessionId, chat.sessionId);
    busy = undefined;
    if (!result.ok) toasts.error($t(result.error));
  }

  async function unlink(chat: LinkedChatV1): Promise<void> {
    const result = await sessionLinks.unlink(sessionId, chat.sessionId);
    if (!result.ok) toasts.error($t(result.error));
  }

  function items(chat: LinkedChatV1): MenuEntry[] {
    return [
      { label: $t('Open'), icon: SquareArrowOutUpRight, onSelect: () => void store.openSession(chat.sessionId) },
      { label: $t('Open to the side'), icon: Columns2, onSelect: () => openBeside(chat) },
      ...(chat.kind === 'peer' ? [{ label: $t('Unlink'), icon: Unlink, disabled: store.safeMode, onSelect: () => void unlink(chat) }] : []),
    ];
  }
</script>

{#if chats.length > 0}
  <section class="links" aria-labelledby="linked-chats-title-{sessionId}">
    <h3 id="linked-chats-title-{sessionId}"><Link2 size={13} /> {$t('Linked chats')}</h3>
    <ul>
      {#each chats as chat (chat.sessionId)}
        {@const marker = badge(chat)}
        <li>
          <div class="row">
            <button type="button" class="open" onclick={() => void store.openSession(chat.sessionId)}>
              <HarnessMark kind={chat.harness} size={16} decorative={false} />
              <span class="title">{titleOf(chat)}</span>
            </button>
            {#if marker}<Badge tone={marker.tone}>{marker.label}</Badge>{/if}
            <Menu align="end" items={items(chat)}>
              {#snippet trigger(props)}
                <IconButton label={$t('Options for {0}', [titleOf(chat)])} size="sm" tooltip={false} {...props}><Ellipsis /></IconButton>
              {/snippet}
            </Menu>
          </div>
          {#if chat.pending > 0}
            <div class="row">
              <span class="note">{$t('{0} waiting', [chat.pending])}</span>
              <Button size="sm" variant="ghost" loading={busy === chat.sessionId} disabled={store.safeMode} onclick={() => void deliver(chat)}>{$t('Deliver')}</Button>
            </div>
          {/if}
          {#if chat.lastReport}<p class="report">{chat.lastReport.excerpt}</p>{/if}
        </li>
      {/each}
    </ul>
    {#if cannotUse}<p class="note">{$t('The agent in this chat cannot use linked chats.')}</p>{/if}
  </section>
{/if}

<style>
  .links {
    display: grid;
    gap: var(--piui-space-2);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  ul {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    gap: 2px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--piui-space-1);
  }
  .open {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    text-align: left;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .row .note {
    flex: 1;
  }
  .report {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    margin: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
</style>
