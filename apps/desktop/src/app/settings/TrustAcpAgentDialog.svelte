<script lang="ts">
  import type { AcpAgentEntryV1 } from '../../../../../contracts/harness-registry-v1';
  import { t } from '../../features/locale/language';
  import { Button, Dialog } from '../../lib/ui';
  import AcpTrustReview from './AcpTrustReview.svelte';

  /**
   * The explicit trust decision for a user ACP descriptor. The host trusts
   * only the reviewed command line and descriptor fingerprint.
   */
  interface Props {
    open: boolean;
    /** The snapshot under review; it changes only through `onReview`. */
    agent: AcpAgentEntryV1;
    busy: boolean;
    error: string | undefined;
    onTrust: (agent: AcpAgentEntryV1) => void;
    /** Review the agent as it is now after the host rejected a stale decision. */
    onReview: () => void;
  }
  let { open = $bindable(), agent, busy, error, onTrust, onReview }: Props = $props();
</script>

<Dialog
  bind:open
  title={$t('Trust {0}?', [agent.descriptor.displayName])}
  description={$t('PiUI will start exactly this command, without a shell. Review it before you trust it.')}
  size="lg"
  closeLabel={$t('Close')}
>
  <AcpTrustReview {agent} {error} {onReview} />
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{$t('Cancel')}</Button>
    <Button variant="primary" loading={busy} disabled={agent.commandLine === undefined || error !== undefined} onclick={() => onTrust(agent)}>
      {$t('Trust this command')}
    </Button>
  {/snippet}
</Dialog>
