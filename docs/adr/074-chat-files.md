# ADR-074 — Chat files: previews, cards and file actions for what the agent produces

Status: accepted, 2026-11-18. Amends ADR-038's note that the window's policy needs no `blob:` source (it now allows `blob:` for images and media only). Contract: `contracts/chat-files-v1.ts`; host: `workspace_chat_files.rs`.

## Context

An agent that writes a chart, generates a sound, reads a screenshot or returns
a file showed up in the chat only as a line of tool text. The person could not
see the image, hear the audio or get the file out of the project without
leaving the app. Nano Web shows such files inline. The Intelligent UI port
(ADR-077) also needs to turn a file name an answer mentions into a preview.

Constraints: the WebView has no filesystem access and must never name a path
(AGENTS.md); a link or a path must not be able to reach outside the project;
history stays native; a signed-out app and safe mode make no call.

## Decision

- **One host command, ids only.** `workspace_chat_files_v1` takes `list`,
  `preview`, `save`, `reveal`, `open` and `resolve`. The WebView holds a
  session id and an opaque file id; it never sends or receives a path.
- **A registry per session.** The host remembers the files that session's own
  native events or native history reported (at most 200, the oldest makes
  room) with the blocks that touched them. One file has one id however many
  blocks touched it. A file id of another chat, or one the host did not hand
  out, is `CHAT_FILE_UNAVAILABLE`.
- **Every call re-checks the file.** Not a link, a regular file, the same
  canonical path as when it was first seen; the bytes come from the one
  handle that was validated. UNC, device (`\\.\`) and alternate-stream paths
  are refused so a request cannot reach a network share.
- **The kind comes from the bytes.** Magic-byte sniffing sets image, audio,
  video, PDF, text or other; the name is only a label. A PNG named `.txt` is an
  image. SVG is a card, never an image (it can carry script or links).
- **Previews are bytes, shown as `blob:` URLs.** `preview` returns base64 for
  an image up to 20 MiB, audio or video up to 64 MiB. The WebView makes one
  `blob:` URL per file, two transfers at a time, and revokes every URL when the
  chat closes. The window's policy gains `img-src ... blob:` and
  `media-src 'self' blob:`; scripts, styles, connections and frames get no
  `blob:`. A card loads its preview when it scrolls into view.
- **Open is for documents, not programs.** The host opens a file with the
  system's default application only when it is not a program, script,
  shortcut or installer (by extension, by magic bytes, and by the exec bit on
  Unix): `CHAT_FILE_OPEN_REFUSED` otherwise. Save as and Open containing folder
  stay available for those. Open containing folder uses Explorer
  `/select,"<path>"` (one raw argument, so spaces, commas and `&` are safe),
  `open -R` on macOS and the file manager's folder on Linux.
- **Save as is a copy through the host's save dialog.** The path comes from
  the dialog, never from the WebView; the copy is written to a temporary file
  and renamed, so saving over the source cannot lose it. A cancelled dialog
  is `saved: false`, not an error.
- **Bytes an agent only returned inline** (a read image, a tool result) are
  stored by the host under its app data, at most 64 MiB each and 128 MiB and
  64 files per session, and are cleared at startup. Nothing is ever written
  into a project. Such a file can be previewed and saved but has no folder to
  show.
- **Placement.** The file cards of a turn's tool blocks are shown with the
  turn's final answer, because the work folds behind one control (ADR-073). A
  turn with no answer yet shows none. A file the agent only read appears when
  it is an image, sound, video or PDF, never for source text; a file that has
  since gone appears only if the agent wrote or generated it, as an
  unavailable card with no actions.
- **`resolve` by name.** `{type: 'resolve', sessionId, name}` returns a file
  or `null`. A name is matched first against the session's registry by its
  trailing path components (a bare name matches by basename, the latest file
  wins), then as a path relative to the chat's verified project folder
  (canonicalized, inside the folder, a regular file, no link out); a match
  there is registered with origin `returned`. Absolute paths, `..`, drive
  letters and UNC names are refused (`null`). The Intelligent UI renderer
  calls `resolve` and then `preview`.
- **Safe mode refuses all six commands.** No network call, no account. The
  remote-access allowlist (ADR-062) does not list the command: a remote viewer
  cannot see or save a file on the computer.

## Consequences

- New contract `chat-files-v1` (protocol 1) with a golden fixture used by the
  Rust and TypeScript tests; the Lab fake mirrors it and records its calls on
  `window.__piuiLabChatFiles` for the e2e specs.
- `AttachmentCard` gains a folder action (only for an attachment that says it
  is `revealable`, with the owner's port) and "Save as…" as the name of its
  save button (only for `saveAs`); other callers (Nano web, print) are
  unchanged. Focus returns to the pressed button after an action.
- The window's policy changed (`blob:` for images and media), which the
  `prod-csp` project checks with a real blob image and audio.
- A closed chat fills its registry from its native history when the chat is
  opened (`HistoryChatFile`, not in safe mode); the same file or the same
  inline bytes of one block keep one id across reopenings.
- **Not done:** the live producer. A running chat's files come from the
  runtime's file events (`record_report`, wired at the event forwarder in
  `workspace_api.rs`), which the bridges do not send yet; until they do, a live
  chat shows cards only after it is closed and reopened, or for a name the
  Intelligent UI resolves. There is no tool-row chip beside the card, and no
  Nano web (`owner`) reveal port.
- Synthetic evidence only (Rust unit tests, vitest, Lab e2e). Opening or
  revealing a real file in Explorer is not exercised by automation.
