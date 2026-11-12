# Nano Desktop

How the optional Nano account, the Nano harness and the Nano Cloud window work,
and what each of them may and may not do. Written for engineers working on this
repository. Decisions: ADR-046 (rebrand, frozen identifiers), ADR-047 (the
account and its privacy model), ADR-048 (the Nano harness and the relay),
ADR-049 (the cloud window). Contracts: `contracts/nano-account-v1.ts` (WebView
and host), `contracts/nano-server-v1.ts` (host and server). The server side is
specified in [NANO_DESKTOP_API.md](NANO_DESKTOP_API.md); a synthetic server for
development lives in `tools/nano-dev-server/`.

Nano Desktop is PiUI under a new name. It is still a workbench over native
harnesses (Codex, Claude Code, Pi, Hermes, Prime Agent, ACP agents). It does
not become a model client: Nano adds one more native harness whose models and
limits come from a Nano account.

## 1. Modes of use

| Mode | What is true | Network to Nano |
|---|---|---|
| No account (default) | Exactly the workbench of 0.2.x. The `nano` harness is listed as "sign in required" and blocks nothing else. | None. Not even discovery. |
| Signed in, local Nano | Upstream Pi runs on this computer against the Nano modes available to the workspace. The Windows release supplies its own Pi and Node.js. History is Pi JSONL on this disk. | Account, entitlement and usage requests; the prompts of Nano sessions through the relay; audio the user dictates. |
| Nano Cloud window | The user's server agent in the Nano web app, in a separate isolated window. | Whatever the web app does, in its own window and profile. |

Local and cloud sessions never merge: no file, history or credential moves
between them, and there is no second chat format. Dictation and the pet avatar
are available in the first two modes; they are features of the account, not of
the harness.

## 2. Components

```
WebView (main window, app origin, CSP connect-src 'self', unchanged)
  Svelte UI: Account settings, sidebar account chip, usage meter, model picker,
  Nano chats. Knows: display name, plan, credits, modes, device names, error
  codes. Never knows: any token, code, key or URL it could open.
        | typed, versioned commands and one event (nano-account-v1)
        v
Rust host (the only holder of Nano credentials, the only caller of Nano)
  account manager   OAuth client, loopback listener, discovery, refresh, state
  credential store  OS credential store (refresh token); memory (access token)
  desktop API client  HTTPS to /api/desktop/v1, issuer-pinned
  relay             127.0.0.1:<ephemeral>, per-session key, injects the token
  existing          scheduler, Fusion broker, harness registry, containment
        | spawn: cleared environment, relay URL + session key
        v
Node bridge  crates/piui-runtime/bridge/pi.mjs in the "nano lane"
        | stdio JSON-RPC, LF framing (unchanged)
        v
Pi (upstream, >= 1.4.0) + nano-guard extension
  provider "nano" -> http://127.0.0.1:<port>/s/<session>/v1
  agent dir: host-owned, private (PI_CODING_AGENT_DIR)

        HTTPS, origins pinned to the issuer's site
        v
Nano server: /connect/* (authorization server), /api/desktop/v1/* (desktop API
and gateway facade), then the existing gateway and providers.

Cloud window (label nano-cloud): separate WebView, no IPC, own profile.
```

Responsibilities. The WebView presents. The host holds credentials, makes every
Nano request, runs the relay and contains processes. The bridge and Pi own the
agent loop, tools, compaction and history, as for every Pi session. The server
owns identity, entitlements, metering and routing. The host runs no agent loop
and builds no prompt: the relay forwards bytes and enforces policy, which is
what separates it from a provider client (ADR-048).

Code map: account state and flows `crates/piui-nano` and
`apps/desktop/src-tauri/src/nano/`; WebView contract `nano-account-v1.ts` and
`apps/desktop/src/host-api/nanoAccountClient.ts` (Lab fake
`host-api/lab/nanoAccountFake.ts`); the lane in `crates/piui-runtime`
(`bridge/pi.mjs`, `bridge/nano-guard.ts`, `src/nano.rs`); presentation metadata
`apps/desktop/src/harness-adapters/nano.ts`.

