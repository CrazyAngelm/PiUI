<script lang="ts">
  import History from '@lucide/svelte/icons/history';
  import { t } from '../../features/locale/language';
  import { Button } from '../../lib/ui';
  import { openView, type PreviousView } from '../viewSwitch';

  interface Props {
    /** Test seam; the desktop reloads the WebView with the chosen view. */
    onOpen?: (view: PreviousView) => void;
  }
  let { onOpen = openView }: Props = $props();
</script>

<div class="row">
  <span class="icon" aria-hidden="true"><History size={16} /></span>
  <div class="text">
    <strong>{$t('Classic view')}</strong>
    <small>{$t('The previous interface is still available in this release and will be removed in the next one. To come back, open its Settings and choose “New interface”.')}</small>
  </div>
  <div class="actions">
    <Button size="sm" onclick={() => onOpen('legacy')}>{$t('Open classic view')}</Button>
    <Button size="sm" variant="ghost" onclick={() => onOpen('classic')}>{$t('Open Pi-only view')}</Button>
  </div>
</div>

<style>
  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-3);
    margin-top: var(--piui-space-4);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .icon {
    display: inline-flex;
    margin-top: 2px;
    color: var(--piui-text-muted);
  }
  .text {
    display: grid;
    flex: 1;
    gap: 2px;
    min-width: 0;
  }
  .text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--piui-space-2);
  }
</style>
