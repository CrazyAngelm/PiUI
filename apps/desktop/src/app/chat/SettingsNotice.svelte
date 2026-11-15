<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { t } from '../../features/locale/language';

  /**
   * A reopened chat whose remembered model, reasoning or speed could not be
   * re-applied: it opened and works, with the harness's own settings.
   */
  interface Props {
    shown: boolean;
  }
  let { shown }: Props = $props();
</script>

{#if shown}
  <p class="notice" role="status">
    <TriangleAlert size={14} aria-hidden="true" />
    <span>{$t("This chat's saved model and reasoning could not be restored. It is using the harness defaults; choose them again.")}</span>
  </p>
{/if}

<style>
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 8px 12px;
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .notice :global(svg) {
    flex: none;
    margin-top: 2px;
  }
</style>
