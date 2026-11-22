import type {
  DictationAnswerV1,
  DictationErrorCodeV1,
  DictationProviderIdV1,
  DictationProviderV1,
  DictationSaveRecordingAnswerV1,
  DictationSaveRecordingRequestV1,
  DictationSettingsRequestV1,
  DictationSettingsV1,
  DictationSourceV1,
  DictationTranscribeRequestV1,
} from '../../../../contracts/dictation-v1';
import { hostInvoke, hostRemote, type HostInvoke } from './transport';

export type * from '../../../../contracts/dictation-v1';

/**
 * Client of dictation sources v1 (ADR-061). The Rust host owns the settings,
 * every API key and the upload; this client validates answers and maps typed
 * failures. No key ever reaches it and it never forwards host text. Copy for
 * the codes lives in `app/nano/dictationCopy.ts`, so this file stays small on
 * the first-paint path.
 */
export type DictationErrorCode = DictationErrorCodeV1 | 'unknown';

export const DICTATION_ERROR_CODES: readonly DictationErrorCodeV1[] = [
  'invalid',
  'safe-mode',
  'not-configured',
  'invalid-url',
  'invalid-model',
  'invalid-language',
  'credential-store',
  'storage',
  'unsupported',
  'prompt-failed',
  'settings-changed',
  'invalid-key',
  'rate-limited',
  'too-large',
  'rejected',
  'provider-unavailable',
  'offline',
  'bad-response',
];

export class DictationOperationError extends Error {
  constructor(readonly code: DictationErrorCode) {
    super(code);
    this.name = 'DictationOperationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps a rejected invoke to a typed error; host text is never forwarded. */
export function dictationError(cause: unknown): DictationOperationError {
  if (cause instanceof DictationOperationError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const code = isRecord(value) && typeof value.code === 'string' ? value.code : undefined;
  const known = code !== undefined && (DICTATION_ERROR_CODES as readonly string[]).includes(code);
  return new DictationOperationError(known ? (code as DictationErrorCodeV1) : 'unknown');
}

const SOURCES: readonly DictationSourceV1[] = ['off', 'nano', 'openai', 'groq', 'custom'];
const PROVIDER_IDS: readonly DictationProviderIdV1[] = ['openai', 'groq', 'custom'];

function decodeProvider(value: unknown, id: DictationProviderIdV1): DictationProviderV1 | undefined {
  if (!isRecord(value) || value.id !== id) return undefined;
  const { baseUrl, model, keyRequired, keySet, ready } = value;
  if (typeof baseUrl !== 'string' || typeof model !== 'string') return undefined;
  if (typeof keyRequired !== 'boolean' || typeof keySet !== 'boolean' || typeof ready !== 'boolean') return undefined;
  return { id, baseUrl, model, keyRequired, keySet, ready };
}

/** The host's settings view, or undefined when it is not one. */
export function decodeDictationSettings(value: unknown): DictationSettingsV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1) return undefined;
  const { source, language, providers, maxBytes, keyEntry, safeMode } = value;
  if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) return undefined;
  if (!(language === null || typeof language === 'string')) return undefined;
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) return undefined;
  if (typeof keyEntry !== 'boolean' || typeof safeMode !== 'boolean') return undefined;
  if (!Array.isArray(providers) || providers.length !== PROVIDER_IDS.length) return undefined;
  const decoded: DictationProviderV1[] = [];
  for (const [index, id] of PROVIDER_IDS.entries()) {
    const provider = decodeProvider(providers[index], id);
    if (!provider) return undefined;
    decoded.push(provider);
  }
  return { protocol: 1, source: source as DictationSourceV1, language, providers: decoded, maxBytes, keyEntry, safeMode };
}

/** `webm`, `ogg`, `m4a` or `wav` for the container of a recording; `webm` when unknown. */
export function recordingExtension(mimeType: string): 'webm' | 'ogg' | 'm4a' | 'wav' {
  const essence = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return essence === 'audio/ogg' ? 'ogg' : essence === 'audio/mp4' ? 'm4a' : essence === 'audio/wav' ? 'wav' : 'webm';
}

/** `nano-voice-YYYYMMDD-HHMM.<ext>`, in local time. */
export function recordingFileName(when: Date, mimeType: string): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}-${two(when.getHours())}${two(when.getMinutes())}`;
  return `nano-voice-${stamp}.${recordingExtension(mimeType)}`;
}

/** Saves a recording through the browser's download, where there is no host dialog (the UI Lab, a remote session). */
function downloadRecording(request: DictationSaveRecordingRequestV1): DictationSaveRecordingAnswerV1 {
  const binary = atob(request.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: request.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = recordingFileName(new Date(), request.mimeType);
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { saved: true };
}

export interface DictationClient {
  settings(request: DictationSettingsRequestV1): Promise<DictationSettingsV1>;
  transcribe(request: DictationTranscribeRequestV1): Promise<DictationAnswerV1>;
  /** Writes a recording to a file the person picks. */
  saveRecording(request: DictationSaveRecordingRequestV1): Promise<DictationSaveRecordingAnswerV1>;
}

export function createDictationClient(invoke: HostInvoke): DictationClient {
  async function call(command: string, request: unknown): Promise<unknown> {
    try {
      return await invoke<unknown>(command, { request });
    } catch (error) {
      throw dictationError(error);
    }
  }
  return {
    settings: async (request) => {
      const decoded = decodeDictationSettings(await call('dictation_settings_v1', request));
      if (!decoded) throw new DictationOperationError('unknown');
      return decoded;
    },
    transcribe: async (request) => {
      const answer = await call('dictation_transcribe_v1', request);
      // An empty text is a valid answer: the session reports that no speech was recognized.
      if (!isRecord(answer) || typeof answer.text !== 'string') throw new DictationOperationError('unknown');
      return { text: answer.text };
    },
    saveRecording: async (request) => {
      if (hostRemote) return downloadRecording(request);
      try {
        const answer = await call('dictation_save_recording_v1', request);
        if (!isRecord(answer) || typeof answer.saved !== 'boolean') throw new DictationOperationError('unknown');
        return { saved: answer.saved };
      } catch (error) {
        // The UI Lab has no native dialog; the download stands in for it.
        if (error instanceof DictationOperationError && error.code === 'unsupported') return downloadRecording(request);
        throw error;
      }
    },
  };
}

export const dictationHost: DictationClient = createDictationClient(hostInvoke);
