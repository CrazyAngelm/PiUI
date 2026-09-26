<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { t } from '../../features/locale/language';
  import { extensionsHost, type ExtensionsClient } from '../../host-api/extensionsClient';
  import { Badge, Button, EmptyState, Segmented, Skeleton, Switch } from '../../lib/ui';
  import { ExtensionInventory } from './extensionInventory.svelte';

  interface Props {
    safeMode: boolean;
    /** Test seam; the desktop uses the transport-backed client. */
    client?: ExtensionsClient;
  }
  let { safeMode, client = extensionsHost }: Props = $props();
  // The client is fixed for the lifetime of this settings page.
  const inventory = new ExtensionInventory(untrack(() => client));
  const label = $derived(inventory.harness === 'pi' ? 'Pi' : 'Prime Agent');

  onMount(() => {
    void inventory.load();
  });
</script>

<div class="title-row">
  <h2>{$t('Extensions')}</h2>
  <Button size="sm" onclick={() => void inventory.load()} loading={inventory.loading} disabled={inventory.busyId !== undefined}>
    {#snippet leading()}<RefreshCw />{/snippet}
    {$t('Refresh')}
  </Button>
</div>
<p class="lead">{$t('Global extensions run with your full user permissions. A change applies the next time that harness starts.')}</p>

<div class="toolbar">
  <Segmented
    label={$t('Harness')}
    value={inventory.harness}
    options={[
      { value: 'pi', label: 'Pi', disabled: inventory.busyId !== undefined },
      { value: 'prime-agent', label: 'Prime Agent', disabled: inventory.busyId !== undefined },
    ]}
    onValueChange={(value) => inventory.select(value)}
  />
</div>

<p class="note" role="note">
  {inventory.harness === 'pi'
    ? $t('Pi and Prime Agent keep separate extension folders. Turning an extension on here does not enable it for Prime Agent.')
    : $t('Some extension APIs share names with Pi, but compatibility is not assumed. Install and test each extension for Prime Agent separately.')}
</p>
{#if safeMode}
  <p class="note" role="status">{$t('Safe mode: extensions are not loaded now. You can still turn one off before the next normal start.')}</p>
{/if}

{#if inventory.error}
  <p class="error" role="alert"><TriangleAlert size={14} /> {$t(inventory.error)}</p>
{/if}

{#if inventory.loading && !inventory.loaded}
  <div class="rows rows--loading" aria-busy="true"><Skeleton lines={3} /></div>
{:else if inventory.loaded && inventory.items.length === 0}
  <EmptyState size="sm" icon={Puzzle} title={$t('No global extensions found')} description={$t('Install extensions with {0}, then refresh this page.', [label])} />
{:else if inventory.items.length > 0}
  <ul class="rows" aria-label={$t('Global {0} extensions', [label])}>
    {#each inventory.items as extension (extension.id)}
      <li class="row">
        <span class="mark" aria-hidden="true">{extension.name.slice(0, 1).toUpperCase()}</span>
        <span class="text">
          <strong>{extension.name}</strong>
          <small>{extension.source === 'Package' ? $t('Package extension') : $t('Global extension')}</small>
        </span>
        {#if !extension.enabled}<Badge>{$t('Off')}</Badge>{/if}
        <Switch
          checked={extension.enabled}
          disabled={inventory.busyId !== undefined}
          hideLabel
          label={extension.enabled ? $t('Turn off {0} for {1}', [extension.name, label]) : $t('Turn on {0} for {1}', [extension.name, label])}
          onCheckedChange={(checked) => void inventory.toggle(extension, checked)}
        />
      </li>
    {/each}
  </ul>
{/if}
<p class="muted small">{$t('Project extensions are not managed here. A harness loads a folder’s own extensions only after you trust that folder.')}</p>

<style>
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  .lead {
    margin: var(--piui-space-2) 0 var(--piui-space-4);
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .toolbar {
    margin-bottom: var(--piui-space-3);
  }
  .note {
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .error {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-danger);
  }
  .rows {
    display: grid;
    margin: 0;
    padding: 0;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
    list-style: none;
  }
  .rows--loading {
    padding: var(--piui-space-4);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3) var(--piui-space-4);
  }
  .row + .row {
    border-top: 1px solid var(--piui-border-subtle);
  }
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    font-weight: var(--piui-weight-semibold);
    flex: none;
  }
  .text {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .text strong {
    overflow: hidden;
    font-weight: var(--piui-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .small {
    margin-top: var(--piui-space-4);
    font-size: var(--piui-text-sm);
  }
</style>
