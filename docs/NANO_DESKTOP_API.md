# Nano desktop server API v1

The contract Nano Desktop expects from a Nano server. It is written for the
NanoAgent team, who implement it in the .NET host (`NanoAgentProject`). The
typed source of truth is `contracts/nano-server-v1.ts`; golden values are in
`contracts/fixtures/nano-server-v1.json`; `tools/nano-dev-server/` is a
synthetic implementation that the desktop's tests run against. Where this
document and the TypeScript disagree, the TypeScript wins and this file is a
bug. The client side is described in [NANO_DESKTOP.md](NANO_DESKTOP.md), the
decisions in ADR-047 to ADR-049.

Status: nothing in this document exists on `https://nanoagents.ru` yet. A
client that finds no `/.well-known/oauth-authorization-server` shows "This Nano
server does not support desktop sign-in yet" and nothing else breaks.

## 1. Conventions

- Base URL: the issuer, `https://nanoagents.ru`. Every endpoint is on that
  origin. The desktop only follows endpoints that are `https` and on the
  issuer's site (a loopback `http` issuer is accepted in development builds
  only).
- Desktop API prefix: `/api/desktop/v1`. Bodies are JSON, UTF-8, camelCase.
  Times are RFC 3339 UTC. Unknown request fields are ignored; clients tolerate
  unknown response fields, but not unknown members of a closed value set
  (section 9).
- Authentication of the desktop API: `Authorization: Bearer <access token>`
  (section 3). Only `GET /api/desktop/v1/meta` is public.
- Error body for every refused desktop API request, with the HTTP status of
  section 6:

  ```json
  { "error": { "code": "credits_exhausted", "message": "No credits left.", "retryable": false } }
  ```

  `message` is localized for people reading logs; the desktop shows its own
  copy and never displays it. OAuth endpoints use the RFC 6749 error shape
  instead (`{ "error": "invalid_grant", "error_description": "..." }`).
- Every response carries `Cache-Control: no-store`. Token responses also carry
  `Pragma: no-cache`.
- The client is native: no CORS headers are needed or wanted on any of these
  endpoints. Do not add `Access-Control-Allow-*`.
- Clients send `X-Nano-Client: nano-desktop/<version>` on every request. The
  gateway additionally receives `X-Nano-Device` and `X-Nano-Session` (opaque ids
  for diagnostics and metering). None of the three is a credential. The server
  reads `X-Nano-Client` for one purpose: the `minClientVersion` check of
  section 9, which every authenticated desktop API and gateway call goes
  through. A call without it, or with a value that is not `nano-desktop/<semver>`,
  is treated as too old.
- Nothing the desktop sends or receives is logged by the desktop beyond status
  and sizes. The server should treat prompt bodies the way the web app does.

## 2. Discovery

### `GET /.well-known/oauth-authorization-server` (RFC 8414)

Public. Fields the client reads:

```json
{
  "issuer": "https://nanoagents.ru",
  "authorization_endpoint": "https://nanoagents.ru/connect/authorize",
  "token_endpoint": "https://nanoagents.ru/connect/token",
  "revocation_endpoint": "https://nanoagents.ru/connect/revoke",
  "device_authorization_endpoint": "https://nanoagents.ru/connect/device",
  "code_challenge_methods_supported": ["S256"],
  "grant_types_supported": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  "scopes_supported": ["openid", "profile", "offline_access", "nano.desktop"]
}
```

`issuer` must equal the origin the client fetched it from, and the three
endpoints must be on the same site. `device_authorization_endpoint` and the
device grant are optional and are used only when `meta.capabilities.deviceCode`
is true.

### `GET /api/desktop/v1/meta`

Public, no authentication, cacheable for a short time.

```json
{
  "apiVersion": 1,
  "serverVersion": "2026.11.0",
  "minClientVersion": "0.3.0",
  "clientId": "nano-desktop",
  "capabilities": { "gateway": true, "cloudLaunch": false, "deviceCode": false, "dictation": true, "voice": false, "imageGeneration": false, "avatars": true },
  "links": { "billing": "https://nanoagents.ru/billing", "devices": "https://nanoagents.ru/account/devices", "signup": "https://nanoagents.ru/signup", "cloud": "https://hermes.nanoagents.ru/" }
}
```

- `apiVersion` is the integer major version of this document (1).
- `minClientVersion` is a semver. A client older than it is told to update and
  does nothing else (section 9).
