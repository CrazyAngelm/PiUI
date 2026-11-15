/**
 * Dictation sources v1 (ADR-061): what transcribes composer dictation besides
 * the Nano account. The host owns the settings file, every API key and the
 * upload. No key, and no address for a request, crosses this contract.
 *
 * - A key is typed in the host's native masked dialog (`set-key` opens it) and
 *   is kept in the OS credential store, bound to the exact transcription
 *   address. It is never part of a request, an answer or an event.
 * - A transcription request carries audio and a MIME type only. The address,
 *   model and key come from the host's own settings.
 * - Safe mode sends no audio to any provider and changes no setting; `get`
 *   still answers from the local file.
 * - The Nano source keeps using `nano_dictation_v1` (nano-account-v1).
 *
 * Commands: `dictation_settings_v1` ({ request: DictationSettingsRequestV1 } ->
 * DictationSettingsV1) and `dictation_transcribe_v1`
 * ({ request: DictationTranscribeRequestV1 } -> DictationAnswerV1).
 * Requests reject unknown fields; failures reject with
 * `{ code: DictationErrorCodeV1 }`.
 */
export const DICTATION_PROTOCOL = 1 as const;

export type DictationSourceV1 = 'off' | 'nano' | 'openai' | 'groq' | 'custom';
export type DictationProviderIdV1 = 'openai' | 'groq' | 'custom';

export interface DictationProviderV1 {
  id: DictationProviderIdV1;
  /** Fixed for a preset; the person's address for `custom` ('' until set). */
  baseUrl: string;
  model: string;
  keyRequired: boolean;
  /** A key for exactly this address is in the system credential store. */
  keySet: boolean;
  /** Address, model and (when required) key are all present. */
  ready: boolean;
}

export interface DictationSettingsV1 {
  protocol: 1;
  source: DictationSourceV1;
  /** Language hint sent to a provider, or null to let it detect. */
  language: string | null;
  /** Always openai, groq, custom, in this order. */
  providers: DictationProviderV1[];
  /** Largest clip a provider source accepts, in bytes. */
  maxBytes: number;
  /** The host can ask for an API key in its native dialog. */
  keyEntry: boolean;
  safeMode: boolean;
}

export interface DictationSettingsUpdateV1 {
  source: DictationSourceV1;
  language: string | null;
  openaiModel: string;
  groqModel: string;
  customBaseUrl: string;
  customModel: string;
}

export type DictationSettingsRequestV1 =
  | { type: 'get' }
  | { type: 'save'; settings: DictationSettingsUpdateV1 }
  | { type: 'set-key'; provider: DictationProviderIdV1; language: 'en' | 'ru' }
  | { type: 'clear-key'; provider: DictationProviderIdV1 };

export interface DictationTranscribeRequestV1 {
  audioBase64: string;
  mimeType: string;
}

export interface DictationAnswerV1 {
  text: string;
}

export type DictationErrorCodeV1 =
  | 'invalid'
  | 'safe-mode'
  | 'not-configured'
  | 'invalid-url'
  | 'invalid-model'
  | 'invalid-language'
  | 'credential-store'
  | 'storage'
  | 'unsupported'
  | 'prompt-failed'
  | 'settings-changed'
  | 'invalid-key'
  | 'rate-limited'
  | 'too-large'
  | 'rejected'
  | 'provider-unavailable'
  | 'offline'
  | 'bad-response';