## 3. Sign-in

```
UI            host                         system browser           Nano server
 | signIn      |                                  |                        |
 |------------>| safe mode or busy? -> refuse     |                        |
 |             | GET /.well-known/..., GET meta ---------------------->    |
 |             | endpoints on the issuer's site? client version ok?        |
 |<- signing-in| verifier + state (32 random bytes each); bind 127.0.0.1:0 |
 |             | open authorize URL (built here) ->|                       |
 |             |                                   | sign in, consent ---->|
 |             |<----- 302 http://127.0.0.1:<port>/callback?code&state&iss-|
 |             | one GET /callback; state (constant time), iss; static page|
 |             | POST /connect/token (code + verifier + device name) ----->|
 |             |<------------------------ access + refresh token ----------|
 |             | refresh token -> credential store; access token -> memory |
 |             | GET me, entitlements, usage                               |
 |<- status    |                                                           |
```

- No password field, no custom URL scheme (on Windows any application can
  claim one), no embedded browser. The authorize URL is assembled by the host;
  the WebView can only ask for `billing`, `devices` or `signup` by name.
- The listener accepts one `GET /callback` with a matching `state` and `iss`,
  answers a static page and closes. Anything else is 400. `iss` is required
  (RFC 9207): a callback without it fails like a wrong one. It gives up after
  five minutes (`sign-in-timeout`); `cancelSignIn` closes it at once. Tokens a
  cancelled (or otherwise superseded) sign-in still receives from a pending
  code exchange are revoked in the background and never stored.
- Issuer: `https://nanoagents.ru` compiled in. `PIUI_NANO_ISSUER` overrides it
  only in debug builds and builds with the `e2e-webview-automation` feature,
  and plain `http` only for a loopback issuer. Release builds never read the
  variable. Every endpoint the discovery document advertises must be `https`
  and on the issuer's site (or loopback in development).
- A server without the desktop API answers 404 to discovery: state
  `unsupported`, error `unsupported-server`. A server whose `minClientVersion`
  is newer than the app: `unsupported`, `client-too-old`. The server applies the
  same minimum to every authenticated call from the `X-Nano-Client` header, so
  an old client is refused with `426` there too. There is no fake success path;
  the only stand-in is the clearly labelled synthetic server.
- Account state machine (`NanoAccountStateV1`): `signed-out`, `signing-in`,
  `signed-in`, `expired` (revoked device or dead refresh token; sign in again,
  local data stays), `unsupported`, `offline` (credential stored, server not
  reachable). The status command reads local data and never touches the
  network; first paint never waits for Nano.

## 4. Token lifecycle

| Token | Lives in | Lifetime | Notes |
|---|---|---|---|
| Authorization code | redirect to host | at most 60 s, once | bound to the PKCE challenge and redirect URI |
| Access token | host memory only | about 10 minutes | sent only as `Authorization` to `/api/desktop/v1` |
| Refresh token | OS credential store (Windows Credential Manager), generic credential `NanoDesktop/<issuer host>/<user id>` | about 30 days sliding | rotated on every use; one family per device |
| Relay session key | host memory, the environment of that session's own Nano bridge process until the bridge deletes it at startup, and that session's Pi child environment | one native session and account generation | worthless off this machine; never in a bridge frame |

- Refresh at 80 percent of the access lifetime and on a 401, single-flight:
  the single-instance plugin guarantees one process, so no cross-process
  rotation race exists. Order: receive the new pair, write the new refresh
  token to the store, then swap memory.
- `invalid_grant` ends the session: state `expired`, relay sessions closed, one
  notice. No retry loop and no fallback credential. A `401 device_revoked` does
  the same.
