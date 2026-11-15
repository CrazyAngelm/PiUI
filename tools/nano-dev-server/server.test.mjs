import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { compareSemver, isLoopbackRedirect, parseSemver, startNanoDevServer } from './server.mjs';
import { FrameReader, MAX_PAYLOAD, acceptKey, connectRaw, encodeClose, encodeText, isClientKey } from './ws.mjs';

const API = '/api/desktop/v1';
const WS = 'ws_synthetic01';
/** What the desktop sends on every request; the fixture's `minClientVersion` is 0.3.0. */
const CLIENT = 'nano-desktop/0.3.0';
const servers = [];

async function start(options = {}) {
  const server = await startNanoDevServer({ port: 0, ...options });
  servers.push(server);
  return server;
}

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

const REDIRECT = 'http://127.0.0.1:53211/callback';

function authorizeUrl(server, params = {}) {
  const url = new URL('/connect/authorize', server.origin);
  const values = {
    client_id: 'nano-desktop',
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: 'openid profile offline_access nano.desktop',
    state: 'state-1',
    code_challenge_method: 'S256',
    ...params,
  };
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return url;
}

/** Runs the authorize page and the consent decision; returns the redirect `Location` URL. */
async function consent(server, params, decision = 'approve') {
  const page = await fetch(authorizeUrl(server, params), { redirect: 'manual' });
  if (page.status === 302) return new URL(page.headers.get('location'));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Synthetic Nano development server/);
  const txn = /name="txn" value="([^"]+)"/.exec(html)[1];
  const response = await fetch(new URL('/connect/authorize', server.origin), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ txn, decision }),
  });
  assert.equal(response.status, 302);
  return new URL(response.headers.get('location'));
}

function tokenRequest(server, fields) {
  return fetch(new URL('/connect/token', server.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'nano-desktop', ...fields }),
  });
}

async function signIn(server, extra = {}) {
  const { verifier, challenge } = pkce();
  const location = await consent(server, { code_challenge: challenge, device_name: 'Test Device', ...extra });
  const code = location.searchParams.get('code');
  assert.ok(code, 'authorization code');
  const response = await tokenRequest(server, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(response.status, 200);
  return { tokens: await response.json(), code, verifier };
}

/** `init.client` overrides the `X-Nano-Client` value; `null` omits the header. */
function api(server, accessToken, path, init = {}) {
  const { client = CLIENT, headers = {}, ...rest } = init;
  return fetch(new URL(`${API}${path}`, server.origin), {
    ...rest,
    headers: { authorization: `Bearer ${accessToken}`, ...(client === null ? {} : { 'x-nano-client': client }), ...headers },
  });
}

function chat(server, accessToken, body, init = {}) {
  return api(server, accessToken, `/workspaces/${WS}/gateway/v1/chat/completions`, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('discovery', () => {
  it('serves RFC 8414 metadata for its own issuer and the meta document', async () => {
    const server = await start();
    const metadata = await (await fetch(new URL('/.well-known/oauth-authorization-server', server.origin))).json();
    assert.equal(metadata.issuer, server.origin);
    assert.equal(metadata.token_endpoint, `${server.origin}/connect/token`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    const meta = await (await fetch(new URL(`${API}/meta`, server.origin))).json();
    assert.equal(meta.apiVersion, 1);
    assert.equal(meta.clientId, 'nano-desktop');
    assert.equal(meta.capabilities.cloudLaunch, true);
    assert.equal(meta.capabilities.remoteAccess, true);
    assert.ok(meta.links.billing.startsWith(server.origin));
  });

  it('answers only for its exact loopback host', async () => {
    const server = await start();
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.port, path: `${API}/meta`, headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
  });

  it('accepts only the loopback callback as redirect URI', () => {
    assert.equal(isLoopbackRedirect('http://127.0.0.1:1234/callback'), true);
    for (const bad of [
      'http://localhost:1234/callback',
      'https://127.0.0.1:1234/callback',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:1234/other',
      'http://127.0.0.1:1234/callback?x=1',
      'http://user@127.0.0.1:1234/callback',
      'http://127.0.0.1.evil.test:1234/callback',
      'nano://callback',
    ]) {
      assert.equal(isLoopbackRedirect(bad), false, bad);
    }
  });
});

describe('authorization code with PKCE', () => {
  it('signs in: consent page, code with state and iss, token, bearer call', async () => {
    const server = await start();
    const { verifier, challenge } = pkce();
    const location = await consent(server, { code_challenge: challenge, device_name: 'Workstation' });
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get('state'), 'state-1');
    assert.equal(location.searchParams.get('iss'), server.origin);
    const response = await tokenRequest(server, {
      grant_type: 'authorization_code',
      code: location.searchParams.get('code'),
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const tokens = await response.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 600);
    assert.equal(tokens.scope, 'openid profile offline_access nano.desktop');
    assert.ok(tokens.access_token && tokens.refresh_token);
    const me = await (await api(server, tokens.access_token, '/me')).json();
    assert.equal(me.user.id, 'usr_synthetic01');
    assert.equal(me.device.name, 'Workstation');
    assert.equal(me.workspaces.length, 2);
  });

  it('rejects a wrong verifier, a different redirect URI and an unknown client', async () => {
    const server = await start();
    const { challenge } = pkce();
    let location = await consent(server, { code_challenge: challenge });
    let response = await tokenRequest(server, {
      grant_type: 'authorization_code',
      code: location.searchParams.get('code'),
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_grant');

    const flow = pkce();
    location = await consent(server, { code_challenge: flow.challenge });
    response = await tokenRequest(server, {
      grant_type: 'authorization_code',
      code: location.searchParams.get('code'),
      redirect_uri: 'http://127.0.0.1:9/callback',
      code_verifier: flow.verifier,
    });
    assert.equal((await response.json()).error, 'invalid_grant');

    response = await fetch(new URL('/connect/token', server.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'other', grant_type: 'authorization_code' }),
    });
    assert.equal((await response.json()).error, 'invalid_client');
  });

  it('refuses authorize requests without PKCE S256, state or a loopback redirect', async () => {
    const server = await start();
    const { challenge } = pkce();
    let location = await consent(server, { code_challenge: undefined });
    assert.equal(location.searchParams.get('error'), 'invalid_request');
    location = await consent(server, { code_challenge: challenge, code_challenge_method: 'plain' });
    assert.equal(location.searchParams.get('error'), 'invalid_request');
    location = await consent(server, { code_challenge: challenge, state: undefined });
    assert.equal(location.searchParams.get('error'), 'invalid_request');
    location = await consent(server, { code_challenge: challenge, scope: 'openid admin' });
    assert.equal(location.searchParams.get('error'), 'invalid_scope');
    // Never redirected: the page itself answers 400.
    for (const redirect_uri of ['https://evil.example/callback', 'http://127.0.0.1:1/other']) {
      const response = await fetch(authorizeUrl(server, { code_challenge: challenge, redirect_uri }), { redirect: 'manual' });
      assert.equal(response.status, 400);
    }
    const unknownClient = await fetch(authorizeUrl(server, { code_challenge: challenge, client_id: 'x' }), { redirect: 'manual' });
    assert.equal(unknownClient.status, 400);
  });

  it('turns a denial into access_denied with state and iss', async () => {
    const server = await start();
    const location = await consent(server, { code_challenge: pkce().challenge }, 'deny');
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('state'), 'state-1');
    assert.equal(location.searchParams.get('iss'), server.origin);
    assert.equal(location.searchParams.get('code'), null);
  });

  it('accepts a code once and revokes what a replayed code already issued', async () => {
    const server = await start();
    const { tokens, code, verifier } = await signIn(server);
    assert.equal((await api(server, tokens.access_token, '/me')).status, 200);
    const replay = await tokenRequest(server, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');
    const after = await api(server, tokens.access_token, '/me');
    assert.equal(after.status, 401);
    assert.equal((await after.json()).error.code, 'device_revoked');
  });
});

describe('refresh tokens', () => {
  it('rotates on every use and revokes the family when an old token returns', async () => {
    const server = await start();
    const { tokens } = await signIn(server);
    const first = await (await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).json();
    assert.notEqual(first.refresh_token, tokens.refresh_token);
    assert.notEqual(first.access_token, tokens.access_token);
    assert.equal((await api(server, first.access_token, '/me')).status, 200);

    const reuse = await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(reuse.status, 400);
    assert.equal((await reuse.json()).error, 'invalid_grant');

    const successor = await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: first.refresh_token });
    assert.equal((await successor.json()).error, 'invalid_grant');
    const revoked = await api(server, first.access_token, '/me');
    assert.equal((await revoked.json()).error.code, 'device_revoked');
  });

  it('rejects unknown tokens and unsupported grants', async () => {
    const server = await start();
    let response = await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: 'nope' });
    assert.equal((await response.json()).error, 'invalid_grant');
    response = await tokenRequest(server, { grant_type: 'password', username: 'a', password: 'b' });
    assert.equal((await response.json()).error, 'unsupported_grant_type');
  });

  it('revokes the family through /connect/revoke and answers 200 for unknown tokens', async () => {
    const server = await start();
    const { tokens } = await signIn(server);
    const revoke = (token) =>
      fetch(new URL('/connect/revoke', server.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'nano-desktop', token, token_type_hint: 'refresh_token' }),
      });
    assert.equal((await revoke('unknown')).status, 200);
    assert.equal((await revoke(tokens.refresh_token)).status, 200);
    const refresh = await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal((await refresh.json()).error, 'invalid_grant');
    assert.equal((await api(server, tokens.access_token, '/me')).status, 401);
  });
});

