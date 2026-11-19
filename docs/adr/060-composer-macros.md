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

## Amendment — 2026-11-17 (0.3.2): a space opens the list

Typing `//` no longer opens the list; it collided with comments, paths and
URLs. A space does instead, in two places only: as the first character of an
empty message, and as the second of two spaces right after text (`fix␣␣`).
A third space, two leading spaces, a space after a line break or a single
space between words open nothing. Letters typed after that space narrow the
list; a space that names no macro closes it and stays an ordinary space.
Enter, Tab or a click replaces the space with the `//name` token (the first
space of a double space stays as the separator). Escape closes the list and
keeps the space; the same space stays closed while the text before it is
unchanged. The token, its marks, its card, `F2` and the expansion on send are
unchanged, and a typed `//name` is still a macro.

## Amendment — 2026-11-19: keys, numbers and a menu that scrolls

- **Numbers.** While the list a space opens has no typed name yet, its first
  nine rows carry the digits 1 to 9 to the left of the title. A digit picks
  that row at once; a click on the row (the digit included) picks it as before.
  A digit past the end of the list types as usual.
- **A macro's own key.** Settings → Macros has an optional **Key**: one letter,
  unique among the macros, stored in the macro (`key`, lower case) in the same
  `piui.macros.v1` entry. In the list, before a name is typed, that letter
  picks the macro and shows as a key cap on its row. A letter typed on another
  keyboard layout counts as the Latin letter on the same physical key, so a
  macro keyed `a` also answers `ф`. A stored key that is not one free letter
  loses only the key; the macro stays. Digits stay for rows, so a key is a
  letter.
- **Once a name is started** (any letter that is not a macro's key, or any
  character after one), keys type again, the numbers and key caps leave the
  rows, and Enter, Tab, the arrows and a click work as before. A macro whose
  key is the first letter of other names is therefore reached by typing a
  longer name or with the arrows.
- **The menu scrolls and stays on screen.** The list holds every macro (up to
  the 200 allowed), grows to 360 px and scrolls inside itself; the highlighted
  row stays in view while the arrows move it. Its height is the room between
  the field and the nearest clipping edge, so it never runs past the top of the
  window or of a scrolling page; when that room is under about 150 px and the
  other side has more, the menu opens below the field.
- **The new-chat screen** sits lower (the first line starts at a third of the
  window height instead of a seventh), which leaves room for the full list
  above its composer.
- **Names without `//`.** The list rows, the hover card and Settings show the
  bare name (`review`); the `//` was noise there. The token a pick writes into
  the message is still `//name`, marked in the editor as before.
