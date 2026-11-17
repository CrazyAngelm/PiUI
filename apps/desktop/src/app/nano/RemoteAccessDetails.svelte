<script lang="ts">
  import { t } from '../../features/locale/language';
  import { Button, Dialog } from '../../lib/ui';
  import { hostSupports, pipelineSectionAvailable, remoteChatOnly } from './remoteMode';

  let { open = $bindable(false) }: { open: boolean } = $props();
</script>

<Dialog bind:open title={$t('Remote access details')} size="sm">
  <section>
    <h3>{$t('On this device')}</h3>
    <ul>
      <li>{$t('Chat history, messages, model selection and approval requests.')}</li>
      {#if pipelineSectionAvailable('systems')}
        <li>{$t('View saved pipelines, their agents and teams.')}</li>
        {#if hostSupports('orchestration_save_graph_v6')}<li>{$t('Edit supported agent pipelines in trusted projects.')}</li>{/if}
        {#if hostSupports('orchestration_start_run_v6')}<li>{$t('Start supported agent pipelines in trusted projects.')}</li>{/if}
      {:else if remoteChatOnly()}
        <li>{$t('This computer shares chats. Update Nano Desktop on it to open pipelines and runs here.')}</li>
      {/if}
      {#if pipelineSectionAvailable('runs')}<li>{$t('Run history, step results and progress.')}</li>{/if}
      {#if pipelineSectionAvailable('schedules')}<li>{$t('View scheduled automations.')}</li>{/if}
      {#if hostSupports('board_command_v1', 'teammates_command_v1')}<li>{$t('View project boards and teammates.')}</li>{/if}
    </ul>
    <h3>{$t('On the paired computer')}</h3>
    <ul>
      <li>{$t('Manage folders and worktrees, attach local files and review file changes.')}</li>
      <li>{$t('Manage providers, account keys, plugins and remote-access permissions in Settings.')}</li>
      <li>{$t('Start scripts, plugin steps and pipelines with elevated permissions on the computer.')}</li>
    </ul>
  </section>
  {#snippet footer()}<Button onclick={() => (open = false)}>{$t('Close')}</Button>{/snippet}
</Dialog>

<style>
  section { display: grid; gap: var(--piui-space-2); }
  h3 { margin: 0; font-size: var(--piui-text-lg); }
  ul { margin: 0 0 var(--piui-space-2); padding-inline-start: var(--piui-space-5); list-style: disc; }
  li { margin-block: var(--piui-space-1); color: var(--piui-text-muted); line-height: var(--piui-leading-normal); }
</style>
