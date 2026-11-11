/**
 * Composer dictation, the pure rules (ADR-047: the clip is sent to Nano and
 * kept nowhere). The recording itself lives in `dictationSession.svelte.ts`.
 */

/** The recording format the host sends on as is. */
export const DICTATION_MIME_PREFERENCE: readonly string[] = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
/** A clip never runs longer than two minutes. */
export const DICTATION_MAX_MS = 120_000;
/** Chunks arrive this often, so the size limit is checked while recording. */
export const DICTATION_TIMESLICE_MS = 1_000;
/** Used when the server did not say how large a clip may be (20 MiB, as the Nano web app). */
export const DICTATION_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export type DictationErrorKind = 'unsupported' | 'denied' | 'no-device' | 'failed' | 'too-large' | 'empty';

/** English source strings of the locale catalog. */
export const DICTATION_ERROR_COPY: Readonly<Record<DictationErrorKind, string>> = {
  unsupported: 'Dictation is not available in this window.',
  denied: 'Allow microphone access to dictate.',
  'no-device': 'No microphone was found.',
  failed: 'Could not record. Try again.',
  'too-large': 'The recording was too large to send.',
  empty: 'No speech was recognized. Try again.',
};

/** The first preferred format the recorder supports, or undefined when none is. */
export function pickDictationMime(isSupported: (mime: string) => boolean): string | undefined {
  return DICTATION_MIME_PREFERENCE.find((mime) => {
    try {
      return isSupported(mime);
    } catch {
      return false;
    }
  });
}

/** The size limit that applies: the entitlement's, else the default; never less than one byte. */
export function dictationByteLimit(maxBytes: number | undefined): number {
  return maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DICTATION_DEFAULT_MAX_BYTES;
}

/** True once the recording must stop because it reached its time or size limit. */
export function dictationLimitReached(elapsedMs: number, bytes: number, maxBytes: number | undefined): boolean {
  // Stop a slice early: the chunk that is still being recorded must fit as well.
  const limit = dictationByteLimit(maxBytes);
  return elapsedMs >= DICTATION_MAX_MS || bytes >= limit - bytesPerSlice(limit);
}

/** Room kept below the byte limit for the chunk still in flight: an eighth of the limit, at most 256 KiB. */
function bytesPerSlice(limit: number): number {
  return Math.min(256 * 1024, Math.ceil(limit / 8));
}

/** A finished clip may be sent: it holds audio and fits the limit. */
export function dictationClipError(size: number, maxBytes: number | undefined): DictationErrorKind | undefined {
  if (size <= 0) return 'empty';
  return size > dictationByteLimit(maxBytes) ? 'too-large' : undefined;
}

/** Maps what `getUserMedia` or a recorder threw to the error to show. */
export function dictationFailure(cause: unknown): DictationErrorKind {
  const name = typeof cause === 'object' && cause !== null && 'name' in cause ? String((cause as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no-device';
  return 'failed';
}

/** Whether this window can record at all. */
export function canRecordAudio(environment: { readonly mediaDevices?: { readonly getUserMedia?: unknown } | undefined; readonly recorder?: unknown }): boolean {
  return typeof environment.mediaDevices?.getUserMedia === 'function' && typeof environment.recorder === 'function';
}

/**
 * Puts dictated text into a message at the caret. The caret clamps into the
 * text; a space keeps the words apart when the neighbours are not blanks.
 * Returns the new text and the caret after the inserted words.
 */
export function insertAtCaret(text: string, caret: number, inserted: string): { text: string; caret: number } {
  const words = inserted.trim();
  const at = Math.min(Math.max(0, Number.isFinite(caret) ? Math.floor(caret) : text.length), text.length);
  if (words === '') return { text, caret: at };
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const tail = after !== '' && !/^\s/.test(after) ? ' ' : '';
  const next = `${before}${lead}${words}${tail}${after}`;
  // The caret lands after the separating blank, whether added or already there.
  const gap = tail !== '' || /^[ \t]/.test(after) ? 1 : 0;
  return { text: next, caret: before.length + lead.length + words.length + gap };
}

/** `m:ss` of a recording's running time. */
export function dictationClock(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Standard base64 of a clip; chunked, so a long recording never overflows the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return btoa(binary);
}