- `capabilities` says which optional parts the server implements. A client
  never calls an endpoint whose capability is false. `gateway` must be true for
  the local Nano agent; `cloudLaunch` for the one-time cloud code;
  `imageGeneration` and `voice` are reserved and ignored in v1.
- `links` are absolute `https` URLs on the issuer's site (the cloud link may be
  the Nano web app's own host). The desktop opens them in the system browser,
  chosen by enum (`billing`, `devices`, `signup`), never by a URL from the UI.

## 3. OAuth 2.0 authorization server

Public client `nano-desktop`: no client secret, so everything below stands on
PKCE, exact redirect matching and short-lived tokens. Follow RFC 6749, RFC 7636
(PKCE), RFC 7009 (revocation), RFC 8252 (native apps), RFC 9207 (issuer
identification) and RFC 9700 (current security practice).

### 3.1 Client registration

| Property | Value |
|---|---|
| `client_id` | `nano-desktop` (fixed; the contract's `NANO_DESKTOP_CLIENT_ID`) |
| Type | public, no secret; `token_endpoint_auth_method: none` |
| Grants | `authorization_code`, `refresh_token`; `device_code` when advertised |
| PKCE | `S256` mandatory; `plain` and a missing challenge are refused |
| Redirect URIs | loopback only, see below |
| Scopes | `openid profile offline_access nano.desktop`; the client requests all four; what each one opens is in section 4 |
| Consent | explicit, every first sign-in of a device (names the device and what it can do) |

Redirect URI rule (RFC 8252 section 7.3): `http://127.0.0.1:<port>/callback`
where `<port>` is any port 1-65535 chosen by the client at sign-in time. Match
scheme, host (`127.0.0.1` literally; no `localhost`, no IPv6 in v1), exact path
`/callback`, and require no query, fragment or userinfo. Ignore only the port.
Any other redirect URI is a hard error shown on the server's page: never
redirect to an unregistered URI, and never redirect an error for an unknown
client.

### 3.2 `GET /connect/authorize` (browser, user-facing)

Parameters:

| Parameter | Required | Notes |
|---|---|---|
| `response_type` | yes | `code` |
| `client_id` | yes | `nano-desktop` |
| `redirect_uri` | yes | per section 3.1 |
| `scope` | no | subset of the four scopes; default all |
| `state` | yes | opaque, at least 128 bits from the client; echoed back unchanged |
| `code_challenge` | yes | 43 characters, base64url of SHA-256 of the verifier |
| `code_challenge_method` | yes | `S256` |
| `device_name` | no | shown on the consent page and stored on the device record; at most 80 characters, treat as untrusted text |

The server signs the user in with its normal website login, then shows a
consent page naming the application, the device and the grants ("use your Nano
limits", "open your cloud agent"). Approve answers `302` to
`redirect_uri?code=<code>&state=<state>&iss=<issuer>`; deny, or any error after
the redirect URI was validated, answers `302` to
`redirect_uri?error=<code>&error_description=<text>&state=<state>&iss=<issuer>`
(`access_denied`, `invalid_request`, `invalid_scope`,
`unsupported_response_type`). `iss` is mandatory in every response (RFC 9207):
the client rejects a response whose `iss` is missing or differs from the issuer.

Authorization codes: opaque, single use, at most 60 seconds, bound to the
client, redirect URI and PKCE challenge. The page must not be frameable
(`frame-ancestors 'none'`) and must say who is asking; device names are
rendered escaped.

### 3.3 `POST /connect/token` (form encoded)

`Content-Type: application/x-www-form-urlencoded`; `client_id=nano-desktop` in
every request.

Authorization code exchange:

```
grant_type=authorization_code&client_id=nano-desktop&code=<code>
  &redirect_uri=http://127.0.0.1:<port>/callback&code_verifier=<43..128 chars>
  [&device_name=...&device_platform=windows&app_version=0.3.0]
```

Refresh:

```
grant_type=refresh_token&client_id=nano-desktop&refresh_token=<token>
```

Success, HTTP 200 (`NanoTokenResponseV1`):

```json
{ "access_token": "...", "token_type": "Bearer", "expires_in": 600, "refresh_token": "...", "scope": "openid profile offline_access nano.desktop" }
```

Errors are HTTP 400 with `NanoTokenErrorV1`: `invalid_grant` (bad, expired,
used or revoked code or refresh token; wrong verifier; redirect URI mismatch),
`invalid_client` (client id is not `nano-desktop`), `invalid_request`,
`unsupported_grant_type`, `invalid_scope`, `unauthorized_client`. Never say
which of the checks failed in a way that helps an attacker: the description for
`invalid_grant` is one fixed sentence.

Token requirements:

| Token | Requirement |
|---|---|
| Access token | Opaque reference token or short JWT, **about 10 minutes** (`expires_in` states it; the host refreshes at 80 percent of it or on a 401). Audience `nano-desktop-api`, scopes as granted, claims `sub` and device id. Must stop working within 30 seconds of a device revocation (check the device on use or keep a small revocation cache). |
| Refresh token | Opaque, **rotated on every use**: each successful refresh returns a new refresh token and invalidates the old one. **About 30 days sliding** lifetime (each use extends it) with an absolute cap of 180 days. One token family per device. |
| Reuse detection | Presenting an already-redeemed refresh token **revokes the whole family at once**, with no leeway: its refresh token, its access tokens and its device record become revoked (RFC 9700 section 4.14). Answer `invalid_grant`, e-mail the account owner. The next call with any access token of that family is `401 device_revoked`. A refresh whose answer never reached the client is the one way a genuine client presents a redeemed token; it signs the user out and they sign in again. |
| Authorization code reuse | A second redemption of a code answers `invalid_grant` and revokes the tokens that code already produced (RFC 6749 section 4.1.2). |

The desktop never sends client credentials, never asks for a password and
never caches the old refresh token after a rotation.

### 3.4 `POST /connect/revoke` (RFC 7009)

Form: `client_id=nano-desktop&token=<refresh or access token>&token_type_hint=refresh_token`.
Revoking a refresh token revokes its whole family and device. Always answer
`200` with an empty JSON object, including for unknown tokens; `invalid_client`
(400) only for a wrong `client_id`. This is what the desktop's Sign out calls,
best effort: sign-out must also work for the user when the server cannot be
reached.

### 3.5 Device record

Every successful authorization-code exchange creates one device record tied to
the refresh-token family: `id` (opaque, `dev_...`), `name` (`device_name`,
default "Nano Desktop"), `createdAt`, `lastSeenAt` (updated on use, coarse is
fine), plus server-side platform, app version and last IP country. A user
holds at most 10 active devices; the eleventh sign-in is refused on the
authorization page with an explanation and a link to the device list. The
website's account page lists devices and revokes them; password change and
account lockout revoke every device (mirroring the current JWT cutoff). Send a
"new device signed in" e-mail for the first sign-in of each device.

### 3.6 Device-code grant (optional, RFC 8628)

Only if `meta.capabilities.deviceCode` is true. `POST /connect/device`
(`client_id`, `scope`, `device_name`) answers `device_code`, `user_code`,
`verification_uri`, `verification_uri_complete`, `expires_in` (at most 900) and
`interval` (5). The token endpoint answers `authorization_pending`,
`slow_down`, `expired_token` and `access_denied` until the user approves on the
verification page, which shows the device name, IP and approximate location.
The v1 desktop does not implement this grant (follow-up in NANO_DESKTOP.md); the
fixtures advertise it for forward compatibility.

## 4. Desktop API endpoints

All require `Authorization: Bearer <access token>` except `meta`. Common
failures on every authenticated call: `401 unauthorized` (missing or unknown
token), `401 token_expired` (retryable: refresh and repeat), `401
device_revoked` (terminal: the user must sign in again), `426 client_too_old`
(section 9), `403 scope_missing`, `429 rate_limited`, `5xx`. The token is
checked first, then the client version, then the scope, all before the
endpoint reads its body or spends anything.

Scopes are those the token was granted at consent (the `scope` of the token
response, which a refresh never widens), not those requested:

| Scope | Opens |
|---|---|
| `nano.desktop` | Every endpoint below and the gateway (section 5). |
| `profile` | `GET /me`, together with `nano.desktop` (it returns the display name and e-mail). |
| `openid`, `offline_access` | No endpoint. `offline_access` is what lets the server issue a refresh token. |

A token that lacks a required scope, for instance one authorized with only
`profile`, answers `403 scope_missing` and nothing else happens: no gateway
call, no credit spent, no audio read.

### 4.1 `GET /api/desktop/v1/me`

```json
{
  "user": { "id": "usr_synthetic01", "displayName": "Synthetic Person", "email": "person@example.com" },
  "device": { "id": "dev_synthetic01", "name": "Nano Desktop on Windows", "createdAt": "2026-11-01T09:00:00Z", "lastSeenAt": "2026-11-11T08:30:00Z" },
  "workspaces": [ { "id": "ws_synthetic01", "name": "Personal", "role": "owner" }, { "id": "ws_synthetic02", "name": "Team", "role": "member" } ]
}
```

`device` is the device of the presented token. `workspaces` are those the user
may bill to, roles `owner`, `admin` or `member`. `email` may be null. Ids are
opaque strings; the client treats them as such.

### 4.2 `GET /api/desktop/v1/devices` and `DELETE /api/desktop/v1/devices/{deviceId}`

List: `200 { "devices": [ NanoDeviceV1, ... ] }` of the caller's active devices
(`id`, `name`, `createdAt`, `lastSeenAt`). Delete: `204` revokes that device's
family (also the caller's own); an unknown or foreign id answers `404`
`invalid_request`. The list shape is not typed in `nano-server-v1.ts` yet; this
is the shape the dev server uses and the contract should adopt it before v1
ships.

### 4.3 `GET /api/desktop/v1/workspaces/{workspaceId}/entitlements`

`404 workspace_not_found` when the workspace is not the caller's. Otherwise
`NanoEntitlementsV1`:

```json
{
  "workspaceId": "ws_synthetic01",
  "plan": { "id": "pro", "name": "Pro", "kind": "paid", "renewsAt": "2026-12-01T00:00:00Z" },
  "credits": { "balance": 18250, "included": 25000, "periodEndsAt": "2026-12-01T00:00:00Z" },
  "modes": [
    { "id": "auto", "name": "Auto", "tier": "mixed", "available": true, "lockedReason": null, "costHint": "Picks a model per request", "contextWindow": 200000, "maxOutputTokens": 32000, "input": ["text", "image"], "reasoning": true }
  ],
  "features": { "localAgent": true, "cloud": true, "dictation": true, "imageGeneration": false, "voice": true, "avatars": true },
  "limits": { "maxConcurrentRequests": 4, "maxRequestBytes": 8388608, "dictationMaxBytes": 20971520 }
}
```

- `plan.kind`: `free`, `trial`, `paid`. The server's free fallback (a paid
  workspace swapped to the free key) reports `kind: "free"`.
- `credits` are whole credits (1 credit = US$ 0.001 of gateway spend on the
  server today; the client never shows money). `included` and `periodEndsAt`
  are null for plans without a period.
- `modes` always lists all four ids in the order `auto`, `free`, `fast`,
  `smart`, with `name` and `costHint` localized by the server (the client
  displays them verbatim). `tier`: `mixed` (auto), `free`, `cheap` (fast),
  `paid` (smart). `available: false` always comes with `lockedReason`: `plan`
  (not in the plan), `credits` (balance exhausted for a paid tier), `disabled`
  (switched off by the workspace or the operator). `contextWindow` and
  `maxOutputTokens` are null for locked modes. `input` lists `text` and,
  where the routed models accept images, `image`. `reasoning` says the mode
  may emit reasoning content; the desktop offers no thinking-level control in
  v1.
- Never name or promise a provider model. A mode is a promise of a tier, not
  of a model; the routing behind it may change without a client release.
- `limits` are per device and per request and are enforced by the server
  (section 5); the client uses them to fail early.

### 4.4 `GET /api/desktop/v1/workspaces/{workspaceId}/usage`

```json
{ "workspaceId": "ws_synthetic01", "periodStart": "2026-11-01T00:00:00Z", "periodEnd": "2026-12-01T00:00:00Z",
  "creditsUsed": 6750, "creditsRemaining": 18250,
  "byMode": [ { "mode": "auto", "credits": 4200, "requests": 310 } ] }
```

Accounting data may lag the gateway by minutes; `creditsRemaining` matches
`entitlements.credits.balance` at the time of the call. The desktop treats
per-turn cost as the difference between two reads and labels it approximate.

### 4.5 `POST /api/desktop/v1/workspaces/{workspaceId}/media/dictation`

One audio part: either `multipart/form-data` with a single part named `audio`
(`filename`, `Content-Type: audio/webm` or `audio/ogg` or `audio/wav`), or a
raw body with an `audio/*` content type. Up to `limits.dictationMaxBytes`
(`413 payload_too_large` above it; `0` means dictation is not in the plan).

```json
{ "text": "Synthetic dictated text.", "language": "en", "durationMs": 2400 }
```

`400 invalid_request` for a missing or malformed audio part, `403
feature_not_in_plan` when `features.dictation` is false,
`502/503 upstream_unavailable` when transcription fails. Do not store the audio
beyond the request. `language` and `durationMs` may be null.

### 4.6 `POST /api/desktop/v1/workspaces/{workspaceId}/cloud/launch`

Only when `capabilities.cloudLaunch` is true. Answers a one-time URL that signs
the **cloud window** into the Nano web app for that workspace:

```json
{ "url": "https://hermes.nanoagents.ru/launch?code=synthetic-one-time-code", "expiresAt": "2026-11-11T09:05:00Z" }
```

The code is opaque, single use, at most 60 seconds, bound to the device (so a
revoked device cannot launch) and to one workspace. It is refused at redemption
if that device was revoked in the meantime or the workspace is no longer the
user's. Opening it creates the
web app's normal cookie session (HttpOnly, session-only) inside the cloud
window's own browser profile and redirects to the app. A cloud web session
launched this way ends when the device is revoked. The host opens only `url`
values on the issuer's site or the `links.cloud` host. While the capability is
false the desktop opens `links.cloud` and the user signs in there as on the
website. `403 feature_not_in_plan` when `features.cloud` is false.

### 4.7 Gateway

`POST /api/desktop/v1/workspaces/{workspaceId}/gateway/v1/chat/completions` and
`GET /api/desktop/v1/workspaces/{workspaceId}/gateway/v1/models`. See section 5.

For servers that expose additional dialects, authenticated
`GET /api/desktop/v1/workspaces/{workspaceId}/gateway/v1/capabilities`
returns `{"dialects":{"chat-completions":["free"],"responses":["free"]}}`
with the available mode IDs for each verified protocol. Missing dialects are
unavailable. Codex uses `POST .../gateway/v1/responses` only for advertised
modes and sends the same Nano device and session headers as Chat Completions.
The backend can also advertise `messages` for Anthropic Messages and
`gemini` for Gemini GenerateContent. Availability is scoped to the account,
workspace and operator-verified provider routes.

### 4.8 Server-owned avatars

All three reads require a current desktop device authorization, workspace
membership, an active own profile and the avatar entitlement. They return
`Cache-Control: no-store`; media does not use conditional or range responses.
The host never accepts an asset URL or filesystem path from the WebView.

- `GET /api/desktop/v1/workspaces/{workspaceId}/avatars` returns
  `{ workspaceId, selectedAvatarId: string | null, avatars: [{ id, name }] }`.
  The selected ID follows the server profile. An unset, pending or removed
  selection remains null; clients must not substitute a bundled/default pet.
- `GET /api/desktop/v1/workspaces/{workspaceId}/avatars/{avatarId}/manifest`
  returns the descriptor defined by `NanoAvatarManifestV1` in
  `contracts/nano-avatars-v1.ts`: schema version, fixed renderer version,
  media SHA-256/MIME/byte count, atlas geometry and animation clips. Version 1
  uses `nano-atlas`, WebP, 192×208 cells, eight columns and nine rows.
- `GET /api/desktop/v1/workspaces/{workspaceId}/avatars/{avatarId}/media/atlas?sha256={hash}`
  returns the exact media named by the descriptor, or 409 if it has changed.
  Only the fixed atlas variant and authorized stock/own ready IDs are accepted.
  The existing server avatar generator's 16 MiB result bound also applies here.

The server rechecks authority after reading an asset. The host binds every
request/body read to its account generation and avatar custody epoch; account,
workspace or entitlement changes cancel it. Credits-only updates do not reload
the avatar. An authoritative avatar feature or workspace-access refusal clears the
cached avatar entitlement only for that exact custody; a later explicit account
refresh can restore the server-granted right. Old requests cannot change a new
workspace or sign-in. The WebView receives neither bearer credentials nor reusable asset
URLs. Media and decoded bitmaps are temporary display data.

## 5. Gateway semantics

An OpenAI-compatible Chat Completions facade. The desktop's local relay puts
the user's agent (an unmodified Pi) behind it; the relay builds no prompt and
forwards the body it receives.

Request: the OpenAI chat completions body. `model` is a mode id (`auto`,
`free`, `fast`, `smart`); any other value is `400 invalid_request`. Supported
and forwarded: `messages` (text and image parts where the mode's `input`
includes `image`), `stream`, `stream_options`, `tools`, `tool_choice`,
`temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`,
`reasoning_effort` (ignored when the mode has no reasoning), `parallel_tool_calls`,
`response_format`. Drop everything else (notably `user`, provider routing
extensions and any field that could change the upstream endpoint or key).
`max_*` values above the mode's `maxOutputTokens` are clamped, not refused.

Response: standard `chat.completion` JSON, or for `stream: true`
`text/event-stream` with `data: <chat.completion.chunk>` events and a final
`data: [DONE]`. **Always send `usage` in the last chunk** (an event with
`choices: []`, as `stream_options.include_usage` does), even when the client did
not ask. Flush each event immediately: no buffering proxy (set
`X-Accel-Buffering: no`, disable response compression for the stream). Rewrite
`model` in every response and chunk to the mode id; never reveal the routed
provider or model, provider request ids, or any `x-litellm-*` header.

Server-side mapping and accounting:

1. Check access exactly like the web agent does (the existing
   `HermesRuntimeAccessService`: subscription state, workspace budget, plan's
   allowed groups), then map the mode to the gateway group: `free` -> `free`,
   `fast` -> `cheap`, `smart` -> `premium`, `auto` -> `auto`.
2. Call the gateway with the **workspace's** key held on the server. That key
   is never returned, logged or placed in any response; there is no endpoint
   that vends a gateway key or a virtual key to a desktop. Budgets, rpm, tpm
   and the free-fallback swap keep working because they live on that key.
3. Credits are debited by the gateway's metering, exactly as for web chats; the
   desktop adds no pricing of its own. Concurrent requests share the workspace
   balance; per-request cost is approximate.
4. Record each request as a usage event with the device id and session id
   (`desktop_llm`), so usage can be split by device and so a stolen device is
   visible.

Refusals, decided before any byte of the answer is sent (JSON error body, not
SSE):

| Case | Status and code |
|---|---|
| Mode not in the plan, or switched off | `403 mode_not_in_plan` |
| Paid tier and balance exhausted | `402 credits_exhausted` (the `free` mode keeps working at zero credits) |
| Subscription expired | `402 subscription_expired` |
| More than `limits.maxConcurrentRequests` requests in flight for this device | `429 rate_limited`, `Retry-After` in seconds |
| Body larger than `limits.maxRequestBytes` | `413 payload_too_large` |
| Provider or gateway failure before streaming began | `502` or `503 upstream_unavailable`, `retryable: true` |
| Workspace unknown or not the caller's | `404 workspace_not_found` |
| Local agent disabled for the workspace by an owner or operator | `403 desktop_local_disabled` |

A failure after streaming started ends the stream (close the connection
without `[DONE]`); the client treats that as an upstream error.

`GET .../gateway/v1/models` answers `{ "object": "list", "data": [ { "id": "free", "object": "model", "created": 0, "owned_by": "nano" } ] }`
containing only the modes the caller can use now (`available: true`).

Rate limits and abuse controls (the server's choice of numbers; these are the
shape): per-device concurrent requests = `limits.maxConcurrentRequests`; a
per-device requests-per-minute limit and a daily credit cap per device on top
of the workspace budget; at most 10 devices per user; a free-tier daily quota;
registration hardening for free-tier farming. Every 429 carries `Retry-After`.
The `minClientVersion` check is the kill switch for a client with a bug.

## 6. Error codes and statuses

| HTTP | `error.code` | Retryable | Meaning and client reaction |
|---|---|---|---|
| 400 | `invalid_request` | no | Malformed request. |
| 401 | `unauthorized` | no | Missing or unknown bearer token. Client treats the session as signed out. |
| 401 | `token_expired` | yes | Refresh and repeat once. |
| 401 | `device_revoked` | no | The device was signed out; state becomes `expired`, local data stays. |
| 402 | `credits_exhausted` | no | Top-up prompt, switch to `free`. |
| 402 | `subscription_expired` | no | Renewal prompt. |
| 403 | `scope_missing` | no | Token lacks the scope for this endpoint (section 4). |
| 403 | `mode_not_in_plan` | no | Mode not in the plan. |
| 403 | `feature_not_in_plan` | no | Feature (dictation, cloud) not in the plan. |
| 403 | `desktop_local_disabled` | no | The workspace does not allow the local agent. |
| 404 | `workspace_not_found` | no | Unknown workspace for the caller. |
| 413 | `payload_too_large` | no | Over `maxRequestBytes` or `dictationMaxBytes`. |
| 426 | `client_too_old` | no | Update Nano Desktop (`minClientVersion`, section 9); also answered when `X-Nano-Client` is missing. |
| 429 | `rate_limited` | yes | Back off by `Retry-After`. |
| 502, 503 | `upstream_unavailable` | yes | Provider or gateway down. |
| 500 | `internal` | yes | Bug on the server. |

The local relay translates these for Pi into the OpenAI-shaped codes
`nano_sign_in_required`, `nano_credits_exhausted`, `nano_mode_locked`,
`nano_rate_limited`, `nano_offline`, `nano_client_too_old`,
`nano_request_too_large` and `nano_upstream_error`.

## 7. Security requirements

- **Audience isolation.** A desktop access token must be useless against every
  other Nano API (`/api/accounts`, the control plane, `/api/admin`, `/hubs`,
  `/api/hermes`), and an account JWT must be useless against `/api/desktop`.
  Today one HS256 key and one audience serve every client; do not reuse them.
- **No gateway key leaves the server**; no provider key, no workspace virtual
  key, no routing details, in any response, header or error text.
- Constant-time comparison for secrets; refresh tokens and codes stored only as
  hashes; all of them fail closed.
- TLS only. HSTS on the issuer. The authorize page and the consent decision are
  protected against framing and CSRF (single-use transaction id).
- Do not log tokens, codes, verifiers, prompts or completions.
- Revocation reaches access tokens within 30 seconds, cloud web sessions
  launched from the device immediately, and is visible in the device list.
- The server must not require or accept any API key for desktop calls: the
  bearer token is the only credential.

## 8. Test doubles and conformance

- `contracts/fixtures/nano-server-v1.json` holds the golden bodies. Copy it into
  the server's test project and assert byte-for-byte shape equality (ignoring
  values) against real responses; the desktop's tests deserialize the same file.
- `tools/nano-dev-server/` (`pnpm nano:dev-server`) implements this document with
  synthetic data. It is the executable specification for edge cases: PKCE,
  one-time codes, rotation and reuse detection, scopes, the client version
  check, device-bound cloud codes, a locked mode, exhausted credits and SSE
  framing. It is deliberately not a security reference.

## 9. Versioning

- `meta.apiVersion` is the major version of this contract. Within v1 only
  additive changes: new fields in response objects (the desktop's
  deserializers do not use `deny_unknown_fields`, so unknown fields are
  ignored), new `capabilities` and `features` keys, new optional request
  parameters, new endpoints behind a capability flag. Existing fields are
  neither removed nor retyped.
- Adding a value to a closed set is not additive. The desktop's typed
  deserializers reject an unknown member: a success document that carries one
  does not parse and the client reports the server as `unsupported`. The closed
  sets are mode ids (`modes[].id`, `usage.byMode[].mode`), `modes[].tier`,
  `modes[].lockedReason`, `modes[].input`, `plan.kind`, workspace `role` and
  the OAuth token `error`. One mode id the client does not know (say `ultra`)
  makes the entitlements response, and with it the account, `unsupported`. The
  desktop API `error.code` is closed as well: an error body with an unknown code
  is read as if it had none, so the client acts on the HTTP status alone. Each
  of these needs a new API version.
- A breaking change gets `/api/desktop/v2`, a new `apiVersion` in `meta`, and v1
  stays served for at least as long as `minClientVersion` allows older clients.
- `meta.minClientVersion`: semver of the oldest Nano Desktop allowed. The server
  compares it, by SemVer precedence (a pre-release is older than its release),
  with the version in `X-Nano-Client: nano-desktop/<semver>` on every
  authenticated desktop API and gateway call. An older version answers `426
  client_too_old` with the ordinary error body (`{ "error": { "code":
  "client_too_old", "message": "...", "retryable": false } }`); the client shows
  "update" and stops. A missing header and a value that does not parse count as
  too old as well: the desktop sends it on every request, so a caller without
  it is not a supported client. `meta`, discovery, the token endpoint and
  revocation do not check it, so a user can still sign out.
- A server that speaks a different `apiVersion` is `unsupported` to the client,
  as is one without discovery.

## 10. Implementation notes (.NET, NanoAgentProject)

These are suggestions, grounded in how the host is built today
(`IdentityStartup.cs`, `JwtTokenService`, `HermesSsoService`,
`HermesRuntimeAccessService`); verify each against the code before relying on
it.

- **Authorization server: OpenIddict** (ASP.NET Core, EF Core stores) with the
  authorization-code flow, PKCE required, refresh-token flow, and the
  `/connect/authorize`, `/connect/token`, `/connect/revoke` (and optionally
  `/connect/device`) endpoints in pass-through mode so the authorize page is
  the site's own Razor/Blazor UI. Register the `nano-desktop` application as a
  public client with permission for those endpoints, PKCE required
  (`Requirements.Features.ProofKeyForCodeExchange`), consent required. Use
  rolling refresh tokens with a sliding lifetime (30 days) and no reuse
  leeway: OpenIddict's default leeway is 30 seconds, so set
  `SetRefreshTokenReuseLeeway(TimeSpan.Zero)` (check the name against the
  release in use). It then revokes the whole authorization chain as soon as a
  redeemed refresh token is replayed, which is the family revocation of section
  3.3. Persist authorizations (one per sign-in) and link the device
  record to the authorization id. Reference access tokens
  (`UseReferenceAccessTokens`) give revocation on the next request without a
  denylist. Confirm that the OpenIddict release in use matches loopback
  redirect URIs ignoring the port (RFC 8252 section 7.3) and emits `iss` in the
  authorization response (RFC 9207); if not, enforce both in a
  `ValidateAuthorizationRequest` handler and an authorization response
  handler.
- **Separate authentication scheme for `/api/desktop`.** The current "Smart"
  scheme sends every `Authorization: Bearer` request to the legacy JwtBearer
  (HS256, audience `NanoAgentClient`). Select the OpenIddict validation scheme
  by path prefix, before that rule, for `/api/desktop/**`, with audience
  `nano-desktop-api` and a policy per scope (the table in section 4), answering
  `403 scope_missing`, plus a filter for the `X-Nano-Client` check of section 9
  that answers `426 client_too_old`. Keep the existing JWT scheme for
  everything else and add a test that a desktop token is rejected there and the
  reverse.
- **Relation to the existing flows.** The browser login (password, e-mail code)
  and the account JWT stay as they are: they authenticate the person on the
  authorize and consent page, using the same control-plane cookie that already
  authenticates page navigations. They never become desktop credentials. The
  desktop gets its own tokens from OpenIddict, scoped and audience-bound,
  tied to a device. Password change, account lockout and the existing admin
  revoke should also revoke the user's OpenIddict authorizations, next to the
  JWT cutoff.
- **Cloud launch** reuses the existing `HermesSsoService` one-time code,
  but takes the person from the device's authorization (carry the
  authorization id where `AccountSessionJti` is carried today so revoking the
  device ends the web session) and cannot require the browser-binding cookie of
  the main window; bind it to the first request instead.