- Account generations: every sign-out, expiry, new sign-in and cancelled
  sign-in starts a new generation. A request, refresh, retry, relay session or
  Nano launch carries the generation it started under and is refused
  (`sign-in-required`) once it ended, so nothing started for one account ever
  runs with the credentials of the next. A new sign-in from `offline` also ends
  the sessions of the offline generation.
- If the OS store fails the session is memory-only (`credentialStore:
  "memory"`, the UI says so); there is never a plaintext fallback. E2E-isolated
  hosts always use the memory store.
- Sign-out revokes the refresh token on the server on a best-effort basis,
  deletes the stored credential, closes relay sessions and clears the cloud
  window's profile. The local part works offline and in safe mode.
- No token appears in IPC payloads, events, logs, files, exported system files,
  the Lab, a bridge, Pi or any environment. Token types redact `Debug` and are
  zeroized on drop; a test asserts that no token reaches any `Debug` or log
  output.

## 5. The Nano harness and the relay

`nano` is a built-in harness identity (grammar v3, additive over v2). Its native
runtime is upstream Pi, driven by the Pi bridge in a Nano lane. Windows x64
release builds include a pinned Pi and Node.js, plus ripgrep and fd. The host
extracts and verifies that runtime on first use under the app data directory,
without a download at install or session start. Development builds and other
platforms use an installed upstream Pi at least 1.4.0. Pi JSONL in the host
session directory remains the authoritative history.

Lane launch (everything below is enforced by the host before a native start):

- A private agent directory under the app data (`PI_CODING_AGENT_DIR`) with a
  host-written `models.json`: one provider `nano`, `api: "openai-completions"`,
  `baseUrl` the relay, `apiKey: "$NANO_RELAY_KEY"`, models `auto|free|fast|smart`
  that the account is entitled to. The user's own `~/.pi`, credentials and
  extensions are never read or changed.
