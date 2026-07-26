<script lang="ts">
  import type { SessionTree } from '../../host-api/types';

  export let tree: SessionTree | undefined;
  export let open = false;
  export let onClose: () => void;
</script>

{#if open}
  <aside class="panel" aria-label="Read-only session tree">
    <header>
      <div><p class="eyebrow">Branch history</p><h2>Read-only tree</h2></div>
      <button type="button" class="close" onclick={onClose} aria-label="Close branch tree">Close</button>
    </header>
    <p class="notice">Navigation is unavailable until an official Pi capability is verified. PiUI never rewrites entry parents.</p>
    {#if tree === undefined}
      <div class="tree-loading"><span class="skeleton"></span><span class="skeleton"></span></div>
    {:else if tree.nodes.length === 0}
      <p class="empty">No readable tree entries.</p>
    {:else}
      <ul class="tree">
        {#each tree.nodes as node (node.entryId)}
          <li class:issue={node.issue !== undefined} style={`--depth: ${node.depth}`}>
            <span class="node-kind">{node.kind}</span>
            <span class="node-label">{node.label}</span>
            {#if node.issue}<span class="issue-label">{node.issue}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if tree.diagnosticCount > 0}<p class="diagnostic">{tree.diagnosticCount} projection diagnostics retained safely.</p>{/if}
    {/if}
  </aside>
{/if}

<style>
  .panel { display: flex; flex-direction: column; min-width: 0; border-left: 1px solid var(--piui-border); background: var(--piui-bg-raised); }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--piui-space-2); padding: var(--piui-space-4); border-bottom: 1px solid var(--piui-border-subtle); }
  .eyebrow { margin: 0; color: var(--piui-text-faint); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  h2 { margin: 3px 0 0; font-size: 15px; letter-spacing: -.02em; }
  .close { padding: 6px 8px; border-radius: var(--piui-radius-sm); background: transparent; color: var(--piui-text-muted); font-size: 12px; }
  .close:hover { background: var(--piui-surface-1); color: var(--piui-text); }
  .notice, .empty, .diagnostic { margin: var(--piui-space-4); color: var(--piui-text-muted); font-size: 12px; line-height: 1.5; }
  .tree { overflow: auto; margin: 0; padding: 0 var(--piui-space-4) var(--piui-space-4); }
  .tree li { display: flex; min-width: 0; align-items: baseline; gap: var(--piui-space-2); padding: 5px 0 5px calc(var(--depth) * 12px); list-style: none; }
  .node-kind { color: var(--piui-text-faint); font: 10px var(--piui-font-mono); }
  .node-label { overflow: hidden; color: var(--piui-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .issue .node-label, .issue-label { color: var(--piui-warning); }
  .issue-label { margin-left: auto; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .diagnostic { color: var(--piui-warning); }
  .tree-loading { display: grid; gap: var(--piui-space-2); padding: var(--piui-space-4); }.tree-loading span { height: 12px; border-radius: 3px; }.tree-loading span:last-child { width: 72%; }
</style>
