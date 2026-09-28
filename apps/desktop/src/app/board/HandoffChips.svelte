<script lang="ts">
  import { untrack } from 'svelte';
  import UserRoundPlus from '@lucide/svelte/icons/user-round-plus';
  import { t } from '../../features/locale/language';
  import { Tooltip, toasts } from '../../lib/ui';
  import { errorMessage } from '../workspaceStore.svelte';
  import TeammateAvatar from '../team/TeammateAvatar.svelte';
  import { teammates } from '../team/teammatesStore.svelte';
  import type { TeammateV1 } from '../../host-api/teammatesClient';
  import { mentionSpans } from '../team/handle';
  import { boards } from './boardStore.svelte';
  import { activeCardOf, handoffPlan, mentionedTeammates } from './chatBoard';

  /**
   * "Hand off to @x" above the composer when the draft mentions a teammate
   * (docs/BOARD.md "Chat ↔ card"). Sending still only talks to the chat's
   * agent; the chip is the explicit alternative: it creates a card from the
   * message (or uses the chat's active card), assigns the teammate with its
   * own start rule and links the card to this chat.
   */
  interface Props {
    workspaceId: string;
    sessionId: string;
    text: string;
    disabled?: boolean;
    /** Called after a successful handoff; the composer clears the draft. */
    onHandedOff: () => void;
  }
  let { workspaceId, sessionId, text, disabled = false, onHandedOff }: Props = $props();

  // Loaded once the draft mentions someone; plain chats never touch the board.
  const wanted = $derived(text.includes('@'));
  $effect(() => {
    const id = workspaceId;
    if (!wanted) return;
    untrack(() => {
      boards.ensure([id]);
      void teammates.ensure(id);
    });
  });
  const board = $derived(boards.stores.get(workspaceId));
  const team = $derived(teammates.list(workspaceId));
  const mentioned = $derived(board?.enabled && wanted ? mentionedTeammates(text, team).slice(0, 3) : []);
  const active = $derived(activeCardOf(board?.board, sessionId));
  let busy = $state<string | undefined>();

  function tooltip(teammate: TeammateV1): string {
    return active
      ? $t('Assign #{0} to @{1} and add this message to the card as a comment. Nothing is sent to the agent.', [active.number, teammate.handle])
      : $t('Create a card from this message, assign it to @{0} and link it to this chat. Nothing is sent to the agent.', [teammate.handle]);
  }

  async function handOff(teammate: TeammateV1): Promise<void> {
    const target = board;
    const plan = handoffPlan(text, teammate, active);
    if (!target || !plan) return;
    busy = teammate.id;
    try {
      if (plan.kind === 'assign') {
        await target.comment(plan.cardId, plan.comment, mentionSpans(plan.comment, team));
        await target.assign(plan.cardId, plan.teammateId, 'ask');
        toasts.success($t('Handed #{0} to @{1}', [plan.cardNumber, teammate.handle]));
      } else {
        const card = await target.createCard({ title: plan.title, description: plan.description }, undefined, sessionId);
        if (!card) throw new Error('The board operation could not be completed.');
        await target.assign(card.id, plan.teammateId, 'ask');
        toasts.success($t('Handed #{0} to @{1}', [card.number, teammate.handle]));
      }
      onHandedOff();
    } catch (error) {
      toasts.error($t('Could not hand off to @{0}', [teammate.handle]), $t(errorMessage(error)));
    } finally {
      busy = undefined;
    }
  }
</script>

{#if mentioned.length}
  <div class="handoff" role="group" aria-label={$t('Hand off to a teammate')}>
    {#each mentioned as teammate (teammate.id)}
      {@const planned = handoffPlan(text, teammate, active) !== undefined}
      <Tooltip content={tooltip(teammate)}>
        {#snippet trigger(props)}
          <button
            type="button"
            class="handoff__chip"
            {...props}
            disabled={disabled || busy !== undefined || !planned}
            aria-busy={busy === teammate.id || undefined}
            aria-label={active ? $t('Hand #{0} off to @{1}', [active.number, teammate.handle]) : $t('Hand off to @{0}', [teammate.handle])}
          >
            <UserRoundPlus size={12} aria-hidden="true" />
            <TeammateAvatar avatar={teammate.avatar} color={teammate.color} size={16} />
            <span>{active ? $t('Hand #{0} off to @{1}', [active.number, teammate.handle]) : $t('Hand off to @{0}', [teammate.handle])}</span>
          </button>
        {/snippet}
      </Tooltip>
    {/each}
  </div>
{/if}

<style>
  .handoff {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px 0;
  }
  .handoff__chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 8px;
    border: 1px dashed var(--piui-border);
    border-radius: var(--piui-radius-full);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .handoff__chip:hover:not(:disabled) {
    border-style: solid;
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .handoff__chip:disabled {
    opacity: 0.55;
  }
</style>
