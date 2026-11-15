import type {
  DictationErrorCodeV1,
  DictationProviderIdV1,
  DictationSettingsUpdateV1,
  DictationSettingsV1,
  DictationSourceV1,
} from '../../../../../contracts/dictation-v1';
import type { LabClock } from './labClock';
import type { LabHandlers } from './labHandlers';
import type { LabDictation, LabState } from './labState';

/** Dictation sources in the UI Lab. Key entry is simulated: the native dialog exists only in the host. */
export const LAB_DICTATION_TEXT = 'This is synthetic dictated text.';

const TRANSCRIBE_MS = 400;
/** A clip whose bytes start with this text is refused once, so a retry can be tested. */
export const LAB_DICTATION_FAIL_ONCE = 'FAIL-ONCE';
const OPENAI_URL = 'https://api.openai.com/v1';
const GROQ_URL = 'https://api.groq.com/openai/v1';
const OPENAI_MODEL = 'gpt-4o-transcribe';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const MAX_MODEL_CHARS = 128;
const MAX_BYTES = 20 * 1024 * 1024;
const SOURCES: readonly DictationSourceV1[] = ['off', 'nano', 'openai', 'groq', 'custom'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const refusal = (code: DictationErrorCodeV1): { readonly code: DictationErrorCodeV1 } => ({ code });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function cleanModel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') throw refusal('invalid');
  const model = raw.trim();
  if (model === '') return fallback;
  if ([...model].length > MAX_MODEL_CHARS || /\p{Cc}/u.test(model)) throw refusal('invalid-model');
  return model;
}

function cleanLanguage(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw refusal('invalid');
  const code = raw.trim().toLowerCase();
  if (code === '') return null;
  if (!/^[a-z]{2,3}$/u.test(code)) throw refusal('invalid-language');
  return code;
}

/** The custom address as the host keeps it: empty, or the trimmed text of an https (or loopback http) address. */
function cleanBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw refusal('invalid');
  const text = raw.trim();
  if (text === '') return '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw refusal('invalid-url');
  }
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname));
  if (!schemeOk || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || /\p{Cc}/u.test(text)) throw refusal('invalid-url');
  return text;
}

/** Two spellings of one address (a trailing slash) are the same endpoint, as in the host. */
const endpointOf = (baseUrl: string): string => (baseUrl === '' ? '' : new URL(baseUrl).href.replace(/\/+$/u, ''));

function parseUpdate(value: unknown): DictationSettingsUpdateV1 {
  if (!isRecord(value)) throw refusal('invalid');
  const { source, language, openaiModel, groqModel, customBaseUrl, customModel } = value;
  if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) throw refusal('invalid');
  // The host validates in this order: language, models, address.
  const cleanedLanguage = cleanLanguage(language);
  return {
    source: source as DictationSourceV1,
    language: cleanedLanguage,
    openaiModel: cleanModel(openaiModel, OPENAI_MODEL),
    groqModel: cleanModel(groqModel, GROQ_MODEL),
    customModel: cleanModel(customModel, ''),
    customBaseUrl: cleanBaseUrl(customBaseUrl),
  };
}

function isProvider(value: unknown): value is DictationProviderIdV1 {
  return value === 'openai' || value === 'groq' || value === 'custom';
}

function initial(): LabDictation {
  return { source: 'nano', language: null, openaiModel: OPENAI_MODEL, groqModel: GROQ_MODEL, customBaseUrl: '', customModel: '', keys: [] };
}

export function dictationHandlers(state: LabState, clock: LabClock): LabHandlers {
  const failedOnce = new Set<string>();
  const current = (): LabDictation => (state.dictation ??= initial());

  const providers = (settings: LabDictation): DictationSettingsV1['providers'] =>
    ([
      ['openai', OPENAI_URL, settings.openaiModel],
      ['groq', GROQ_URL, settings.groqModel],
      ['custom', settings.customBaseUrl, settings.customModel],
    ] as const).map(([id, baseUrl, model]) => {
      const keyRequired = id !== 'custom';
      const keySet = settings.keys.includes(id);
      return { id, baseUrl, model, keyRequired, keySet, ready: baseUrl !== '' && model !== '' && (keySet || !keyRequired) };
    });

  const view = (): DictationSettingsV1 => {
    const settings = current();
    return {
      protocol: 1,
      source: settings.source,
      language: settings.language,
      providers: providers(settings),
      maxBytes: MAX_BYTES,
      keyEntry: !state.safeMode,
      safeMode: state.safeMode,
    };
  };

  return {
    dictation_settings_v1: (args) => {
      const request = args.request;
      if (!isRecord(request) || typeof request.type !== 'string') throw refusal('invalid');
      if (request.type === 'get') return view();
      if (state.safeMode) throw refusal('safe-mode');
      const settings = current();
      switch (request.type) {
        case 'save': {
          const update = parseUpdate(request.settings);
          const before = endpointOf(settings.customBaseUrl);
          Object.assign(settings, update);
          // A key belongs to the address it was entered for.
          if (before !== endpointOf(settings.customBaseUrl)) settings.keys = settings.keys.filter((id) => id !== 'custom');
          return view();
        }
        case 'set-key': {
          if (!isProvider(request.provider) || (request.language !== 'en' && request.language !== 'ru')) throw refusal('invalid');
          const provider = request.provider;
          if (provider === 'custom' && settings.customBaseUrl === '') throw refusal('invalid-url');
          if (provider === 'custom' && settings.customModel === '') throw refusal('invalid-model');
          if (!settings.keys.includes(provider)) settings.keys = [...settings.keys, provider];
          return view();
        }
        case 'clear-key': {
          if (!isProvider(request.provider)) throw refusal('invalid');
          const provider = request.provider;
          settings.keys = settings.keys.filter((id) => id !== provider);
          return view();
        }
        default:
          throw refusal('invalid');
      }
    },
    dictation_transcribe_v1: async (args) => {
      if (state.safeMode) throw refusal('safe-mode');
      const request = args.request;
      if (!isRecord(request) || typeof request.audioBase64 !== 'string' || typeof request.mimeType !== 'string') throw refusal('invalid');
      if (!/^audio\/(webm|ogg|mp4)\s*(;|$)/iu.test(request.mimeType)) throw refusal('invalid');
      const settings = view();
      const ready = settings.providers.some((provider) => provider.id === settings.source && provider.ready);
      if (!ready) throw refusal('not-configured');
      await clock.delay(TRANSCRIBE_MS);
      if (atob(request.audioBase64).startsWith(LAB_DICTATION_FAIL_ONCE) && !failedOnce.has(request.audioBase64)) {
        failedOnce.add(request.audioBase64);
        throw refusal('provider-unavailable');
      }
      return { text: LAB_DICTATION_TEXT };
    },
    // The host opens a native save dialog; the Lab has none, so the client downloads the file itself.
    dictation_save_recording_v1: () => {
      throw refusal('unsupported');
    },
  };
}
