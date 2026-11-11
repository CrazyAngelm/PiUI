import { describe, expect, it, vi } from 'vitest';
import {
  DICTATION_DEFAULT_MAX_BYTES,
  DICTATION_ERROR_COPY,
  DICTATION_MAX_MS,
  bytesToBase64,
  canRecordAudio,
  dictationByteLimit,
  dictationClipError,
  dictationClock,
  dictationFailure,
  dictationLimitReached,
  insertAtCaret,
  pickDictationMime,
} from './dictation';
import { Dictation, type DictationEnvironment, type RecorderLike } from './dictationSession.svelte';

describe('dictation guards', () => {
  it('prefers webm with opus and skips formats the recorder lacks', () => {
    expect(pickDictationMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickDictationMime((mime) => mime === 'audio/webm')).toBe('audio/webm');
    expect(pickDictationMime((mime) => mime.startsWith('audio/ogg'))).toBe('audio/ogg;codecs=opus');
    expect(pickDictationMime(() => false)).toBeUndefined();
    expect(pickDictationMime(() => {
      throw new Error('probe failed');
    })).toBeUndefined();
  });

  it('takes the size limit from the plan, else the 20 MiB default', () => {
    expect(dictationByteLimit(5_000_000)).toBe(5_000_000);
    expect(dictationByteLimit(1234.9)).toBe(1234);
    for (const missing of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(dictationByteLimit(missing)).toBe(DICTATION_DEFAULT_MAX_BYTES);
    }
  });

  it('stops at two minutes or just below the size limit', () => {
    expect(DICTATION_MAX_MS).toBe(120_000);
    expect(dictationLimitReached(119_999, 0, undefined)).toBe(false);
    expect(dictationLimitReached(120_000, 0, undefined)).toBe(true);
    expect(dictationLimitReached(1_000, 10_000, 1_000_000)).toBe(false);
    // Room for the chunk in flight (an eighth of the limit, at most 256 KiB) stays below the limit.
    expect(dictationLimitReached(1_000, 1_000_000 - 70_000, 1_000_000)).toBe(true);
    expect(dictationLimitReached(1_000, 900, 1_000)).toBe(true);
    expect(dictationLimitReached(1_000, 100, 1_000)).toBe(false);
  });

  it('refuses an empty or oversized clip', () => {
    expect(dictationClipError(0, 100)).toBe('empty');
    expect(dictationClipError(101, 100)).toBe('too-large');
    expect(dictationClipError(100, 100)).toBeUndefined();
    expect(dictationClipError(5, undefined)).toBeUndefined();
  });

  it('maps microphone failures to the copy to show', () => {
    expect(dictationFailure({ name: 'NotAllowedError' })).toBe('denied');
    expect(dictationFailure({ name: 'SecurityError' })).toBe('denied');
    expect(dictationFailure({ name: 'NotFoundError' })).toBe('no-device');
    expect(dictationFailure(new Error('boom'))).toBe('failed');
    expect(dictationFailure(undefined)).toBe('failed');
    for (const copy of Object.values(DICTATION_ERROR_COPY)) expect(copy.length).toBeGreaterThan(10);
  });

  it('records only where the window has a microphone API and a recorder', () => {
    expect(canRecordAudio({ mediaDevices: { getUserMedia: () => undefined }, recorder: class {} })).toBe(true);
    expect(canRecordAudio({ mediaDevices: undefined, recorder: class {} })).toBe(false);
    expect(canRecordAudio({ mediaDevices: { getUserMedia: () => undefined }, recorder: undefined })).toBe(false);
    expect(canRecordAudio({ mediaDevices: {}, recorder: class {} })).toBe(false);
  });

  it('formats the running clock', () => {
    expect([0, 999, 7_400, 61_000, 120_000].map(dictationClock)).toEqual(['0:00', '0:00', '0:07', '1:01', '2:00']);
    expect(dictationClock(-5)).toBe('0:00');
  });

  it('encodes a long clip to base64 without overflowing the stack', () => {
    expect(bytesToBase64(new Uint8Array([0, 1, 2]))).toBe('AAEC');
    const long = new Uint8Array(200_000).map((_, index) => index % 251);
    expect(Buffer.from(bytesToBase64(long), 'base64').equals(Buffer.from(long))).toBe(true);
  });
});