describe('bearer checks', () => {
  it('answers unauthorized without a valid bearer and token_expired after the lifetime', async () => {
    const server = await start({ accessTtlSeconds: 0.3 });
    let response = await fetch(new URL(`${API}/me`, server.origin), { headers: { 'x-nano-client': CLIENT } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: 'unauthorized', message: 'Sign in required.', retryable: false } });
    assert.equal((await api(server, 'x'.repeat(40), '/me')).status, 401);

    const { tokens } = await signIn(server);
    assert.equal(tokens.expires_in, 1);
    assert.equal((await api(server, tokens.access_token, '/me')).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    response = await api(server, tokens.access_token, '/me');
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'token_expired');
    assert.equal(body.error.retryable, true);
  });

  it('lists devices and signs one out', async () => {
    const server = await start();
    const first = (await signIn(server, { device_name: 'First' })).tokens;
    const second = (await signIn(server, { device_name: 'Second' })).tokens;
    const list = await (await api(server, first.access_token, '/devices')).json();
    assert.deepEqual(list.devices.map((device) => device.name).sort(), ['First', 'Second']);
    const target = list.devices.find((device) => device.name === 'Second');
    assert.equal((await api(server, first.access_token, `/devices/${target.id}`, { method: 'DELETE' })).status, 204);
    const revoked = await api(server, second.access_token, '/me');
    assert.equal((await revoked.json()).error.code, 'device_revoked');
    assert.equal((await api(server, first.access_token, '/me')).status, 200);
  });
});

describe('entitlements and usage', () => {
  it('reports the free and the paid plan from the fixtures', async () => {
    const free = await start({ plan: 'free' });
    const freeTokens = (await signIn(free)).tokens;
    const freeEntitlements = await (await api(free, freeTokens.access_token, `/workspaces/${WS}/entitlements`)).json();
    assert.equal(freeEntitlements.plan.kind, 'free');
    assert.deepEqual(freeEntitlements.modes.filter((mode) => mode.available).map((mode) => mode.id), ['free']);

    const paid = await start({ plan: 'paid', credits: 100 });
    const paidTokens = (await signIn(paid)).tokens;
    const paidEntitlements = await (await api(paid, paidTokens.access_token, `/workspaces/${WS}/entitlements`)).json();
    assert.equal(paidEntitlements.credits.balance, 100);
    assert.equal(paidEntitlements.modes.every((mode) => mode.available), true);
    const usage = await (await api(paid, paidTokens.access_token, `/workspaces/${WS}/usage`)).json();
    assert.equal(usage.creditsRemaining, 100);
    assert.equal(usage.byMode.length, 4);
  });

  it('locks paid modes with lockedReason credits at zero balance and rejects unknown workspaces', async () => {
    const server = await start({ plan: 'paid', credits: 0 });
    const { tokens } = await signIn(server);
    const entitlements = await (await api(server, tokens.access_token, `/workspaces/${WS}/entitlements`)).json();
    const fast = entitlements.modes.find((mode) => mode.id === 'fast');
    assert.equal(fast.available, false);
    assert.equal(fast.lockedReason, 'credits');
    assert.equal(entitlements.modes.find((mode) => mode.id === 'free').available, true);
    const missing = await api(server, tokens.access_token, '/workspaces/ws_missing/entitlements');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'workspace_not_found');
  });
});

