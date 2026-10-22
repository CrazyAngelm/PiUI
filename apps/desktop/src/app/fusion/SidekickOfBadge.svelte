<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye';
  import { t } from '../../features/locale/language';
  import { useWorkspace } from '../shell/context';

  /**
   * The header badge of a sidekick's own chat (ADR-043). The sidekick is
   * driven by the broker through the lead's briefs, so the person reads its
   * conversation here but does not write to it. A link opens the lead chat.
   */
  interface Props {
    leadSessionId: string | undefined;
  }
  let { leadSessionId }: Props = $props();
  const store = useWorkspace();

  const lead = $derived(leadSessionId === undefined ? undefined : store.catalog.sessions.find((item) => item.id === leadSessionId));
  const leadTitle = $derived(lead?.title ?? $t('the lead chat'));
</script>

<span class="badge" title={$t('Read-only: the lead gives the sidekick its work through briefs.')} role="note" aria-label={$t('Sidekick of {0}. Read-only.', [leadTitle])}>
  <Eye size={12} aria-hidden="true" />
  <span class="badge__text">{$t('Sidekick of {0}', [leadTitle])}</span>
</span>
{#if leadSessionId}
  <button type="button" class="link" onclick={() => void store.openSession(leadSessionId)}>{$t('Open lead chat')}</button>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    max-width: 280px;
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--piui-border-subtle);
    border-left: 3px solid var(--piui-chaos-gold);
    border-radius: var(--piui-radius-xs);
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-medium);
  }
  .link:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .badge__text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link {
    flex: none;
    padding: 0 4px;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    font-size: var(--piui-text-xs);
    text-decoration: underline;
  }
</style>