describe('insertAtCaret', () => {
  it('inserts at the caret and keeps the words apart', () => {
    expect(insertAtCaret('', 0, 'hello')).toEqual({ text: 'hello', caret: 5 });
    expect(insertAtCaret('fix the', 7, 'tests')).toEqual({ text: 'fix the tests', caret: 13 });
    expect(insertAtCaret('fix the ', 8, 'tests')).toEqual({ text: 'fix the tests', caret: 13 });
    expect(insertAtCaret('fix tests', 3, 'the')).toEqual({ text: 'fix the tests', caret: 8 });
    expect(insertAtCaret('line one\n', 9, 'two')).toEqual({ text: 'line one\ntwo', caret: 12 });
  });

  it('trims the words and ignores empty ones', () => {
    expect(insertAtCaret('a', 1, '  b  \n')).toEqual({ text: 'a b', caret: 3 });
    expect(insertAtCaret('abc', 1, '   ')).toEqual({ text: 'abc', caret: 1 });
  });

  it('clamps a caret outside the text', () => {
    expect(insertAtCaret('abc', 99, 'd')).toEqual({ text: 'abc d', caret: 5 });
    expect(insertAtCaret('abc', -4, 'x')).toEqual({ text: 'x abc', caret: 2 });
    expect(insertAtCaret('abc', Number.NaN, 'd')).toEqual({ text: 'abc d', caret: 5 });
  });
});

// ---- the recording session, over fake browser seams ------------------------

class FakeRecorder implements RecorderLike {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  slice = 0;
  stops = 0;
  /** What the final `dataavailable` of `stop()` delivers. */
  last = new Blob([new Uint8Array([9])]);
  start(timesliceMs: number): void {
    this.slice = timesliceMs;
  }
  stop(): void {
    this.stops += 1;
    this.ondataavailable?.({ data: this.last });
    this.onstop?.();
  }
  emit(bytes: number): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
}

