<script lang="ts">
  import { onMount } from 'svelte';
  import MarkdownContent from '../../components/MarkdownContent.svelte';
  import type { TimelineBlock } from '../../host-api/types';
  import {
    activityBlockTitle,
    activityStatusLabel,
    shouldAutoOpenActivity,
    type TimelineActivityGroup,
  } from './timelineView';

  export let group: TimelineActivityGroup;
  export let initialOpen: boolean | undefined = undefined;
  export let onOpenChange: (open: boolean) => void = () => {};

  let groupOpen = initialOpen ?? group.autoOpen;
  let groupTouched = false;
  let mounted = false;
  let rowOpenState: Record<string, boolean> = {};
  let copiedOutputId: string | undefined;

  onMount(() => {
    mounted = true;
  });

  // Add newly streamed blocks without resetting the disclosure state of rows
  // the user has already inspected or collapsed.
  $: {
    let changed = false;
    const next = { ...rowOpenState };
    for (const block of group.blocks) {
      if (!(block.id in next)) {
        next[block.id] = shouldAutoOpenActivity(block.status);
        changed = true;
      }
    }
    if (changed) rowOpenState = next;
  }

  // A live group may start closed and become attention-worthy later. Respect a
  // deliberate user collapse, but otherwise surface running/failing work.
  $: if (!groupTouched && group.autoOpen) groupOpen = true;

  function groupStatusClass(status: TimelineBlock['status']): string {
    return `activity-status--${status}`;
  }

  function isRowOpen(block: TimelineBlock): boolean {
    return rowOpenState[block.id] ?? shouldAutoOpenActivity(block.status);
  }

  function onGroupToggle(event: Event): void {
    groupOpen = (event.currentTarget as HTMLDetailsElement).open;
    if (mounted) {
      groupTouched = true;
      onOpenChange(groupOpen);
    }
  }

  function onRowToggle(id: string, event: Event): void {
    rowOpenState = {
      ...rowOpenState,
      [id]: (event.currentTarget as HTMLDetailsElement).open,
    };
  }

  async function copyOutput(id: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copiedOutputId = id;
      window.setTimeout(() => {
        if (copiedOutputId === id) copiedOutputId = undefined;
      }, 1_500);
    } catch {
      copiedOutputId = undefined;
    }
  }
</script>

<details
  class="activity-group"
  class:activity-group--attention={group.status !== 'complete'}
  open={groupOpen}
  ontoggle={onGroupToggle}
  data-activity-group={group.id}
  data-timeline-block={group.blocks[0]?.id}
  data-timeline-blocks={group.blocks.map((block) => block.id).join(' ')}
