import { nanoAccountError } from '../../host-api/nanoAccountClient';
import { desktopAvailable, hostRemote } from '../../host-api/transport';
import {
  DICTATION_BITS_PER_SECOND,
  DICTATION_CHECKPOINT_MS,
  DICTATION_ERROR_COPY,
  DICTATION_KEEP_ON_ESCAPE_MS,
  DICTATION_TIMESLICE_MS,
  bytesToBase64,
  canRecordAudio,
  dictationClipError,
  dictationFailure,
  dictationLimitReached,
  pickDictationMime,
  type DictationErrorKind,
  type DictationNotice,
} from './dictation';
import { requestDictationMicrophone } from './dictationMicrophone';
import { WAV_MIME, WavRecorder, assembleClip, canRecordWav } from './wavRecorder';
import { newRecordingId, type PendingReason, type PendingRecordings } from './dictationPendingStore.svelte';

/** The parts of `MediaRecorder` the session uses. */
export interface RecorderLike {
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(timesliceMs: number): void;
  stop(): void;
}

/** The browser seams of a recording; tests substitute fakes. */
export interface DictationEnvironment {
  readonly available: boolean;
  isTypeSupported(mime: string): boolean;
  requestMicrophone(): Promise<MediaStream>;
  createRecorder(stream: MediaStream, mimeType: string): RecorderLike;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export function browserDictationEnvironment(native = desktopAvailable && !hostRemote): DictationEnvironment {
  const browser = typeof navigator === 'undefined' ? undefined : navigator;
  // WebKitGTK can advertise MP4 but produce no audio. Native Linux records through Web Audio.
  const nativeLinux = native && /^Linux\b/.test(browser?.platform ?? '');
  const recorder = nativeLinux || typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder;
  const wav = canRecordWav();
  return {
    available: canRecordAudio({ mediaDevices: browser?.mediaDevices, recorder: recorder ?? (wav ? WavRecorder : undefined) }),
    isTypeSupported: (mime) => (mime === WAV_MIME ? wav : (recorder?.isTypeSupported(mime) ?? false)),
    requestMicrophone: requestDictationMicrophone,
    // MediaRecorder's event types are wider than the slice the session reads.
    createRecorder: (stream, mimeType) => mimeType === WAV_MIME
      ? new WavRecorder(stream)
      : new MediaRecorder(stream, { mimeType, audioBitsPerSecond: DICTATION_BITS_PER_SECOND }) as unknown as RecorderLike,
    now: () => Date.now(),
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]),
  };
}

export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'sending';

/** Sends one clip for transcription. */
export interface DictationTransport {
  dictate(request: { readonly audioBase64: string; readonly mimeType: string }): Promise<{ readonly text: string }>;
}

/**
 * One composer's dictation: record from the microphone, send the clip through
 * the host to the chosen speech service, hand the text back. A recording stops
 * by itself at ten minutes or at the size the plan allows. A recording is
 * never lost (ADR-066): from five seconds on it is saved to the scope's pending
 * store every five seconds, and the finished clip is saved before it is
 * uploaded. When it cannot be turned into text, is cut short or is abandoned
 * after five seconds, it stays until it is sent, saved or deleted. Only a
 * success, an Esc within five seconds and a recording without audio leave
 * nothing behind. The scope and the id are fixed when the recording starts.
 */
export class Dictation {
  phase = $state<DictationPhase>('idle');
  /** English source copy of the last failure; the view translates it. */
  error = $state<string | undefined>();
  /** A fact worth a toast that is not a failure; the view translates `DICTATION_NOTICE_COPY`. */
  notice = $state<DictationNotice | undefined>();
  elapsedMs = $state(0);
  private chunks: Blob[] = [];
  private bytes = 0;
  private stream: MediaStream | undefined;
  private recorder: RecorderLike | undefined;
  private mimeType = '';
  private startedAt = 0;
  private timer: unknown;
  private discard = false;
  private stopping = false;
  /** Set when the recording is ending to be kept as it is instead of sent. */
  private keepOnStop = false;
  /** The finished clip while it is being read or uploaded. */
  private inflight: { readonly clip: Blob; readonly mimeType: string; readonly durationMs: number } | undefined;
  /** The scope and id fixed by `start`; every write of this recording uses them. */
  private recordingScope = '';
  private recordingId = '';
  /** The id this session holds in the pending store while it records or sends. */
  private heldId: string | undefined;
  /** When the last checkpoint was written, in `environment.now()` time. */
  private lastCheckpointAt: number | undefined;
  /** Bumped by every start and cancel, so a late callback of an old recording is ignored. */
  private generation = 0;

  constructor(
    private readonly client: DictationTransport,
    private readonly options: {
      readonly maxBytes: () => number | undefined;
      readonly onText: (text: string) => void;
      /** English source copy for a failed request; the Nano account's copy when absent. */
      readonly errorCopy?: (cause: unknown) => string;
      /** The composer the recording belongs to, and where an unsent clip is kept. */
      readonly scope: () => string;
      readonly pending: PendingRecordings;
    },
    private readonly environment: DictationEnvironment = browserDictationEnvironment(),
  ) {}

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  async toggle(): Promise<void> {
    if (this.phase === 'recording') this.stop();
    else if (this.phase === 'idle') await this.start();
  }

