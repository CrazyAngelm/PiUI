<script lang="ts">
  import MarkdownContent from '../../components/MarkdownContent.svelte';
  import type { TimelineBlock } from '../../host-api/types';
  import ActivityGroup from './ActivityGroup.svelte';
  import { groupTimelineBlocks, type TimelineActivityGroup } from './timelineView';

  export let blocks: TimelineBlock[] = [];
  export let loading = false;
  export let sessionKey: string | undefined = undefined;

  let rememberedSessionKey = sessionKey;
  let activityOpenState: Record<string, boolean> = {};

  const labels: Record<TimelineBlock['kind'], string> = {
    user: 'You',
    assistant: 'Pi',
    thinking: 'Reasoning',
    tool: 'Tool activity',
    custom: 'Extension message',
    error: 'Runtime notice',
    compaction: 'Context compacted',
    unknown: 'Unsupported session event',
  };

  $: if (sessionKey !== rememberedSessionKey) {
    rememberedSessionKey = sessionKey;
    activityOpenState = {};
  }
  $: viewItems = groupTimelineBlocks(blocks);

  function activityGroupOpen(group: TimelineActivityGroup): boolean | undefined {
    const remembered = group.blocks.find((block) => activityOpenState[block.id] !== undefined);
    return remembered === undefined ? undefined : activityOpenState[remembered.id];
  }

  function rememberActivityGroupOpen(group: TimelineActivityGroup, open: boolean): void {
    const next = { ...activityOpenState };
    for (const block of group.blocks) next[block.id] = open;
    activityOpenState = next;
  }

  function kindClass(kind: TimelineBlock['kind']): string {
    return `block--${kind}`;
  }

  function displayTime(value: string): string {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fullTime(value: string): string {
    return new Date(value).toLocaleString();
  }
</script>

<section class="timeline" aria-label="Session timeline">
  {#if blocks.length === 0 && loading}
    <div class="loading-block" aria-label="Loading session timeline">
      <span class="skeleton line line--short"></span>
      <span class="skeleton line"></span>
      <span class="skeleton line line--wide"></span>
    </div>
  {:else if blocks.length === 0}
    <p class="empty-timeline">This session has no readable timeline entries.</p>
  {:else}
    {#each viewItems as item (item.type === 'activity-group' ? item.id : item.block.id)}
      {#if item.type === 'activity-group'}
        <ActivityGroup
          group={item}
          initialOpen={activityGroupOpen(item)}
          onOpenChange={(open) => rememberActivityGroupOpen(item, open)}
        />
      {:else}
        {@const block = item.block}
        <article class={`block ${kindClass(block.kind)}`} class:block--fallback={block.fallback} class:block--failed={block.status === 'failed'} class:block--interrupted={block.status === 'interrupted'} data-timeline-block={block.id}>
          {#if block.kind === 'compaction'}
            <div class="event-row"><span></span><strong>{block.label ?? labels.compaction}</strong>{#if block.text || block.safeSummary}<span>{block.text ?? block.safeSummary}</span>{/if}</div>
          {:else if block.kind === 'custom' || block.kind === 'unknown'}
            <details class="activity-disclosure fallback-disclosure">
              <summary>
                <span class="activity-chevron" aria-hidden="true">›</span>
                <span class="activity-title">{block.label ?? labels[block.kind]}</span>
                {#if block.fallback}<span class="fallback-label">Compatibility view</span>{/if}
              </summary>
              {#if block.text}<div class="extension-content"><MarkdownContent source={block.text} compact={true} /></div>
              {:else}<p class="activity-summary">{block.safeSummary ?? 'This session event is not supported by a richer renderer yet.'}</p>{/if}
            </details>
          {:else}
            <header>
              <span>{block.label ?? labels[block.kind]}</span>
              {#if block.status === 'streaming'}<span class="streaming-label">Writing…</span>
              {:else if block.status === 'failed'}<span class="failure-label">Failed</span>
              {:else if block.status === 'interrupted'}<span class="interrupted-label">Stopped</span>{/if}
              {#if block.createdAt}<time datetime={block.createdAt} title={fullTime(block.createdAt)}>{displayTime(block.createdAt)}</time>{/if}
            </header>
            {#if block.text}
              <MarkdownContent source={block.text} />
              {#if block.truncated}<p class="truncation-note">Long message was shortened to keep this session responsive.</p>{/if}
            {:else if block.safeSummary}
              <p class="safe-summary">{block.safeSummary}</p>
            {/if}
          {/if}
        </article>
      {/if}
    {/each}
  {/if}
</section>

<style>
  .timeline { width: min(100%, var(--piui-chat-column-width)); min-width: 0; margin: 0 auto; padding: clamp(30px, 5vw, 58px) var(--piui-chat-inline-padding) 120px; }
  .block { position: relative; min-width: 0; max-width: 100%; margin: 0 0 30px; }
  .block header { display: flex; min-height: 20px; align-items: baseline; gap: var(--piui-space-2); margin-bottom: 7px; color: var(--piui-text-muted); font-size: 11px; font-weight: 720; letter-spacing: .02em; }
  .block time { margin-left: 2px; color: var(--piui-text-faint); font-size: 10px; font-variant-numeric: tabular-nums; font-weight: 500; opacity: 0; transition: opacity 140ms ease; }
  .block:hover time, .block:focus-within time { opacity: 1; }
  .streaming-label { color: var(--piui-accent); font-size: 10px; font-weight: 600; }
  .failure-label { color: var(--piui-danger-text); font-size: 10px; font-weight: 650; }.interrupted-label { color: var(--piui-warning-text); font-size: 10px; font-weight: 650; }
  .block--assistant { padding-left: 2px; }.block--assistant.block--failed, .block--assistant.block--interrupted { padding-left: 12px; border-left: 2px solid var(--piui-danger-border); border-radius: 1px; }.block--assistant.block--interrupted { border-left-color: var(--piui-warning-border); }
  .block--user { width: fit-content; max-width: min(78%, var(--piui-chat-reading-width)); margin-left: auto; padding: 13px 15px 14px; border: 1px solid var(--piui-user-border); border-radius: 14px; background: var(--piui-user-surface); }
  .block--user header { margin-bottom: 5px; color: var(--piui-accent); }
  .block--user :global(.markdown-content) { font-size: var(--piui-chat-user-font-size); line-height: 1.58; }
  .activity-disclosure { margin: 0 0 18px 14px; color: var(--piui-text-muted); }
  .activity-disclosure summary { display: grid; grid-template-columns: 14px minmax(0, auto) auto; width: fit-content; max-width: 100%; align-items: center; gap: 7px; min-height: 28px; border-radius: 7px; cursor: pointer; list-style: none; font-size: 11px; }
  .activity-disclosure summary::-webkit-details-marker { display: none; }
  .activity-disclosure summary:hover { color: var(--piui-text); }
  .activity-disclosure summary:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 3px; }
  .activity-chevron { color: var(--piui-text-faint); font-size: 18px; line-height: 1; transform: translateY(-1px); transition: transform 140ms ease; }
  .activity-disclosure[open] .activity-chevron { transform: rotate(90deg) translateX(-1px); }
  .activity-title { overflow: hidden; color: inherit; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .extension-content { max-width: min(100%, var(--piui-chat-reading-width)); margin: 5px 0 0 21px; overflow: hidden; border: 1px solid var(--piui-border-subtle); border-radius: 9px; background: color-mix(in srgb, var(--piui-bg) 72%, var(--piui-surface-1)); padding: 12px 14px; }
  .activity-summary { max-width: var(--piui-chat-reading-width); margin: 5px 0 0 21px; color: var(--piui-text-muted); font-size: calc(var(--piui-chat-font-size) - 3px); line-height: 1.55; }
  .fallback-disclosure { margin-top: 0; }.fallback-label { color: var(--piui-text-faint); font-size: 9px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
  .event-row { display: flex; align-items: center; gap: 9px; margin: 8px 0 28px; color: var(--piui-text-faint); font-size: 10px; }
  .event-row > span:first-child { width: 22px; height: 1px; background: var(--piui-border); }.event-row strong { color: var(--piui-text-muted); font-size: 10px; }.event-row > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .block--error { padding: 12px 14px; border: 1px solid var(--piui-danger-border); border-radius: var(--piui-radius-sm); background: var(--piui-danger-surface); color: var(--piui-danger-text); }
  .safe-summary { max-width: var(--piui-chat-reading-width); margin: 0; color: var(--piui-text-muted); font-size: calc(var(--piui-chat-font-size) - 2px); line-height: 1.55; }
  .truncation-note { margin: 8px 0 0; color: var(--piui-text-muted); font-size: 10px; line-height: 1.45; }
  .loading-block { display: grid; gap: var(--piui-space-3); max-width: 680px; padding: var(--piui-space-4); }.empty-timeline { margin: 0; color: var(--piui-text-muted); font-size: 13px; line-height: 1.5; }
  .line { display: block; width: 68%; height: 12px; border-radius: 4px; }.line--short { width: 20%; }.line--wide { width: 88%; }
  @media (max-width: 700px) { .timeline { width: 100%; padding-right: 14px; padding-bottom: 96px; padding-left: 14px; }.block--user { max-width: 92%; }.activity-disclosure { margin-left: 4px; }.extension-content, .activity-summary { margin-left: 15px; } }
</style>
