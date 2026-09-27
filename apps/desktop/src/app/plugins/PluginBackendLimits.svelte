<script lang="ts">
  import type { PluginPermission } from '../../../../../contracts/piui-plugin-v1';
  import type { PluginBackendLimitsV1 } from '../../../../../contracts/plugins-v1';
  import { t } from '../../features/locale/language';

  /**
   * What Node's permission model enforces for one backend, in plain words:
   * the trust review and Settings → Plugins show the same text. It never
   * promises a sandbox: Node's model limits trusted code, and a Node.js
   * without it does not run backends at all.
   */
  interface Props {
    limits: PluginBackendLimitsV1 | undefined;
    permissions: readonly PluginPermission[];
  }
  let { limits, permissions }: Props = $props();

  const writes = $derived(permissions.includes('project.write'));
  const reads = $derived(writes || permissions.includes('project.read'));
  const network = $derived(permissions.includes('network'));
</script>

<div class="limits">
  {#if !limits}
    <p class="muted">{$t('PiUI checks what Node.js can limit before the backend first starts.')}</p>
  {:else if !limits.enforced}
    <p class="warn" role="note">{$t('Node.js {0} cannot limit plugin backends, so PiUI will not start this one. Install Node.js 22.13 or later.', [limits.nodeVersion])}</p>
  {:else}
    <ul>
      <li>{$t('Limited by Node.js {0}: the backend reads its own files, keeps data in its own folder and cannot start other programs or worker threads.', [limits.nodeVersion])}</li>
      <li>
        {#if writes}
          {$t('It can read and change the folder of each project it works in.')}
        {:else if reads}
          {$t('It can read the folder of each project it works in, but not change it.')}
        {:else}
          {$t('It cannot open your project folders.')}
        {/if}
      </li>
      <li>
        {#if network}
          {$t('It can use the network.')}
        {:else if limits.network}
          {$t('Its network access is blocked.')}
        {:else}
          <span class="warn">{$t('This Node.js cannot block network access: the backend can use the network although it does not ask for it.')}</span>
        {/if}
      </li>
    </ul>
    <p class="muted">{$t("Node's permission model guards against mistakes, not against deliberately malicious code.")}</p>
  {/if}
</div>

<style>
  .limits {
    display: grid;
    gap: var(--piui-space-1);
    font-size: var(--piui-text-sm);
  }
  ul {
    display: grid;
    gap: 2px;
    margin: 0;
    padding-left: var(--piui-space-4);
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .warn {
    color: var(--piui-warning-text);
  }
</style>