>
  <summary aria-label={`Activity: ${group.summary}${activityStatusLabel(group.status) ? `, ${activityStatusLabel(group.status)}` : ''}`}>
    <span class="activity-chevron" aria-hidden="true">›</span>
    <span class="activity-summary-title">{group.summary}</span>
    {#if activityStatusLabel(group.status)}
      <span class={`activity-status ${groupStatusClass(group.status)}`}>{activityStatusLabel(group.status)}</span>
    {/if}
  </summary>

  {#if groupOpen}
    <div class="activity-rows">
      {#each group.blocks as block (block.id)}
        <details
          class="activity-row"
          open={isRowOpen(block)}
          ontoggle={(event) => onRowToggle(block.id, event)}
          data-timeline-block={block.id}
        >
          <summary aria-label={`${activityBlockTitle(block)}${activityStatusLabel(block.status) ? `, ${activityStatusLabel(block.status)}` : ''}`}>
            <span class="row-chevron" aria-hidden="true">›</span>
            <span class="activity-title">{activityBlockTitle(block)}</span>
            {#if activityStatusLabel(block.status)}
              <span class={`activity-status ${groupStatusClass(block.status)}`}>{activityStatusLabel(block.status)}</span>
            {/if}
          </summary>

          {#if isRowOpen(block)}
            {#if block.kind === 'tool'}
              {#if block.text}
                <div class="tool-output">
                  <header class="tool-output-header">
                    <span>Output</span>
                    <button type="button" onclick={() => void copyOutput(block.id, block.text ?? '')} aria-label={`Copy ${activityBlockTitle(block)} output`}>
                      {copiedOutputId === block.id ? 'Copied' : 'Copy'}
                    </button>
                  </header>
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <pre tabindex="0" role="region" aria-label={`${activityBlockTitle(block)} output`}><code>{block.text}</code></pre>
                  {#if block.truncated}<p class="truncation-note">Long output was shortened to keep this session responsive.</p>{/if}
                </div>
              {:else if block.safeSummary}
                <p class="activity-detail">{block.safeSummary}</p>
              {/if}
            {:else if block.text}
              <div class="reasoning-content"><MarkdownContent source={block.text} compact={true} /></div>
            {:else if block.safeSummary}
              <p class="activity-detail">{block.safeSummary}</p>
            {/if}
          {/if}
        </details>
      {/each}
    </div>
  {/if}
</details>

<style>
  .activity-group { margin: -4px 0 18px 14px; color: var(--piui-text-muted); }
  .activity-group--attention > summary { color: var(--piui-text); }
  .activity-group > summary, .activity-row > summary { display: grid; grid-template-columns: 14px minmax(0, auto) auto; width: fit-content; max-width: 100%; align-items: center; gap: 7px; min-height: 30px; border-radius: 7px; cursor: pointer; list-style: none; font-size: 11px; }
  .activity-group > summary::-webkit-details-marker, .activity-row > summary::-webkit-details-marker { display: none; }
  .activity-group > summary:hover, .activity-row > summary:hover { color: var(--piui-text); }
  .activity-group > summary:focus-visible, .activity-row > summary:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 3px; }
  .activity-chevron, .row-chevron { color: var(--piui-text-faint); font-size: 18px; line-height: 1; transform: translateY(-1px); transition: transform 140ms ease; }
  .activity-group[open] > summary .activity-chevron, .activity-row[open] > summary .row-chevron { transform: rotate(90deg) translateX(-1px); }
  .activity-summary-title { overflow: hidden; color: inherit; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .activity-rows { display: grid; gap: 1px; margin: 3px 0 0 21px; padding: 4px 0 5px 10px; border-left: 1px solid var(--piui-border-subtle); }
  .activity-row > summary { min-height: 27px; font-size: 11px; }
  .row-chevron { font-size: 15px; }
  .activity-title { overflow: hidden; color: inherit; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
  .activity-status { color: var(--piui-text-faint); font-size: 10px; font-weight: 600; white-space: nowrap; }
  .activity-status--streaming { color: var(--piui-accent); }.activity-status--failed { color: var(--piui-danger-text); }.activity-status--interrupted { color: var(--piui-warning-text); }
  .tool-output, .reasoning-content { max-width: min(100%, var(--piui-chat-reading-width)); margin: 4px 0 5px 21px; overflow: hidden; border: 1px solid var(--piui-border-subtle); border-radius: 9px; background: color-mix(in srgb, var(--piui-bg) 72%, var(--piui-surface-1)); }
  .tool-output-header { display: flex; min-height: 30px; align-items: center; justify-content: space-between; gap: 12px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--piui-border-subtle); color: var(--piui-text-faint); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .tool-output-header button { padding: 4px 6px; border: 0; border-radius: 5px; background: transparent; color: var(--piui-text-muted); font-size: 10px; letter-spacing: normal; text-transform: none; }
  .tool-output-header button:hover { background: var(--piui-surface-2); color: var(--piui-text); }
  .tool-output-header button:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }
  .tool-output pre { max-height: 310px; margin: 0; padding: 12px 14px; overflow: auto; color: var(--piui-text-muted); font-family: var(--piui-font-mono); font-size: var(--piui-chat-code-font-size); line-height: 1.55; tab-size: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
  .reasoning-content { padding: 12px 14px; }
  .activity-detail { max-width: var(--piui-chat-reading-width); margin: 4px 0 5px 21px; color: var(--piui-text-muted); font-size: calc(var(--piui-chat-font-size) - 3px); line-height: 1.55; }
  .truncation-note { margin: 0; padding: 8px 14px; border-top: 1px solid var(--piui-border-subtle); background: color-mix(in srgb, var(--piui-surface-1) 72%, var(--piui-bg)); color: var(--piui-text-muted); font-size: 10px; line-height: 1.45; }
  @media (max-width: 700px) { .activity-group { margin-left: 4px; }.activity-rows { margin-left: 15px; }.tool-output, .reasoning-content, .activity-detail { margin-left: 15px; } }
</style>
