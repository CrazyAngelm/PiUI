import { describe, expect, it } from 'vitest';
import { pickDictationMime } from './dictation';
import { WAV_MIME, assembleClip, canRecordWav, toPcm16, wavHeader } from './wavRecorder';

describe('WAV dictation', () => {
  it('writes a 16 kHz mono 16-bit RIFF header for the sample bytes', () => {
    const view = new DataView(wavHeader(320).buffer);
    const text = (at: number) => String.fromCharCode(...new Uint8Array(view.buffer, at, 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(356);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(320);
  });

  it('puts the header in front of WAV chunks and leaves other containers as they are', async () => {
    const parts = [new Blob([new Uint8Array(100)]), new Blob([new Uint8Array(60)])];
    const wav = assembleClip(parts, WAV_MIME);
    expect(wav.type).toBe(WAV_MIME);
    expect(wav.size).toBe(44 + 160);
    expect(new DataView(await wav.slice(40, 44).arrayBuffer()).getUint32(0, true)).toBe(160);
    const webm = assembleClip(parts, 'audio/webm;codecs=opus');
    expect(webm.size).toBe(160);
    expect(webm.type).toBe('audio/webm;codecs=opus');
  });

  it('downsamples float samples to clamped 16-bit PCM', () => {
    const pcm = toPcm16(new Float32Array([1, 1, 1, -2, -2, -2, 0, 0, 0]), 48_000);
    expect(Array.from(pcm)).toEqual([0x7fff, -0x8000, 0]);
    expect(toPcm16(new Float32Array([0.5]), 16_000)[0]).toBe(Math.trunc(0.5 * 0x7fff));
  });

  it('does not make a WAV header without samples, but keeps captured silence', () => {
    expect(assembleClip([new Blob()], WAV_MIME).size).toBe(0);
    expect(assembleClip([new Blob([new Uint8Array(2)])], WAV_MIME).size).toBe(46);
  });

  it('is the last choice, taken only when MediaRecorder records none of the others', () => {
    expect(pickDictationMime((mime) => mime === WAV_MIME)).toBe(WAV_MIME);
    expect(pickDictationMime((mime) => mime === WAV_MIME || mime === 'audio/mp4')).toBe('audio/mp4');
    expect(canRecordWav({ AudioContext: class {} })).toBe(true);
    expect(canRecordWav({ webkitAudioContext: class {} })).toBe(true);
    expect(canRecordWav({})).toBe(false);
  });
});
