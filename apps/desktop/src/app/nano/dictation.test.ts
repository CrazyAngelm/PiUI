import { describe, expect, it, vi } from 'vitest';
import {
  DICTATION_CHECKPOINT_MS,
  DICTATION_DEFAULT_MAX_BYTES,
  DICTATION_ERROR_COPY,
  DICTATION_KEEP_ON_ESCAPE_MS,
  DICTATION_MAX_MS,
  DICTATION_NOTICE_COPY,
  DICTATION_WARNING_MS,
  bytesToBase64,
  canRecordAudio,
  dictationByteLimit,
  dictationClipError,
  dictationClock,
  dictationClockWithLimit,
  dictationFailure,
  dictationLimitReached,
  dictationNearLimit,
  insertAtCaret,
  pickDictationMime,
} from './dictation';
import { PendingRecordings, type PendingRecording, type PendingStorage } from './dictationPendingStore.svelte';
import { Dictation, browserDictationEnvironment, type DictationEnvironment, type RecorderLike } from './dictationSession.svelte';
import { retryRecording } from './dictationTransport';
import { DictationSource, whenKeyChanges } from './dictationSource.svelte';
import { WAV_MIME, WavRecorder } from './wavRecorder';

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

  it('stops at ten minutes or just below the size limit', () => {
    expect(DICTATION_MAX_MS).toBe(600_000);
    expect(dictationLimitReached(599_999, 0, undefined)).toBe(false);
    expect(dictationLimitReached(600_000, 0, undefined)).toBe(true);
    expect(dictationLimitReached(1_000, 10_000, 1_000_000)).toBe(false);
    // Room for the chunk in flight (an eighth of the limit, at most 256 KiB) stays below the limit.
    expect(dictationLimitReached(1_000, 1_000_000 - 70_000, 1_000_000)).toBe(true);
    expect(dictationLimitReached(1_000, 900, 1_000)).toBe(true);
    expect(dictationLimitReached(1_000, 100, 1_000)).toBe(false);
  });

  it('refuses an empty or oversized clip', () => {
    expect(dictationClipError(0, 100)).toBe('failed');
    expect(dictationClipError(101, 100)).toBe('too-large');
    expect(dictationClipError(100, 100)).toBeUndefined();
    expect(dictationClipError(5, undefined)).toBeUndefined();
  });

  it('maps microphone failures to the copy to show', () => {
    expect(dictationFailure({ name: 'NotAllowedError' })).toBe('denied');
    expect(dictationFailure({ name: 'SecurityError' })).toBe('denied');
    expect(dictationFailure({ name: 'NotFoundError' })).toBe('no-device');
    expect(dictationFailure({ name: 'DictationMicrophoneUnavailable' })).toBe('selected-device-unavailable');
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

  it('shows the clock against the limit and warns in the last thirty seconds', () => {
    expect(dictationClockWithLimit(0)).toBe('0:00 / 10:00');
    expect(dictationClockWithLimit(61_000)).toBe('1:01 / 10:00');
    expect(DICTATION_WARNING_MS).toBe(30_000);
    expect(dictationNearLimit(DICTATION_MAX_MS - DICTATION_WARNING_MS - 1)).toBe(false);
    expect(dictationNearLimit(DICTATION_MAX_MS - DICTATION_WARNING_MS)).toBe(true);
    expect(dictationNearLimit(DICTATION_MAX_MS)).toBe(true);
    expect(Object.values(DICTATION_NOTICE_COPY).every((copy) => copy.length > 10)).toBe(true);
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

const SCOPE = 'chat:session-1';
/** The fake clock of the recording environment; stores under test read the same time. */
const CLOCK_START = 1_000_000;

function rig(options: { available?: boolean; denied?: unknown; supported?: string[]; errorCopy?: (cause: unknown) => string; pending?: PendingRecordings; scope?: () => string } = {}) {
  const recorder = new FakeRecorder();
  const pending = options.pending ?? new PendingRecordings(undefined, () => CLOCK_START);
  const track = { stop: vi.fn() };
  let clock = CLOCK_START;
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
    { maxBytes: () => maxBytes, onText: (text) => texts.push(text), scope: options.scope ?? (() => SCOPE), pending, ...(options.errorCopy ? { errorCopy: options.errorCopy } : {}) },
    environment,
  );
  return {
    session,
    pending,
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
  it('uses WAV on native Linux without probing or constructing the advertised MP4 recorder', () => {
    const probe = vi.fn((mime: string) => mime === 'audio/mp4');
    const constructed = vi.fn();
    class AdvertisedRecorder {
      static isTypeSupported = probe;
      constructor() {
        constructed();
      }
    }
    vi.stubGlobal('MediaRecorder', AdvertisedRecorder);
    vi.stubGlobal('AudioContext', class {});
    const stream = {} as MediaStream;
    try {
      vi.stubGlobal('navigator', { platform: 'Linux x86_64', mediaDevices: { getUserMedia: vi.fn() } });
      const linux = browserDictationEnvironment(true);
      expect(linux.available).toBe(true);
      expect(pickDictationMime(linux.isTypeSupported)).toBe(WAV_MIME);
      expect(linux.createRecorder(stream, WAV_MIME)).toBeInstanceOf(WavRecorder);
      expect(probe).not.toHaveBeenCalled();
      expect(constructed).not.toHaveBeenCalled();
      expect(pickDictationMime(browserDictationEnvironment(false).isTypeSupported)).toBe('audio/mp4');

      for (const platform of ['Win32', 'MacIntel']) {
        vi.stubGlobal('navigator', { platform, mediaDevices: { getUserMedia: vi.fn() } });
        expect(pickDictationMime(browserDictationEnvironment(true).isTypeSupported)).toBe('audio/mp4');
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['audio/mp4', WAV_MIME])('reports missing %s recording bytes as capture failure, without uploading', async (mime) => {
    const test = rig({ supported: [mime] });
    test.recorder.last = new Blob();
    await test.session.start();
    test.session.stop();
    await settle();
    expect(test.session.error).toBe(DICTATION_ERROR_COPY.failed);
    expect(test.session.phase).toBe('idle');
    expect(test.sent).toEqual([]);
    expect(test.pending.get(SCOPE)).toBeUndefined();
  });

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

  it('stops by itself at ten minutes, says so and sends what it has', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.emit(5);
    test.advance(DICTATION_MAX_MS - 1_000);
    expect(test.recorder.stops).toBe(0);
    test.advance(1_000);
    await settle();
    expect(test.recorder.stops).toBe(1);
    expect(test.session.notice).toBe('limit-reached');
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

  it('reports a provider failure with the given copy', async () => {
    const copy = 'The speech service refused the API key. Check it in Settings.';
    const test = rig({ errorCopy: (cause) => (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'invalid-key' ? copy : 'other') });
    test.setAnswer(async () => {
      throw { code: 'invalid-key' };
    });
    await test.session.start();
    await test.session.toggle();
    await settle();
    expect(test.session.phase).toBe('idle');
    expect(test.session.error).toBe(copy);
    expect(test.texts).toEqual([]);
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

describe('a recording and the source it started with', () => {
  /** A Nano source over an account whose whole status can be replaced, as a token refresh does. */
  function nanoRig() {
    let status = { revision: 1, dictation: true };
    const account = {
      get canDictate(): boolean {
        return status.dictation;
      },
      dictationMaxBytes: 5_000_000,
    };
    const source = new DictationSource({ settings: () => Promise.reject(new Error('not read')) }, account);
    const test = rig();
    // What the dictation button wires: the guard runs whenever the effect re-runs.
    const guard = whenKeyChanges(source.key, () => test.session.cancel('teardown'));
    return {
      test,
      source,
      refresh(next: Partial<typeof status> = {}) {
        status = { ...status, revision: status.revision + 1, ...next };
        guard(source.key);
      },
    };
  }

  /** Records one clip and leaves it uploading until `release` is called. */
  async function upload(test: ReturnType<typeof rig>): Promise<(text: string) => void> {
    let release: (value: { text: string }) => void = () => undefined;
    test.setAnswer(() => new Promise((resolve) => (release = resolve)));
    await test.session.start();
    test.recorder.emit(4);
    await test.session.toggle();
    await settle();
    expect(test.session.phase).toBe('sending');
    return (text) => release({ text });
  }

  it('keeps a clip that is uploading when the account status is only refreshed', async () => {
    const { test, source, refresh } = nanoRig();
    expect(source.active).toBe('nano');
    const finish = await upload(test);
    refresh();
    refresh();
    expect(source.active).toBe('nano');
    expect(test.session.phase).toBe('sending');
    finish('kept words');
    await settle();
    expect(test.texts).toEqual(['kept words']);
    expect(test.session.error).toBeUndefined();
  });

  it('keeps the clip as unsent when the source stops being available', async () => {
    const { test, source, refresh } = nanoRig();
    const finish = await upload(test);
    refresh({ dictation: false });
    expect(source.active).toBeUndefined();
    expect(test.session.phase).toBe('idle');
    finish('too late');
    await settle();
    // The late words are dropped; the audio is not.
    expect(test.texts).toEqual([]);
    expect(test.pending.get(SCOPE)?.reason).toBe('unsent');
  });

  it('keeps a recording whose source changes while it runs', async () => {
    const { test, refresh } = nanoRig();
    await test.session.start();
    test.recorder.emit(6);
    refresh({ dictation: false });
    await settle();
    expect(test.session.phase).toBe('idle');
    expect(test.sent).toEqual([]);
    expect(test.pending.get(SCOPE)?.reason).toBe('unsent');
    expect(test.pending.get(SCOPE)?.blob.size).toBe(7);
  });
});

describe('a recording is never lost', () => {
  const kept = (test: ReturnType<typeof rig>) => test.pending.get(SCOPE);

  it('keeps the clip when transcription fails, with the error copy', async () => {
    const test = rig();
    test.setAnswer(async () => {
      throw { code: 'credits-exhausted' };
    });
    await test.session.start();
    test.recorder.emit(3);
    test.advance(2_500);
    await test.session.toggle();
    await settle();
    expect(test.session.error).toBe('You are out of Nano credits.');
    const pending = kept(test);
    expect(pending).toMatchObject({ scope: SCOPE, reason: 'failed', mimeType: 'audio/webm;codecs=opus', durationMs: 2_500, error: 'You are out of Nano credits.' });
    expect(pending?.blob.size).toBe(4);
  });

  it('keeps the clip when no speech was recognized', async () => {
    const test = rig();
    test.setAnswer(async () => ({ text: '  ' }));
    await test.session.start();
    await test.session.toggle();
    await settle();
    expect(kept(test)?.reason).toBe('empty');
    expect(test.texts).toEqual([]);
  });

  it('keeps a clip that is too large to send', async () => {
    const test = rig();
    test.setMaxBytes(10);
    test.recorder.last = new Blob([new Uint8Array(100)]);
    await test.session.start();
    await test.session.toggle();
    await settle();
    expect(test.sent).toEqual([]);
    expect(kept(test)?.reason).toBe('too-large');
  });

  it('leaves nothing behind after a success', async () => {
    const test = rig();
    await test.session.start();
    await test.session.toggle();
    await settle();
    expect(test.texts).toEqual(['hello there']);
    expect(kept(test)).toBeUndefined();
  });

  it('retries a kept clip with the source active now and reports the new error', async () => {
    const test = rig();
    test.setAnswer(async () => {
      throw { code: 'credits-exhausted' };
    });
    await test.session.start();
    test.recorder.emit(3);
    await test.session.toggle();
    await settle();
    const clip = kept(test);
    expect(clip).toBeDefined();
    const failing = await retryRecording(clip!, { dictate: async () => Promise.reject({ code: 'credits-exhausted' }) }, undefined);
    expect(failing).toEqual({ ok: false, reason: 'failed', error: 'You are out of Nano credits.' });
    expect(await retryRecording(clip!, { dictate: async () => ({ text: '  ' }) }, undefined)).toMatchObject({ ok: false, reason: 'empty' });
    expect(await retryRecording(clip!, { dictate: async () => ({ text: 'x' }) }, 1)).toMatchObject({ ok: false, reason: 'too-large' });
    const sent: string[] = [];
    const invalid = await retryRecording(
      { blob: new Blob(), mimeType: clip!.mimeType },
      {
        dictate: async () => {
          sent.push('invalid');
          return { text: 'x' };
        },
      },
      undefined,
    );
    expect(invalid).toMatchObject({ ok: false, reason: 'failed' });
    const retried = await retryRecording(
      clip!,
      {
        dictate: async (request) => {
          sent.push(request.mimeType);
          return { text: ' recovered ' };
        },
      },
      undefined,
    );
    expect(retried).toEqual({ ok: true, text: 'recovered' });
    expect(sent).toEqual(['audio/webm;codecs=opus']);
    // Success is the caller's cue to delete the clip.
    await test.pending.remove(SCOPE, clip!.id);
    expect(kept(test)).toBeUndefined();
  });

  it('drops a recording that Esc ends before five seconds', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.emit(100);
    test.advance(DICTATION_KEEP_ON_ESCAPE_MS - 1);
    test.session.cancel();
    await settle();
    expect(kept(test)).toBeUndefined();
    expect(test.sent).toEqual([]);
    expect(test.session.phase).toBe('idle');
  });

  it('keeps a recording that Esc ends after five seconds, unsent', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.emit(100);
    test.advance(DICTATION_KEEP_ON_ESCAPE_MS);
    test.session.cancel();
    await settle();
    expect(test.session.phase).toBe('idle');
    expect(test.sent).toEqual([]);
    expect(test.texts).toEqual([]);
    expect(kept(test)).toMatchObject({ reason: 'unsent', durationMs: DICTATION_KEEP_ON_ESCAPE_MS });
    expect(kept(test)?.blob.size).toBe(101);
    expect(test.track.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps a recording when the composer is destroyed, however short', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.emit(8);
    test.session.cancel('teardown');
    await settle();
    expect(test.sent).toEqual([]);
    expect(kept(test)?.reason).toBe('unsent');
    expect(test.session.phase).toBe('idle');
  });

  it('keeps what was said when the recorder fails mid-speech', async () => {
    const test = rig();
    await test.session.start();
    test.recorder.emit(7);
    test.advance(3_000);
    test.recorder.onerror?.(new Error('device lost'));
    await settle();
    expect(test.session.error).toBe(DICTATION_ERROR_COPY.failed);
    expect(kept(test)).toMatchObject({ reason: 'failed', durationMs: 3_000, error: DICTATION_ERROR_COPY.failed });
    expect(kept(test)?.blob.size).toBe(7);
    expect(test.sent).toEqual([]);
  });

  it('refuses a new recording while one is waiting in the scope', async () => {
    const test = rig();
    test.setAnswer(async () => {
      throw { code: 'credits-exhausted' };
    });
    await test.session.start();
    await test.session.toggle();
    await settle();
    test.requests.length = 0;
    await test.session.start();
    expect(test.session.phase).toBe('idle');
    expect(test.session.notice).toBe('previous-recording');
    expect(test.requests).toEqual([]);
    await test.pending.remove(SCOPE);
    await test.session.start();
    expect(test.session.phase).toBe('recording');
  });
});

// ---- written before sending, checkpoints, the scope fixed at start ---------

/** A storage over a map, to see what a fresh window would load. */
function rowsStorage() {
  const rows = new Map<string, PendingRecording>();
  const storage: PendingStorage = {
    load: async () => [...rows.values()],
    put: async (item) => void rows.set(item.scope, item),
    delete: async (scope) => void rows.delete(scope),
  };
  return { rows, storage };
}

describe('a recording survives a closed or dead app', () => {
  it('has the clip in the storage before the upload starts and nothing after a success', async () => {
    const { rows, storage } = rowsStorage();
    const test = rig({ pending: new PendingRecordings(storage, () => CLOCK_START) });
    const seen: (string | undefined)[] = [];
    test.setAnswer(async () => {
      seen.push(rows.get(SCOPE)?.reason);
      return { text: 'done' };
    });
    await test.session.start();
    test.recorder.emit(3);
    await test.session.toggle();
    await settle();
    expect(seen).toEqual(['unsent']);
    expect(test.texts).toEqual(['done']);
    expect(rows.size).toBe(0);
  });

  it('leaves an unsent clip that a fresh store loads when the app dies during the upload', async () => {
    const { rows, storage } = rowsStorage();
    const test = rig({ pending: new PendingRecordings(storage, () => CLOCK_START) });
    test.setAnswer(() => new Promise(() => undefined));
    await test.session.start();
    test.recorder.emit(3);
    test.advance(2_000);
    await test.session.toggle();
    await settle();
    expect(test.session.phase).toBe('sending');
    expect(rows.get(SCOPE)).toMatchObject({ reason: 'unsent', durationMs: 2_000 });
    const reopened = new PendingRecordings(storage, () => CLOCK_START);
    await reopened.load();
    expect(reopened.get(SCOPE)).toMatchObject({ reason: 'unsent', mimeType: 'audio/webm;codecs=opus' });
    expect(reopened.get(SCOPE)?.blob.size).toBe(4);
  });

  it('saves a checkpoint after five seconds of recording and not before, then every five seconds', async () => {
    const { rows, storage } = rowsStorage();
    const test = rig({ pending: new PendingRecordings(storage, () => CLOCK_START) });
    await test.session.start();
    test.recorder.emit(10);
    test.advance(DICTATION_CHECKPOINT_MS - 1);
    await settle();
    expect(rows.size).toBe(0);
    test.advance(1);
    await settle();
    expect(rows.get(SCOPE)).toMatchObject({ reason: 'unsent', durationMs: DICTATION_CHECKPOINT_MS });
    expect(rows.get(SCOPE)?.blob.size).toBe(10);
    test.recorder.emit(5);
    test.advance(DICTATION_CHECKPOINT_MS - 1);
    await settle();
    expect(rows.get(SCOPE)?.blob.size).toBe(10);
    test.advance(1);
    await settle();
    expect(rows.get(SCOPE)?.blob.size).toBe(15);
    expect(rows.get(SCOPE)?.durationMs).toBe(2 * DICTATION_CHECKPOINT_MS);
  });

  it('keeps the checkpoint as the clip when the app comes back, and does not offer it while recording', async () => {
    const { storage } = rowsStorage();
    const pending = new PendingRecordings(storage, () => CLOCK_START);
    const test = rig({ pending });
    await test.session.start();
    test.recorder.emit(10);
    test.advance(DICTATION_CHECKPOINT_MS);
    await settle();
    expect(pending.get(SCOPE)).toBeDefined();
    expect(pending.visible(SCOPE)).toBeUndefined();
    const reopened = new PendingRecordings(storage, () => CLOCK_START);
    await reopened.load();
    expect(reopened.visible(SCOPE)?.reason).toBe('unsent');
  });

  it('leaves nothing when Esc ends a recording, or an upload of a clip, shorter than five seconds', async () => {
    const { rows, storage } = rowsStorage();
    const pending = new PendingRecordings(storage, () => CLOCK_START);
    const test = rig({ pending });
    await test.session.start();
    test.recorder.emit(10);
    test.advance(1_000);
    test.session.cancel();
    await settle();
    expect(rows.size).toBe(0);
    expect(pending.get(SCOPE)).toBeUndefined();

    test.setAnswer(() => new Promise(() => undefined));
    await test.session.start();
    test.recorder.emit(10);
    test.advance(2_000);
    await test.session.toggle();
    await settle();
    expect(rows.get(SCOPE)?.reason).toBe('unsent');
    test.session.cancel();
    await settle();
    expect(rows.size).toBe(0);
    expect(pending.get(SCOPE)).toBeUndefined();
    expect(test.session.phase).toBe('idle');
  });

  it('keeps an upload that Esc ends after five seconds', async () => {
    const { rows, storage } = rowsStorage();
    const test = rig({ pending: new PendingRecordings(storage, () => CLOCK_START) });
    test.setAnswer(() => new Promise(() => undefined));
    await test.session.start();
    test.recorder.emit(10);
    test.advance(DICTATION_KEEP_ON_ESCAPE_MS);
    await test.session.toggle();
    await settle();
    test.session.cancel();
    await settle();
    expect(rows.get(SCOPE)?.reason).toBe('unsent');
  });

  it('keeps the clip under the scope the recording started in when the composer moves on', async () => {
    const { rows, storage } = rowsStorage();
    let scope = 'chat:a';
    const test = rig({ pending: new PendingRecordings(storage, () => CLOCK_START), scope: () => scope });
    test.setAnswer(async () => {
      throw { code: 'credits-exhausted' };
    });
    await test.session.start();
    test.recorder.emit(10);
    test.advance(DICTATION_CHECKPOINT_MS);
    scope = 'chat:b';
    await test.session.toggle();
    await settle();
    expect(rows.get('chat:a')).toMatchObject({ reason: 'failed' });
    expect(rows.has('chat:b')).toBe(false);
    expect(test.pending.get('chat:b')).toBeUndefined();
  });

  it('holds the clip while it records or sends and lets go when idle again', async () => {
    const test = rig();
    test.setAnswer(async () => {
      throw { code: 'credits-exhausted' };
    });
    await test.session.start();
    test.recorder.emit(10);
    test.advance(DICTATION_CHECKPOINT_MS);
    expect(test.pending.visible(SCOPE)).toBeUndefined();
    await test.session.toggle();
    await settle();
    expect(test.session.phase).toBe('idle');
    expect(test.pending.visible(SCOPE)?.reason).toBe('failed');
  });

  it('keeps what was recorded under the same id when the recorder fails', async () => {
    const { rows, storage } = rowsStorage();
    const test = rig({ pending: new PendingRecordings(storage, () => CLOCK_START) });
    await test.session.start();
    test.recorder.emit(10);
    test.advance(DICTATION_CHECKPOINT_MS);
    await settle();
    const checkpoint = rows.get(SCOPE);
    test.recorder.onerror?.(new Error('device lost'));
    await settle();
    expect(rows.get(SCOPE)).toMatchObject({ id: checkpoint?.id, reason: 'failed' });
  });
});
