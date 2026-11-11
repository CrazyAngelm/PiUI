# Synthetic Nano development server

A zero-dependency stand-in for the Nano server's desktop API
(`contracts/nano-server-v1.ts`, `docs/NANO_DESKTOP_API.md`). It exists for
development and E2E runs of Nano Desktop. Every value is synthetic and comes
from `contracts/fixtures/nano-server-v1.json`; no model, account or payment is
involved, and every page says "Synthetic Nano development server".

Node 22 or newer. It binds `127.0.0.1` only, answers only its exact
`127.0.0.1:<port>` host, and never logs tokens, codes, verifiers or bodies (the
optional request log is `METHOD path status`).

## Run

```bash
pnpm nano:dev-server -- --port 8787 --plan paid --credits 500
# or: node tools/nano-dev-server/server.mjs --port 8787 --plan free
```

Then start a debug build (or an `e2e-webview-automation` build) with
`PIUI_NANO_ISSUER=http://127.0.0.1:8787`. Release builds ignore that variable.

| Flag | Default | Meaning |
|---|---|---|
| `--port N` | `8787` | Listening port (`0` picks a free one). |
| `--plan free\|paid` | `free` | `free`: only the Free mode is entitled, no dictation. `paid`: all four modes, dictation, 18250 credits. |
| `--credits N` | plan default | Credit balance. A paid plan at `0` locks `auto`, `fast`, `smart` with `lockedReason: "credits"`. |
| `--access-ttl SECONDS` | `600` | Access-token lifetime (fractions allowed; for refresh tests). |
| `--scenario NAME` | `default` | `client-too-old`: `meta.minClientVersion` is `99.0.0`, so every authenticated API call answers 426. `upstream-down`: the gateway answers 503. |
| `--stream-delay MS` | `0` | Delay between streamed chunks (for cancellation and concurrency tests). |

From code:

```js
import { startNanoDevServer } from './tools/nano-dev-server/server.mjs';
const server = await startNanoDevServer({ port: 0, plan: 'paid', credits: 100 });
// server.origin, server.port, server.getCredits(), server.setCredits(n), server.setPlan(p),
// server.removeWorkspace(id), server.close()
```

## What it implements

- OAuth: `/.well-known/oauth-authorization-server`, `GET|POST /connect/authorize`
  (consent page with Approve and Deny), `POST /connect/token`
  (`authorization_code` with PKCE S256 and one-time codes bound to the redirect
  URI; `refresh_token` with rotation and reuse detection that revokes the whole
  device family), `POST /connect/revoke`. The only redirect URI accepted is
  `http://127.0.0.1:<port>/callback`; the redirect carries `code`, `state` and
  `iss`; a denial carries `error=access_denied`.
- `/api/desktop/v1`: `meta` (no auth), `me`, `devices`, `DELETE devices/{id}`,
  `workspaces/{id}/entitlements`, `usage`, `media/dictation` (one multipart or
  raw audio body up to the plan limit, answers the fixture text),
  `cloud/launch` (a one-time URL of its own `/cloud` page), and the gateway
  `gateway/v1/chat/completions` (JSON or SSE with a final usage chunk and
  `[DONE]`) and `gateway/v1/models`.
- Every authenticated call is checked in this order: bearer (`401`), the client
  version, the scopes. `X-Nano-Client: nano-desktop/<semver>` must not be older
  than `meta.minClientVersion` (`0.3.0`; semver precedence, so a pre-release is
  older): an older version, a missing header and a header that does not parse
  all answer `426 client_too_old`. `meta`, the OAuth endpoints and revocation
  skip this check. The token carries the scopes granted at consent: every
  endpoint needs `nano.desktop`, and `me` also needs `profile`; otherwise
  `403 scope_missing`, before anything is spent.
- A cloud launch code is bound to the device family and the workspace that asked
  for it: it stops working once the device is signed out or the workspace is
  gone.
- Gateway replies are `Synthetic Nano reply (<mode>): <echo of the last user
  message>`. Credits cost 0 (`free`), 1 (`fast`), 2 (`auto`), 8 (`smart`) per
  request; a locked mode answers 403 `mode_not_in_plan`, a lack of credits 402
  `credits_exhausted`, more than the plan's concurrent requests per device 429
  `rate_limited`.
- Access tokens are random and live ten minutes. Workspaces `ws_synthetic01`
  and `ws_synthetic02` exist; anything else is 404 `workspace_not_found`.

State lives in memory and resets on restart. The server is not a security
reference: it has no rate limits per IP, no consent hardening beyond a random
transaction id and no persistence.

## Test

```bash
pnpm nano:dev-server:test    # node --test tools/nano-dev-server/server.test.mjs
```
