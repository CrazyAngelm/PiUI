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
- **Every call re-checks the file, on the opened handle.** The host opens the
  file first (no link, a regular file), then asks the operating system for the
  final path of that very handle (`GetFinalPathNameByHandleW` on Windows; on
  Unix the canonical path and the device/inode pair), compares it with the
  path first seen and with the scope below, and reads, saves, opens and
  reveals through that verified handle and path. A link swapped in between the
  check and the read cannot redirect any of them. UNC, device (`\\.\`) and
  alternate-stream paths are refused so a request cannot reach a network share.
- **Scope: what a chat may serve.** A registered path is served only while its
  final path is inside (a) the chat's verified working directory (its own
  worktree when it has one, else the project folder), (b) the host's inline
  store, (c) a harness's known output folder that the host resolves itself
  (Codex: `<CODEX_HOME or ~/.codex>/generated_images`; the folder of other
  harnesses is not known, so there is none), or (d) it is a file the chat's own
  agent wrote or generated, wherever that is. A file the agent only read
  outside (a) to (c) is never kept and never served: a read of `~/.ssh` or of
  another project gives the chat no preview, card or action. The check runs when
  the file is registered and again on every list, preview, save, open, reveal
  and resolve, so a file that moved out (a link, a replaced folder) stops
  being served. The scope is rebuilt per call from the session's current
  folder; the WebView never supplies it.
- **The kind comes from the bytes.** Magic-byte sniffing sets image, audio,
  video, PDF, text or other; the name is only a label. A PNG named `.txt` is an
  image. SVG is a card, never an image (it can carry script or links).
- **Previews are bytes, shown as `blob:` URLs.** `preview` returns base64 for
  an image up to 20 MiB, audio or video up to 64 MiB. The WebView makes one
  `blob:` URL per file, three transfers at a time, and revokes every URL when the
  chat closes. One memory budget per chat (192 MiB) is shared by the gallery,
  the widgets and the cards: a file's listed size is reserved before its bytes
  are requested, a chat over its budget refuses the next preview instead of
  growing, and a preview that scrolls far out of view or is collapsed gives its
  bytes back and is fetched again when it is shown once more. The window's policy gains `img-src ... blob:` and
  `media-src 'self' blob:`; scripts, styles, connections and frames get no
  `blob:`. A card loads its preview when it scrolls into view.
- **Open is an allowlist of documents and media.** The host opens a file with
  the system's default application only when its extension is one of png, jpg,
  jpeg, gif, webp, wav, mp3, ogg, flac, m4a, mp4, m4v, mov, webm, pdf (the
  sniffed bytes must be that same type) or txt, log, md, markdown, csv, json
  (the bytes must be text), it is not a program by magic bytes and it has no
  exec bit on Unix. Everything else, including `.msix`, `.appx`,
  `.appinstaller`, scripts, shortcuts, archives, Office documents (macros,
  linked content, DDE), SVG, HTML and XML, is `CHAT_FILE_OPEN_REFUSED`: a file
  an agent wrote carries no mark-of-the-web, so the default application would
  run it trusted. Save as and Open containing folder stay available for those.
  The `openable` flag in the listing says the same thing, so the card shows
  Open only where it will work. Open containing folder uses Explorer
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
  unavailable card with no actions. Ordinary writes are collapsed into one
  disclosure with the count of unique changed files for this answer. Files
  generated or explicitly returned to the reader stay visible as individual
  cards, including when another tool in the turn also wrote them.
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
- **Live refresh.** When the registry changes (a runtime file event, inline
  bytes that finish writing on the blocking pool, a history load) the host
  emits `piui://chat-files-v1` with `{protocol: 1, type: "changed", sessionId}`,
  at most once per 250 ms per chat. It carries no file and no path, is
  presentation-only and is not part of the revisioned workspace event stream.
  The chat re-lists (after 400 ms of quiet), so a file that finishes writing
  after its block shows up without another message. The event is local (no
  network, no account). The Lab fake publishes it after a turn that reports files.
- **A turn is split by the transcript's rules.** A turn that was interrupted
  and followed by a new user message is its own turn, so its files keep their
  answer; placement is memoized and does not run again on every streamed token.
- **Not done:** the bridges send file events only for what they report today;
  a harness that reports none shows cards after the chat is reopened, or for a
  name the Intelligent UI resolves. The thread-to-session mapping of the Codex
  output folder is not verified, so (c) admits the whole `generated_images`
  folder of that harness. There is no tool-row chip beside the card, and no
  Nano web (`owner`) reveal port.
- Synthetic evidence only (Rust unit tests, vitest, Lab e2e). Opening or
  revealing a real file in Explorer is not exercised by automation.