function rig(options: { available?: boolean; denied?: unknown; supported?: string[] } = {}) {
  const recorder = new FakeRecorder();
  const track = { stop: vi.fn() };
  let clock = 1_000_000;
  const intervals = new Map<number, () => void>();
  let nextHandle = 1;
  const requests: string[] = [];
  const environment: DictationEnvironment = {
    available: options.available ?? true,
    isTypeSupported: (mime) => (options.supported ?? ['audio/webm;codecs=opus']).includes(mime),
    requestMicrophone: async () => {
      requests.push('microphone');
      if (options.denied !== undefined) throw options.denied;
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
    createRecorder: (_stream, mimeType) => {
      requests.push(`recorder ${mimeType}`);
      return recorder;
    },
    now: () => clock,
    setInterval: (callback) => {
      intervals.set(nextHandle, callback);
      return nextHandle++;
    },
    clearInterval: (handle) => void intervals.delete(handle as number),
  };
  const sent: { audioBase64: string; mimeType: string }[] = [];
  const texts: string[] = [];
  let answer: (request: { audioBase64: string; mimeType: string }) => Promise<{ text: string }> = async (request) => {
    sent.push(request);
    return { text: ' hello there ' };
  };
  let maxBytes: number | undefined;
  const session = new Dictation(
    { dictate: (request) => answer(request) },
    { maxBytes: () => maxBytes, onText: (text) => texts.push(text) },
    environment,
  );
  return {
    session,
    recorder,
    track,
    sent,
    texts,
    requests,
    intervals,
    advance(ms: number) {
      clock += ms;
      for (const callback of [...intervals.values()]) callback();
    },
    setAnswer(next: typeof answer) {
      answer = next;
    },
    setMaxBytes(value: number | undefined) {
      maxBytes = value;
    },
  };
}

/** Lets promise chains and Blob reads finish (a Blob read takes a real turn). */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe('dictation session', () => {
  it('records, sends one clip and hands back the trimmed words', async () => {
    const test = rig();
    await test.session.toggle();
    expect(test.session.phase).toBe('recording');
    expect(test.requests).toEqual(['microphone', 'recorder audio/webm;codecs=opus']);
    expect(test.recorder.slice).toBe(1_000);
    test.recorder.emit(3);
    test.advance(2_500);
    expect(test.session.elapsedMs).toBe(2_500);
    await test.session.toggle();
    await settle();
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]!.mimeType).toBe('audio/webm;codecs=opus');
    expect(Buffer.from(test.sent[0]!.audioBase64, 'base64')).toEqual(Buffer.from([0, 0, 0, 9]));
    expect(test.texts).toEqual(['hello there']);
    expect(test.session.phase).toBe('idle');
    expect(test.session.error).toBeUndefined();
    // No audio is kept: the microphone is released and the recorder forgets its handlers.
    expect(test.track.stop).toHaveBeenCalledTimes(1);
    expect(test.recorder.ondataavailable).toBeNull();
    expect(test.intervals.size).toBe(0);
  });

  it('says so and records nothing when the window cannot record', async () => {
    const none = rig({ available: false });
    await none.session.start();
    expect([none.session.phase, none.session.error, none.requests]).toEqual(['idle', DICTATION_ERROR_COPY.unsupported, []]);
    const noFormat = rig({ supported: [] });
    await noFormat.session.start();
    expect(noFormat.session.error).toBe(DICTATION_ERROR_COPY.unsupported);
    expect(noFormat.requests).toEqual([]);
  });

  it('explains a refused or missing microphone', async () => {
    const denied = rig({ denied: { name: 'NotAllowedError' } });
    await denied.session.start();
    expect([denied.session.phase, denied.session.error]).toEqual(['idle', DICTATION_ERROR_COPY.denied]);
    const missing = rig({ denied: { name: 'NotFoundError' } });
    await missing.session.start();
    expect(missing.session.error).toBe(DICTATION_ERROR_COPY['no-device']);
  });

  it('cancels without sending and releases the microphone', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.emit(100);
    test.session.cancel();
    await settle();
    expect(test.session.phase).toBe('idle');
    expect(test.session.error).toBeUndefined();
    expect(test.sent).toEqual([]);
    expect(test.texts).toEqual([]);
    expect(test.track.stop).toHaveBeenCalledTimes(1);
    expect(test.intervals.size).toBe(0);
  });

  it('drops a late answer after cancel', async () => {
    const test = rig();
    let release: (value: { text: string }) => void = () => undefined;
    test.setAnswer(() => new Promise((resolve) => (release = resolve)));
    await test.session.start();
    test.recorder.emit(4);
    await test.session.toggle();
    await settle();
    expect(test.session.phase).toBe('sending');
    test.session.cancel();
    release({ text: 'too late' });
    await settle();
    expect(test.texts).toEqual([]);
    expect(test.session.phase).toBe('idle');
  });

  it('uploads nothing when the clip is cancelled while it is still being read', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.emit(4);
    // `stop()` ends the recording and `finish()` waits for the Blob read; no turn passes before the cancel.
    test.session.stop();
    expect(test.session.phase).toBe('sending');
    test.session.cancel();
    await settle();
    expect(test.sent).toEqual([]);
    expect(test.texts).toEqual([]);
    expect(test.session.phase).toBe('idle');
    expect(test.session.error).toBeUndefined();
  });

  it('stops by itself at two minutes and sends what it has', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.emit(5);
    test.advance(DICTATION_MAX_MS - 1_000);
    expect(test.recorder.stops).toBe(0);
    test.advance(1_000);
    await settle();
    expect(test.recorder.stops).toBe(1);
    expect(test.texts).toEqual(['hello there']);
    // Later ticks of the dead recording do nothing.
    test.advance(10_000);
    expect(test.recorder.stops).toBe(1);
  });

  it('stops by itself when the plan size limit is reached', async () => {
    const test = rig();
    test.setMaxBytes(1_000);
    await test.session.start();
    test.recorder.emit(500);
    expect(test.recorder.stops).toBe(0);
    test.recorder.emit(450);
    await settle();
    expect(test.recorder.stops).toBe(1);
    expect(test.sent).toHaveLength(1);
  });

  it('refuses a clip over the limit without sending it', async () => {
    const test = rig();
    test.setMaxBytes(10);
    test.recorder.last = new Blob([new Uint8Array(100)]);
    await test.session.start();
    await test.session.toggle();
    await settle();
    expect(test.sent).toEqual([]);
    expect(test.session.error).toBe(DICTATION_ERROR_COPY['too-large']);
    expect(test.track.stop).toHaveBeenCalledTimes(1);
  });

  it('reports no recognized speech as an error, not as empty text', async () => {
    const test = rig();
    test.setAnswer(async () => ({ text: '   ' }));
    await test.session.start();
    await test.session.toggle();
    await settle();
    expect(test.texts).toEqual([]);
    expect(test.session.error).toBe(DICTATION_ERROR_COPY.empty);
  });

  it('reports an account failure as fixed copy', async () => {
    const test = rig();
    test.setAnswer(async () => {
      throw { code: 'credits-exhausted', message: 'raw server text' };
    });
    await test.session.start();
    await test.session.toggle();
    await settle();
    expect(test.session.phase).toBe('idle');
    expect(test.session.error).toBe('You are out of Nano credits.');
    test.session.clearError();
    expect(test.session.error).toBeUndefined();
  });

  it('ignores a second start while busy and can record again afterwards', async () => {
    const test = rig();
    await test.session.start();
    await test.session.start();
    expect(test.requests.filter((request) => request === 'microphone')).toHaveLength(1);
    await test.session.toggle();
    await settle();
    expect(test.texts).toHaveLength(1);
    await test.session.start();
    expect(test.session.phase).toBe('recording');
  });

  it('abandons a recording whose recorder fails', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.onerror?.(new Error('device lost'));
    await settle();
    expect(test.session.phase).toBe('idle');
    expect(test.session.error).toBe(DICTATION_ERROR_COPY.failed);
    expect(test.sent).toEqual([]);
    expect(test.track.stop).toHaveBeenCalledTimes(1);
  });
});