describe('gateway', () => {
  it('lists only the entitled modes', async () => {
    const server = await start({ plan: 'free' });
    const { tokens } = await signIn(server);
    const models = await (await api(server, tokens.access_token, `/workspaces/${WS}/gateway/v1/models`)).json();
    assert.deepEqual(models.data.map((model) => model.id), ['free']);
  });

  it('answers a non-streaming completion and decrements credits', async () => {
    const server = await start({ plan: 'paid', credits: 10 });
    const { tokens } = await signIn(server);
    const response = await chat(server, tokens.access_token, { model: 'smart', messages: [{ role: 'user', content: 'hello there' }] });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'Synthetic Nano reply (smart): hello there');
    assert.ok(body.usage.total_tokens > 0);
    assert.equal(server.getCredits(), 2);
    const refused = await chat(server, tokens.access_token, { model: 'smart', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(refused.status, 402);
    assert.equal((await refused.json()).error.code, 'credits_exhausted');
    assert.equal(server.getCredits(), 2);
  });

  it('refuses a locked mode with mode_not_in_plan', async () => {
    const server = await start({ plan: 'free' });
    const { tokens } = await signIn(server);
    const response = await chat(server, tokens.access_token, { model: 'smart', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'mode_not_in_plan');
  });

  it('refuses paid modes at zero credits but keeps the free mode working', async () => {
    const server = await start({ plan: 'paid', credits: 0 });
    const { tokens } = await signIn(server);
    const fast = await chat(server, tokens.access_token, { model: 'fast', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(fast.status, 402);
    assert.deepEqual(await fast.json(), { error: { code: 'credits_exhausted', message: 'No credits left.', retryable: false } });
    const free = await chat(server, tokens.access_token, { model: 'free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(free.status, 200);
  });

  it('validates the request body and the mode id', async () => {
    const server = await start({ plan: 'paid' });
    const { tokens } = await signIn(server);
    for (const body of [{ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }] }, { model: 'free', messages: [] }, { model: 'free' }]) {
      const response = await chat(server, tokens.access_token, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid_request');
    }
  });

  it('streams OpenAI chunks, a usage chunk and [DONE] as server-sent events', async () => {
    const server = await start({ plan: 'free' });
    const { tokens } = await signIn(server);
    const response = await chat(server, tokens.access_token, {
      model: 'free',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'stream me please' }] }],
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const text = await response.text();
    const events = text.split('\n\n').filter(Boolean);
    assert.ok(events.every((event) => event.startsWith('data: ')));
    assert.equal(events.at(-1), 'data: [DONE]');
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event.slice(6)));
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.ok(chunks.every((chunk) => chunk.object === 'chat.completion.chunk'));
    const content = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('');
    assert.equal(content, 'Synthetic Nano reply (free): stream me please');
    assert.equal(chunks.find((chunk) => chunk.choices[0]?.finish_reason === 'stop') !== undefined, true);
    assert.ok(chunks.at(-1).usage.completion_tokens > 0);
    assert.deepEqual(chunks.at(-1).choices, []);
  });

  it('caps concurrent requests per device with rate_limited', async () => {
    const server = await start({ plan: 'free', streamDelayMs: 150 });
    const { tokens } = await signIn(server);
    const body = { model: 'free', stream: true, messages: [{ role: 'user', content: 'one two three four five' }] };
    const open = [chat(server, tokens.access_token, body), chat(server, tokens.access_token, body)];
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await chat(server, tokens.access_token, body);
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('retry-after'), '1');
    assert.equal((await third.json()).error.retryable, true);
    await Promise.all(open.map(async (pending) => (await pending).text()));
  });

  it('simulates an unavailable upstream and an outdated client', async () => {
    const down = await start({ plan: 'paid', scenario: 'upstream-down' });
    const downTokens = (await signIn(down)).tokens;
    const response = await chat(down, downTokens.access_token, { model: 'free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(response.status, 503);

    const old = await start({ scenario: 'client-too-old' });
    const meta = await (await fetch(new URL(`${API}/meta`, old.origin))).json();
    assert.equal(meta.minClientVersion, '99.0.0');
    const { tokens } = await signIn(old);
    const me = await api(old, tokens.access_token, '/me', { client: 'nano-desktop/98.9.9' });
    assert.equal(me.status, 426);
    assert.equal((await me.json()).error.code, 'client_too_old');
    assert.equal((await api(old, tokens.access_token, '/me', { client: 'nano-desktop/99.0.0' })).status, 200);
  });
});

describe('client version', () => {
  const tooOld = { error: { code: 'client_too_old', message: 'Update Nano Desktop.', retryable: false } };

  it('compares semver precedence', () => {
    const order = ['0.2.11', '0.3.0-alpha.1', '0.3.0-alpha.2', '0.3.0-beta', '0.3.0', '0.3.1', '0.10.0', '1.0.0+build.5'];
    for (let index = 1; index < order.length; index += 1) {
      assert.equal(compareSemver(parseSemver(order[index - 1]), parseSemver(order[index])), -1, order[index]);
      assert.equal(compareSemver(parseSemver(order[index]), parseSemver(order[index - 1])), 1, order[index]);
    }
    assert.equal(compareSemver(parseSemver('1.2.3+a'), parseSemver('1.2.3+b')), 0);
    for (const bad of ['', '1', '1.2', '01.2.3', 'v1.2.3', '1.2.3.4', '1.2.3-', 'x']) assert.equal(parseSemver(bad), null, bad);
  });

  it('answers 426 client_too_old to an older, missing or malformed X-Nano-Client on authenticated calls', async () => {
    const server = await start({ plan: 'paid', credits: 10 });
    const { tokens } = await signIn(server);
    const meta = await (await fetch(new URL(`${API}/meta`, server.origin))).json();
    assert.equal(meta.minClientVersion, '0.3.0');

    for (const client of ['nano-desktop/0.2.11', 'nano-desktop/0.3.0-beta.1', null, '', 'nano-desktop/', 'nano-desktop/abc', 'curl/8.4.0', 'other/9.9.9', 'nano-desktop/0.3.0, nano-desktop/9.0.0']) {
      const me = await api(server, tokens.access_token, '/me', { client });
      assert.equal(me.status, 426, String(client));
      assert.deepEqual(await me.json(), tooOld);
      const entitlements = await api(server, tokens.access_token, `/workspaces/${WS}/entitlements`, { client });
      assert.equal(entitlements.status, 426, String(client));
    }
    // The gateway refuses before it spends anything.
    const refused = await chat(server, tokens.access_token, { model: 'smart', messages: [{ role: 'user', content: 'x' }] }, { client: 'nano-desktop/0.2.11' });
    assert.equal(refused.status, 426);
    assert.deepEqual(await refused.json(), tooOld);
    assert.equal(server.getCredits(), 10);

    for (const client of ['nano-desktop/0.3.0', 'nano-desktop/0.3.1', 'nano-desktop/1.0.0']) {
      assert.equal((await api(server, tokens.access_token, '/me', { client })).status, 200, client);
    }
    assert.equal((await chat(server, tokens.access_token, { model: 'smart', messages: [{ role: 'user', content: 'x' }] }, { client: 'nano-desktop/0.3.1' })).status, 200);
  });

  it('leaves the public meta, the token endpoint and revocation open to an old client', async () => {
    const server = await start();
    const { tokens } = await signIn(server);
    assert.equal((await fetch(new URL(`${API}/meta`, server.origin), { headers: { 'x-nano-client': 'nano-desktop/0.1.0' } })).status, 200);
    const refresh = await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(refresh.status, 200);
    const rotated = await refresh.json();
    const revoke = await fetch(new URL('/connect/revoke', server.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-nano-client': 'nano-desktop/0.1.0' },
      body: new URLSearchParams({ client_id: 'nano-desktop', token: rotated.refresh_token, token_type_hint: 'refresh_token' }),
    });
    assert.equal(revoke.status, 200);
  });

  it('reports a missing token before the version', async () => {
    const server = await start();
    const response = await fetch(new URL(`${API}/me`, server.origin));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'unauthorized');
  });
});

describe('scopes', () => {
  const assertScopeMissing = (body) => {
    assert.equal(body.error.code, 'scope_missing');
    assert.equal(body.error.retryable, false);
  };

  it('refuses a token granted only profile on every desktop endpoint and spends nothing', async () => {
    const server = await start({ plan: 'paid', credits: 100 });
    const { tokens } = await signIn(server, { scope: 'profile' });
    assert.equal(tokens.scope, 'profile');
    const get = ['/me', '/devices', `/workspaces/${WS}/entitlements`, `/workspaces/${WS}/usage`, `/workspaces/${WS}/gateway/v1/models`];
    for (const path of get) {
      const response = await api(server, tokens.access_token, path);
      assert.equal(response.status, 403, path);
      assertScopeMissing(await response.json());
    }
    const post = [
      [`/workspaces/${WS}/cloud/launch`, {}],
      [`/workspaces/${WS}/media/dictation`, { headers: { 'content-type': 'audio/webm' }, body: Buffer.from('a') }],
      [`/workspaces/${WS}/gateway/v1/chat/completions`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: 'x' }] }) }],
    ];
    for (const [path, init] of post) {
      const response = await api(server, tokens.access_token, path, { method: 'POST', ...init });
      assert.equal(response.status, 403, path);
      assertScopeMissing(await response.json());
    }
    assert.equal((await api(server, tokens.access_token, '/devices/dev_x', { method: 'DELETE' })).status, 403);
    assert.equal(server.getCredits(), 100);
  });

  it('keeps the granted scopes through a refresh', async () => {
    const server = await start({ plan: 'paid', credits: 100 });
    const { tokens } = await signIn(server, { scope: 'openid profile offline_access' });
    const refreshed = await (await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).json();
    assert.equal(refreshed.scope, 'openid profile offline_access');
    const response = await chat(server, refreshed.access_token, { model: 'smart', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(response.status, 403);
    assertScopeMissing(await response.json());
    assert.equal(server.getCredits(), 100);
  });

  it('needs nano.desktop for the API and profile on top of it for /me', async () => {
    const server = await start({ plan: 'paid', credits: 100 });
    const { tokens } = await signIn(server, { scope: 'nano.desktop' });
    assert.equal((await api(server, tokens.access_token, `/workspaces/${WS}/entitlements`)).status, 200);
    assert.equal((await chat(server, tokens.access_token, { model: 'free', messages: [{ role: 'user', content: 'x' }] })).status, 200);
    const me = await api(server, tokens.access_token, '/me');
    assert.equal(me.status, 403);
    assertScopeMissing(await me.json());
    const full = (await signIn(server)).tokens;
    assert.equal((await api(server, full.access_token, '/me')).status, 200);
  });
});

