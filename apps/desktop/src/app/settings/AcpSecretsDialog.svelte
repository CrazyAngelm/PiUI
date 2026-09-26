<script lang="ts">
  import type { AcpAgentEntryV1 } from '../../../../../contracts/harness-registry-v1';
  import { t } from '../../features/locale/language';
  import { Button, Dialog } from '../../lib/ui';
  import AcpSecretChoices from './AcpSecretChoices.svelte';

  /**
   * Secret-like environment names (API keys, tokens) pass to an agent only
   * after an explicit per-name decision. PiUI handles names, never values.
   */
  interface Props {
    open: boolean;
    agent: AcpAgentEntryV1;
    busy: boolean;
    error: string | undefined;
    onSave: (agent: AcpAgentEntryV1, names: string[]) => void;
  }
  let { open = $bindable(), agent, busy, error, onSave }: Props = $props();

  // A local draft of the decision, reset whenever another agent or decision is under review.
  let allowed = $state<string[]>([]);
  let draftFor = '';
  $effect.pre(() => {
    const key = `${agent.descriptor.id}:${agent.fingerprint}:${agent.allowedSecrets.join(',')}`;
    if (key === draftFor) return;
    draftFor = key;
    allowed = [...agent.allowedSecrets];
  });
</script>

<Dialog bind:open title={$t('Secret variables for {0}', [agent.descriptor.displayName])} size="md" closeLabel={$t('Close')}>
  <div class="body">
    <p>{$t('When the agent starts, PiUI passes the value of each selected variable from your environment. PiUI never reads, shows or stores the values. Leave a variable unselected to keep it from the agent.')}</p>
    <AcpSecretChoices names={agent.secretEnvironment} bind:allowed />
    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  </div>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{$t('Cancel')}</Button>
    <Button variant="primary" loading={busy} onclick={() => onSave(agent, [...allowed].sort())}>{$t('Save')}</Button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: grid;
    gap: var(--piui-space-4);
    line-height: var(--piui-leading-normal);
  }
  p {
    margin: 0;
  }
  .error {
    color: var(--piui-danger-text);
  }
</style>
