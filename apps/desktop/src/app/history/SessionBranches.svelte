<script lang="ts">
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { t } from '../../features/locale/language';
  import type { SessionTree } from '../../host-api/types';
  import { Button, Skeleton } from '../../lib/ui';
  import { summarizeTree, TREE_ENTRY_PAGE, treeIssueLabel } from './piHistory';

  interface Props {
    tree: SessionTree | undefined;
    agentLabel: string;
  }
  let { tree, agentLabel }: Props = $props();

  const summary = $derived(tree ? summarizeTree(tree) : undefined);
  let shown = $state(TREE_ENTRY_PAGE);
  const entries = $derived(tree ? tree.nodes.slice(0, shown) : []);
  // Deep branches are indented up to a readable limit; the level stays in the label.
  const indent = (depth: number) => `${Math.min(depth, 24) * 10}px`;
</script>

<section class="branches" aria-labelledby="branches-title">
  <h3 id="branches-title">{$t('Branches')}</h3>
  {#if tree === undefined || summary === undefined}
    <Skeleton lines={3} height="12px" />
  {:else if summary.entries === 0}
    <p class="muted">{$t('No readable entries.')}</p>
  {:else}
    <p class="muted">
      {summary.branches.length === 1 ? $t('One branch') : $t('{0} branches', [summary.branches.length])} · {$t('{0} entries', [summary.entries])}
    </p>
    <ol class="list" aria-label={$t('Branches of this session')}>
      {#each summary.branches as branch, index (branch.leafId)}
        <li class:current={branch.current}>
          <span class="icon" aria-hidden="true"><GitBranch size={13} /></span>
          <span class="text">
            <strong>{branch.current ? $t('Current branch') : $t('Branch {0}', [index + 1])}</strong>
            <small>
              {$t('{0} entries', [branch.entries])}{#if branch.splitsAfter !== undefined} · {$t('splits after entry {0}', [branch.splitsAfter])}{/if}
            </small>
          </span>
        </li>
      {/each}
    </ol>
    <p class="note">{$t('Read only. The transcript shows the current branch. Switch branches in the {0} terminal app; PiUI never rewrites session files.', [agentLabel])}</p>
    {#if summary.issues > 0 || summary.diagnostics > 0}
      <p class="warn" role="note"><TriangleAlert size={13} /> {$t('Some entries could not be linked. The index kept them without changing the file.')}</p>
    {/if}
    <details class="entries">
      <summary>{$t('All entries ({0})', [summary.entries])}</summary>
      <ul aria-label={$t('Entries in tree order')}>
        {#each entries as node (node.entryId)}
          <li style:padding-left={indent(node.depth)} class:current={node.isCurrentPath} class:issue={node.issue !== undefined}>
            <span class="marker" aria-hidden="true">{node.isCurrentPath ? '●' : '○'}</span>
            <code>{node.label}</code>
            <span class="visually-hidden">{$t('level {0}', [node.depth + 1])}{node.isCurrentPath ? `, ${$t('on the current branch')}` : ''}</span>
            {#if node.issue}<span class="issue-label">{$t(treeIssueLabel(node.issue))}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if tree.nodes.length > shown}
        <Button size="sm" variant="ghost" onclick={() => (shown += TREE_ENTRY_PAGE)}>{$t('Show more entries ({0})', [tree.nodes.length - shown])}</Button>
      {/if}
    </details>
  {/if}
</section>

<style>
  .branches {
    display: grid;
    gap: var(--piui-space-2);
  }
  h3 {
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .muted {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: flex;
    gap: var(--piui-space-2);
    padding: 6px 8px;
    border-radius: var(--piui-radius-sm);
  }
  .list li.current {
    background: var(--piui-selected);
  }
  .icon {
    display: inline-flex;
    margin-top: 2px;
    color: var(--piui-text-muted);
  }
  .current .icon {
    color: var(--piui-accent);
  }
  .text {
    display: grid;
    min-width: 0;
  }
  .text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .note {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    line-height: var(--piui-leading-normal);
  }
  .warn {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-xs);
  }
  .entries summary {
    cursor: pointer;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .entries summary:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 2px;
  }
  .entries ul {
    display: grid;
    margin: var(--piui-space-2) 0;
    padding: 0;
    list-style: none;
  }
  .entries li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    padding-block: 2px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .entries li.current {
    color: var(--piui-text);
  }
  .marker {
    flex: none;
    font-size: 8px;
  }
  .entries li.current .marker {
    color: var(--piui-accent);
  }
  code {
    overflow: hidden;
    font-family: var(--piui-font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .issue-label {
    margin-left: auto;
    color: var(--piui-warning-text);
    white-space: nowrap;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
</style>
