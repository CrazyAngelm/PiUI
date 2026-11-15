import type { DictationErrorCode, DictationProviderIdV1 } from '../../host-api/dictationClient';

/** English source strings of the locale catalog. */
export const DICTATION_SOURCE_ERROR_COPY: Readonly<Record<DictationErrorCode, string>> = {
  invalid: 'The dictation request was not valid.',
  'safe-mode': 'Dictation is off in safe mode.',
  'not-configured': 'Finish the dictation setup in Settings.',
  'invalid-url': 'Enter an HTTPS address. HTTP works only for this computer (localhost).',
  'invalid-model': 'Enter a model name.',
  'invalid-language': 'Use a language code such as en or ru.',
  'credential-store': 'The operating system could not store or remove this API key.',
  storage: 'Could not read or save dictation settings.',
  unsupported: 'API keys can be entered only on Windows in this version.',
  'prompt-failed': 'Could not open the native API key dialog.',
  'settings-changed': 'The address changed while the key dialog was open, so the key was not saved. Enter it again.',
  'invalid-key': 'The speech service refused the API key. Check it in Settings.',
  'rate-limited': 'The speech service is receiving too many requests or the quota ran out. Try again later.',
  'too-large': 'The recording was too large to send.',
  rejected: 'The speech service refused the request. Check the address and the model in Settings.',
  'provider-unavailable': 'The speech service is not working right now. Try again later.',
  offline: 'Could not reach the speech service. Check your connection and the address.',
  'bad-response': 'The speech service sent an answer Nano Desktop could not read.',
  unknown: 'Dictation could not be completed.',
};

/** Starting points for the model field; any model name may be typed. */
export const DICTATION_MODEL_SUGGESTIONS: Readonly<Record<DictationProviderIdV1, readonly string[]>> = {
  openai: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'],
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  custom: [],
};
