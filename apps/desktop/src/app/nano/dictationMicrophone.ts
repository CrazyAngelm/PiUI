const MICROPHONE_KEY = 'piui.dictation.microphone';

export interface DictationMicrophone {
  readonly id: string;
  readonly label: string;
}

export function dictationMicrophoneId(): string | undefined {
  try {
    return localStorage.getItem(MICROPHONE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function saveDictationMicrophoneId(id: string): boolean {
  try {
    if (id === '') localStorage.removeItem(MICROPHONE_KEY);
    else localStorage.setItem(MICROPHONE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

function unavailable(): Error {
  const error = new Error('The selected microphone is unavailable.');
  error.name = 'DictationMicrophoneUnavailable';
  return error;
}

export async function requestDictationMicrophone(
  media: Pick<MediaDevices, 'getUserMedia'> & Partial<Pick<MediaDevices, 'getSupportedConstraints'>> = navigator.mediaDevices,
  id: string | undefined = dictationMicrophoneId(),
): Promise<MediaStream> {
  if (id === undefined) return media.getUserMedia({ audio: true });
  if (media.getSupportedConstraints && media.getSupportedConstraints().deviceId !== true) throw unavailable();

  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({ audio: { deviceId: { exact: id } } });
  } catch (cause) {
    const name = typeof cause === 'object' && cause !== null && 'name' in cause ? cause.name : undefined;
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') throw unavailable();
    throw cause;
  }
  const tracks = stream.getAudioTracks();
  if (tracks.length === 0 || tracks.some((track) => {
    const actual = track.getSettings().deviceId;
    return actual !== undefined && actual !== id;
  })) {
    stream.getTracks().forEach((track) => track.stop());
    throw unavailable();
  }
  return stream;
}

/** Call from Settings after the user asks to list microphones. The active track exposes device IDs and labels. */
export async function loadDictationMicrophones(
  media: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'> = navigator.mediaDevices,
): Promise<DictationMicrophone[]> {
  const stream = await media.getUserMedia({ audio: true });
  try {
    const inputs = new Map<string, DictationMicrophone>();
    for (const device of await media.enumerateDevices()) {
      if (device.kind === 'audioinput' && device.deviceId !== '' && device.deviceId !== 'default' && !inputs.has(device.deviceId)) {
        inputs.set(device.deviceId, { id: device.deviceId, label: device.label.trim() });
      }
    }
    return [...inputs.values()];
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
