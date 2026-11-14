<script lang="ts">
  import type { WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { t } from '../../features/locale/language';
  import { Button, Dialog } from '../../lib/ui';

  interface Props {
    trustTarget: WorkspaceSummary | undefined;
    trustBusy: boolean;
    trustError: string;
    deleteTarget: string | undefined;
    deleteBusy: boolean;
    deleteTitle: string | undefined;
    deleteHasWorktree: boolean;
    pendingNavigation: boolean;
    onTrustOpenChange: (open: boolean) => void;
    onDeleteOpenChange: (open: boolean) => void;
    cancelTrust: () => void;
    confirmTrust: () => Promise<void>;
    cancelDelete: () => void;
    confirmDelete: () => Promise<void>;
    cancelNavigation: () => void;
    confirmNavigation: () => void;
  }
  let { trustTarget, trustBusy, trustError, deleteTarget, deleteBusy, deleteTitle,
    deleteHasWorktree, pendingNavigation, onTrustOpenChange, onDeleteOpenChange,
    cancelTrust, confirmTrust, cancelDelete, confirmDelete, cancelNavigation, confirmNavigation }: Props = $props();
</script>

  <Dialog
    open={trustTarget !== undefined}
    title={trustTarget ? $t('Trust {0}?', [trustTarget.name]) : ''}
    description={$t('Agents can then work on files in this folder within the permissions of each chat.')}
    onOpenChange={onTrustOpenChange}
  >
    <p class="dialog-text"><strong>{$t('Trust is not a sandbox.')}</strong> {$t('Native agent processes may access more of your computer unless their permission mode is enforced by the harness.')}</p>
    {#if trustError}<p class="dialog-error" role="alert">{$t(trustError)}</p>{/if}
    {#snippet footer()}
      <Button variant="ghost" onclick={cancelTrust} disabled={trustBusy}>{$t('Cancel')}</Button>
      <Button variant="primary" onclick={() => void confirmTrust()} loading={trustBusy}>{$t('Trust folder')}</Button>
    {/snippet}
  </Dialog>

  <Dialog
    open={deleteTarget !== undefined}
    title={$t('Delete chat?')}
    description={deleteTitle}
    size="sm"
    onOpenChange={onDeleteOpenChange}
  >
    <p class="dialog-text">{$t('The chat is removed from Nano Desktop. The harness keeps its own history.')}</p>
    {#if deleteHasWorktree}
      <p class="dialog-text">{$t('Its worktree folder and branch stay on disk. Remove the worktree from the chat details first if you no longer need it.')}</p>
    {/if}
    {#snippet footer()}
      <Button variant="ghost" onclick={cancelDelete} disabled={deleteBusy}>{$t('Cancel')}</Button>
      <Button variant="danger" onclick={() => void confirmDelete()} loading={deleteBusy}>{$t('Delete chat')}</Button>
    {/snippet}
  </Dialog>

  <Dialog
    open={pendingNavigation}
    title={$t('Leave the pipeline editor?')}
    description={$t('The draft has unsaved changes.')}
    size="sm"
    dismissible={false}
  >
    {#snippet footer()}
      <Button variant="ghost" onclick={() => cancelNavigation()}>{$t('Keep editing')}</Button>
      <Button variant="danger" onclick={() => confirmNavigation()}>{$t('Discard changes')}</Button>
    {/snippet}
  </Dialog>

<style>
  .dialog-text {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .dialog-text strong {
    color: var(--piui-text);
  }
  .dialog-error {
    margin: var(--piui-space-3) 0 0;
    color: var(--piui-danger);
  }
</style>