  async start(): Promise<void> {
    if (this.phase !== 'idle') return;
    this.error = undefined;
    this.notice = undefined;
    const scope = this.options.scope();
    const id = newRecordingId();
    const mimeType = this.environment.available ? pickDictationMime((mime) => this.environment.isTypeSupported(mime)) : undefined;
    if (mimeType === undefined) return this.fail('unsupported');
    const generation = ++this.generation;
    this.phase = 'requesting';
    // One unsent recording per composer: the person decides about it first.
    await this.options.pending.load();
    if (generation !== this.generation) return;
    if (this.options.pending.get(scope) !== undefined) {
      this.toIdle();
      this.notice = 'previous-recording';
      return;
    }
    let stream: MediaStream;
    try {
      stream = await this.environment.requestMicrophone();
    } catch (cause) {
      if (generation === this.generation) this.fail(dictationFailure(cause));
      return;
    }
    if (generation !== this.generation) {
      stopTracks(stream);
      return;
    }
    try {
      const recorder = this.environment.createRecorder(stream, mimeType);
      this.stream = stream;
      this.recorder = recorder;
      this.mimeType = mimeType;
      this.chunks = [];
      this.bytes = 0;
      this.discard = false;
      this.stopping = false;
      this.keepOnStop = false;
      this.inflight = undefined;
      this.recordingScope = scope;
      this.recordingId = id;
      this.lastCheckpointAt = undefined;
      recorder.ondataavailable = (event) => this.collect(generation, event.data);
      recorder.onstop = () => void this.finish(generation);
      recorder.onerror = () => this.abort(generation, 'failed');
      this.startedAt = this.environment.now();
      this.elapsedMs = 0;
      recorder.start(DICTATION_TIMESLICE_MS);
      this.options.pending.hold(id);
      this.heldId = id;
      this.phase = 'recording';
      this.timer = this.environment.setInterval(() => this.tick(generation), 250);
    } catch (cause) {
      stopTracks(stream);
      this.release();
      this.fail(dictationFailure(cause));
    }
  }

  /** Ends the recording and sends it. */
  stop(): void {
    if (this.phase !== 'recording' || this.stopping) return;
    this.stopping = true;
    try {
      this.recorder?.stop();
    } catch {
      this.abort(this.generation, 'failed');
    }
  }

  /**
   * Ends the recording without sending anything. Esc keeps what was recorded
   * when it ran for five seconds or more; tearing the composer down (or
   * changing the source) always keeps it, as a pending recording.
   */
  cancel(reason: 'escape' | 'teardown' = 'escape'): void {
    if (this.phase === 'idle') return;
    if (this.phase === 'recording') {
      const elapsed = Math.max(0, this.environment.now() - this.startedAt);
      if (reason === 'teardown' || elapsed >= DICTATION_KEEP_ON_ESCAPE_MS) {
        // The recorder delivers its last chunk first; `finish` keeps the clip.
        this.keepOnStop = true;
        this.stop();
        return;
      }
    }
    // Every other cancel keeps the clip: it is already in the store. Esc on a
    // recording or upload shorter than five seconds leaves nothing.
    const inflight = this.inflight;
    const keep = reason === 'teardown' || (inflight !== undefined && inflight.durationMs >= DICTATION_KEEP_ON_ESCAPE_MS);
    if (!keep && this.recordingId !== '') void this.options.pending.remove(this.recordingScope, this.recordingId);
    this.generation += 1;
    this.discard = true;
    this.inflight = undefined;
    const recorder = this.recorder;
    this.release();
    this.toIdle();
    this.error = undefined;
    try {
      recorder?.stop();
    } catch {
      // Already stopped.
    }
  }

  clearError(): void {
    this.error = undefined;
  }

  clearNotice(): void {
    this.notice = undefined;
  }

  private collect(generation: number, data: Blob): void {
    if (generation !== this.generation || this.discard) return;
    if (data.size > 0) {
      this.chunks.push(data);
      this.bytes += data.size;
    }
    this.guard(generation);
  }

  private tick(generation: number): void {
    if (generation !== this.generation) return;
    this.elapsedMs = this.environment.now() - this.startedAt;
    this.checkpoint();
    this.guard(generation);
  }

  /** Saves what was recorded so far, so an app that dies mid-speech loses at most the last few seconds. */
  private checkpoint(): void {
    if (this.phase !== 'recording' || this.stopping || this.chunks.length === 0 || this.elapsedMs < DICTATION_KEEP_ON_ESCAPE_MS) return;
    const at = this.environment.now();
    if (this.lastCheckpointAt !== undefined && at - this.lastCheckpointAt < DICTATION_CHECKPOINT_MS) return;
    this.lastCheckpointAt = at;
    void this.options.pending.put({
      id: this.recordingId,
      scope: this.recordingScope,
      blob: assembleClip(this.chunks, this.mimeType),
      mimeType: this.mimeType,
      durationMs: this.elapsedMs,
      createdAt: at,
      reason: 'unsent',
    });
  }