- **Gateway facade**: a new controller under `/api/desktop/v1/workspaces/{id}/gateway`
  that authorizes through `HermesRuntimeAccessService`, maps the mode to the
  gateway group, streams through `HttpClient` with
  `HttpCompletionOption.ResponseHeadersRead` and copies the SSE stream without
  buffering. Strip response headers, rewrite `model`, ensure the last chunk has
  `usage`. Record usage events with the device id.
- **Entitlements** come from the same plan table and credential rows the web
  app reads (`HermesLiteLlmPlans`, workspace credits). Locked reasons are
  derived: not in plan -> `plan`, paid group with zero remaining credits ->
  `credits`, operator switch -> `disabled`.
- **Rate limits** with ASP.NET Core's `AddRateLimiter` keyed on device id (not
  IP: the forwarded-header trust lists are reportedly empty in production, so
  per-IP limits are spoofable), plus a concurrency limiter for the gateway.
- **Dictation** reuses the existing speech-to-text route with the workspace
  key; apply the plan's `dictationMaxBytes` before reading the body.
- Emit the `Retry-After` header on every 429, `Cache-Control: no-store` on
  every desktop API and token response, and add no CORS policy to these paths.

## 11. Open points for the Nano team

1. Whether `auto` may route to a paid tier while `fast` and `smart` are locked
   (free fallback); the client assumes a mode is usable exactly when
   `available` is true.
2. Production values for device limits, rpm and daily caps.
3. Realtime voice and image generation endpoints are out of v1; the capability
   flags are reserved for them.
