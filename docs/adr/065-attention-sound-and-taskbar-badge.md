# ADR-065 — Attention: a sound and a taskbar badge when a chat needs you

Status: accepted, 2026-11-16.

## Context

A chat can run for minutes. People switch to another window and have to come
back to check whether it finished or is waiting for an approval or an answer.
The sidebar shows the state only while the window is in front.

## Decision

When an ordinary chat finishes its turn, fails, or asks for something (an
approval or a question), and the person is not looking at it, Nano Desktop plays
a short sound and shows a red circle with a number on its taskbar button. The
number counts chats, not events. It clears when the chat is shown in a focused
window, when the chat starts running again, or when it goes away.

- **The WebView decides, the host draws.** Pure rules in
  `app/attention/attentionRules.ts` compare two observations of the session list
  and the pending approvals. A lazy controller (its own chunk, loaded after first
  paint) applies them and reports `{ count, flash }` to the host through
  `attention_set_v1` (`contracts/attention-v1.ts`). The first observation after
  start-up raises nothing, and neither does a request that arrives with a
  chat's first loaded snapshot: it was already waiting.
  Pipeline members (sessions with a run) and Fusion
  sidekick chats are skipped.
- **Sounds are synthesized** with the Web Audio API (four presets: chime, bell,
  pop, marimba), so there are no assets and the CSP needs no `media-src`.
- **The host** sets a Windows overlay icon drawn from a built-in bitmap font
  ("1".."9", "9+"), or the platform badge count on macOS and Linux, and may flash
  the taskbar button when the window is not focused. It works in safe mode.
- **Settings** (Settings -> Notifications) are kept per device in
  `localStorage` (`piui.attention.v1`): sound, preset, volume, badge, flash and
  the three event kinds. Everything is on by default.

## Consequences

- Local only: no network call, no OS notification centre entry, no account.
- A sound needs the page to have received a user gesture once; before that the
  browser keeps audio suspended and the badge still works.
- The remote browser window (ADR-062) does not run the controller.
- The sidebar dot for an unseen chat reads `attention.kind(sessionId)`.
- Settings are not part of an exported system and are not shared between devices.
