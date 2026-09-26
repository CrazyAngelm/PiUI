<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../features/locale/language';
  import type { WorktreePreviewV1 } from '../../../../../contracts/workspace-placement-v1';
  import { plainBranchName } from '../../host-api/branchNames';
  import { Button, Dialog, Field, Input, Spinner } from '../../lib/ui';
  import { confirmedWorktree, newChatPlacement } from './newChatPlacement.svelte';
  import { placementRequest } from './placements.svelte';

  interface Props {
    workspaceId: string;
    onClose: () => void;
  }
  let { workspaceId, onClose }: Props = $props();

  let branch = $state('');
  let preview = $state.raw<WorktreePreviewV1 | undefined>();
  let error = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;

  const ready = $derived(preview !== undefined && !loading && preview.branch === branch.trim() && !error);

  async function load(requested: string | undefined): Promise<void> {
    const ticket = ++request;
    loading = true;
    error = '';
    try {
      const result = await placementRequest({ type: 'previewWorktree', workspaceId, ...(requested === undefined ? {} : { branch: requested }) });
      if (ticket !== request) return;
      if (result.type === 'preview') {
        preview = result.preview;
        if (requested === undefined) branch = result.preview.branch;
      }
    } catch (cause) {
      if (ticket !== request) return;
      preview = undefined;
      error = cause instanceof Error ? cause.message : 'The operation could not be completed.';
    } finally {
      if (ticket === request) loading = false;
    }
  }

  onMount(() => {
    void load(undefined);
    return () => clearTimeout(timer);
  });

  function changed(): void {
    clearTimeout(timer);
    const name = branch.trim();
    if (!plainBranchName(name)) {
      request += 1;
      preview = undefined;
      loading = false;
      error = "Choose a branch name with letters, digits, '.', '_', '-' and '/'.";
      return;
    }
    loading = true;
    timer = setTimeout(() => void load(name), 300);
  }

  function confirm(): void {
    if (!ready || preview === undefined) return;
    newChatPlacement.chooseWorktree(confirmedWorktree(preview));
    onClose();
  }
</script>

<Dialog
  open={true}
  title={$t('New chat in a worktree')}
  description={$t('The chat works in its own git worktree on a new branch, so your project folder stays as it is.')}
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <form
    class="body"
    onsubmit={(event) => {
      event.preventDefault();
      confirm();
    }}
  >
    <Field label={$t('New branch')} for="worktree-branch" error={error ? $t(error) : undefined}>
      <Input id="worktree-branch" bind:value={branch} oninput={changed} autocomplete="off" spellcheck={false} />
    </Field>
    {#if loading && preview === undefined && !error}
      <p class="muted" role="status"><Spinner size={12} /> {$t('Checking the repository…')}</p>
    {:else if preview}
      <dl>
        <div>
          <dt>{$t('Folder')}</dt>
          <dd class="mono">{preview.path}</dd>
        </div>
        <div>
          <dt>{$t('Starts from')}</dt>
          <dd><span class="mono">{preview.base.short}</span>{preview.base.branch ? ` · ${preview.base.branch}` : ''}</dd>
        </div>
      </dl>
      {#if preview.projectChanges}
        <p class="warn">{$t('Uncommitted changes in the project folder are not included: the worktree starts from the last commit.')}</p>
      {/if}
      <p class="muted">
        {$t('PiUI creates the folder with git and runs no repository hooks. Removing the worktree later keeps the branch and its commits.')}
      </p>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose}>{$t('Cancel')}</Button>
    <Button variant="primary" onclick={confirm} disabled={!ready} loading={loading && preview !== undefined}>{$t('Use this worktree')}</Button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: grid;
    gap: var(--piui-space-3);
  }
  dl {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
  }
  dt {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
  }
  dd {
    margin: 0;
    word-break: break-all;
  }
  .mono {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-sm);
  }
  .muted,
  .warn {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .warn {
    color: var(--piui-warning-text);
  }
</style>
