# ADR-061 — Dictation sources: Nano, a preset provider or a custom endpoint

Status: accepted, 2026-11-15.

## Context

Composer dictation worked only with a Nano sign-in whose plan includes it. People
who use other harnesses without a Nano account, or who already pay a speech
provider or run a local Whisper server, had no dictation.

## Decision

**Settings → Dictation** chooses the source: Off, the Nano subscription (the
default, as before), OpenAI, Groq, or a custom OpenAI-compatible endpoint. The
dictation button is shown whenever the chosen source can transcribe now.

- **The host makes the request.** The WebView records as before and sends the
  clip to `dictation_transcribe_v1` with a MIME type and nothing else. The
  address, model and API key come from the host's own settings and credential
  store. The WebView makes no network call and the CSP is unchanged.
  `nano_dictation_v1` is unchanged and is used when the source is Nano.
  Native Linux uses Web Audio WAV because WebKitGTK can declare MP4 support
  and return an empty clip. Other supported platforms keep their existing
  format preference. An empty recording is reported as a recording failure.
- **Settings are host-owned** (`dictation-v1.json` in the app data folder,
  contract `contracts/dictation-v1.ts`): source, models, the custom base
  address, an optional language hint. The WebView reads a view of them with
  `keySet` and `ready` flags. They are not part of an exported system.
- **API keys never cross IPC.** A key is typed in the host's native masked
  dialog (the one external model providers use, ADR-051) and is stored in the
  OS credential store, service `dev.piui.desktop.dictation`, under a name that
  contains a hash of the provider and the exact transcription address. An
  edited settings file cannot send a stored key elsewhere, and changing the
  custom address drops its key. The dialog shows the address; the host stores
  the key only while the provider's address is still that one (otherwise
  `settings-changed`, nothing stored), under its settings lock. A key is read
  only while the settings record it for the exact address. A failed settings
  write puts the previous key back, and a credential that could not be deleted
  is listed in the file and deleted at the next change. There is no file,
  environment or memory fallback outside isolated test hosts. Key entry exists on Windows only; a
  custom endpoint that needs no key works on every platform.
- **Network rules.** `https`, or `http` to a loopback host only; no user
  information, query or fragment in the address; redirects are never followed;
  one multipart request per clip (`file`, `model`, `response_format=json`,
  optional `language`) to `<base>/audio/transcriptions`; 20 MiB; 120 s; a
  1 MiB answer. Refusals map to fixed codes (`invalid-key` for 401/403,
  `rate-limited` for 402/429, `too-large`, `rejected`, `provider-unavailable`,
  `offline`, `bad-response`); provider text is never shown or logged.
- **Safe mode sends no audio anywhere** and changes no dictation setting; the
  settings can still be read.
- **A signed-out application still makes no Nano call**: a provider source
  never touches the account, and the Nano source is unavailable until sign-in.

## Consequences

- A recording goes to the service the person chose and to no one else; with a
  provider source Nano never sees it.
- Model names are text the person can change; the defaults
  (`gpt-4o-transcribe`, `whisper-large-v3-turbo`) are starting values, not a
  promise about any account.
- Linux and macOS cannot enter a provider key yet.
- Pressing Esc while a clip is being transcribed drops the answer in the
  window; the host request ends on its own within the time limit.
- Evidence is synthetic (loopback fakes and the UI Lab) until a real provider
  key is tried; report the two separately.
