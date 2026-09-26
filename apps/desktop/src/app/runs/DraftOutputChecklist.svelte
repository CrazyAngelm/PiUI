<script lang="ts">
  import { t } from '../../features/locale/language';
  import { pinnedPreview } from '../../host-api/pinnedData';
  import { Checkbox } from '../../lib/ui';
  import type { DraftOutput } from '../pipelines/runDraft';

  /**
   * The succeeded steps of a run whose outputs a new draft can hold as
   * pinned data. A checked step does not run when the draft is started with
   * pinned data; an unavailable one says why.
   */
  interface Props {
    items: readonly DraftOutput[];
    checked: Record<string, boolean>;
    disabled?: boolean;
  }
  let { items, checked = $bindable(), disabled = false }: Props = $props();
</script>

{#if items.length === 0}
  <p class="empty">{$t('No step of this run succeeded, so there is nothing to pin. The draft runs every step.')}</p>
{:else}
  <fieldset class="list">
    <legend>{$t('Pin the outputs to reuse')}</legend>
    {#each items as item (item.stepId)}
      <div class="item">
        <Checkbox
          checked={item.pin !== undefined && checked[item.stepId] === true}
          disabled={disabled || item.pin === undefined}
          label={item.name}
          description={item.pin === undefined
            ? $t(item.reason ?? '')
            : [item.wasPinned ? $t('Pinned data in this run') : '', pinnedPreview(item.pin)].filter(Boolean).join(' · ')}
          onCheckedChange={(value) => (checked = { ...checked, [item.stepId]: value })}
        />
      </div>
    {/each}
  </fieldset>
{/if}

<style>
  .list {
    display: grid;
    gap: var(--piui-space-2);
    max-height: 320px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    border: 0;
  }
  legend {
    margin-bottom: var(--piui-space-2);
    padding: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .item {
    padding: 6px 8px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    overflow-wrap: anywhere;
  }
  .empty {
    margin: 0;
    color: var(--piui-text-muted);
  }
</style>
