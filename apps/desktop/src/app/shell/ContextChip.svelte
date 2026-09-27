<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Folder from '@lucide/svelte/icons/folder';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import { t } from '../../features/locale/language';
  import type { PermissionMode, WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { Input, Popover } from '../../lib/ui';
  import { newChatPlacement } from '../worktrees/newChatPlacement.svelte';

  /**
   * Where a new chat works and what it may do, in one chip: project,
   * permissions and worktree are chosen rarely, so they share one popover
   * and the composer bar keeps room for who answers.
   */
  interface Props {
    workspaces: readonly WorkspaceSummary[];
    workspaceId: string;
    permissionMode: PermissionMode;
    permissions: readonly { value: PermissionMode; label: string; description?: string }[];
    /** A pipeline's agents run in the project folder; the worktree choice is hidden then. */
    worktree?: boolean;
    disabled?: boolean;
    onWorkspace: (id: string) => void;
    onPermission: (mode: PermissionMode) => void;
  }
  let { workspaces, workspaceId, permissionMode, permissions, worktree = true, disabled = false, onWorkspace, onPermission }: Props = $props();

  let open = $state(false);
  let query = $state('');
  let worktreeDialog = $state(false);
  // Loaded on first use so the home composer keeps its first-paint budget.
  const loadDialog = () => import('../worktrees/WorktreeDialog.svelte');

  const workspace = $derived(workspaces.find((item) => item.id === workspaceId));
  const projectName = (item: WorkspaceSummary | undefined): string => (item ? (item.personal ? $t('Personal chats') : item.name) : $t('Choose project'));
  const permission = $derived(permissions.find((item) => item.value === permissionMode));
  const worktrees = $derived(worktree && workspace !== undefined && !workspace.personal && !workspace.missing && workspace.trust === 'trusted');
  const chosen = $derived(worktrees && workspace && newChatPlacement.worktree?.workspaceId === workspace.id ? newChatPlacement.worktree : undefined);
  const handoff = $derived(worktrees && workspace && newChatPlacement.handoff?.workspaceId === workspace.id ? newChatPlacement.handoff : undefined);
  const shared = $derived(chosen === undefined && handoff?.shareWorktree === true && handoff.worktreeBranch !== undefined);
  const place = $derived(chosen ? $t('Worktree · {0}', [chosen.branch]) : shared ? $t('Same worktree · {0}', [handoff?.worktreeBranch ?? '']) : '');
  const summary = $derived([projectName(workspace), permission?.label, place].filter(Boolean).join(' · '));
  const shown = $derived(
    query.trim() ? workspaces.filter((item) => projectName(item).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : workspaces,
  );

  function workLocally(): void {
    newChatPlacement.chooseWorktree(undefined);
    newChatPlacement.setShareWorktree(false);
  }
  function shareWorktree(): void {
    newChatPlacement.chooseWorktree(undefined);
    newChatPlacement.setShareWorktree(true);
  }
  function newWorktree(): void {
    open = false;
    worktreeDialog = true;
  }
</script>

<Popover bind:open width={340} align="end" side="top" label={$t('Project and permissions')}>
  {#snippet trigger(props)}
    <button
      type="button"
      class="chip"
      class:chip--warn={permissionMode === 'full-access'}
      class:chip--on={Boolean(place)}
      {...props}
      {disabled}
      aria-label={$t('Project and permissions: {0}', [summary])}
    >
      {#if permissionMode === 'full-access'}<ShieldAlert size={14} />{:else if place}<GitBranch size={14} />{:else if workspace?.personal}<MessagesSquare size={14} />{:else}<Folder size={14} />{/if}
      <span>{summary}</span>
      <ChevronDown size={12} />
    </button>
  {/snippet}
  <div class="panel">
    <fieldset>
      <legend>{$t('Project')}</legend>
      {#if workspaces.length > 8}
        <Input size="sm" bind:value={query} placeholder={$t('Search projects')} aria-label={$t('Search projects')} />
      {/if}
      <div class="options options--scroll">
        {#each shown as item (item.id)}
          <label class="option">
            <input type="radio" name="context-project" value={item.id} checked={item.id === workspaceId} onchange={() => onWorkspace(item.id)} />
            <span class="option__text">
              <span>{projectName(item)}</span>
              <small>
                {item.personal ? $t('Not tied to a project folder') : item.trust === 'trusted' ? $t('Trusted folder') : $t('Restricted — trust required')}
              </small>
            </span>
          </label>
        {/each}
      </div>
    </fieldset>
    <fieldset>
      <legend>{$t('Permissions')}</legend>
      <div class="options">
        {#each permissions as item (item.value)}
          <label class="option" class:option--warn={item.value === 'full-access'}>
            <input type="radio" name="context-permission" value={item.value} checked={item.value === permissionMode} onchange={() => onPermission(item.value)} />
            <span class="option__text">
              <span>{item.label}</span>
              {#if item.description}<small>{item.description}</small>{/if}
            </span>
          </label>
        {/each}
      </div>
    </fieldset>
    {#if worktrees}
      <fieldset>
        <legend>{$t('Where the chat works')}</legend>
        <div class="options">
          <label class="option">
            <input type="radio" name="context-place" checked={chosen === undefined && !shared} onchange={workLocally} />
            <span class="option__text"><span>{$t('Work in the project folder')}</span></span>
          </label>
          {#if handoff?.worktreeBranch !== undefined}
            <label class="option">
              <input type="radio" name="context-place" checked={shared} onchange={shareWorktree} />
              <span class="option__text"><span>{$t('Continue in the same worktree')}</span><small>{handoff.worktreeBranch}</small></span>
            </label>
          {/if}
          {#if chosen}
            <label class="option">
              <input type="radio" name="context-place" checked={true} />
              <span class="option__text"><span>{$t('Worktree · {0}', [chosen.branch])}</span></span>
            </label>
          {/if}
          <button type="button" class="new-worktree" onclick={newWorktree} {disabled}>
            <GitBranch size={14} />
            {$t('New worktree…')}
          </button>
        </div>
      </fieldset>
    {/if}
  </div>
</Popover>
{#if worktreeDialog && workspace}
  {#await loadDialog() then module}
    <module.default workspaceId={workspace.id} onClose={() => (worktreeDialog = false)} />
  {/await}
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 300px;
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
  .chip--warn {
    color: var(--piui-warning);
  }
  .panel {
    display: grid;
    gap: var(--piui-space-3);
  }
  fieldset {
    display: grid;
    gap: 6px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: 4px;
    padding: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .options {
    display: grid;
    gap: 2px;
  }
  .options--scroll {
    max-height: 220px;
    overflow-y: auto;
  }
  .option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 8px;
    border-radius: var(--piui-radius-sm);
    cursor: pointer;
  }
  .option:hover,
  .option:has(input:focus-visible) {
    background: var(--piui-hover);
  }
  .option input {
    margin: 3px 0 0;
    accent-color: var(--piui-accent);
  }
  .option__text {
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .option__text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .option--warn .option__text > span {
    color: var(--piui-warning);
  }
  .new-worktree {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    justify-self: start;
    margin-top: 2px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-accent);
    font-size: var(--piui-text-sm);
  }
  .new-worktree:hover:not(:disabled) {
    background: var(--piui-hover);
  }
</style>
