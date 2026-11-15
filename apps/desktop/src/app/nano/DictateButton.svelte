<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Mic from '@lucide/svelte/icons/mic';
  import Square from '@lucide/svelte/icons/square';
  import { t } from '../../features/locale/language';
  import { dictationHost, type DictationClient } from '../../host-api/dictationClient';
  import { nanoAccountHost, type NanoAccountClient } from '../../host-api/nanoAccountClient';
  import { Spinner, Tooltip, toasts } from '../../lib/ui';
  import { DICTATION_NOTICE_COPY, dictationClockWithLimit, dictationNearLimit } from './dictation';
  import { dictationPending, type PendingRecordings } from './dictationPendingStore.svelte';
  import { Dictation, type DictationEnvironment } from './dictationSession.svelte';
  import { dictationErrorCopy, dictationTransport } from './dictationTransport';
  import { dictationSource as sharedSource, whenKeyChanges, type DictationSource } from './dictationSource.svelte';

  interface Props {
    /** Receives the recognized words; the composer puts them at its caret. */
    onText: (text: string) => void;
    /** The composer this button belongs to: `chat:<sessionId>` or `new:<workspaceId or "personal">`. One unsent recording is kept per scope. */
    scope: string;
    /** The composer cannot take input now (safe mode, sending). */
    disabled?: boolean;
    /** Test seams; the desktop uses the host client and the browser's recorder. */
    client?: Pick<NanoAccountClient, 'dictate'>;
    provider?: Pick<DictationClient, 'transcribe'>;
    source?: DictationSource;
    environment?: DictationEnvironment;
    pending?: PendingRecordings;
  }
  let {
    onText,
    scope,
    disabled = false,
    client = nanoAccountHost,
    provider = dictationHost,
    source = sharedSource,
    environment = undefined,
    pending = dictationPending,
  }: Props = $props();

  const dictation = untrack(
    () =>
      new Dictation(
        // The clip goes to the source that is active when it is sent.
        dictationTransport(source, client, provider),
        {
          maxBytes: () => source.maxBytes,
          onText: (text) => onText(text),
          errorCopy: dictationErrorCopy,
          scope: () => scope,
          pending,
        },
        environment,
      ),
  );
  const recording = $derived(dictation.phase === 'recording');
  const working = $derived(dictation.phase === 'requesting' || dictation.phase === 'sending');
  const label = $derived(recording ? $t('Stop dictation') : $t('Dictate'));
  const tooltip = $derived(recording ? $t('Stop dictation (Esc cancels)') : $t('Dictate'));
  const nearLimit = $derived(recording && dictationNearLimit(dictation.elapsedMs));
  const status = $derived(
    recording ? $t('Recording {0}', [dictationClockWithLimit(dictation.elapsedMs)]) : dictation.phase === 'sending' ? $t('Transcribing…') : '',
  );

  // A failure is told once, then forgotten with the toast.
  $effect(() => {
    const message = dictation.error;
    if (message === undefined) return;
    toasts.show({ tone: 'warning', title: $t('Dictation did not finish'), description: $t(message), duration: 6000 });
    dictation.clearError();
  });

  // A fact that is not a failure (the limit was reached, a recording is waiting) is told once as well.
  $effect(() => {
    const notice = dictation.notice;
    if (notice === undefined) return;
    toasts.show({ tone: notice === 'limit-reached' ? 'neutral' : 'warning', title: $t(DICTATION_NOTICE_COPY[notice]), duration: 6000 });
    dictation.clearNotice();
  });

  // Nothing is left recording when the composer goes away; what was said stays as a pending recording.
  onDestroy(() => dictation.cancel('teardown'));

  // A recording belongs to the source it started with: it is cancelled when the source changes or goes away.
  // Only a change of the key counts: the account status is replaced by every token refresh, and that
  // must not discard a clip that is being transcribed.
  const sourceKey = $derived(source.key);
  const cancelWhenSourceChanges = untrack(() => whenKeyChanges(source.key, () => dictation.cancel('teardown')));
  $effect(() => cancelWhenSourceChanges(sourceKey));

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && dictation.phase !== 'idle') {
      event.preventDefault();
      dictation.cancel();
    }
  }
</script>

<svelte:window onkeydown={keydown} />

{#if source.available}
  <Tooltip content={tooltip}>
    {#snippet trigger(props)}
      <button
        {...props}
        type="button"
        class="dictate"
        class:dictate--recording={recording}
        class:dictate--near-limit={nearLimit}
        aria-label={label}
        aria-busy={working || undefined}
        disabled={disabled || working}
        onclick={() => void dictation.toggle()}
      >
        {#if working}
          <Spinner size={14} />
        {:else if recording}
          <Square size={13} />
          <span class="dictate__clock" aria-hidden="true">{dictationClockWithLimit(dictation.elapsedMs)}</span>
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
  /* The last thirty seconds: the clock turns to the warning colour. */
  .dictate--near-limit {
    border-color: var(--piui-warning-border);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
    box-shadow: none;
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
