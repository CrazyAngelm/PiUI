<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { t } from '../../features/locale/language';
  import type { SessionNoticeCode } from '../../features/workspace/sessionNotices';

  /**
   * The chat's model, reasoning or speed did not survive a restart: either a
   * reopened chat could not get its remembered settings back, or a choice just
   * made could not be saved. The chat works with the harness's own settings.
   */
  interface Props {
    notices: readonly SessionNoticeCode[];
  }
  let { notices }: Props = $props();

  const text = $derived(
    notices.includes('settings-not-restored')
      ? $t("This chat's saved model and reasoning could not be restored. It is using the harness defaults; choose them again.")
      : notices.includes('settings-not-remembered')
        ? $t("This chat's model and reasoning could not be saved. After a restart it uses the harness defaults.")
        : '',
  );
</script>

{#if text}
  <p class="notice" role="status">
    <TriangleAlert size={14} aria-hidden="true" />
    <span>{text}</span>
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
