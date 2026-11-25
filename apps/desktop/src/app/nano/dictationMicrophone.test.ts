import { afterEach, describe, expect, it, vi } from 'vitest';
import { dictationMicrophoneId, loadDictationMicrophones, requestDictationMicrophone, saveDictationMicrophoneId } from './dictationMicrophone';

function microphoneStream(deviceId: string | undefined) {
  const stop = vi.fn();
  const track = { stop, getSettings: () => ({ deviceId }) };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  return { stream, stop };
}

afterEach(() => vi.unstubAllGlobals());

describe('dictation microphone', () => {
  it('uses the normal default until a device is saved, then requests that exact device', async () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
    const { stream } = microphoneStream('g733');
    const media = { getUserMedia: vi.fn().mockResolvedValue(stream) };

    await expect(requestDictationMicrophone(media)).resolves.toBe(stream);
    expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: true });
    expect(saveDictationMicrophoneId('g733')).toBe(true);
    expect(dictationMicrophoneId()).toBe('g733');
    await expect(requestDictationMicrophone(media)).resolves.toBe(stream);
    expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'g733' } } });
    expect(saveDictationMicrophoneId('')).toBe(true);
    expect(dictationMicrophoneId()).toBeUndefined();
    await expect(requestDictationMicrophone(media)).resolves.toBe(stream);
    expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: true });
  });

  it('fails explicitly when a selected microphone disconnects without requesting another one', async () => {
    const media = { getUserMedia: vi.fn().mockRejectedValue({ name: 'OverconstrainedError' }) };
    await expect(requestDictationMicrophone(media, 'removed-device')).rejects.toMatchObject({ name: 'DictationMicrophoneUnavailable' });
    expect(media.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: { deviceId: { exact: 'removed-device' } } });
  });

  it('stops and rejects a stream that reports a different input than requested', async () => {
    const { stream, stop } = microphoneStream('analog');
    const media = { getUserMedia: vi.fn().mockResolvedValue(stream) };
    await expect(requestDictationMicrophone(media, 'g733')).rejects.toMatchObject({ name: 'DictationMicrophoneUnavailable' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('enumerates microphones while the permission-granting stream is open and then releases it', async () => {
    const { stream, stop } = microphoneStream('analog');
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const enumerateDevices = vi.fn().mockImplementation(async () => {
      expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
      expect(stop).not.toHaveBeenCalled();
      return [
        { kind: 'audioinput', deviceId: 'default', label: 'Default: Analog' },
        { kind: 'audioinput', deviceId: 'analog', label: ' Analog ' },
        { kind: 'audioinput', deviceId: 'g733', label: '   ' },
        { kind: 'audioinput', deviceId: 'g733', label: 'Duplicate' },
        { kind: 'audioinput', deviceId: '', label: '' },
        { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker' },
      ];
    });
    await expect(loadDictationMicrophones({ getUserMedia, enumerateDevices })).resolves.toEqual([
      { id: 'analog', label: 'Analog' },
      { id: 'g733', label: '' },
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('stops the discovery stream even when enumeration fails', async () => {
    const { stream, stop } = microphoneStream('analog');
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const enumerateDevices = vi.fn().mockRejectedValue(new Error('enumeration unavailable'));
    await expect(loadDictationMicrophones({ getUserMedia, enumerateDevices })).rejects.toThrow('enumeration unavailable');
    expect(stop).toHaveBeenCalledOnce();
  });
});
