<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Download from '@lucide/svelte/icons/download';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { t } from '../../features/locale/language';
  import { dictationHost, type DictationClient } from '../../host-api/dictationClient';
  import { nanoAccountHost, type NanoAccountClient } from '../../host-api/nanoAccountClient';
  import { Button, toasts } from '../../lib/ui';
  import { bytesToBase64, dictationClock } from './dictation';
  import { dictationPending, type PendingRecordings } from './dictationPendingStore.svelte';
  import { dictationTransport, retryRecording } from './dictationTransport';
  import { dictationSource as sharedSource, type DictationSource } from './dictationSource.svelte';

  interface Props {
    /** The composer this bar belongs to; the same string the dictation button of that composer gets. */
    scope: string;
    /** Receives the recognized words; the composer puts them at its caret. */
    onText: (text: string) => void;
    disabled?: boolean;
    /** Test seams. */
    client?: Pick<NanoAccountClient, 'dictate'>;
    provider?: Pick<DictationClient, 'transcribe' | 'saveRecording'>;
    source?: DictationSource;
    pending?: PendingRecordings;
  }
  let { scope, onText, disabled = false, client = nanoAccountHost, provider = dictationHost, source = sharedSource, pending = dictationPending }: Props = $props();

  // A clip this window is still recording or sending is not offered for retry.
  const recording = $derived(pending.visible(scope));
  let working = $state<'retry' | 'save' | undefined>();
  let confirming = $state(false);
  let alive = true;

  // Clips another window of the app left appear as well.
  onMount(() => void pending.refresh());
  onDestroy(() => (alive = false));

  const text = $derived.by(() => {
    if (recording === undefined) return '';
    const clock = dictationClock(recording.durationMs);
    if (recording.reason === 'unsent') return $t('Recording {0} was not sent', [clock]);
    if (recording.reason === 'too-large') return $t('Recording {0} was too large to send', [clock]);
    return $t('Recording {0} was not transcribed', [clock]);
  });

  async function retry(): Promise<void> {
    const current = recording;
    if (current === undefined || working !== undefined) return;
    working = 'retry';
    const outcome = await retryRecording(current, dictationTransport(source, client, provider), source.maxBytes);
    working = undefined;
    if (outcome.ok) {
      // A composer that went away cannot take the words: the clip stays then, so nothing is lost.
      if (!alive) return;
      onText(outcome.text);
      await pending.remove(scope, current.id);
    } else {
      // Only while the clip is still the one that was retried: a removed or replaced one stays gone.
      await pending.replace(scope, current.id, { ...current, reason: outcome.reason, error: outcome.error });
      toasts.show({ tone: 'warning', title: $t('Dictation did not finish'), description: $t(outcome.error), duration: 6000 });
    }
  }

  async function save(): Promise<void> {
    const current = recording;
    if (current === undefined || working !== undefined) return;
    working = 'save';
    try {
      const audioBase64 = bytesToBase64(new Uint8Array(await current.blob.arrayBuffer()));
      const { saved } = await provider.saveRecording({ audioBase64, mimeType: current.mimeType });
      if (saved) toasts.show({ tone: 'success', title: $t('Audio saved.'), duration: 4500 });
    } catch {
      toasts.show({ tone: 'warning', title: $t('Could not save the audio.'), duration: 6000 });
    }
    working = undefined;
  }

  function remove(): void {
    const current = recording;
    if (current === undefined) return;
    // The clip is the only copy of what was said: the first press asks, the second deletes.
    if (!confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    void pending.remove(scope, current.id);
  }
</script>

{#if recording}
  <div class="pending" role="group" aria-label={$t('Unsent recording')}>
    <MicOff size={15} aria-hidden="true" />
    <div class="pending__text">
      <span>{text}</span>
      {#if pending.isVolatile(scope)}<span class="pending__note">{$t('Kept only until the app closes')}</span>{/if}
    </div>
    <div class="pending__actions">
      <Button size="sm" variant="ghost" loading={working === 'retry'} disabled={disabled || !source.available || working === 'save'} onclick={() => void retry()}>
        {#snippet leading()}<RotateCw size={14} />{/snippet}
        {$t('Retry')}
      </Button>
      <Button size="sm" variant="ghost" loading={working === 'save'} disabled={working === 'retry'} onclick={() => void save()}>
        {#snippet leading()}<Download size={14} />{/snippet}
        {$t('Save audio')}
      </Button>
      <Button
        size="sm"
        variant={confirming ? 'danger' : 'ghost'}
        disabled={working !== undefined}
        onclick={remove}
        onblur={() => (confirming = false)}
      >
        {#snippet leading()}<Trash2 size={14} />{/snippet}
        {confirming ? $t('Confirm delete') : $t('Delete')}
      </Button>
    </div>
  </div>
{/if}

<style>
  .pending {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
    margin: 8px 12px 0;
    padding: 4px 6px 4px 10px;
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .pending__text {
    flex: 1 1 12rem;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
  .pending__note {
    display: block;
    opacity: 0.85;
  }
  .pending__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-1);
  }
</style>
