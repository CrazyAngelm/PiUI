# ADR-062 — Remote access from Nano Web

Status: accepted for implementation, 2026-11-15.

## Context

A person away from their computer wants to continue the chats of their agents
from the Nano web app, on a phone or another laptop. The agents run as the user
on the desktop; their history stays in the native files of each harness; the
Nano server stores none of it. Nano Desktop already makes outbound calls to the
Nano server and has exactly one listener, the loopback relay (ADR-048).

## Decision

1. **Two outbound-style legs and a relay.** The desktop opens a
   bearer-authenticated WebSocket to `GET /api/desktop/v1/remote/link`
   (subprotocol `nano-remote.v1`). A browser opens a cookie-authenticated
   same-origin WebSocket to `GET /api/hermes/remote/devices/{deviceId}/socket`.
   The Nano server is an in-memory relay: it pairs the two sockets of one
   user, copies frames, stores nothing and logs metadata only. The desktop gets
   no new listener; the loopback relay stays the only one.
2. **Off by default, and only when everything holds.** The link exists only
   while the application is not in safe mode, the account is signed in, the
   server's `meta.capabilities.remoteAccess` is `true`, and the person's toggle
   (stored per device, in `nano-remote-v1.json`) is on. The link closes at once
   when any of them stops holding. A signed-out or safe-mode application makes
   no remote call, as for every other Nano feature.
3. **Trust is a browser key approved at the computer.** A browser holds a
   non-extractable ECDSA P-256 key. For every connection it proves possession
   by signing a challenge bound to this device's id and its relay session; the
   desktop verifies, not the server. A key the computer has never seen needs
   the person's decision at the computer, with a 6-digit code both screens show:
   deny, allow once, or always allow this browser. Remembered browsers (at most
   eight, public keys only) reconnect without a prompt, so phone-only use works
   after one pairing. Three denials or timeouts in ten minutes lock unknown keys
   for ten minutes; one prompt at a time, 120 seconds. Same-account trust alone
   was rejected: a stolen web session would become control of the computer.
4. **The shell is the real shell.** `@piui/nano-ui` compiles the application
   shell with its transport replaced by a WebSocket transport; Nano Web shows it
   in a same-origin iframe. Whatever the shell cannot do remotely is hidden
   there and refused by the desktop.
5. **Advertised workspace commands.** The host lists its admitted commands and
   event channels in `welcome`. Older hosts advertise the chat surface. The web
   shell checks the list before showing workspace actions. The authoritative
   lists and wire fixture live in `contracts/nano-remote-v1.ts` and
   `contracts/fixtures/nano-remote-v1.json`. Dispatch parses typed requests and
   calls the same local services that own the selected project.
6. **Workbench scope requires local consent.** An entry created by a chat-only
   desktop lacks the workbench grant. After proving possession of the browser
   key the owner sees the pairing prompt again. Allow once grants this session.
   Always allow replaces that key's grant atomically. Selecting Deny grants
   nothing. No account, shell, filesystem or plugin administration enters the
   allowlist.
7. **Graph and run authority.** A paired browser can inspect saved pipelines,
   teams, agents, launches, run state and outputs, the board, teammates and
   schedules. It can edit agent graphs atomically in trusted projects and run
   matching saved launch commands. The host checks the definition that is
   actually committed or started. Writing or running a graph requires read-only
   agent profiles without enabled resource grants, allow tool rules, network
   access or spawn grants, and agent or LLM steps. Script, plugin and nested
   pipeline execution remains local. Editing a command targeted or observed by
   an enabled automation, used by a saved sub-pipeline step, or assigned to a
   board teammate requires the desktop. A command with an enabled run-finished
   automation can only be started on the computer. Run cancellations
   are revision-checked. The host assigns remote runs the reserved ID
   `nano-remote-v1-` plus the lowercase SHA-256 hex digest of the request ID
   (UTF-8). A retried request resolves to the same ID. This preserves the
   persisted v6 journal format. The `pairedBrowser` field is a projection in
   remote responses.
   Only these runs accept remote flow control and cancellation, receive no
   session board tool and cannot fire run-finished automations even if a rule
   is enabled later. The host forwards the negotiated event channels.

## Alternatives rejected

- Trusting the signed-in account alone (no per-browser key or approval).
- Server-sent events plus POST: no ordered, bidirectional channel, more
  endpoints, no backpressure.
- A purpose-built mini UI for the web: a second implementation of the chat
  surface that drifts from the shell.
- Routing remote requests through the WebView: the WebView may be hidden,
  reloading or in an unrelated state; the host already owns the commands.
- A server-side binding of browsers to devices: the server would decide trust,
  and a compromised server could pair itself.
- End-to-end encryption of frames in the first version.

## Consequences

- The Nano server sees the chat list and the content of all open chats while a
  paired browser is connected, in transit, over TLS on both legs: the remote
  shell loads the snapshots of every open session and the host forwards the
  events of every session to each connected browser, not only the chats that
  browser opens. They are not stored there. This is a disclosure in
  `docs/NANO_DESKTOP.md` section 6 and in the Settings text.
- A paired browser can do in chats what the keyboard can, including approving a
  tool call. This is remote control of agents that run as the user, not a
  sandbox, and no document describes it as one.
- An event larger than one frame (a Pi `editor` prefill, say) is never sent. The
  desktop sends the browser a small `gap` frame (`ch`, plus `sid` when the event
  named a session) and the browser reads that state again; a queue overflow
  still drops the browser, which reloads on reconnect. `gap` is additive within
  `nano-remote.v1`, so a browser that predates it ignores it.
- A new dependency: `tokio-tungstenite` (framing only, without TLS or connect
  features). The WebSocket upgrade itself uses the account's `reqwest` client, so
  the link inherits the issuer pin, the platform certificate verifier,
  `https_only`, the system proxy and `X-Nano-Client`.
- Presence is in the memory of one server process. A server restart closes every
  link; the desktop reconnects with backoff (1 s to 60 s).
- Follow-ups: frame encryption between browser and desktop, attachments,
  more channels and commands (advertised in `welcome`, so
  additive within `nano-remote.v1`).

See [NANO_DESKTOP.md](../NANO_DESKTOP.md) section 15 and
[NANO_DESKTOP_API.md](../NANO_DESKTOP_API.md) section 4.9.