- Pi runs with `--mode rpc --no-approve --offline`, so project-local `.pi`
  resources never load, telemetry and version checks are off, and the child
  environment is cleared to an OS allowlist plus `PI_CODING_AGENT_DIR`,
  `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and
  `NANO_RELAY_KEY`. No Nano credential and no user secret is in that
  environment. `--provider nano --model <mode>` is passed when the start names
  a mode; a reopened or resumed session without one passes neither, and the
  bridge refuses it unless Pi restored a `nano` model.
- The relay key path: the host starts that session's own Nano bridge process
  from the same OS allowlist plus `PIUI_NANO_RELAY_KEY`; the bridge reads the
  variable once, deletes it from its environment and gives the key only to the
  Pi child as `NANO_RELAY_KEY`. The key is never in the `initialize` frame,
  an argument, an event or a log.
- Permission modes: `native` (default; the `nano-guard` extension asks before
  shell commands, `write` and `edit`, shown as approval cards), `read-only` (`--tools
  read,grep,find,ls`), `full-access` (no guard). `workspace-write` is refused
  before launch because Pi has no OS boundary. All of this is an approval
  prompt and a tool list, not a sandbox; the UI says so wherever a mode is
  chosen.
- Nano explicitly loads the bundled BES Deep Mode skill and the
  `/skill-paths` command. On Windows, Nano registers a PowerShell tool using
  Pi's shell operations and the absolute path to the system PowerShell. It
  works on machines without Git Bash. A preload holds the relay key in the
  Pi process so tool subprocesses do not inherit it.
- Unsupported and refused before native execution: thinking levels, speed tiers,
  base-prompt replacement, per-agent tools, skills and MCP servers, the board
  tool, plugin MCP servers, native subagents, the coordinator role, and network
  restriction. See `src/harness-adapters/nano.ts`.
- A session using Nano subscription models needs sign-in, a selected workspace, `capabilities.gateway`
  and `entitlements.features.localAgent`. Otherwise it fails before launch with
  `NANO_SIGN_IN_REQUIRED` or a typed refusal; there is no fallback to another
  harness. Signed out, existing Nano chats stay readable from their local JSONL.
- Nano subscription models in catalogs are the account's available modes
  (`WorkspaceModel { id: <mode>, provider: "nano", name }`), host-served from
  entitlements, not native discovery; signed out the list is empty and nothing
  is spawned. Tier, cost hint and lock reason are joined by mode id in the
  picker.
- OpenCode and Prime Agent on their verified Windows releases offer a **Nano
  subscription** group alongside the native catalog. Goose uses the same
  picker and starts a separate native ACP process on the selected mode. Codex
  uses a separate native app-server on Windows and adds only modes that the
  signed-in workspace gateway advertises for the Responses dialect. Reopening
  a Nano connector session uses its saved source and native history.
- On Windows, **Settings → Nano account → External model providers** can add a
  model from an HTTPS OpenAI Chat Completions endpoint. Enter the model ID and
  select the endpoint's request format. The native dialog confirms the exact
  destination and accepts the API key, which the host stores in Credential
  Manager. Choose the model in the Nano harness under **External model providers**.
  The connection works while signed out of Nano and has its own session history.
  Disconnecting revokes its requests and removes it from the picker.
- The same Windows settings section offers **Continue with ChatGPT**. The
  system browser asks for permission to use the account's ChatGPT plan. After
  sign-in, choose a model in the Nano harness under **ChatGPT**. The picker
  uses the account's model catalog and shows where to manage ChatGPT usage.
  The connection supports one ChatGPT account per Nano Desktop profile and
  works independently of a Nano account. Connecting sends sign-in and catalog
  requests to OpenAI. Selected chats send inference to its public Responses
  API. Disconnect ends local requests and reports if OpenAI did not confirm
  remote revocation. [OpenAI's sign-in and plan usage guide](https://developers.openai.com/siwc/token-sharing-open-source).

Relay request path: Pi sends `POST /s/<session>/v1/chat/completions` (or
`GET .../v1/models`) to `127.0.0.1:<ephemeral>` with `Authorization: Bearer
<relay key>`. The relay checks, in order and before the body is parsed: method
and path allowlist; `Host` equals `127.0.0.1:<port>`; no `Origin` and no
`Sec-Fetch-Site` header (rejects browsers and DNS rebinding); bearer equal to
that session's key in constant time; the session's account generation is still
current (else `nano_sign_in_required`); the plan is loaded; a declared
`Content-Length` within the plan's `maxRequestBytes` (8 MiB when the plan names
none, never more than 64 MiB); a concurrency slot (`maxConcurrentRequests`, 4
by default), taken **before** any body byte is read so parked uploads count
against it; the body read within that size and a 60 s upload deadline (`408`
otherwise, freeing the slot); `model` is an entitled mode; the generation once
more. It then builds the upstream URL from the pinned API base and a fixed
path (never from request content), drops every inbound header except content
type and accept, adds the host's `Authorization`, `X-Nano-Device` and
`X-Nano-Session` (an opaque random per-session id, not a secret), with
`X-Nano-Client` on every Nano request of the host, and streams the answer back
without buffering. A 401 before the first streamed byte triggers one refresh
and one retry, both only within the same account generation, so a sign-out
(or another sign-in) during the retry never replays the request with other
credentials. The session's end (sign-out, expiry, device revocation, a new
sign-in, or its runtime being dropped or failing) cuts its upload, upstream
request and stream at once. Server errors
become OpenAI-shaped bodies with stable codes (`nano_sign_in_required`,
`nano_credits_exhausted`, `nano_mode_locked`, `nano_rate_limited`,
`nano_offline`, `nano_client_too_old`, `nano_request_too_large`,
`nano_upstream_error`) so the bridge classifies by code. Logs hold status and
byte counts only. Sign-out, device revocation, session end and app exit remove
sessions.

## 6. What leaves the machine

The privacy model of ADR-047, as a list:

1. While signed in: account, entitlement and usage requests to the Nano server.
2. Prompts, tool output and attachments inside the model requests of Nano
   sessions, through the relay to the gateway facade. This includes file
   contents the agent reads and sends as context, so the permission mode and
   the project matter.
3. Audio that the user dictates (one request per recording).
4. Devices: the server learns a device name, platform and app version at
   sign-in.

What does not leave: local Nano histories (never uploaded or synced), other
harnesses' traffic, credentials of other products, telemetry (there is none).
A signed-out application, and any application in safe mode, makes no request to
Nano servers. The cloud window is a browser in its own right and talks to the
Nano web app as the website does.

## 7. Modes, credits and locks

Modes: `auto` (the server picks a tier per request), `free`, `fast`, `smart`.
They are promises of a tier, not of a model: the concrete provider model is the
server's decision and the client never names or promises one. Entitlements
(`GET .../entitlements`) give per mode `available`, `lockedReason` (`plan`,
`credits`, `disabled`), a server-localized `costHint`, context window, maximum
output and input kinds; plus the plan, the credit balance and per-device limits.

- A locked mode is visible and disabled in the picker with its reason. The
  client never downgrades a mode by itself.
- A paid workspace at zero credits locks the paid modes with `credits`; `free`
  keeps working. A zero balance is `credits-exhausted` and shows a typed block
  in the chat with Top up (opens the billing link in the system browser;
  payment is never in-app) and, when entitled, "Switch this chat to Nano
  Free".
- Balance and cost: the sidebar account chip shows the workspace and a meter
  (low at 10 percent or less). Per-turn cost is the usage delta after the turn
  settles and is labelled approximate. Credits are whole numbers; their money
  value is a server matter.
- A Nano chat composer says "This computer, billed to <workspace>".
- Rate limits: `429` maps to `rate-limited` and `nano_rate_limited`; the
  concurrency cap of the plan applies per device.

## 8. Fusion and pipelines

- Fusion: Nano may be the sidekick (executor) of a Claude Code or Codex lead
  under the same rule as Pi (both roles full access). Nano as lead is refused
  (`LeadHarnessUnsupported`): the stock Pi lane has no host tools, and the
  sidekick, board and coordinator tools need native custom tools. See
  follow-ups.
- Pipelines and delegation: a Nano node is a native session on this computer;
  the scheduler has no Nano branch. `authorize_spawn` rules are unchanged:
  Nano-to-Nano with `native` permissions is comparable; any cross-harness
  spawn needs explicit modes on both sides, otherwise it is refused. A node
  with `coordination: true` is refused before launch. Result edges work as for
  Pi, including Codex to Nano and back through verified native history
  references.
- A schedule that contains a Nano node has no spending cap of its own: it runs
  unattended and spends the account's credits, bounded only by the plan's
  limits on the server. A Nano node whose account cannot start a Nano session
  (signed out, no local agent in the plan, no available mode) fails before
  launch with its typed code; a locked mode is refused by the relay on the
  request. The run's `uncertain` semantics are unchanged.
- Portable system files carry only `harness: "nano"`, `modelProvider: "nano"`
  and the mode id: no account, workspace, token or limit.

## 9. Nano Cloud window

`nano_cloud_open_v1` opens or focuses a separate window labelled `nano-cloud`
on the Nano web app (`meta.links.cloud`, default `https://hermes.nanoagents.ru/`).

