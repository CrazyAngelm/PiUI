<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Folder from '@lucide/svelte/icons/folder';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import { t } from '../../features/locale/language';
  import type { WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { Menu, type MenuEntry } from '../../lib/ui';
  import { newChatPlacement } from './newChatPlacement.svelte';

  /** "Local" or "Worktree" for the next chat of the new chat composer. */
  interface Props {
    workspace: WorkspaceSummary | undefined;
    disabled?: boolean;
  }
  let { workspace, disabled = false }: Props = $props();
  let dialog = $state(false);
  // Loaded on first use so the home composer keeps its first-paint budget.
  const loadDialog = () => import('./WorktreeDialog.svelte');

  const available = $derived(workspace !== undefined && !workspace.personal && !workspace.missing && workspace.trust === 'trusted');
  const chosen = $derived(workspace !== undefined && newChatPlacement.worktree?.workspaceId === workspace.id ? newChatPlacement.worktree : undefined);
  const handoff = $derived(workspace !== undefined && newChatPlacement.handoff?.workspaceId === workspace.id ? newChatPlacement.handoff : undefined);
  const shared = $derived(chosen === undefined && handoff?.shareWorktree === true && handoff.worktreeBranch !== undefined);
  const label = $derived(
    chosen ? $t('Worktree · {0}', [chosen.branch]) : shared ? $t('Same worktree · {0}', [handoff?.worktreeBranch ?? '']) : $t('Local'),
  );
  const items = $derived<MenuEntry[]>([
    {
      label: $t('Work in the project folder'),
      icon: Folder,
      checked: chosen === undefined && !shared,
      onSelect: () => {
        newChatPlacement.chooseWorktree(undefined);
        newChatPlacement.setShareWorktree(false);
      },
    },
    ...(handoff?.worktreeBranch !== undefined
      ? [{
          label: $t('Continue in the same worktree'),
          icon: GitBranch,
          checked: shared,
          onSelect: () => {
            newChatPlacement.chooseWorktree(undefined);
            newChatPlacement.setShareWorktree(true);
          },
        }]
      : []),
    { label: $t('New worktree…'), icon: GitBranch, checked: chosen !== undefined, onSelect: () => (dialog = true) },
  ]);
</script>

{#if available && workspace}
  <Menu align="start" {items} minWidth={240}>
    {#snippet trigger(props)}
      <button
        type="button"
        class="chip"
        class:chip--on={chosen !== undefined || shared}
        {...props}
        {disabled}
        aria-label={$t('Where the chat works: {0}', [label])}
      >
        <GitBranch size={14} />
        <span>{label}</span>
        <ChevronDown size={12} />
      </button>
    {/snippet}
  </Menu>
  {#if dialog}
    {#await loadDialog() then module}
      <module.default workspaceId={workspace.id} onClose={() => (dialog = false)} />
    {/await}
  {/if}
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 260px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip:hover:not(:disabled),
  .chip[data-state='open'] {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .chip--on {
    color: var(--piui-accent);
  }
</style>
