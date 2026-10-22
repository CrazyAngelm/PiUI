<script lang="ts">
  import Swords from '@lucide/svelte/icons/swords';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import { t } from '../../features/locale/language';
  import type { FusionPairV1 } from '../../host-api/fusionClient';
  import { Segmented } from '../../lib/ui';
  import type { FusionHarnessOption } from './FusionRolePicker.svelte';
  import { isFusionLead } from './fusionPair';

  /**
   * "Chat | Fusion" switch of the new-chat composer (ADR-043). Fusion mode
   * shows the pair picker above the composer; the composer's text box stays
   * the place for the first message, and its send button starts the pair.
   */
  interface Props {
    workspaceId: string;
    trusted: boolean;
    harnesses: readonly FusionHarnessOption[];
    disabled: boolean;
    active?: boolean;
    pair?: FusionPairV1 | undefined;
    ready?: boolean;
  }
  let { workspaceId, trusted, harnesses, disabled, active = $bindable(false), pair = $bindable(undefined), ready = $bindable(false) }: Props = $props();

  // Without a harness that can lead there is nothing to switch to.
  const canLead = $derived(harnesses.some((item) => item.available && isFusionLead(item.kind)));
  const mode = $derived(active ? 'fusion' : 'chat');
  // The pair picker loads on first use, outside the first-paint bundle.
  const loadPicker = () => import('./FusionPairPicker.svelte');
</script>

{#if canLead || active}
  <div class="bar">
    <Segmented
      value={mode}
      label={$t('Chat type')}
      size="sm"
      options={[
        { value: 'chat', label: $t('Chat'), icon: MessageSquare, title: $t('One agent answers you') },
        { value: 'fusion', label: $t('Fusion'), icon: Swords, disabled, title: $t('A lead agent and a sidekick work as a pair') },
      ]}
      onValueChange={(value) => (active = value === 'fusion')}
    />
  </div>
  {#if active}
    {#await loadPicker() then { default: FusionPairPicker }}
      <FusionPairPicker {workspaceId} {trusted} {harnesses} {disabled} bind:pair bind:ready />
    {/await}
  {/if}
{/if}

<style>
  .bar {
    display: flex;
    margin-bottom: var(--piui-space-2);
  }
</style>
