# ADR-066 — Unsent dictation recordings are kept locally until sent, saved or deleted

Status: accepted, 2026-11-16.

## Context

Dictation stopped a recording at two minutes and held the clip only in memory
(ADR-047, ADR-061). Any failure (the network, a provider refusal, an empty
answer, a closed composer, a recorder error) dropped it, so a long dictation
could be lost completely. The Nano web app already keeps such a clip for a
retry. What a person said must never be lost to a failed request.

## Decision

- **Longer recordings.** The limit is ten minutes, at 32 kbps, so a full clip is
  about 2.4 MB. The clock reads `m:ss / 10:00` and turns to the warning colour
  in the last 30 seconds. Reaching the limit stops and transcribes the clip as
  before, with a toast. The host's transcription timeout is 300 s.
- **A recording is never lost.** It is saved while it is made and before it is
  sent, so a failed request, a closed or reloaded app and a crash all leave it
  on this computer.
  - *Checkpoints.* Once a recording has run five seconds it is written to the
    pending store every five seconds as `unsent` (the one tick of the session
    carries it; there is no second timer).
  - *Write before upload.* When recording ends, the finished clip is written as
    `unsent` and only then uploaded. Success deletes it; an empty answer
    rewrites it as `empty`, a failure as `failed` with the error, a clip too
    large to send as `too-large`.
  - *One id.* The recording's scope and id are fixed when it starts. Every later
    write uses them, even if the composer's scope changes meanwhile, so one
    recording is one entry that is rewritten, never duplicated.
  - *What leaves nothing.* Esc within five seconds of recording, Esc while a
    clip shorter than five seconds uploads, success and a recording without
    audio. Every other end (a recorder error, a closed composer, a changed
    source, a longer Esc) keeps what is already stored.
  - *Not offered twice.* While this window records or sends a clip, the pending
    bar does not offer it for retry (the store holds its id until the session
    is idle again).
- **Cancel is a button as well as Esc** (2026-11-20). From the first press until
  the words are in the draft the composer bar shows only Cancel, Stop and Send
  (the attachment, agent, model and project controls are hidden meanwhile). Cancel
  ends the dictation exactly as Esc does, so the rules above apply: nothing is
  left after under five seconds, and a longer recording stays as an unsent
  recording that the bar above the composer can retry, save or delete.
- **One per composer scope** (`chat:<sessionId>`, `new:<workspaceId or
  "personal">`). While one waits, a new recording is refused with a toast.
- **Where it is kept.** In the WebView's IndexedDB (`piui-dictation-pending`,
  store `recordings`, keyed by scope) for at most 24 hours; expired entries are
  purged when the store is opened. Where IndexedDB is unavailable it stays in
  memory for the run, and the bar then adds "Kept only until the app closes"
  (the same when a write fails). Writes go through one queue in the store, so a
  delete is never overtaken by an earlier write. An expired clip is not
  returned by any read and is deleted from memory and storage. It is deleted
  when its text was inserted, when the person deletes it, and after 24 hours. A
  failed retry rewrites the clip only while it is still the one that was
  retried, so it cannot bring back a clip that was deleted or replaced.
- **What the person can do.** A bar above the composer toolbar offers Retry
  (transcribes with the source active now; on success the text goes in at the
  caret and the clip is deleted; on failure the clip stays), Save audio and
  Delete (asks to confirm).
- **Save audio** goes through the host: `dictation_save_recording_v1` takes
  audio and a MIME type, checks the same media-type allowlist as the dictation
  commands and a 32 MiB cap, opens the native save dialog with the name
  `nano-voice-YYYYMMDD-HHMM.<ext>` and writes the file. It sends nothing
  anywhere and works in safe mode. The UI Lab and a remote session have no host
  dialog and use a browser download. The audio is never logged.

## Consequences

- This changes "the clip is kept nowhere": an unsent clip is on this computer,
  in the WebView's own storage, for up to 24 hours. It leaves the device only
  through the dictation source the person chose (on Retry) or an explicit save.
  The WebView still makes no network request and the CSP is unchanged. The
  Settings text says so.
- Deleting browsing data of the WebView removes pending recordings.
- Pressing Esc (after five seconds of audio) or closing the composer while a
  clip uploads keeps the clip; the late answer is dropped, so a retry may
  transcribe the same audio twice. The same holds after a crash during the
  upload.
- Two windows recording in the same composer scope at once: the last write
  wins, and the other window's clip in that scope is overwritten. This is
  accepted; the scope is per chat or per new-chat target, which one person
  rarely dictates into from two windows.
- A checkpoint rewrites up to the clip's full size (about 2.4 MB at ten
  minutes) every five seconds into the WebView's own storage; nothing is sent
  anywhere.
- Evidence is synthetic (fakes and the UI Lab) until a real long recording is
  tried; report the two separately.