  private guard(generation: number): void {
    if (generation !== this.generation || this.phase !== 'recording' || this.stopping) return;
    if (!dictationLimitReached(this.elapsedMs, this.bytes, this.options.maxBytes())) return;
    this.notice = 'limit-reached';
    this.stop();
  }

  /** The recorder failed: what was said so far is kept for a retry. */
  private abort(generation: number, kind: DictationErrorKind): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.discard = true;
    const parts = this.chunks;
    const mimeType = this.mimeType;
    const durationMs = Math.max(0, this.environment.now() - this.startedAt);
    const recorder = this.recorder;
    const target = this.target(mimeType);
    this.release();
    try {
      recorder?.stop();
    } catch {
      // Already stopped.
    }
    const clip = assembleClip(parts, mimeType);
    if (clip.size > 0) void this.keep(target, clip, durationMs, 'failed', DICTATION_ERROR_COPY[kind]);
    else void this.options.pending.remove(target.scope, target.id);
    this.fail(kind);
  }

  /** The scope, id and format this recording writes under. */
  private target(mimeType: string): RecordingTarget {
    return { scope: this.recordingScope, id: this.recordingId, mimeType };
  }

  /** Writes the clip under the recording's own id; resolves to whether it reached the storage. */
  private keep(target: RecordingTarget, clip: Blob, durationMs: number, reason: PendingReason, error: string | undefined = undefined): Promise<boolean> {
    return this.options.pending.put({
      id: target.id,
      scope: target.scope,
      blob: clip,
      mimeType: target.mimeType,
      durationMs,
      createdAt: this.environment.now(),
      reason,
      ...(error === undefined ? {} : { error }),
    });
  }

  private async finish(generation: number): Promise<void> {
    if (generation !== this.generation || this.discard) return;
    const parts = this.chunks;
    const mimeType = this.mimeType;
    const target = this.target(mimeType);
    const durationMs = Math.max(0, this.environment.now() - this.startedAt);
    const keepAsIs = this.keepOnStop;
    this.keepOnStop = false;
    this.release();
    const clip = assembleClip(parts, mimeType);
    if (keepAsIs) {
      if (clip.size > 0) void this.keep(target, clip, durationMs, 'unsent');
      else void this.options.pending.remove(target.scope, target.id);
      this.toIdle();
      return;
    }
    const kind = dictationClipError(clip.size, this.options.maxBytes());
    if (kind === 'too-large') void this.keep(target, clip, durationMs, 'too-large');
    else if (kind !== undefined) void this.options.pending.remove(target.scope, target.id);
    if (kind !== undefined) return this.fail(kind);
    this.inflight = { clip, mimeType, durationMs };
    this.phase = 'sending';
    try {
      // The clip is in the store before it leaves: an app that closes or dies during the upload loses nothing.
      await this.keep(target, clip, durationMs, 'unsent');
      if (generation !== this.generation) return;
      const audioBase64 = bytesToBase64(new Uint8Array(await clip.arrayBuffer()));
      // Esc during the read cancelled the clip: nothing may be uploaded.
      if (generation !== this.generation) return;
      const answer = await this.client.dictate({ audioBase64, mimeType });
      if (generation !== this.generation) return;
      this.inflight = undefined;
      const words = answer.text.trim();
      if (words === '') {
        void this.keep(target, clip, durationMs, 'empty');
        this.fail('empty');
      } else {
        void this.options.pending.remove(target.scope, target.id);
        this.toIdle();
        this.options.onText(words);
      }
    } catch (cause) {
      if (generation !== this.generation) return;
      this.inflight = undefined;
      const message = (this.options.errorCopy ?? ((failure: unknown) => nanoAccountError(failure).message))(cause);
      void this.keep(target, clip, durationMs, 'failed', message);
      this.toIdle();
      this.error = message;
    }
  }

  /** Stops the microphone and the recorder's hold on the audio. */
  private release(): void {
    if (this.timer !== undefined) this.environment.clearInterval(this.timer);
    this.timer = undefined;
    if (this.stream) stopTracks(this.stream);
    this.stream = undefined;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onerror = null;
    }
    this.recorder = undefined;
    this.chunks = [];
    this.bytes = 0;
  }

  /** Back to idle: this window lets go of the clip it held, so the pending bar may offer it. */
  private toIdle(): void {
    this.phase = 'idle';
    if (this.heldId !== undefined) this.options.pending.release(this.heldId);
    this.heldId = undefined;
    this.recordingId = '';
    this.recordingScope = '';
  }

  private fail(kind: DictationErrorKind): void {
    this.toIdle();
    this.error = DICTATION_ERROR_COPY[kind];
  }
}

interface RecordingTarget {
  readonly scope: string;
  readonly id: string;
  readonly mimeType: string;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
