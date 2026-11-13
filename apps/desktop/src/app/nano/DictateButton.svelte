<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Mic from '@lucide/svelte/icons/mic';
  import Square from '@lucide/svelte/icons/square';
  import { t } from '../../features/locale/language';
  import { nanoAccountHost, type NanoAccountClient } from '../../host-api/nanoAccountClient';
  import { Spinner, Tooltip, toasts } from '../../lib/ui';
  import { dictationClock } from './dictation';
  import { Dictation, type DictationEnvironment } from './dictationSession.svelte';
  import { nanoAccount } from './nanoAccount.svelte';

  interface Props {
    /** Receives the recognized words; the composer puts them at its caret. */
    onText: (text: string) => void;
    /** The composer cannot take input now (safe mode, sending). */
    disabled?: boolean;
    /** Test seams; the desktop uses the host client and the browser's recorder. */
    client?: Pick<NanoAccountClient, 'dictate'>;
    environment?: DictationEnvironment;
  }
  let { onText, disabled = false, client = nanoAccountHost, environment = undefined }: Props = $props();

  const dictation = untrack(
    () => new Dictation(client, { maxBytes: () => nanoAccount.dictationMaxBytes, onText: (text) => onText(text) }, environment),
  );
  const recording = $derived(dictation.phase === 'recording');
  const working = $derived(dictation.phase === 'requesting' || dictation.phase === 'sending');
  const label = $derived(recording ? $t('Stop dictation') : $t('Dictate'));
  const tooltip = $derived(recording ? $t('Stop dictation (Esc cancels)') : $t('Dictate'));
  const status = $derived(
    recording ? $t('Recording {0}', [dictationClock(dictation.elapsedMs)]) : dictation.phase === 'sending' ? $t('Transcribing…') : '',
  );

  // A failure is told once, then forgotten with the toast.
  $effect(() => {
    const message = dictation.error;
    if (message === undefined) return;
    toasts.show({ tone: 'warning', title: $t('Dictation did not finish'), description: $t(message), duration: 6000 });
    dictation.clearError();
  });

  // Nothing is left recording when the composer goes away.
  onDestroy(() => dictation.cancel());

  // The recording is cancelled when the account stops allowing dictation.
  $effect(() => {
    if (!nanoAccount.canDictate) untrack(() => dictation.cancel());
  });

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && dictation.phase !== 'idle') {
      event.preventDefault();
      dictation.cancel();
    }
  }
</script>

<svelte:window onkeydown={keydown} />

{#if nanoAccount.canDictate}
  <Tooltip content={tooltip}>
    {#snippet trigger(props)}
      <button
        {...props}
        type="button"
        class="dictate"
        class:dictate--recording={recording}
        aria-label={label}
        aria-busy={working || undefined}
        disabled={disabled || working}
        onclick={() => void dictation.toggle()}
      >
        {#if working}
          <Spinner size={14} />
        {:else if recording}
          <Square size={13} />
          <span class="dictate__clock" aria-hidden="true">{dictationClock(dictation.elapsedMs)}</span>
        {:else}
          <Mic size={16} />
        {/if}
      </button>
    {/snippet}
  </Tooltip>
  <span class="visually-hidden" role="status">{status}</span>
{/if}

<style>
  .dictate {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: none;
    min-width: var(--piui-control-md);
    height: var(--piui-control-md);
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .dictate:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .dictate:disabled {
    color: var(--piui-text-disabled);
    cursor: default;
  }
  .dictate:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  /* Recording: one crimson accent, a slanted blade like the model picker's current row. */
  .dictate--recording {
    padding: 0 8px;
    border-color: color-mix(in srgb, var(--piui-decoration-primary) 55%, transparent);
    background: var(--piui-decoration-wash);
    color: var(--piui-decoration-primary);
    box-shadow: 0 0 10px var(--piui-decoration-glow);
    animation: dictate-pulse 1.4s ease-in-out infinite;
  }
  .dictate__clock {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    font-variant-numeric: tabular-nums;
  }
  @keyframes dictate-pulse {
    50% {
      box-shadow: 0 0 2px var(--piui-decoration-glow);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dictate--recording {
      animation: none;
    }
  }
  :global(:root[data-reduced-motion='reduce']) .dictate--recording {
    animation: none;
  }
</style>
