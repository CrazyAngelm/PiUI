/**
 * Dictation where the WebView's `MediaRecorder` records no format the host
 * accepts (the WebKitGTK bundled in the Linux AppImage): the microphone is read
 * through Web Audio and kept as 16 kHz mono 16-bit PCM. Chunks carry raw
 * samples; `assembleClip` puts the WAV header in front of them, so a
 * checkpoint and the finished clip are both a complete file.
 */
import type { RecorderLike } from './dictationSession.svelte';

export const WAV_MIME = 'audio/wav';
/** Speech needs no more; ten minutes stay near 19 MB. */
export const WAV_SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;
const FRAME = 4096;

/** The 44-byte RIFF header of 16-bit mono PCM with `dataBytes` of samples. */
export function wavHeader(dataBytes: number, sampleRate: number = WAV_SAMPLE_RATE): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  const text = (at: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(at + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/** The clip a recording's chunks make: WAV samples get their header, every other format is joined as it is. */
export function assembleClip(parts: readonly Blob[], mimeType: string): Blob {
  if (mimeType.split(';')[0]?.trim().toLowerCase() !== WAV_MIME) return new Blob(parts as Blob[], { type: mimeType });
  const dataBytes = parts.reduce((total, part) => total + part.size, 0);
  return new Blob([wavHeader(dataBytes) as BlobPart, ...parts], { type: WAV_MIME });
}

/** Float samples at `fromRate` as 16-bit PCM at `toRate` (averaging when it shrinks). */
export function toPcm16(samples: Float32Array, fromRate: number, toRate: number = WAV_SAMPLE_RATE): Int16Array {
  const ratio = fromRate / toRate;
  const length = ratio > 1 ? Math.floor(samples.length / ratio) : samples.length;
  const pcm = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    let value: number;
    if (ratio > 1) {
      const start = Math.floor(index * ratio);
      const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
      let sum = 0;
      for (let at = start; at < end; at += 1) sum += samples[at] ?? 0;
      value = end > start ? sum / (end - start) : 0;
    } else {
      value = samples[index] ?? 0;
    }
    const clamped = Math.max(-1, Math.min(1, value));
    pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm;
}

/** Whether this WebView can record through Web Audio. */
export function canRecordWav(scope: { readonly AudioContext?: unknown; readonly webkitAudioContext?: unknown } = globalThis as never): boolean {
  return typeof (scope.AudioContext ?? scope.webkitAudioContext) === 'function';
}

/** A `MediaRecorder`-shaped recorder that produces WAV samples. */
export class WavRecorder implements RecorderLike {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private context: AudioContext | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private processor: ScriptProcessorNode | undefined;
  private pending: Int16Array[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly stream: MediaStream) {}

  start(timesliceMs: number): void {
    const Context = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Context === undefined) throw new Error('Web Audio is unavailable');
    const context = new Context();
    this.context = context;
    this.source = context.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but, unlike an AudioWorklet, needs no module URL the CSP would have to allow.
    const processor = context.createScriptProcessor(FRAME, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (event) => {
      if (this.stopped) return;
      this.pending.push(toPcm16(event.inputBuffer.getChannelData(0), context.sampleRate));
    };
    this.source.connect(processor);
    // A processor runs only while connected to the output; it writes silence.
    processor.connect(context.destination);
    void context.resume().catch((cause: unknown) => this.onerror?.(cause));
    this.flushTimer = setInterval(() => this.flush(), Math.max(100, timesliceMs));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    this.flush();
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {
      // Already disconnected.
    }
    if (this.processor) this.processor.onaudioprocess = null;
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
    // `MediaRecorder` reports `stop` after its last chunk, asynchronously.
    queueMicrotask(() => this.onstop?.());
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const parts = this.pending;
    this.pending = [];
    this.ondataavailable?.({ data: new Blob(parts.map((part) => part.buffer as ArrayBuffer), { type: WAV_MIME }) });
  }
}
