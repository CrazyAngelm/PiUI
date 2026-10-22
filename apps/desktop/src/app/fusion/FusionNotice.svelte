<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { t } from '../../features/locale/language';
  import type { SessionNoticeCode } from '../../features/workspace/sessionNotices';

  /**
   * A Fusion lead whose harness could not take the `sidekick` tool (ADR-043):
   * the chat works, but the lead cannot hand work to its sidekick.
   */
  interface Props {
    code: SessionNoticeCode | undefined;
  }
  let { code }: Props = $props();

  const text = $derived(
    code === 'unsupported-sidekick-tool'
      ? $t('This harness could not take the sidekick tool, so the lead cannot delegate to its sidekick in this chat.')
      : code === 'unsupported-sidekick-tool-resume'
        ? $t('This resumed chat was started without the sidekick tool, so the lead cannot delegate. Start a new Fusion chat to work as a pair.')
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
