<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { t } from '../../features/locale/language';
  import { parseTimestamp } from '../../host-api/projectsClient';
  import type { SessionSummary } from '../../host-api/types';
  import { IconButton } from '../../lib/ui';
  import SessionBranches from './SessionBranches.svelte';
  import { parseStateLabel, type HistoryReader } from './piHistory';

  interface Props {
    session: SessionSummary;
    reader: HistoryReader | undefined;
    agentLabel: string;
    onClose: () => void;
  }
  let { session, reader, agentLabel, onClose }: Props = $props();

  const fileState = $derived(parseStateLabel(session.parseState));
  function when(value: string | undefined): string {
    const time = parseTimestamp(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : '—';
  }
</script>

<aside class="details" aria-label={$t('Session details')}>
  <header>
    <h2>{$t('Details')}</h2>
    <IconButton label={$t('Close details')} size="sm" onclick={onClose}><X /></IconButton>
  </header>
  <div class="body">
    <dl>
      <div><dt>{$t('Source')}</dt><dd>{$t('{0} session file', [agentLabel])}</dd></div>
      <div><dt>{$t('Started')}</dt><dd>{when(session.createdAt)}</dd></div>
      <div><dt>{$t('Updated')}</dt><dd>{when(session.updatedAt)}</dd></div>
      <div><dt>{$t('Entries')}</dt><dd>{session.entryCount}</dd></div>
      {#if reader && !reader.loading}
        <div><dt>{$t('Loaded')}</dt><dd>{$t('{0} of {1} messages and actions', [reader.blocks.length, reader.totalBlocks])}</dd></div>
      {/if}
      {#if fileState}<div><dt>{$t('File')}</dt><dd class="warn">{$t(fileState)}</dd></div>{/if}
    </dl>
    <SessionBranches tree={reader?.tree} {agentLabel} />
    <p class="muted small">{$t('PiUI reads this history from the harness’s own files and never changes them.')}</p>
  </div>
</aside>

<style>
  .details {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-2) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .body {
    display: grid;
    align-content: start;
    gap: var(--piui-space-6);
    padding: var(--piui-space-4);
    overflow-y: auto;
  }
  dl {
    display: grid;
    gap: var(--piui-space-3);
    margin: 0;
  }
  dl div {
    display: grid;
    gap: 2px;
  }
  dt {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
  .warn {
    color: var(--piui-warning-text);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .small {
    margin: 0;
    font-size: var(--piui-text-sm);
  }
</style>
