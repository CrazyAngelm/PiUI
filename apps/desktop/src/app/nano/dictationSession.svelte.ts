import { nanoAccountError, type NanoAccountClient } from '../../host-api/nanoAccountClient';
import {
  DICTATION_ERROR_COPY,
  DICTATION_TIMESLICE_MS,
  bytesToBase64,
  canRecordAudio,
  dictationClipError,
  dictationFailure,
  dictationLimitReached,
  pickDictationMime,
  type DictationErrorKind,
} from './dictation';

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

export function browserDictationEnvironment(): DictationEnvironment {
  const recorder = typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder;
  return {
    available: canRecordAudio({ mediaDevices: typeof navigator === 'undefined' ? undefined : navigator.mediaDevices, recorder }),
    isTypeSupported: (mime) => recorder?.isTypeSupported(mime) ?? false,
    requestMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    // MediaRecorder's event types are wider than the slice the session reads.
    createRecorder: (stream, mimeType) => new MediaRecorder(stream, { mimeType }) as unknown as RecorderLike,
    now: () => Date.now(),
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]),
  };
}

export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'sending';

/**
 * One composer's dictation: record from the microphone, send the clip to Nano
 * through the host, hand the text back. The clip lives only in memory for the
 * length of the request and is dropped on success, failure and cancel. A
 * recording stops by itself at two minutes or at the size the plan allows.
 */
export class Dictation {
  phase = $state<DictationPhase>('idle');
  /** English source copy of the last failure; the view translates it. */
  error = $state<string | undefined>();
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
  /** Bumped by every start and cancel, so a late callback of an old recording is ignored. */
  private generation = 0;

  constructor(
    private readonly client: Pick<NanoAccountClient, 'dictate'>,
    private readonly options: { readonly maxBytes: () => number | undefined; readonly onText: (text: string) => void },
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
    const mimeType = this.environment.available ? pickDictationMime((mime) => this.environment.isTypeSupported(mime)) : undefined;
    if (mimeType === undefined) return this.fail('unsupported');
    const generation = ++this.generation;
    this.phase = 'requesting';
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
      recorder.ondataavailable = (event) => this.collect(generation, event.data);
      recorder.onstop = () => void this.finish(generation);
      recorder.onerror = () => this.abort(generation, 'failed');
      this.startedAt = this.environment.now();
      this.elapsedMs = 0;
      recorder.start(DICTATION_TIMESLICE_MS);
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

  /** Esc: drops the recording without sending anything. */
  cancel(): void {
    if (this.phase === 'idle') return;
    this.generation += 1;
    this.discard = true;
    const recorder = this.recorder;
    this.release();
    this.phase = 'idle';
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
    this.guard(generation);
  }

  private guard(generation: number): void {
    if (generation === this.generation && this.phase === 'recording' && dictationLimitReached(this.elapsedMs, this.bytes, this.options.maxBytes())) this.stop();
  }

  private abort(generation: number, kind: DictationErrorKind): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.discard = true;
    this.release();
    this.fail(kind);
  }

  private async finish(generation: number): Promise<void> {
    if (generation !== this.generation || this.discard) return;
    const parts = this.chunks;
    const mimeType = this.mimeType;
    this.release();
    const clip = new Blob(parts, { type: mimeType });
    const kind = dictationClipError(clip.size, this.options.maxBytes());
    if (kind !== undefined) return this.fail(kind);
    this.phase = 'sending';
    try {
      const audioBase64 = bytesToBase64(new Uint8Array(await clip.arrayBuffer()));
      // Esc during the read cancelled the clip: nothing may be uploaded.
      if (generation !== this.generation) return;
      const answer = await this.client.dictate({ audioBase64, mimeType });
      if (generation !== this.generation) return;
      const words = answer.text.trim();
      if (words === '') this.fail('empty');
      else {
        this.phase = 'idle';
        this.options.onText(words);
      }
    } catch (cause) {
      if (generation !== this.generation) return;
      this.phase = 'idle';
      this.error = nanoAccountError(cause).message;
    }
  }

  /** Stops the microphone and forgets the audio. */
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

  private fail(kind: DictationErrorKind): void {
    this.phase = 'idle';
    this.error = DICTATION_ERROR_COPY[kind];
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
