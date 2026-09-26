<script lang="ts">
  import Info from '@lucide/svelte/icons/info';
  import type { Harness } from '../../../../../contracts/orchestration-v6';
  import { t } from '../../features/locale/language';
  import { harnessConfiguration } from '../../harness-adapters';

  /**
   * What the selected harness cannot do, from its adapter manifest. The list
   * is presentation metadata: the host still enforces every setting at launch,
   * and nothing here is a sandbox claim.
   */
  interface Props {
    harness: Harness;
  }
  let { harness }: Props = $props();
  const configuration = $derived(harnessConfiguration(harness));
  const limitations = $derived(configuration?.limitations ?? []);
</script>

{#if configuration && limitations.length}
  <details class="limits">
    <summary>
      <Info size={13} aria-hidden="true" />
      <span>{$t('Limitations of {0}', [configuration.name])}</span>
      <span class="limits__count">{limitations.length}</span>
    </summary>
    <ul>
      {#each limitations as limitation (limitation)}
        <li>{$t(limitation)}</li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .limits {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    margin-left: -4px;
    border-radius: var(--piui-radius-sm);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  /* Decorative disclosure marker; `details` already exposes the state. */
  summary::before {
    content: '▸' / '';
    font-size: 10px;
  }
  .limits[open] summary::before {
    content: '▾' / '';
  }
  summary:hover {
    color: var(--piui-text);
  }
  summary:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .limits__count {
    min-width: 16px;
    padding: 0 5px;
    border-radius: 8px;
    background: var(--piui-surface-2);
    font-size: var(--piui-text-xs);
    text-align: center;
  }
  ul {
    display: grid;
    gap: 4px;
    margin: 6px 0 0;
    padding-left: 18px;
    line-height: var(--piui-leading-normal);
  }
</style>