- No IPC. No capability lists the window; the command guard is an allowlist
  that accepts only the main window label on the app origin.
- Opens only for a signed-in account whose plan includes the cloud
  (`sign-in-required` otherwise, `feature-unavailable` when the plan lacks it),
  checked before focusing, after the server call and once more after the
  window exists.
- Its own WebView2 data directory under app local data. The window closes and
  the directory is cleared on every entry into `signed-out` or `expired` and on
  every account generation change (sign-out, expiry, a new sign-in); `signed-in`
  and `offline` keep it. Cookies are session-only.
- Navigation allowlist: https Nano hosts (the issuer's site and workspace
  hosts; the dev issuer host in development). Every other link opens in the
  system browser; no new windows; downloads are disabled for now (the host
  cancels every one).
- Sign-in still happens in the system browser (RFC 8252). When the server offers
  `cloud/launch`, the host asks for a one-time, device-bound URL and navigates
  the window to it, so the web app starts a session without a second sign-in; a
  revoked device ends that session. Until then the user signs in on the web page
  itself.
- A separate window, not an iframe: the server forbids framing and an iframe
  would share the app origin.
- Realtime voice and the talking portrait are features of this window; local
  Nano has neither.

## 10. Pet avatar and dictation

- Pet avatar: a Svelte component that steps a WebP sprite atlas by session
  state (idle, think, work, wait, done, error). A `nano` look is bundled;
  further looks, when the server offers them, are downloaded by the host, with
  hash, size and type checked, and cached. Reduced motion shows a still frame.
  It is decoration: nothing depends on it, and it makes no request while signed
  out.
