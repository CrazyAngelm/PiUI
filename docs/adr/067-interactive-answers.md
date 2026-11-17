# ADR-067 — Interactive answers in desktop chats

Status: accepted, 2026-11-16. Amended by ADR-077 (2026-11-18): media from chat files, regions, formulas, links and application actions; the paragraphs below marked "amended" describe the first version.

## Context

Nano Web already renders structured `hermes-ui` answers as interactive forms,
calculators, tables and charts. Desktop chats previously displayed their JSON
as ordinary fenced code. Sharing that renderer must preserve the desktop's
existing trust boundary and its literal treatment of shell text such as `$HOME`.

## Decision

Port the Nano Web renderer and its expression interpreter as a lazy desktop
module. Only assistant messages receive a decorator. Widget recognition is
independent of rich Markdown: desktop keeps math, automatic links and image
slots off. The shared conversation surface retains its existing defaults.

- **Untrusted JSON only.** The renderer keeps its size, depth, list and
  expression limits. It uses text nodes and `textContent`, its own interpreter,
  and no HTML sinks or executable expressions. Message content cannot supply
  application callbacks.
- **No network or navigation.** The port contains no frames, embedding,
  network calls or cross-window message listeners. *(Amended by ADR-077: links
  are https-only buttons that go through a host operation or copy their
  address; media is loaded only from chat files as `blob:` URLs the host's
  bytes produced; remote media and embedded players stay unsupported. The CSP
  needs `blob:` for images and media, and KaTeX is a dependency.)*
- **Supported subset.** Layout uses row, column, grid, card, tabs, details and
  divider. Content uses heading, text, callout, badge, badges, list, kv, stat,
  progress, steps and link. Data uses table and chart. Controls use slider,
  number, input, date, select, segmented, toggle, checklist and range. Actions
  use button, buttons, choices and each. *(Amended by ADR-077: formula, image,
  gallery, video, audio and region are supported and advertised; html and
  canvas still display an explanatory note.)*
- **Replies use the composer.** An interactive send action submits a normalized
  user message through the existing typed composer command, only while the
  direct chat's composer is available and its session is idle. Text is limited
  to 4,000 characters. Optional JSON payloads are validated, limited to 16,000
  characters, and fenced after escaping embedded fence terminators. Read-only
  views and busy or closed chats disable send buttons and say why (ADR-077
  reads the reason live).
- **Instruction placement.** The host appends the fixed instruction after a
  session's own instructions for a direct chat. It excludes Fusion sidekicks,
  coordinator-owned sessions, run-owned sessions and Hermes, whose bridge
  already repeats instructions on each turn. Fusion leads remain direct chats.
- **Preference and safe mode.** Settings → General exposes Interactive answers,
  enabled by default and persisted in the host index. Changing it affects
  instructions for chats started afterward, not rendering of existing answers.
  Safe mode supplies neither a decorator nor an instruction and refuses
  preference updates. No Nano account or network call is involved.

## Consequences

The renderer and stylesheet load only after an assistant widget fence appears.
Scopes own their mounted controls and are disposed with the message. Ordinary
code remains readable before loading, after a failed import, in raw mode, and
in safe mode. Rendering requires no account and preserves native chat history;
it introduces no second message format. Synthetic tests cover the interpreter,
reply contract, preferences and instruction placement. The UI Lab and an E2E
spec cover keyboard changes, sending, safe mode and preference persistence.