describe('dictation and cloud', () => {
  it('transcribes a raw or multipart audio body within the plan limit', async () => {
    const paid = await start({ plan: 'paid' });
    const { tokens } = await signIn(paid);
    const url = `/workspaces/${WS}/media/dictation`;
    const raw = await api(paid, tokens.access_token, url, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('audio') });
    assert.equal(raw.status, 200);
    assert.equal((await raw.json()).text, 'Synthetic dictated text.');
    const boundary = 'xyz';
    const multipart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.webm"\r\nContent-Type: audio/webm\r\n\r\nabc\r\n--${boundary}--\r\n`);
    const form = await api(paid, tokens.access_token, url, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: multipart });
    assert.equal(form.status, 200);
    const bad = await api(paid, tokens.access_token, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 400);
  });

  it('refuses dictation on the free plan and bodies above the limit', async () => {
    const free = await start({ plan: 'free' });
    const freeTokens = (await signIn(free)).tokens;
    const denied = await api(free, freeTokens.access_token, `/workspaces/${WS}/media/dictation`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('a') });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'feature_not_in_plan');

    const paid = await start({ plan: 'paid' });
    const paidTokens = (await signIn(paid)).tokens;
    const huge = Buffer.alloc(20 * 1024 * 1024 + 1);
    const response = await api(paid, paidTokens.access_token, `/workspaces/${WS}/media/dictation`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: huge });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'payload_too_large');
  });

  it('returns a one-time launch URL of its own cloud page', async () => {
    const server = await start({ plan: 'free' });
    const { tokens } = await signIn(server);
    const launch = await (await api(server, tokens.access_token, `/workspaces/${WS}/cloud/launch`, { method: 'POST' })).json();
    assert.ok(launch.url.startsWith(`${server.origin}/cloud?code=`));
    assert.ok(Date.parse(launch.expiresAt) > Date.now());
    const first = await fetch(launch.url);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /Synthetic Nano development server/);
    assert.equal((await fetch(launch.url)).status, 400);
  });

  it('binds a launch code to its device and its workspace', async () => {
    const server = await start();
    const first = (await signIn(server, { device_name: 'First' })).tokens;
    const second = (await signIn(server, { device_name: 'Second' })).tokens;
    const launch = async (tokens, workspace) => {
      const response = await api(server, tokens.access_token, `/workspaces/${workspace}/cloud/launch`, { method: 'POST' });
      assert.equal(response.status, 200);
      return (await response.json()).url;
    };
    const firstUrl = await launch(first, WS);
    const secondUrl = await launch(second, 'ws_synthetic02');

    // Signing the first device out ends what it launched; the other device is unaffected.
    const devices = await (await api(server, second.access_token, '/devices')).json();
    const target = devices.devices.find((device) => device.name === 'First');
    assert.equal((await api(server, second.access_token, `/devices/${target.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(firstUrl)).status, 400);
    const accepted = await fetch(secondUrl);
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /signed in to Team/);
  });

  it('refuses a launch code whose device was revoked by refresh-token reuse or whose workspace is gone', async () => {
    const server = await start();
    const { tokens } = await signIn(server);
    const launch = async (workspace) => (await (await api(server, tokens.access_token, `/workspaces/${workspace}/cloud/launch`, { method: 'POST' })).json()).url;
    const reused = await launch(WS);
    const removed = await launch('ws_synthetic02');
    const kept = await launch(WS);
    assert.match(await (await fetch(kept)).text(), /signed in to Personal/);

    server.removeWorkspace('ws_synthetic02');
    assert.equal((await fetch(removed)).status, 400);
    const gone = await api(server, tokens.access_token, '/workspaces/ws_synthetic02/cloud/launch', { method: 'POST' });
    assert.equal(gone.status, 404);

    // A refresh token coming back revokes the family, and the code of that device with it.
    await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    const reuse = await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(reuse.status, 400);
    assert.equal((await fetch(reused)).status, 400);
  });
});

// ------------------------------------------------------------------ remote access (ADR-062)

const LINK_PATH = `${API}/remote/link`;
const PROTOCOL = 'nano-remote.v1';
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens the desktop link; `ws` is null when the server refused the upgrade. */
function openLink(server, accessToken, { client = CLIENT, headers = {}, protocols = [PROTOCOL] } = {}) {
  const auth = accessToken === null ? {} : { authorization: `Bearer ${accessToken}` };
  return connectRaw(new URL(LINK_PATH, server.origin).toString(), { ...auth, ...(client === null ? {} : { 'x-nano-client': client }), ...headers }, protocols);
}

function openViewer(server, deviceId, { headers = {}, protocols = [PROTOCOL] } = {}) {
  return connectRaw(new URL(`/api/hermes/remote/devices/${deviceId}/socket`, server.origin).toString(), headers, protocols);
}

async function deviceOf(server, accessToken) {
  return (await (await api(server, accessToken, '/me')).json()).device.id;
}

/** A signed-in device whose link is open and has read its `hello`. */
async function linkedDevice(server, name = 'Laptop') {
  const { tokens } = await signIn(server, { device_name: name });
  const deviceId = await deviceOf(server, tokens.access_token);
  const opened = await openLink(server, tokens.access_token);
  assert.equal(opened.status, 101);
  assert.deepEqual(await opened.ws.nextJson(), { t: 'hello', device: deviceId, maxFrame: 262144, maxViewers: 2 });
  return { tokens, deviceId, link: opened.ws };
}

/** A browser on the device that has read its `ready`; the link has read `viewer-open`. */
async function viewerOn(server, device) {
  const opened = await openViewer(server, device.deviceId);
  assert.equal(opened.status, 101);
  const ready = await opened.ws.nextJson();
  assert.equal(ready.t, 'ready');
  assert.match(ready.viewer, /^vw_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(await device.link.nextJson(), { t: 'viewer-open', viewer: ready.viewer });
  return { ws: opened.ws, viewer: ready.viewer, ready };
}

function maskedFrame(fin, opcode, payload) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload).map((byte, index) => byte ^ mask[index % 4]);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]), mask, body]);
}

describe('WebSocket subset', () => {
  it('computes the RFC 6455 accept key', () => {
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    assert.equal(isClientKey('dGhlIHNhbXBsZSBub25jZQ=='), true);
    assert.equal(isClientKey('short'), false);
  });

  it('reads masked, fragmented and control frames, also split across chunks', () => {
    const reader = new FrameReader({ expectMasked: true });
    const bytes = Buffer.concat([maskedFrame(false, 1, 'hel'), maskedFrame(true, 9, 'p'), maskedFrame(true, 0, 'lo'), encodeText('é', true)]);
    const events = [];
    for (const byte of bytes) events.push(...reader.push(Buffer.from([byte])));
    assert.deepEqual(
      events.map((event) => [event.type, event.text ?? event.data?.toString()]),
      [['ping', 'p'], ['text', 'hello'], ['text', 'é']],
    );
  });

  it('fails on unmasked client frames, invalid UTF-8, reserved bits and oversize payloads', () => {
    assert.deepEqual(new FrameReader({ expectMasked: true }).push(encodeText('x', false)), [{ type: 'error', code: 1002 }]);
    assert.deepEqual(new FrameReader({ expectMasked: false }).push(encodeText('x', true)), [{ type: 'error', code: 1002 }]);
    assert.deepEqual(new FrameReader({ expectMasked: true }).push(maskedFrame(true, 1, [0xff, 0xfe])), [{ type: 'error', code: 1007 }]);
    const reserved = maskedFrame(true, 1, 'x');
    reserved[0] |= 0x40;
    assert.deepEqual(new FrameReader({ expectMasked: true }).push(reserved), [{ type: 'error', code: 1002 }]);
    assert.deepEqual(new FrameReader({ expectMasked: true, maxPayload: 10 }).push(encodeText('x'.repeat(11), true)), [{ type: 'error', code: 1009 }]);
    const reader = new FrameReader({ expectMasked: true });
    assert.equal(reader.push(encodeText('x'.repeat(MAX_PAYLOAD), true))[0].text.length, MAX_PAYLOAD);
    assert.deepEqual(reader.push(encodeText('x'.repeat(MAX_PAYLOAD + 1), true)), [{ type: 'error', code: 1009 }]);
    assert.deepEqual(reader.push(encodeText('y', true)), [], 'a failed reader ignores input');
  });

  it('encodes close frames with their code and reason', () => {
    const [event] = new FrameReader({ expectMasked: false }).push(encodeClose(4403, 'kicked'));
    assert.deepEqual(event, { type: 'close', code: 4403, reason: 'kicked' });
  });
});

describe('remote link', () => {
  it('advertises the capability and turns it off in the remote-off scenario', async () => {
    const on = await start();
    assert.equal((await (await fetch(new URL(`${API}/meta`, on.origin))).json()).capabilities.remoteAccess, true);
    const off = await start({ scenario: 'remote-off' });
    assert.equal((await (await fetch(new URL(`${API}/meta`, off.origin))).json()).capabilities.remoteAccess, false);
  });

  it('checks the bearer, the client version and the scope before the upgrade', async () => {
    const server = await start();
    const anonymous = await openLink(server, null);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'unauthorized');
    const garbage = await openLink(server, 'x'.repeat(40));
    assert.equal(garbage.status, 401);

    const { tokens } = await signIn(server);
    for (const client of ['nano-desktop/0.2.9', 'other/1.0.0', null]) {
      const old = await openLink(server, tokens.access_token, { client });
      assert.equal(old.status, 426, String(client));
      assert.equal(old.body.error.code, 'client_too_old');
    }
    const profileOnly = (await signIn(server, { scope: 'profile' })).tokens;
    const scoped = await openLink(server, profileOnly.access_token);
    assert.equal(scoped.status, 403);
    assert.equal(scoped.body.error.code, 'scope_missing');
  });

  it('requires a well-formed upgrade offering the nano-remote.v1 subprotocol', async () => {
    const server = await start();
    const { tokens } = await signIn(server);
    const without = await openLink(server, tokens.access_token, { protocols: [] });
    assert.equal(without.status, 400);
    assert.equal(without.body.error.code, 'invalid_request');
    assert.equal((await openLink(server, tokens.access_token, { protocols: ['other.v1'] })).status, 400);
    const opened = await openLink(server, tokens.access_token, { protocols: ['other.v1', PROTOCOL] });
    assert.equal(opened.status, 101);
    assert.equal(opened.headers['sec-websocket-protocol'], PROTOCOL);
    opened.ws.close();
    const badVersion = await openLink(server, tokens.access_token, { headers: { 'sec-websocket-version': '8' } });
    assert.equal(badVersion.status, 400);
  });

  it('answers 403 feature_not_in_plan and 503 for the scenarios that switch it off', async () => {
    const off = await start({ scenario: 'remote-off' });
    const { tokens } = await signIn(off);
    const refused = await openLink(off, tokens.access_token);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'feature_not_in_plan');
    const viewer = await openViewer(off, 'dev_anything');
    assert.equal(viewer.status, 403);
    assert.equal((await fetch(new URL('/api/hermes/remote/devices', off.origin))).status, 403);

    const down = await start({ scenario: 'upstream-down' });
    const second = (await signIn(down)).tokens;
    const unavailable = await openLink(down, second.access_token);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.retryable, true);
  });

  it('relays both ways, announces viewers and reports a closed browser', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const first = await viewerOn(server, device);
    assert.deepEqual(first.ready.device, { id: device.deviceId, name: 'Laptop' });

    first.ws.sendText(JSON.stringify({ t: 'msg', d: { k: 'hello', proto: 1, key: 'a', label: 'Chrome · Android' } }));
    assert.deepEqual(await device.link.nextJson(), { t: 'msg', viewer: first.viewer, d: { k: 'hello', proto: 1, key: 'a', label: 'Chrome · Android' } });
    device.link.sendText(JSON.stringify({ t: 'msg', viewer: first.viewer, d: { k: 'challenge', nonce: 'n' } }));
    assert.deepEqual(await first.ws.nextJson(), { t: 'msg', d: { k: 'challenge', nonce: 'n' } });

    // A message for a viewer that is gone, or for someone else's, goes nowhere and keeps the link.
    device.link.sendText(JSON.stringify({ t: 'msg', viewer: 'vw_unknown0000000000000000', d: { k: 'x' } }));
    first.ws.close(1000);
    assert.deepEqual(await device.link.nextJson(), { t: 'viewer-close', viewer: first.viewer });
    assert.equal(device.link.open, true);
  });

  it('closes a browser the device drops with 4403 and the reason, without echoing viewer-close', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const first = await viewerOn(server, device);
    device.link.sendText(JSON.stringify({ t: 'drop', viewer: first.viewer, reason: 'kicked' }));
    assert.deepEqual(await first.ws.closed(), { code: 4403, reason: 'kicked' });
    const second = await viewerOn(server, device);
    assert.notEqual(second.viewer, first.viewer);
    device.link.sendText(JSON.stringify({ t: 'drop', viewer: 'vw_unknown0000000000000000', reason: 'denied' }));
    device.link.sendText(JSON.stringify({ t: 'drop', viewer: second.viewer, reason: 'protocol' }));
    assert.deepEqual(await second.ws.closed(), { code: 4403, reason: 'protocol' });
    assert.equal(device.link.open, true);
  });

  it('closes a link that drops with an unknown reason, sends invalid JSON, binary or an unknown t', async () => {
    const server = await start();
    for (const send of [
      (ws) => ws.sendText(JSON.stringify({ t: 'drop', viewer: 'vw_x', reason: 'because' })),
      (ws) => ws.sendText('not json'),
      (ws) => ws.sendText(JSON.stringify({ t: 'msg', viewer: 'vw_x', d: 'not an object' })),
      (ws) => ws.sendText(JSON.stringify({ t: 'ping', viewer: 'vw_x' })),
      (ws) => ws.sendText(JSON.stringify({ t: 'msg', d: {} })),
      (ws) => ws.sendBinary(Buffer.from([1, 2, 3])),
    ]) {
      const device = await linkedDevice(server);
      send(device.link);
      assert.deepEqual((await device.link.closed()).code, 4400);
    }
  });

  it('closes a browser that sends anything but a msg envelope with 4400', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    for (const send of [(ws) => ws.sendText('nope'), (ws) => ws.sendText(JSON.stringify({ t: 'drop' })), (ws) => ws.sendText(JSON.stringify({ t: 'msg', d: [] })), (ws) => ws.sendBinary(Buffer.alloc(1))]) {
      const browser = await viewerOn(server, device);
      send(browser.ws);
      assert.equal((await browser.ws.closed()).code, 4400);
      assert.deepEqual(await device.link.nextJson(), { t: 'viewer-close', viewer: browser.viewer });
    }
  });

  it('closes a browser of an offline or unknown device with 4404', async () => {
    const server = await start();
    const { tokens } = await signIn(server);
    const deviceId = await deviceOf(server, tokens.access_token);
    for (const id of [deviceId, 'dev_unknown']) {
      const browser = await openViewer(server, id);
      assert.equal(browser.status, 101);
      assert.deepEqual(await browser.ws.closed(), { code: 4404, reason: 'device-offline' });
    }
  });

  it('closes a third browser of a device with 4429 and never tells the device', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const first = await viewerOn(server, device);
    await viewerOn(server, device);
    const third = await openViewer(server, device.deviceId);
    assert.equal(third.status, 101);
    assert.deepEqual(await third.ws.closed(), { code: 4429, reason: 'limit' });
    first.ws.close(1000);
    assert.deepEqual(await device.link.nextJson(), { t: 'viewer-close', viewer: first.viewer });
    const again = await viewerOn(server, device);
    assert.equal(again.ready.t, 'ready');
  });

  it('allows four browsers per user across devices', async () => {
    const server = await start();
    const devices = [await linkedDevice(server, 'A'), await linkedDevice(server, 'B'), await linkedDevice(server, 'C')];
    await viewerOn(server, devices[0]);
    await viewerOn(server, devices[0]);
    await viewerOn(server, devices[1]);
    await viewerOn(server, devices[1]);
    const fifth = await openViewer(server, devices[2].deviceId);
    assert.deepEqual(await fifth.ws.closed(), { code: 4429, reason: 'limit' });
  });

  it('limits a browser to 600 messages a minute', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const browser = await viewerOn(server, device);
    for (let index = 0; index < 601; index += 1) browser.ws.sendText(JSON.stringify({ t: 'msg', d: { n: index } }));
    assert.deepEqual(await browser.ws.closed(), { code: 4429, reason: 'rate' });
    let relayed = 0;
    for (;;) {
      const frame = await device.link.nextJson(5000);
      if (frame.t === 'viewer-close') break;
      assert.equal(frame.t, 'msg');
      relayed += 1;
    }
    assert.equal(relayed, 600);
  });

  it('closes everything on the device with 4401 when it is signed out', async () => {
    const server = await start();
    const keeper = await linkedDevice(server, 'Keeper');
    const target = await linkedDevice(server, 'Target');
    const browser = await viewerOn(server, target);
    const response = await api(server, keeper.tokens.access_token, `/devices/${target.deviceId}`, { method: 'DELETE' });
    assert.equal(response.status, 204);
    assert.deepEqual(await target.link.closed(), { code: 4401, reason: 'authorization-ended' });
    assert.deepEqual(await browser.ws.closed(), { code: 4401, reason: 'authorization-ended' });
    assert.equal(keeper.link.open, true);
    const again = await openLink(server, target.tokens.access_token);
    assert.equal(again.status, 401);
    assert.equal(again.body.error.code, 'device_revoked');
  });

  it('closes everything when a reused refresh token revokes the family', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const browser = await viewerOn(server, device);
    await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: device.tokens.refresh_token });
    await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: device.tokens.refresh_token });
    assert.equal((await device.link.closed()).code, 4401);
    assert.equal((await browser.ws.closed()).code, 4401);
  });

  it('replaces an older link of the same device with 4409 and ends its browsers', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const browser = await viewerOn(server, device);
    const next = await openLink(server, device.tokens.access_token);
    assert.equal(next.status, 101);
    assert.equal((await next.ws.nextJson()).t, 'hello');
    assert.deepEqual(await device.link.closed(), { code: 4409, reason: 'replaced' });
    assert.deepEqual(await browser.ws.closed(), { code: 4404, reason: 'device-offline' });
    const fresh = await openViewer(server, device.deviceId);
    assert.equal((await fresh.ws.nextJson()).t, 'ready');
    assert.equal((await next.ws.nextJson()).t, 'viewer-open');
  });

  it('ends the browsers when the link closes', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const browser = await viewerOn(server, device);
    device.link.close(1000);
    assert.deepEqual(await browser.ws.closed(), { code: 4404, reason: 'device-offline' });
    const list = await (await fetch(new URL('/api/hermes/remote/devices', server.origin))).json();
    assert.equal(list.devices.find((entry) => entry.id === device.deviceId).online, false);
  });

  it('closes frames above 262144 bytes with 1009 on both sides', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const browser = await viewerOn(server, device);
    browser.ws.sendText('x'.repeat(MAX_PAYLOAD + 1));
    assert.equal((await browser.ws.closed()).code, 1009);
    device.link.sendText('x'.repeat(MAX_PAYLOAD + 1));
    assert.equal((await device.link.closed()).code, 1009);
  });

  it('relays a large frame below the cap unchanged', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const browser = await viewerOn(server, device);
    const filler = 'a'.repeat(200_000);
    browser.ws.sendText(JSON.stringify({ t: 'msg', d: { p: filler } }));
    const relayed = await device.link.nextJson(5000);
    assert.equal(relayed.viewer, browser.viewer);
    assert.equal(relayed.d.p, filler);
  });

  it('pings, closes 4408 when nothing answers, and keeps a link that does', async () => {
    const server = await start({ pingIntervalMs: 60, pongTimeoutMs: 60 });
    const alive = await linkedDevice(server, 'Alive');
    const silent = await linkedDevice(server, 'Silent');
    silent.link.autoPong = false;
    assert.deepEqual(await silent.link.closed(3000), { code: 4408, reason: 'keepalive' });
    await settle(250);
    assert.equal(alive.link.open, true);
  });

  it('accepts a browser only from the server origin and not from a cross-site page', async () => {
    const server = await start();
    const device = await linkedDevice(server);
    const foreign = await openViewer(server, device.deviceId, { headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    const crossSite = await openViewer(server, device.deviceId, { headers: { origin: server.origin, 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const same = await openViewer(server, device.deviceId, { headers: { origin: server.origin, 'sec-fetch-site': 'same-origin' } });
    assert.equal(same.status, 101);
    const noSubprotocol = await openViewer(server, device.deviceId, { protocols: [] });
    assert.equal(noSubprotocol.status, 400);
    const rebinding = await openViewer(server, device.deviceId, { headers: { host: 'evil.example' } });
    assert.equal(rebinding.status, 400);
  });

  it('lists the active devices with their presence and client version', async () => {
    const server = await start();
    const online = await linkedDevice(server, 'Online');
    const idle = (await signIn(server, { device_name: 'Idle' })).tokens;
    const idleId = await deviceOf(server, idle.access_token);
    const list = (await (await fetch(new URL('/api/hermes/remote/devices', server.origin))).json()).devices;
    const byId = Object.fromEntries(list.map((entry) => [entry.id, entry]));
    assert.deepEqual(Object.keys(byId[online.deviceId]).sort(), ['appVersion', 'id', 'lastSeenAt', 'name', 'online', 'platform']);
    assert.equal(byId[online.deviceId].online, true);
    assert.equal(byId[online.deviceId].appVersion, '0.3.0');
    assert.equal(byId[idleId].online, false);
    assert.equal(byId[idleId].appVersion, null);
  });

  it('never prints a frame body or a token in its log', async () => {
    const lines = [];
    const server = await start({ log: (line) => lines.push(line) });
    const device = await linkedDevice(server);
    const browser = await viewerOn(server, device);
    browser.ws.sendText(JSON.stringify({ t: 'msg', d: { secret: 'SECRET-CHAT-TEXT' } }));
    await device.link.nextJson();
    const text = lines.join('\n');
    assert.match(text, /UPGRADE \/api\/desktop\/v1\/remote\/link/);
    assert.doesNotMatch(text, /SECRET-CHAT-TEXT/);
    assert.doesNotMatch(text, new RegExp(device.tokens.access_token));
  });
});

describe('remote UI hosting', () => {
  const directories = [];
  const makeUi = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-remote-ui-'));
    directories.push(root);
    const ui = path.join(root, 'ui');
    fs.mkdirSync(path.join(ui, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>Remote</title>');
    fs.writeFileSync(path.join(ui, 'app.js'), 'export const x = 1;');
    fs.writeFileSync(path.join(ui, 'sub', 'style.css'), 'body{}');
    fs.writeFileSync(path.join(ui, 'data.bin'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(root, 'secret.txt'), 'outside');
    return ui;
  };
  after(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  /** A raw GET that keeps the path exactly as given (fetch would normalize `..`). */
  const rawGet = (server, rawPath, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.port, path: rawPath, method }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });

  it('serves the directory read-only with MIME types', async () => {
    const server = await start({ remoteUiDir: makeUi() });
    const index = await rawGet(server, '/remote/');
    assert.equal(index.status, 200);
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(index.body, /<title>Remote<\/title>/);
    assert.equal((await rawGet(server, '/remote/index.html')).status, 200);
    assert.equal((await rawGet(server, '/remote/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await rawGet(server, '/remote/sub/style.css')).headers['content-type'], 'text/css; charset=utf-8');
    assert.equal((await rawGet(server, '/remote/data.bin')).headers['content-type'], 'application/octet-stream');
    const head = await rawGet(server, '/remote/app.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '19');
    assert.equal(head.body, '');
    assert.equal((await rawGet(server, '/remote')).status, 302);
    assert.equal((await rawGet(server, '/remote/missing.js')).status, 404);
    assert.equal((await rawGet(server, '/remote/sub')).status, 404);
  });

  it('refuses traversal, backslashes and writes', async () => {
    const server = await start({ remoteUiDir: makeUi() });
    for (const rawPath of ['/remote/../secret.txt', '/remote/%2e%2e/secret.txt', '/remote/..%2fsecret.txt', '/remote/sub/../../secret.txt', '/remote/..%5csecret.txt', '/remote/%00', '/remote//etc/passwd']) {
      const response = await rawGet(server, rawPath);
      assert.notEqual(response.status, 200, rawPath);
      assert.doesNotMatch(response.body, /outside/, rawPath);
    }
    const post = await fetch(new URL('/remote/app.js', server.origin), { method: 'POST', body: 'x' });
    assert.equal(post.status, 404);
  });

  it('serves nothing without a directory and lists linked devices on the lab page', async () => {
    const bare = await start();
    assert.equal((await rawGet(bare, '/remote/index.html')).status, 404);
    const lab = await rawGet(bare, '/remote-lab');
    assert.equal(lab.status, 200);
    assert.match(lab.body, /Synthetic Nano development server/);
    assert.match(lab.body, /--remote-ui/);
    assert.match(lab.body, /No device is linked/);

    const server = await start({ remoteUiDir: makeUi() });
    const device = await linkedDevice(server, 'Lab <b>Laptop</b>');
    const page = await rawGet(server, '/remote-lab');
    assert.match(page.body, new RegExp(`href="/remote/index.html#device=${device.deviceId}&amp;lang=en&amp;theme=system"`));
    assert.match(page.body, /Lab &lt;b&gt;Laptop&lt;\/b&gt;/);
    assert.doesNotMatch(page.body, /<b>Laptop/);
    assert.doesNotMatch(page.body, /No device is linked/);
  });

  it('refuses a remote UI directory that does not exist', async () => {
    await assert.rejects(() => startNanoDevServer({ port: 0, remoteUiDir: path.join(os.tmpdir(), 'nano-remote-ui-missing-dir') }), /not a directory/);
  });
});