- Dictation: a composer feature that works for every harness. The WebView
  records with `MediaRecorder` (push-to-talk, at most five minutes, visible
  recording state) and sends the bytes to the host (`nano_dictation_v1`); the
  host posts them to `media/dictation` and returns text for the composer. The
  WebView makes no network request, so the CSP is unchanged. The recording
  stays in memory for one retry and is never written to disk. Available only
  when `capabilities.dictation` and `features.dictation` are both true.
  WebView2's own microphone prompt applies; whether the host can answer it is
  unverified.

## 11. Safe mode

Safe mode makes no Nano network call: no discovery, no refresh, no relay, no
dictation, no cloud window; the `nano` harness refuses with `SAFE_MODE`. The
account status is read from local data and local sign-out is allowed (it
forgets the credential without a network call). Every other command of
`nano-account-v1` answers `safe-mode`. The generic fallback for Nano chats
(Pi's projection) is unchanged.

## 12. Threat model

The Nano agent runs as the user; this is not a sandbox and the UI never says
otherwise.

| Threat | Mitigation | Residual |
|---|---|---|
| Local malware running as the user | Credential store, not a file; short access tokens; rotation with reuse detection; device revocation; no secret in any environment the agent sees | Malware as the user can read user files and use the host's open session or steal a refresh token until the genuine client next refreshes; the credential store stops other users and offline theft, not same-user code |
| Other local processes hitting the relay | 256-bit per-session key checked in constant time before parsing; `Host` and `Origin` checks; loopback only; fixed paths; request size, concurrency and upload-time limits | A same-user process that reads the agent's environment can use the relay, and spend the account's credits, until the session ends |
| Browser drive-by to the relay or the loopback callback | Relay refuses any `Origin` or `Sec-Fetch-Site` and any non-loopback `Host`; no CORS; the callback accepts one request with a matching `state` and `iss`, then closes | None practical; a hostile page cannot read the answers |
| Prompt-injected agent exfiltrates credentials | Nothing exfiltratable: the relay key is local and per session, the environment is cleared, the agent directory is private | It can read the user files it is allowed to reach and approved commands do what they say |
| Authorization code interception | Loopback redirect on an ephemeral port, PKCE S256, `state`, `iss`, one-shot listener, no custom scheme | None practical |
| Stolen refresh token | Rotation with reuse detection revokes the whole device; new-device e-mail; device list | Use until the genuine client refreshes |
| Revoked device | Server revokes the family and access tokens within seconds; the client turns `device_revoked` into state `expired`, closes relay sessions and clears the cloud profile | A running agent loses its model on the next request |
| Server compromise or hostile server response | TLS, issuer pin, same-site endpoint check, bounded bodies and time, `minClientVersion` kill switch, local histories never uploaded | A compromised Nano server sees the prompts the user sends to it |
| Script in the WebView (model output, plugin panel) | No token in the WebView; CSP blocks network; typed commands; guard allowlist | UI spoofing inside the app |
| Cost exhaustion (unattended schedules, farming) | The server's plan limits: credit balance, locked modes, per-device limits. The relay's own limits are the entitled-mode check, request size, concurrency, an upload deadline and the account generation | The relay has no spending budget per session or per schedule. Spending is bounded only by the account's plan limits on the server, and a scheduled Nano step spends unattended |

Non-goals: OS isolation of the agent (Pi has none and Windows containment only
ends process trees), protection against malware running as the user, hiding
file contents the agent legitimately reads from the model request, a spending
budget in the relay or the scheduler, an independent proof of Nano's
server-side limits.

## 13. Limitations and follow-ups

- The Windows x64 build embeds the runtime archive and its file manifest.
  Verification rejects incomplete or changed contents before starting Nano.
  Other platforms still resolve a separately installed Pi and Node.js.
- Nano as the lead of Fusion, as a coordinator and with the board tool needs
  host tools in the Pi lane (native custom tool registration calling a
  bridge-owned loopback endpoint). Refused until then.
- An image generation tool (a Nano package tool through the relay to a
  `media/images` endpoint) needs the server endpoint.
- A native cloud chat client (chat only, over a versioned `/api/desktop/v1`
  session API) may follow; until then Cloud is the web app in its window.
- Device-code sign-in (RFC 8628) when the loopback cannot complete; offered only
  if `meta` advertises it.
- Local realtime voice and the talking portrait are cloud-only; DPoP-bound
  tokens and a non-exportable device key are a later hardening step.
- Releases are unsigned previews until a signing certificate exists; signing
  becomes mandatory before the installer is offered on a website.
- Only Windows has verified process containment and credential storage; no
  claim is made for macOS or Linux.
- Downloads in the cloud window are cancelled; a host save dialog is a later
  step.
- Evidence so far is synthetic (the dev server and fixtures). Real-provider
  behavior is reported separately once the production server ships the API.

## 14. Development and testing

- `pnpm nano:dev-server` starts the synthetic server (see its README); start a
  debug build with `PIUI_NANO_ISSUER=http://127.0.0.1:8787`. The UI Lab fakes
  the host with `?nano=signed-out|signed-in|low|empty|offline|unsupported|revoked`.
- Contract fixtures (`contracts/fixtures/nano-*.json`) are read by the TS
  tests, the Rust tests and the dev server; change a contract only with a
  version bump and a compatibility test.
- Identifiers that stay as they were are listed in ADR-046 and AGENTS.md; the
  `piui` prefix in code is historical.

## Краткое содержание (RU)

Аккаунт Nano необязателен. Без входа приложение работает как раньше и не
обращается к серверам Nano; в безопасном режиме сетевых вызовов Nano тоже нет.
Вход: OAuth 2.0 с PKCE S256 в системном браузере и loopback-редиректом на
`127.0.0.1`, без поля пароля и без собственной URL-схемы. Токены хранит только
Rust-хост: refresh-токен в хранилище учётных данных ОС, access-токен в памяти;
WebView, мост и Pi их не видят.

Локальный агент Nano - это установленный у пользователя Pi (не форк) с
приватной директорией агента, очищенным окружением и историей Pi JSONL. Модели
(Auto, Free, Fast, Smart) и лимиты берутся из тарифа аккаунта. Pi обращается не
к серверу, а к локальному relay на `127.0.0.1` с ключом на одну сессию; relay
пересылает байты и проверяет политику, но не строит промпты. Режимы прав:
`native` (подтверждение перед bash/write/edit), `read-only`, `full-access`;
`workspace-write` отклоняется. Это не песочница.

Из машины уходят: запросы аккаунта и лимитов, промпты и вывод инструментов в
сессиях Nano, надиктованное аудио. Локальные истории не загружаются и не
синхронизируются. Облачный режим - отдельное изолированное окно без IPC с
белым списком навигации. Fusion: Nano может быть исполнителем (sidekick), но
не ведущим. Ограничения и дальнейшие шаги: встроенные Node и Pi, Nano как
ведущий Fusion, инструмент генерации изображений, нативный облачный чат,
вход по коду устройства, локальный голос.
