# ADR-067 — Interactive answers in desktop chats

Status: accepted, 2026-11-16.

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
- **No network or navigation.** Links are inert spans with the address in a
  tooltip. The port contains no media loading, frames, embedding, player
  control, file resolution, network calls or cross-window message listeners.
  The CSP is unchanged and no dependency is added.
- **Supported subset.** Layout uses row, column, grid, card, tabs, details and
  divider. Content uses heading, text, callout, badge, badges, list, kv, stat,
  progress, steps and link. Data uses table and chart. Controls use slider,
  number, input, date, select, segmented, toggle, checklist and range. Actions
  use button, buttons, choices and each. Formula retains its existing TeX-text
  fallback but is not advertised. Image, gallery, video, audio, region and html
  nodes display an explanatory note; media and custom HTML are outside the
  desktop's trust boundary.
- **Replies use the composer.** An interactive send action submits a normalized
  user message through the existing typed composer command, only while the
  direct chat's composer is available and its session is idle. Text is limited
  to 4,000 characters. Optional JSON payloads are validated, limited to 16,000
  characters, and fenced after escaping embedded fence terminators. Read-only
  views omit the send operation and disable send buttons.
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
