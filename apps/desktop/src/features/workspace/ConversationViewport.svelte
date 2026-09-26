<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../locale/language';
  import Timeline from '../sessions/Timeline.svelte';
  import { readWorkspaceHistory } from '../../host-api/workspaceHistory';
  import type { TimelineBlock } from '../../host-api/types';
  export let blocks: TimelineBlock[];
  export let loading: boolean;
  export let sessionKey: string;
  export let historySessionId: string | undefined = undefined;
  export let agentLabel: string;
  let scroller: HTMLDivElement;
  let following = true;
  let searchOpen = false, query = '', searchBusy = false, searchError = '';
  let searchBlocks: TimelineBlock[] = [];
  let match = 0, request = 0;
  let observedKey = sessionKey;
  let matchView = '';
  $: if (searchOpen && query.trim() && matchView !== `${query}:${match}`) { matchView = `${query}:${match}`; void tick().then(() => { scroller.scrollTop = 0; scroller.querySelectorAll('details').forEach(detail => detail.open = true); }); }
  $: if (observedKey !== sessionKey) { observedKey = sessionKey; searchOpen = false; query = ''; searchBlocks = []; searchError = ''; request++; searchBusy = false; }
  $: matches = searchBlocks.filter(block => `${block.text ?? ''} ${block.safeSummary ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  $: if (match >= matches.length) match = 0;
  $: shownBlocks = searchOpen && query.trim() ? matches.slice(match, match + 1) : blocks;
  async function refreshSearch(): Promise<void> {
    searchOpen = true; searchBusy = true; searchError = '';
    const ticket = ++request;
    try { const result = historySessionId ? await readWorkspaceHistory(historySessionId) : blocks; if (ticket === request) searchBlocks = result; }
    catch { if (ticket === request) { searchBlocks = []; searchError = 'Could not load native history. Try again.'; } }
    finally { if (ticket === request) searchBusy = false; }
  }
  async function fullAnswer(block: TimelineBlock): Promise<string> {
    if (!historySessionId) throw new Error('No native history');
    const history = await readWorkspaceHistory(historySessionId);
    const answer = history.find(candidate => candidate.id === block.id && candidate.kind === 'assistant' && !candidate.truncated);
    if (!answer?.text) throw new Error('Native answer unavailable');
    return answer.text;
  }
  function latest(): void { following = true; scroller.scrollTop = scroller.scrollHeight; }
  function followConversation(node: HTMLDivElement, scope: { key: string; loading: boolean }) {
    let current = scope.key, restoring = true;
    const key = () => `piui.conversation.view.${current}`;
    const persist = () => { if (restoring || searchOpen) return; try { localStorage.setItem(key(), JSON.stringify({ top: node.scrollTop, following })); } catch { /* Optional reading position only. */ } };
    const restore = async () => {
      const expected = current;
      restoring = true;
      let view = { top: 0, following: true };
      try { const saved = JSON.parse(localStorage.getItem(key()) ?? 'null'); if (saved && Number.isFinite(saved.top) && saved.top >= 0 && typeof saved.following === 'boolean') view = saved; } catch { /* Ignore damaged view metadata. */ }
      await tick();
      if (expected !== current) return;
      following = view.following; node.scrollTop = following ? node.scrollHeight : view.top; restoring = false;
    };
    // One CSS pixel accounts for integer scrollHeight/clientHeight rounding.
    const onScroll = () => { if (!restoring && !searchOpen) { following = node.scrollHeight - node.clientHeight - node.scrollTop <= 1; persist(); } };
    const observer = new ResizeObserver(() => { if (!restoring && !searchOpen && following) latest(); });
    observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', onScroll, { passive: true });
    if (!scope.loading) void restore();
    return {
      update(next: { key: string; loading: boolean }) { if (next.key !== current) { persist(); current = next.key; restoring = true; } if (restoring && !next.loading) void restore(); },
      destroy() { persist(); observer.disconnect(); node.removeEventListener('scroll', onScroll); },
    };
  }
  async function closeSearch(): Promise<void> { searchOpen = false; query = ''; await tick(); try { const view = JSON.parse(localStorage.getItem(`piui.conversation.view.${sessionKey}`) ?? 'null'); if (view) { following = view.following; scroller.scrollTop = following ? scroller.scrollHeight : view.top; } } catch { /* Retain current view. */ } }
</script>
<div class="conversation-viewport">
  <div class="history-tools">
    {#if !searchOpen}<button onclick={refreshSearch}>{$t('Search messages')}</button>{:else}
      <input type="search" aria-label={$t('Search messages')} placeholder={$t('Search messages')} bind:value={query} oninput={() => match = 0} />
      <button disabled={!matches.length || searchBusy} aria-label={$t('Previous match')} onclick={() => match = (match - 1 + matches.length) % matches.length}>↑</button>
      <button disabled={!matches.length || searchBusy} aria-label={$t('Next match')} onclick={() => match = (match + 1) % matches.length}>↓</button>
      <span role="status">{searchBusy ? $t('Loading…') : query.trim() ? `${matches.length ? match + 1 : 0} / ${matches.length}` : $t('Saved native history')}</span>
      <button disabled={searchBusy} onclick={refreshSearch}>{$t('Refresh')}</button><button onclick={closeSearch}>{$t('Close search')}</button>
    {/if}
  </div>
  {#if searchOpen}<p class="search-scope">{$t('Searches saved messages and full answers. Tool output may be shortened. Refresh to include newly saved messages.')}</p>{/if}
  {#if searchError}<p role="alert">{$t(searchError)}</p>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region must support keyboard scrolling.) -->
  <div class="timeline-scroller" bind:this={scroller} use:followConversation={{key:sessionKey,loading}} tabindex="0" role="region" aria-label={$t('Conversation messages')}>
    <Timeline blocks={shownBlocks} loading={loading || searchBusy} sessionKey={`${sessionKey}:${searchOpen && query.trim() ? `search:${match}` : 'conversation'}`} {agentLabel} readFullAnswer={historySessionId ? fullAnswer : undefined} />
  </div>
  {#if !following && !searchOpen}<button class="jump-latest" type="button" onclick={latest}>{$t('↓ Back to latest')}</button>{/if}
</div>
<style>
  .conversation-viewport { position:relative; display:flex; flex-direction:column; flex:1; min-height:0; }
  .history-tools { display:flex; gap:var(--piui-space-2); align-items:center; flex-wrap:wrap; padding:var(--piui-space-2); color:var(--piui-text-muted); font-size:12px; }
  .search-scope { margin:0; padding:0 var(--piui-space-2); color:var(--piui-text-muted); font-size:12px; }
  .history-tools input { flex:1; min-width:0; }
  .history-tools button,.history-tools input { font:inherit; color:var(--piui-text); background:var(--piui-bg-raised); padding:5px 8px; border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); }
  .timeline-scroller { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; }
  .jump-latest { position:absolute; bottom:var(--piui-space-4); left:50%; transform:translateX(-50%); padding:8px 14px; border:1px solid var(--piui-border); border-radius:var(--piui-radius-md); background:var(--piui-bg-raised); color:var(--piui-text); font:inherit; font-size:12px; box-shadow:0 3px 12px #0002; }
  .jump-latest:hover { background:var(--piui-surface-1); }
  button:focus-visible,input:focus-visible,.timeline-scroller:focus-visible { outline:2px solid var(--piui-focus); outline-offset:-2px; }
</style>
