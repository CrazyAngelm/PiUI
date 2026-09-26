<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import { t } from '../../features/locale/language';
  import { Button, Dialog } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';

  /**
   * "Continue in PiUI" for a Pi session started in the terminal
   * (workspace adopt v1): registers it as a chat once, then opens it with the
   * ordinary workspace open, which resumes the same session file with Pi.
   */
  interface Props {
    workspaceId: string;
    personal: boolean;
    /** Index session id. */
    sessionId: string;
    title: string;
  }
  let { workspaceId, personal, sessionId, title }: Props = $props();
  const store = useWorkspace();
  let open = $state(false);
  let busy = $state(false);
  let error = $state('');

  async function adopt(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const { adoptHost } = await import('../../host-api/adoptClient');
      const result = await adoptHost.adopt(personal ? { sessionId } : { projectId: workspaceId, sessionId });
      await store.loadCatalog(workspaceId);
      open = false;
      await store.openSession(result.sessionId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The operation could not be completed.';
    } finally {
      busy = false;
    }
  }
</script>

<Button
  size="sm"
  variant="ghost"
  disabled={store.safeMode}
  title={store.safeMode ? $t('Runtime actions are disabled in safe mode.') : undefined}
  onclick={() => {
    error = '';
    open = true;
  }}
>
  {#snippet leading()}<Play />{/snippet}
  {$t('Continue in PiUI')}
</Button>

{#if open}
  <Dialog
    open={true}
    title={$t('Continue this session in PiUI?')}
    description={title}
    onOpenChange={(next) => {
      if (!next && !busy) open = false;
    }}
  >
    <div class="body">
      <p>{$t('PiUI opens the same session file with Pi and adds this chat to the sidebar. It never rewrites the file; Pi appends new turns to it.')}</p>
      <p><strong>{$t('Close it in the Pi terminal app first.')}</strong> {$t('The terminal and PiUI must not write to one session at the same time.')}</p>
      {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
    </div>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (open = false)} disabled={busy}>{$t('Cancel')}</Button>
      <Button variant="primary" onclick={() => void adopt()} loading={busy}>{$t('Continue in PiUI')}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .body {
    display: grid;
    gap: var(--piui-space-3);
  }
  p {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  strong {
    color: var(--piui-text);
  }
  .error {
    color: var(--piui-danger);
  }
</style>
