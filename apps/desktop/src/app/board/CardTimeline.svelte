<script lang="ts">
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import UserRound from '@lucide/svelte/icons/user-round';
  import Cpu from '@lucide/svelte/icons/cpu';
  import Route from '@lucide/svelte/icons/route';
  import { t, language } from '../../features/locale/language';
  import type { BoardActorV1, CardCommentV1, CardV1 } from '../../host-api/boardClient';
  import type { TeammateV1 } from '../../host-api/teammatesClient';
  import { harnessMeta } from '../harnessMeta';
  import { relativeTime } from '../format';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import TeammateAvatar from '../team/TeammateAvatar.svelte';
  import { actorView, changeCopy, STATUS_LABEL, timelineOf } from './boardModel';

  interface Props {
    card: CardV1;
    teammates: readonly TeammateV1[];
    busy: boolean;
    onUndo: (activityId: string) => void;
    onOpenChat: (sessionId: string) => void;
    onOpenRun: (runId: string) => void;
  }
  let { card, teammates, busy, onUndo, onOpenChat, onOpenRun }: Props = $props();

  const entries = $derived(timelineOf(card));
  const handleOf = (teammateId: string | undefined): string => {
    const teammate = teammateId === undefined ? undefined : teammates.find((item) => item.id === teammateId);
    return teammate ? `@${teammate.handle}` : $t('a removed teammate');
  };

  const STATUS_NAMES = new Set<string>(Object.values(STATUS_LABEL));
  /** Status names are UI copy; reasons, handles and field names stay as written. */
  function params(values: readonly (string | number)[]): (string | number)[] {
    return values.map((value) => (typeof value === 'string' && STATUS_NAMES.has(value) ? $t(value) : value));
  }

  /** Body split into plain text and mention spans (stored by teammate id, so renames show the new handle). */
  function segments(comment: CardCommentV1): { text: string; mention: boolean }[] {
    const spans = [...(comment.mentions ?? [])].sort((left, right) => left.start - right.start);
    const parts: { text: string; mention: boolean }[] = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.start < cursor || span.start + span.length > comment.body.length) continue;
      if (span.start > cursor) parts.push({ text: comment.body.slice(cursor, span.start), mention: false });
      parts.push({ text: handleOf(span.teammateId), mention: true });
      cursor = span.start + span.length;
    }
    if (cursor < comment.body.length) parts.push({ text: comment.body.slice(cursor), mention: false });
    return parts;
  }
</script>

{#snippet actor(value: BoardActorV1)}
  {@const view = actorView(value, teammates)}
  {#if view.kind === 'person'}
    <span class="actor"><UserRound size={13} aria-hidden="true" /><strong>{$t('You')}</strong></span>
  {:else if view.kind === 'chatAgent'}
    <span class="actor">
      <HarnessMark kind={view.harness} size={14} />
      <button type="button" class="actor__link" onclick={() => onOpenChat(view.sessionId)} title={$t('Open the chat')}>
        {$t('{0} in a chat', [harnessMeta(view.harness).label])}
      </button>
    </span>
  {:else if view.kind === 'teammate'}
    <span class="actor"><TeammateAvatar avatar={view.teammate.avatar} color={view.teammate.color} size={16} /><strong>@{view.teammate.handle}</strong></span>
  {:else if view.kind === 'runMember'}
    <span class="actor">
      <Route size={13} aria-hidden="true" />
      <button type="button" class="actor__link" onclick={() => onOpenRun(view.runId)}>{$t('A pipeline run')}</button>
    </span>
  {:else}
    <span class="actor"><Cpu size={13} aria-hidden="true" /><strong>PiUI</strong></span>
  {/if}
{/snippet}

<ol class="timeline" aria-label={$t('Activity and comments')}>
  {#each entries as entry (entry.kind === 'comment' ? `c:${entry.comment.id}` : `a:${entry.activity.id}`)}
    {#if entry.kind === 'comment'}
      <li class="entry entry--comment">
        <div class="entry__head">
          {@render actor(entry.comment.actor)}
          <time datetime={entry.at} class="entry__time">{relativeTime(entry.at, $language)}</time>
        </div>
        <p class="comment">
          {#each segments(entry.comment) as part, index (index)}
            {#if part.mention}<span class="comment__mention">{part.text}</span>{:else}{part.text}{/if}
          {/each}
        </p>
      </li>
    {:else}
      {@const copy = changeCopy(entry.activity.change, handleOf)}
      <li class="entry entry--activity">
        <span class="entry__dot" aria-hidden="true"></span>
        {@render actor(entry.activity.actor)}
        <span class="entry__text">{$t(copy.text, params(copy.params))}</span>
        <time datetime={entry.at} class="entry__time">{relativeTime(entry.at, $language)}</time>
        {#if entry.activity.undoable}
          <button type="button" class="undo" onclick={() => onUndo(entry.activity.id)} disabled={busy} aria-label={$t('Undo: {0}', [$t(copy.text, params(copy.params))])}>
            <Undo2 size={12} aria-hidden="true" />{$t('Undo')}
          </button>
        {/if}
      </li>
    {/if}
  {/each}
</ol>

<style>
  .timeline {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .entry {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: var(--piui-text-sm);
  }
  .entry--comment {
    display: grid;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-raised);
  }
  .entry__head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .entry--activity {
    padding: 0 2px;
    color: var(--piui-text-muted);
  }
  .entry__dot {
    width: 5px;
    height: 9px;
    background: color-mix(in srgb, var(--piui-chaos) 55%, transparent);
    clip-path: polygon(40% 0, 100% 0, 60% 100%, 0 100%);
  }
  .entry__text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .entry__time {
    color: var(--piui-text-faint);
    font-size: var(--piui-text-xs);
  }
  .actor {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--piui-text);
  }
  .actor strong {
    font-weight: var(--piui-weight-medium);
  }
  .actor__link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-text);
    font-weight: var(--piui-weight-medium);
    text-decoration: underline;
    text-decoration-color: var(--piui-border-strong);
    text-underline-offset: 2px;
  }
  .comment {
    margin: 0;
    color: var(--piui-text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: var(--piui-leading-normal);
  }
  .comment__mention {
    padding: 0 3px;
    border-radius: var(--piui-radius-xs);
    background: color-mix(in srgb, var(--piui-chaos) 14%, transparent);
    color: var(--piui-chaos);
    font-weight: var(--piui-weight-medium);
  }
  .undo {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: auto;
    padding: 1px 6px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .undo:hover:not(:disabled) {
    color: var(--piui-text);
    border-color: var(--piui-chaos);
  }
</style>
