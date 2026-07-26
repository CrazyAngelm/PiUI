<script lang="ts">
  import type { RuntimeSnapshot } from '../../host-api/types';
  export let runtime: RuntimeSnapshot | undefined;
  export let canStart = false;
  export let busy = false;
  export let onStart: () => void;
  export let onStop: () => void;

  const label: Record<string, string> = { dormant: 'Dormant', starting: 'Starting', ready: 'Ready', running: 'Running', recovering: 'Recovering', stopping: 'Stopping', failed: 'Failed' };
</script>

<div class="runtime-bar" aria-live="polite">
  <div class="status"><span class:status-dot--ready={runtime?.state === 'ready' || runtime?.state === 'running'} class:status-dot--failed={runtime?.state === 'failed'} class="status-dot status-dot--dormant" aria-hidden="true"></span><span>{runtime ? label[runtime.state] : 'Read-only'}</span></div>
  <p>{runtime?.safeSummary ?? 'The deterministic fake runtime does not send prompts or modify sessions.'}</p>
  {#if runtime?.state === 'ready' || runtime?.state === 'running'}
    <button type="button" class="runtime-button" onclick={onStop} disabled={busy}>Stop fake runtime</button>
  {:else}
    <button type="button" class="runtime-button" onclick={onStart} disabled={!canStart || busy}>{busy ? 'Working…' : 'Run fake runtime'}</button>
  {/if}
</div>

<style>
  .runtime-bar { display: flex; align-items: center; gap: var(--piui-space-3); min-height: 48px; padding: 8px var(--piui-space-6); border-top: 1px solid var(--piui-border); background: var(--piui-bg-raised); }
  .status { display: flex; flex: 0 0 auto; align-items: center; gap: var(--piui-space-2); color: var(--piui-text); font-size: 12px; font-weight: 700; }
  p { overflow: hidden; margin: 0; color: var(--piui-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .runtime-button { flex: 0 0 auto; margin-left: auto; min-height: 30px; padding: 0 var(--piui-space-2); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font-size: 11px; font-weight: 700; }
  .runtime-button:hover:not(:disabled) { border-color: var(--piui-accent); }.runtime-button:disabled { opacity: .55; }
  @media (max-width: 700px) { .runtime-bar { padding: 8px var(--piui-space-4); }.runtime-bar p { display: none; } }
</style>
