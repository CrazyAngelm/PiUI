<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { Button, Dialog, Input, toasts } from '../../lib/ui';
  import { errorMessage } from '../workspaceStore.svelte';
  import { useWorkspace } from '../shell/context';
  import { projectRemoval, type ProjectDialogRequest } from './projectActions';

  interface Props {
    request: ProjectDialogRequest | undefined;
    onClose: () => void;
  }
  let { request, onClose }: Props = $props();
  const store = useWorkspace();

  let name = $state(untrack(() => (request?.kind === 'rename' ? request.workspace.name : '')));
  let busy = $state(false);
  let error = $state('');
  const removal = $derived(request?.kind === 'remove' ? projectRemoval(request.workspace.id, store.catalog.sessions) : undefined);
  const trimmed = $derived(name.trim());

  function close(): void {
    if (busy) return;
    error = '';
    onClose();
  }

  async function rename(): Promise<void> {
    if (!request || busy || !trimmed || trimmed === request.workspace.name) return;
    busy = true;
    error = '';
    try {
      await store.renameProject(request.workspace.id, trimmed);
      busy = false;
      onClose();
    } catch (cause) {
      error = errorMessage(cause);
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    if (!request || busy || removal?.blocked) return;
    const label = request.workspace.name;
    busy = true;
    error = '';
    try {
      await store.removeProject(request.workspace.id);
      busy = false;
      onClose();
      toasts.success($t('Folder removed from PiUI'), label);
    } catch (cause) {
      error = errorMessage(cause);
      busy = false;
    }
  }
</script>

{#if request?.kind === 'rename'}
  <Dialog
    open
    title={$t('Rename project')}
    description={$t('Changes the name shown in PiUI. The folder on disk keeps its name.')}
    size="sm"
    closeLabel={$t('Close')}
    onOpenChange={(open) => {
      if (!open) close();
    }}
  >
    <form
      id="rename-project-form"
      onsubmit={(event) => {
        event.preventDefault();
        void rename();
      }}
    >
      <Input bind:value={name} aria-label={$t('Project name')} maxlength={120} disabled={busy} invalid={!trimmed} />
    </form>
    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
    {#snippet footer()}
      <Button variant="ghost" onclick={close} disabled={busy}>{$t('Cancel')}</Button>
      <Button variant="primary" type="submit" form="rename-project-form" loading={busy} disabled={!trimmed || trimmed === request.workspace.name}>{$t('Save name')}</Button>
    {/snippet}
  </Dialog>
{:else if request?.kind === 'remove'}
  <Dialog
    open
    title={$t('Remove {0} from PiUI?', [request.workspace.name])}
    size="sm"
    closeLabel={$t('Close')}
    onOpenChange={(open) => {
      if (!open) close();
    }}
  >
    <p class="text">{$t('PiUI forgets this folder. Its chats, pipelines and automations disappear from PiUI, and automations stop running.')}</p>
    <p class="text"><strong>{$t('Nothing is deleted from disk.')}</strong> {$t('The folder, its files and each harness’s own history stay where they are. Adding the folder again starts a new entry.')}</p>
    {#if removal?.blocked}
      <p class="error" role="alert">{$t('Stop the agents running in this folder first ({0}).', [removal.running])}</p>
    {:else if removal && removal.chats > 0}
      <p class="muted">{$t('{0} chats will be hidden.', [removal.chats])}</p>
    {/if}
    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
    {#snippet footer()}
      <Button variant="ghost" onclick={close} disabled={busy}>{$t('Cancel')}</Button>
      <Button variant="danger" loading={busy} disabled={removal?.blocked} onclick={() => void remove()}>{$t('Remove from PiUI')}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  form :global(.input) {
    width: 100%;
  }
  .text {
    margin: 0 0 var(--piui-space-2);
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .text strong {
    color: var(--piui-text);
  }
  .muted {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .error {
    margin: var(--piui-space-2) 0 0;
    color: var(--piui-danger);
  }
</style>
