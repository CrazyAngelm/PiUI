<script lang="ts">
  import { t } from '../locale/language';
  import Timeline from '../sessions/Timeline.svelte';
  import type { TimelineBlock } from '../../host-api/types';

  export let blocks: TimelineBlock[];
  export let loading: boolean;
  export let sessionKey: string;
  export let agentLabel: string;

  let scroller: HTMLDivElement;
  let following = true;

  function latest(): void {
    following = true;
    scroller.scrollTop = scroller.scrollHeight;
  }

  function followConversation(node: HTMLDivElement, key: string) {
    let currentKey = key;
    // CSSOM scrollHeight/clientHeight are integers, while scrollTop can be
    // fractional. One CSS pixel accounts only for that rounding difference.
    const onScroll = () => following = node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
    const observer = new ResizeObserver(() => { if (following) latest(); });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', onScroll, { passive: true });
    latest();
    return {
      update(next: string) { if (next !== currentKey) { currentKey = next; latest(); } },
      destroy() { observer.disconnect(); node.removeEventListener('scroll', onScroll); },
    };
  }
</script>

<div class="conversation-viewport">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region must support keyboard scrolling.) -->
  <div class="timeline-scroller" bind:this={scroller} use:followConversation={sessionKey} tabindex="0" role="region" aria-label={$t('Conversation messages')}>
    <Timeline {blocks} {loading} {sessionKey} {agentLabel} />
  </div>
  {#if !following}<button class="jump-latest" type="button" onclick={latest}>{$t('↓ Back to latest')}</button>{/if}
</div>

<style>
  .conversation-viewport { position:relative; flex:1; min-height:0; }
  .timeline-scroller { height:100%; overflow:auto; scrollbar-gutter:stable; }
  .jump-latest { position:absolute; bottom:var(--piui-space-4); left:50%; transform:translateX(-50%); padding:8px 14px; border:1px solid var(--piui-border); border-radius:var(--piui-radius-md); background:var(--piui-bg-raised); color:var(--piui-text); font:inherit; font-size:12px; box-shadow:0 3px 12px #0002; }
  .jump-latest:hover { background:var(--piui-surface-1); }
  .jump-latest:focus-visible, .timeline-scroller:focus-visible { outline:2px solid var(--piui-focus); outline-offset:-2px; }
</style>
