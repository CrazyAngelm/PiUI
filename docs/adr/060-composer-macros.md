# ADR-060 — Composer macros

Status: accepted, 2026-11-15.

## Context

People repeat the same instructions and the same sets of skills in many
messages. Each harness has its own way to call a skill (`$name` in Codex, a
`/name` command elsewhere), and none of them keeps a reusable prompt that
works across harnesses.

## Decision

A macro is a named, saved piece of a message: a prompt, a list of skills, or
both. It is managed in **Settings → Macros** and used by typing `//name` in
the new-chat composer or in an open chat. One message may hold several.

- **Text expansion only.** When a message is sent, the composer replaces every
  known `//name` with the macro's text: its skills in the syntax of the agent
  that reads the message (the open chat's listed mention or native command,
  else `$name` for Codex, `/skill:name` for Pi and `/name` for other
  harnesses), then its prompt, on one line. An agent runs a native `/command`
  only at the start of a message, so skills written that way move there, each
  once and in the order of the macros, while every prompt stays where its
  macro stood. A message that already starts with a command keeps everything
  in place. The harness receives ordinary text and records it in its native
  history. Nano Desktop executes nothing, adds no chat format and makes no
  host call. Inserted text is not scanned again, so a macro cannot call
  another. An unknown `//name` stays as typed.
- **Token rule.** `//name` starts a message or follows whitespace and ends at
  whitespace, at the end, or before closing punctuation that ends the word.
  `https://host`, `a//b` and `//path/file` are not macros. Names are letters,
  digits, `-` and `_`, compared in lower case. `//` takes the place of a `/`
  command only while at least one macro exists.
- **Visible before sending.** Typing `//` lists the macros, an exact name
  first. A whole name that is not the start of a longer one opens no list, so
  Enter sends the message. A known token is marked in the editor as it is
  typed, also inside pasted text. Resting the pointer on it, or moving the
  caret onto it, shows what the macro adds for this chat's agent and a pencil
  that opens the macro in Settings; `F2` with the caret in the token opens it
  directly. The editor stays a plain textarea: the marks are an inert mirror
  layer that holds no text of its own.
- **Local preference.** Macros live in the WebView's `localStorage`
  (`piui.macros.v1`), like favorite models: no host, harness, account or
  project file stores them, and they are not part of an exported system. A
  stored entry that breaks the rules is dropped on load, never repaired. If
  storage refuses a write, the macros last until the app closes and Settings
  says so.
- **A skill name is a request, not a grant.** A macro can name any skill; it
  does not install, enable or verify one. A harness that does not know the
  name answers as if the person had typed it: an unknown `$name` is plain
  text, an unknown `/name` at the start is that harness's unknown command.

## Consequences

- Macros work in safe mode and without a Nano account: they need no runtime.
- The transcript shows the expanded text, because that is what the harness
  received; the draft keeps the `//name` form until it is sent.
- Macros are per device. Sharing or syncing them needs its own decision.
- The new-chat composer is on the first paint, so only the token rules and the
  small store load there; the expansion rules, the mirror layer and the menu
  load on first use.
