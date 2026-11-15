import { DictationOperationError, type DictationClient } from '../../host-api/dictationClient';
import { nanoAccountError, type NanoAccountClient } from '../../host-api/nanoAccountClient';
import { DICTATION_ERROR_COPY, bytesToBase64, dictationClipError } from './dictation';
import { DICTATION_SOURCE_ERROR_COPY } from './dictationCopy';
import type { PendingReason, PendingRecording } from './dictationPendingStore.svelte';
import type { DictationTransport } from './dictationSession.svelte';
import type { DictationSource } from './dictationSource.svelte';

/** Sends a clip to the source that is active when it is sent. */
export function dictationTransport(
  source: Pick<DictationSource, 'active'>,
  client: Pick<NanoAccountClient, 'dictate'>,
  provider: Pick<DictationClient, 'transcribe'>,
): DictationTransport {
  return { dictate: (request) => (source.active === 'nano' ? client.dictate(request) : provider.transcribe(request)) };
}

/** English source copy of a failed transcription; the view translates it. */
export function dictationErrorCopy(cause: unknown): string {
  return cause instanceof DictationOperationError ? DICTATION_SOURCE_ERROR_COPY[cause.code] : nanoAccountError(cause).message;
}

export type RetryOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: PendingReason; /** English source copy. */ readonly error: string };

/** Transcribes a pending recording again with the source that is active now. Never throws. */
export async function retryRecording(
  recording: Pick<PendingRecording, 'blob' | 'mimeType'>,
  transport: DictationTransport,
  maxBytes: number | undefined,
  errorCopy: (cause: unknown) => string = dictationErrorCopy,
): Promise<RetryOutcome> {
  const kind = dictationClipError(recording.blob.size, maxBytes);
  if (kind === 'too-large') return { ok: false, reason: 'too-large', error: DICTATION_ERROR_COPY[kind] };
  if (kind !== undefined) return { ok: false, reason: 'empty', error: DICTATION_ERROR_COPY[kind] };
  try {
    const audioBase64 = bytesToBase64(new Uint8Array(await recording.blob.arrayBuffer()));
    const answer = await transport.dictate({ audioBase64, mimeType: recording.mimeType });
    const text = answer.text.trim();
    return text === '' ? { ok: false, reason: 'empty', error: DICTATION_ERROR_COPY.empty } : { ok: true, text };
  } catch (cause) {
    return { ok: false, reason: 'failed', error: errorCopy(cause) };
  }
}
