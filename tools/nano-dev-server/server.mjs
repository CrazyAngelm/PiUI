#!/usr/bin/env node
// Synthetic Nano development server (docs/NANO_DESKTOP.md, docs/NANO_DESKTOP_API.md).
//
// Implements contracts/nano-server-v1.ts with the values of
// contracts/fixtures/nano-server-v1.json so the desktop host and its E2E tests
// can sign in, read entitlements and stream replies without the real Nano
// service. Every value is synthetic; no model is ever called.
//
// Zero dependencies, Node >= 22, binds 127.0.0.1 only, never logs tokens,
// codes, verifiers or request/response bodies.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_PAYLOAD, WsPeer, acceptKey, isClientKey } from './ws.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../contracts/fixtures/nano-server-v1.json', import.meta.url), 'utf8'));

const CLIENT_ID = 'nano-desktop';
const SCOPES = ['openid', 'profile', 'offline_access', 'nano.desktop'];
/** Scopes a token needs per desktop API endpoint (docs/NANO_DESKTOP_API.md section 4). */
const DESKTOP_SCOPE = 'nano.desktop';
const requiredScopes = (rest) => (rest === '/me' ? [DESKTOP_SCOPE, 'profile'] : [DESKTOP_SCOPE]);
const API = '/api/desktop/v1';
const MODE_IDS = ['auto', 'free', 'fast', 'smart'];
/** Synthetic credit cost of one gateway request per mode. */
const MODE_COST = { free: 0, fast: 1, auto: 2, smart: 8 };
const CODE_TTL_MS = 60_000;
const TXN_TTL_MS = 10 * 60_000;
const CLOUD_CODE_TTL_MS = 60_000;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const FORM_LIMIT = 64 * 1024;

// Remote access (ADR-062, docs/NANO_DESKTOP_API.md section 4.9).
const REMOTE_SUBPROTOCOL = 'nano-remote.v1';
const REMOTE_LINK_PATH = `${API}/remote/link`;
const REMOTE_VIEWER_PATH = /^\/api\/hermes\/remote\/devices\/([A-Za-z0-9_-]{1,64})\/socket$/;
const MAX_VIEWERS_PER_DEVICE = 2;
const MAX_VIEWERS_PER_USER = 4;
const VIEWER_MESSAGES_PER_MINUTE = 600;
const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;
const DROP_REASONS = new Set(['denied', 'kicked', 'disabled', 'protocol']);
const REMOTE_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};
const STATUS_PHRASE = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 500: 'Internal Server Error', 503: 'Service Unavailable' };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  token_expired: 401,
  device_revoked: 401,
  scope_missing: 403,
  mode_not_in_plan: 403,
  feature_not_in_plan: 403,
  desktop_local_disabled: 403,
  credits_exhausted: 402,
  subscription_expired: 402,
  workspace_not_found: 404,
  payload_too_large: 413,
  client_too_old: 426,
  rate_limited: 429,
  upstream_unavailable: 503,
  internal: 500,
};
const RETRYABLE = new Set(['token_expired', 'rate_limited', 'upstream_unavailable', 'internal']);

const clone = (value) => JSON.parse(JSON.stringify(value));
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeEqual(a, b) {
  const x = sha256(String(a));
  const y = sha256(String(b));
  return crypto.timingSafeEqual(x, y);
}

function apiError(code, message, extra = {}) {
  return { __nano: true, status: ERROR_STATUS[code] ?? 500, code, message, retryable: RETRYABLE.has(code), ...extra };
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `{ core, pre }` of a semver string, or `null`. */
export function parseSemver(value) {
  const match = SEMVER.exec(String(value).trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/** Semver precedence: -1, 0 or 1; a pre-release is older than its release. */
export function compareSemver(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** The version in `X-Nano-Client: nano-desktop/<semver>`, or `null` when missing or malformed. */
function clientVersion(req) {
  const value = String(req.headers['x-nano-client'] ?? '');
  if (value.length > 128 || !value.startsWith(`${CLIENT_ID}/`)) return null;
  return parseSemver(value.slice(CLIENT_ID.length + 1));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** `http://127.0.0.1:<port>/callback`, nothing else (RFC 8252 section 7.3). */
export function isLoopbackRedirect(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.port !== '' &&
    Number(url.port) >= 1 &&
    Number(url.port) <= 65535 &&
    url.pathname === '/callback' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    value === `http://127.0.0.1:${url.port}/callback`
  );
}

/** The real path of the directory `--remote-ui` serves; fails early when it is not one. */
function remoteUiRoot(dir) {
  try {
    const root = fs.realpathSync(path.resolve(dir));
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw new Error(`--remote-ui ${dir} is not a directory.`);
  }
}

function normalizeOptions(options) {
  const plan = options.plan === 'paid' ? 'paid' : 'free';
  const defaultCredits = plan === 'paid' ? FIXTURE.entitlementsPaid.credits.balance : FIXTURE.entitlementsFree.credits.balance;
  const credits = Number.isFinite(options.credits) ? Math.max(0, Math.floor(options.credits)) : defaultCredits;
  const port = Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535 ? options.port : 8787;
  const accessTtlSeconds = Number.isFinite(options.accessTtlSeconds) && options.accessTtlSeconds > 0 ? options.accessTtlSeconds : 600;
  const scenario = ['default', 'client-too-old', 'upstream-down', 'remote-off'].includes(options.scenario) ? options.scenario : 'default';
  const streamDelayMs = Number.isFinite(options.streamDelayMs) && options.streamDelayMs > 0 ? options.streamDelayMs : 0;
  const remoteUiDir = typeof options.remoteUiDir === 'string' && options.remoteUiDir !== '' ? options.remoteUiDir : null;
  const pingIntervalMs = Number.isFinite(options.pingIntervalMs) && options.pingIntervalMs > 0 ? options.pingIntervalMs : 25_000;
  const pongTimeoutMs = Number.isFinite(options.pongTimeoutMs) && options.pongTimeoutMs > 0 ? options.pongTimeoutMs : 20_000;
  return {
    plan,
    credits,
    port,
    accessTtlSeconds,
    scenario,
    streamDelayMs,
    remoteUiDir,
    pingIntervalMs,
    pongTimeoutMs,
    log: typeof options.log === 'function' ? options.log : null,
  };
}

/**
 * Start the synthetic server.
 * @param {{ port?: number, plan?: 'free'|'paid', credits?: number, scenario?: 'default'|'client-too-old'|'upstream-down'|'remote-off',
 *           accessTtlSeconds?: number, streamDelayMs?: number, remoteUiDir?: string, pingIntervalMs?: number,
 *           pongTimeoutMs?: number, log?: (line: string) => void }} [options]
 */
export async function startNanoDevServer(options = {}) {
  const cfg = normalizeOptions(options);
  let origin = '';
  let plan = cfg.plan;
  let credits = cfg.credits;
  const usageByMode = new Map(MODE_IDS.map((id) => [id, { credits: 0, requests: 0 }]));
  let usageDeltaUsed = 0;

  /** access token -> { familyId, expiresAt, scopes }. Expired entries stay to answer `token_expired`. */
  const accessTokens = new Map();
  /** sha256(refresh token) hex -> { familyId, used, expiresAt } */
  const refreshTokens = new Map();
  /** familyId -> { id, deviceId, revoked, scope } */
  const families = new Map();
  /** deviceId -> NanoDeviceV1 */
  const devices = new Map();
  const authCodes = new Map();
  const transactions = new Map();
  const cloudCodes = new Map();
  const inflight = new Map();
  /** The caller's workspaces (the fixture's, minus those removed by `removeWorkspace`). */
  const workspaces = clone(FIXTURE.me.workspaces);
  /** deviceId -> { peer, familyId, viewers: Set<viewerId> }: the desktop links. */
  const links = new Map();
  /** viewerId -> { peer, deviceId, window }: the synthetic browsers. */
  const viewers = new Map();
  /** deviceId -> the `X-Nano-Client` version of its latest link. */
  const linkVersions = new Map();
  /** Every upgraded socket, so `close()` can end them (they leave the HTTP server's tracking). */
  const peers = new Set();
  const remoteRoot = cfg.remoteUiDir ? remoteUiRoot(cfg.remoteUiDir) : null;

  const now = () => Date.now();
  const iso = (ms = now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // ---------------------------------------------------------------- state views

  function baseEntitlements(workspaceId) {
    const entitlements = clone(plan === 'paid' ? FIXTURE.entitlementsPaid : FIXTURE.entitlementsFree);
    entitlements.workspaceId = workspaceId;
    entitlements.credits.balance = credits;
    if (plan === 'paid' && credits <= 0) {
      for (const mode of entitlements.modes) {
        if (mode.tier !== 'free') {
          mode.available = false;
          mode.lockedReason = 'credits';
        }
      }
    }
    return entitlements;
  }

  function modeRow(entitlements, id) {
    return entitlements.modes.find((mode) => mode.id === id);
  }

  function usageView(workspaceId) {
    const base = clone(FIXTURE.usage);
    const paid = plan === 'paid';
    const byMode = MODE_IDS.map((id) => {
      const baseRow = paid ? base.byMode.find((row) => row.mode === id) : null;
      const delta = usageByMode.get(id);
      return { mode: id, credits: (baseRow?.credits ?? 0) + delta.credits, requests: (baseRow?.requests ?? 0) + delta.requests };
    });
    return {
      workspaceId,
      periodStart: base.periodStart,
      periodEnd: base.periodEnd,
      creditsUsed: (paid ? base.creditsUsed : 0) + usageDeltaUsed,
      creditsRemaining: credits,
      byMode,
    };
  }

  function workspaceFor(id) {
    const row = workspaces.find((workspace) => workspace.id === id);
    if (!row) throw apiError('workspace_not_found', 'Workspace not found.');
    return row;
  }

  // ---------------------------------------------------------------- http helpers

  function sendJson(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(text);
  }

  function sendApiError(res, error) {
    const headers = {};
    if (error.retryAfter) headers['retry-after'] = String(error.retryAfter);
    sendJson(res, error.status, { error: { code: error.code, message: error.message, retryable: error.retryable } }, headers);
  }

  function sendTokenError(res, error, description, status = 400) {
    sendJson(res, status, { error, error_description: description }, { pragma: 'no-cache' });
  }

  function sendHtml(res, status, title, body) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1f}h1{font-size:1.25rem}.badge{display:inline-block;background:#fde68a;color:#451a03;padding:.15rem .5rem;border-radius:.25rem;font-weight:600}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem;cursor:pointer}dl{margin:1rem 0}dt{font-weight:600}dd{margin:0 0 .5rem}</style></head><body><p class="badge">Synthetic Nano development server</p>${body}</body></html>`;
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  }

  function redirect(res, location) {
    res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-length': 0 });
    res.end();
  }

  async function readBody(req, limit) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw apiError('payload_too_large', 'Body too large.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw apiError('payload_too_large', 'Body too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readForm(req) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') throw apiError('invalid_request', 'Expected application/x-www-form-urlencoded.');
    return new URLSearchParams((await readBody(req, FORM_LIMIT)).toString('utf8'));
  }

  // ---------------------------------------------------------------- tokens

  function newFamily(deviceName, scope) {
    const device = {
      id: `dev_${token(9)}`,
      name: deviceName || 'Nano Desktop',
      createdAt: iso(),
      lastSeenAt: null,
    };
    const family = { id: token(12), deviceId: device.id, revoked: false, scope };
    devices.set(device.id, device);
    families.set(family.id, family);
    return family;
  }

  function issueTokens(family) {
    const access = token(32);
    const refresh = token(32);
    const ttlMs = cfg.accessTtlSeconds * 1000;
    accessTokens.set(access, { familyId: family.id, expiresAt: now() + ttlMs, scopes: new Set(family.scope.split(' ')) });
    refreshTokens.set(sha256(refresh).toString('hex'), { familyId: family.id, used: false, expiresAt: now() + REFRESH_TTL_MS });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.round(cfg.accessTtlSeconds)),
      refresh_token: refresh,
      scope: family.scope,
    };
  }

  function revokeFamily(familyId) {
    const family = families.get(familyId);
    if (!family) return;
    family.revoked = true;
    // A signed-out device loses its remote link and every browser on it at once.
    const link = links.get(family.deviceId);
    if (link) endLink(family.deviceId, link, 4401, 'authorization-ended', 4401, 'authorization-ended');
  }

  /** `meta.minClientVersion`; the `client-too-old` scenario raises it above every real release. */
  const minClientVersion = () => (cfg.scenario === 'client-too-old' ? '99.0.0' : FIXTURE.meta.minClientVersion);

  /**
   * Bearer, family, lifetime, then the client version (`426`; a missing or
   * malformed `X-Nano-Client` counts as too old) and the scopes the endpoint
   * needs (`403 scope_missing`), all before anything is dispatched.
   */
  function authenticate(req, required) {
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization ?? ''));
    if (!match) throw apiError('unauthorized', 'Sign in required.');
    const entry = accessTokens.get(match[1]);
    if (!entry) throw apiError('unauthorized', 'Sign in required.');
    const family = families.get(entry.familyId);
    if (!family || family.revoked) throw apiError('device_revoked', 'This device was signed out.');
    if (entry.expiresAt <= now()) throw apiError('token_expired', 'Access token expired.');
    const client = clientVersion(req);
    if (!client || compareSemver(client, parseSemver(minClientVersion())) < 0) throw apiError('client_too_old', 'Update Nano Desktop.');
    if (required.some((scope) => !entry.scopes.has(scope))) throw apiError('scope_missing', 'The token does not grant this endpoint.');
    const device = devices.get(family.deviceId);
    device.lastSeenAt = iso();
    return { family, device };
  }

  // ---------------------------------------------------------------- OAuth

  function metadata() {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/connect/authorize`,
      token_endpoint: `${origin}/connect/token`,
      revocation_endpoint: `${origin}/connect/revoke`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: [...SCOPES],
    };
  }

  function meta() {
    const value = clone(FIXTURE.meta);
    value.capabilities.cloudLaunch = true;
    value.capabilities.remoteAccess = cfg.scenario !== 'remote-off';
    value.links = { billing: `${origin}/billing`, devices: `${origin}/account/devices`, signup: `${origin}/signup`, cloud: `${origin}/cloud` };
    value.minClientVersion = minClientVersion();
    return value;
  }

  function authorizeError(res, redirectUri, state, error, description) {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    url.searchParams.set('iss', origin);
    redirect(res, url.toString());
  }

  function handleAuthorizeGet(url, res) {
    const q = url.searchParams;
    const redirectUri = q.get('redirect_uri') ?? '';
    // Errors that must never redirect: an unknown client or a redirect URI that is not the loopback callback.
    if (q.get('client_id') !== CLIENT_ID) return sendHtml(res, 400, 'Invalid request', '<h1>Invalid request</h1><p>Unknown client.</p>');
    if (!isLoopbackRedirect(redirectUri)) {
      return sendHtml(res, 400, 'Invalid request', '<h1>Invalid request</h1><p>The redirect URI must be http://127.0.0.1:&lt;port&gt;/callback.</p>');
    }
    const state = q.get('state') ?? '';
    if (!state) return authorizeError(res, redirectUri, '', 'invalid_request', 'state is required');
    if (q.get('response_type') !== 'code') return authorizeError(res, redirectUri, state, 'unsupported_response_type', 'response_type must be code');
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return authorizeError(res, redirectUri, state, 'invalid_request', 'PKCE S256 code_challenge is required');
    }
    const requested = (q.get('scope') ?? SCOPES.join(' ')).split(/\s+/).filter(Boolean);
    if (requested.length === 0 || requested.some((scope) => !SCOPES.includes(scope))) {
      return authorizeError(res, redirectUri, state, 'invalid_scope', 'unknown scope');
    }
    const txn = token(24);
    const deviceName = (q.get('device_name') ?? '').slice(0, 80) || 'Nano Desktop';
    transactions.set(txn, { redirectUri, state, challenge, scope: requested.join(' '), deviceName, expiresAt: now() + TXN_TTL_MS });
    const grants = requested.map((scope) => `<li>${escapeHtml(scope)}</li>`).join('');
    sendHtml(
      res,
      200,
      'Authorize Nano Desktop',
      `<h1>Authorize Nano Desktop</h1><p>This is a development stand-in for the Nano sign-in page. Nothing here is a real account.</p>` +
        `<dl><dt>Device</dt><dd>${escapeHtml(deviceName)}</dd><dt>Requested scopes</dt><dd><ul>${grants}</ul></dd></dl>` +
        `<form method="post" action="/connect/authorize"><input type="hidden" name="txn" value="${escapeHtml(txn)}">` +
        `<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>`,
    );
  }

  async function handleAuthorizePost(req, res) {
    const form = await readForm(req);
    const txn = transactions.get(form.get('txn') ?? '');
    transactions.delete(form.get('txn') ?? '');
    if (!txn || txn.expiresAt <= now()) return sendHtml(res, 400, 'Invalid request', '<h1>Invalid request</h1><p>This sign-in request expired. Start again from the app.</p>');
    if (form.get('decision') !== 'approve') return authorizeError(res, txn.redirectUri, txn.state, 'access_denied', 'The user denied the request');
    const code = token(32);
    authCodes.set(sha256(code).toString('hex'), {
      redirectUri: txn.redirectUri,
      challenge: txn.challenge,
      scope: txn.scope,
      deviceName: txn.deviceName,
      expiresAt: now() + CODE_TTL_MS,
      familyId: null,
    });
    const url = new URL(txn.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', txn.state);
    url.searchParams.set('iss', origin);
    redirect(res, url.toString());
  }

  async function handleToken(req, res) {
    let form;
    try {
      form = await readForm(req);
    } catch (error) {
      if (error.__nano) return sendTokenError(res, 'invalid_request', 'Malformed request.');
      throw error;
    }
    if (form.get('client_id') !== CLIENT_ID) return sendTokenError(res, 'invalid_client', 'Unknown client.');
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const key = sha256(form.get('code') ?? '').toString('hex');
      const record = authCodes.get(key);
      if (!record || record.expiresAt <= now()) return sendTokenError(res, 'invalid_grant', 'The authorization code is not valid.');
      if (record.familyId) {
        // RFC 6749 section 4.1.2: a replayed code revokes what it already issued.
        revokeFamily(record.familyId);
        return sendTokenError(res, 'invalid_grant', 'The authorization code is not valid.');
      }
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || form.get('redirect_uri') !== record.redirectUri) {
        authCodes.delete(key);
        return sendTokenError(res, 'invalid_grant', 'The authorization code is not valid.');
      }
      const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!safeEqual(computed, record.challenge)) {
        authCodes.delete(key);
        return sendTokenError(res, 'invalid_grant', 'The authorization code is not valid.');
      }
      const family = newFamily((form.get('device_name') ?? '').slice(0, 80) || record.deviceName, record.scope);
      record.familyId = family.id;
      return sendJson(res, 200, issueTokens(family), { pragma: 'no-cache' });
    }
    if (grant === 'refresh_token') {
      const key = sha256(form.get('refresh_token') ?? '').toString('hex');
      const record = refreshTokens.get(key);
      const invalid = () => sendTokenError(res, 'invalid_grant', FIXTURE.tokenError.error_description);
      if (!record) return invalid();
      const family = families.get(record.familyId);
      if (!family || family.revoked || record.expiresAt <= now()) return invalid();
      if (record.used) {
        // RFC 9700 section 4.14: a rotated token came back; the whole family is compromised.
        revokeFamily(family.id);
        return invalid();
      }
      record.used = true;
      return sendJson(res, 200, issueTokens(family), { pragma: 'no-cache' });
    }
    return sendTokenError(res, 'unsupported_grant_type', 'Unsupported grant type.');
  }

  async function handleRevoke(req, res) {
    let form;
    try {
      form = await readForm(req);
    } catch {
      return sendTokenError(res, 'invalid_request', 'Malformed request.');
    }
    if (form.get('client_id') !== CLIENT_ID) return sendTokenError(res, 'invalid_client', 'Unknown client.');
    const value = form.get('token') ?? '';
    const refresh = refreshTokens.get(sha256(value).toString('hex'));
    if (refresh) revokeFamily(refresh.familyId);
    const access = accessTokens.get(value);
    if (access) accessTokens.delete(value);
    // RFC 7009: unknown tokens answer 200 too.
    sendJson(res, 200, {}, { pragma: 'no-cache' });
  }

  // ---------------------------------------------------------------- desktop API

  function handleCloudPage(url, res) {
    const code = url.searchParams.get('code') ?? '';
    const record = cloudCodes.get(code);
    cloudCodes.delete(code);
    const family = record ? families.get(record.familyId) : undefined;
    const workspace = record ? workspaces.find((row) => row.id === record.workspaceId) : undefined;
    // One answer for every refusal: expired, used, device signed out, workspace gone.
    if (!record || record.expiresAt <= now() || !family || family.revoked || !workspace) {
      return sendHtml(res, 400, 'Nano Cloud', '<h1>Nano Cloud (synthetic)</h1><p>The launch code is missing, expired, already used or no longer valid.</p>');
    }
    sendHtml(
      res,
      200,
      'Nano Cloud',
      `<h1>Nano Cloud (synthetic)</h1><p>This page stands in for the Nano web app, signed in to ${escapeHtml(workspace.name)}. The one-time launch code was accepted.</p>`,
    );
  }

  async function handleDictation(req, res, workspace) {
    const entitlements = baseEntitlements(workspace.id);
    const limit = entitlements.limits.dictationMaxBytes;
    if (!entitlements.features.dictation || limit <= 0) throw apiError('feature_not_in_plan', 'Dictation is not in your plan.');
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    const multipart = type.startsWith('multipart/form-data') && /boundary=/.test(type);
    if (!multipart && !type.startsWith('audio/') && !type.startsWith('application/octet-stream')) {
      throw apiError('invalid_request', 'Send one multipart audio part or a raw audio body.');
    }
    const body = await readBody(req, limit);
    if (body.length === 0 || (multipart && !body.includes('name="audio"'))) throw apiError('invalid_request', 'Missing audio part.');
    sendJson(res, 200, clone(FIXTURE.dictation));
  }

  function chargeFor(entitlements, mode) {
    const row = modeRow(entitlements, mode);
    if (!row) throw apiError('invalid_request', 'Unknown mode.');
    if (!row.available) {
      if (row.lockedReason === 'credits') throw apiError('credits_exhausted', 'No credits left.');
      throw apiError('mode_not_in_plan', 'This mode is not in your plan.');
    }
    const cost = MODE_COST[mode];
    if (cost > 0 && credits < cost) throw apiError('credits_exhausted', 'No credits left.');
    return cost;
  }

  function lastUserText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== 'user') continue;
      const content = message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join(' ');
    }
    return '';
  }

  async function handleChat(req, res, auth, workspace) {
    if (cfg.scenario === 'upstream-down') throw apiError('upstream_unavailable', 'The model provider is unavailable.');
    const entitlements = baseEntitlements(workspace.id);
    const body = await readBody(req, entitlements.limits.maxRequestBytes);
    let json;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      throw apiError('invalid_request', 'The body is not valid JSON.');
    }
    if (!json || typeof json !== 'object' || !MODE_IDS.includes(json.model) || !Array.isArray(json.messages) || json.messages.length === 0) {
      throw apiError('invalid_request', 'model must be a Nano mode and messages a non-empty array.');
    }
    const mode = json.model;
    const cost = chargeFor(entitlements, mode);
    const active = inflight.get(auth.device.id) ?? 0;
    if (active >= entitlements.limits.maxConcurrentRequests) throw apiError('rate_limited', 'Too many requests.', { retryAfter: 1 });
    inflight.set(auth.device.id, active + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflight.set(auth.device.id, Math.max(0, (inflight.get(auth.device.id) ?? 1) - 1));
    };
    try {
      credits -= cost;
      usageDeltaUsed += cost;
      const row = usageByMode.get(mode);
      row.credits += cost;
      row.requests += 1;

      const echo = lastUserText(json.messages).replace(/\s+/g, ' ').trim().slice(0, 80);
      const reply = `Synthetic Nano reply (${mode}): ${echo}`.trimEnd();
      const usage = {
        prompt_tokens: Math.max(1, Math.ceil(JSON.stringify(json.messages).length / 4)),
        completion_tokens: Math.max(1, Math.ceil(reply.length / 4)),
      };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      const id = `chatcmpl-${token(9)}`;
      const created = Math.floor(now() / 1000);

      if (json.stream !== true) {
        release();
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: mode,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage,
        });
      }

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      let closed = false;
      res.on('close', () => {
        closed = true;
        release();
      });
      const send = (payload) => res.write(`data: ${payload === '[DONE]' ? payload : JSON.stringify(payload)}\n\n`);
      const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model: mode, choices: [{ index: 0, delta, finish_reason: finish }] });
      send(chunk({ role: 'assistant', content: '' }));
      for (const piece of reply.match(/\S+\s*/g) ?? []) {
        if (closed) return;
        if (cfg.streamDelayMs) await sleep(cfg.streamDelayMs);
        send(chunk({ content: piece }));
      }
      if (closed) return;
      send(chunk({}, 'stop'));
      send({ id, object: 'chat.completion.chunk', created, model: mode, choices: [], usage });
      send('[DONE]');
      res.end();
      release();
    } catch (error) {
      release();
      throw error;
    }
  }

  function handleModels(res, workspace) {
    const entitlements = baseEntitlements(workspace.id);
    const created = Math.floor(Date.parse(FIXTURE.me.device.createdAt) / 1000);
    sendJson(res, 200, {
      object: 'list',
      data: entitlements.modes.filter((mode) => mode.available).map((mode) => ({ id: mode.id, object: 'model', created, owned_by: 'nano' })),
    });
  }

  // ---------------------------------------------------------------- remote access (ADR-062)
  //
  // An in-memory relay of the `nano-remote.v1` envelope (docs/NANO_DESKTOP_API.md
  // section 4.9). Synthetic: browsers connect without a cookie session and are
  // not authenticated; the real service authenticates them. `d` is parsed to
  // check that it is an object and written back as compact JSON.

  function refuseUpgrade(socket, error) {
    const text = JSON.stringify({ error: { code: error.code, message: error.message, retryable: error.retryable } });
    socket.end(
      `HTTP/1.1 ${error.status} ${STATUS_PHRASE[error.status] ?? 'Error'}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(text)}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n${text}`,
    );
  }

  /** Throws unless the request is a well-formed WebSocket upgrade offering `nano-remote.v1`. */
  function checkHandshake(req) {
    const connection = String(req.headers.connection ?? '').toLowerCase().split(',').map((part) => part.trim());
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !connection.includes('upgrade')) {
      throw apiError('invalid_request', 'Expected a WebSocket upgrade.');
    }
    if (req.headers['sec-websocket-version'] !== '13' || !isClientKey(req.headers['sec-websocket-key'])) {
      throw apiError('invalid_request', 'Malformed WebSocket handshake.');
    }
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((part) => part.trim());
    if (!offered.includes(REMOTE_SUBPROTOCOL)) throw apiError('invalid_request', `The ${REMOTE_SUBPROTOCOL} subprotocol is required.`);
  }

  /** Completes the handshake on the raw socket and returns the server end. */
  function acceptUpgrade(req, socket, head) {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\nsec-websocket-protocol: ${REMOTE_SUBPROTOCOL}\r\n\r\n`,
    );
    const peer = new WsPeer(socket, { role: 'server', head });
    peers.add(peer);
    peer.once('close', () => peers.delete(peer));
    return peer;
  }

  /** Server ping every `pingIntervalMs`; no pong within `pongTimeoutMs` closes 4408. */
  function keepalive(peer) {
    let waiting = null;
    const timer = setInterval(() => {
      if (!peer.open) return;
      clearTimeout(waiting);
      peer.ping();
      waiting = setTimeout(() => peer.close(4408, 'keepalive'), cfg.pongTimeoutMs);
      waiting.unref();
    }, cfg.pingIntervalMs);
    timer.unref();
    peer.on('pong', () => {
      clearTimeout(waiting);
      waiting = null;
    });
    peer.once('close', () => {
      clearInterval(timer);
      clearTimeout(waiting);
    });
  }

  /** Writes a frame, closing the socket with 4429 when its outbound queue is over the cap. */
  function relay(peer, value) {
    if (peer.buffered > MAX_OUTBOUND_BYTES) {
      peer.close(4429, 'queue');
      return;
    }
    peer.sendText(JSON.stringify(value));
  }

  function parseEnvelope(text) {
    try {
      const value = JSON.parse(text);
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** Forgets a viewer; `notify` tells its device (the device itself dropped it otherwise). */
  function removeViewer(viewerId, notify) {
    const viewer = viewers.get(viewerId);
    if (!viewer) return;
    viewers.delete(viewerId);
    const link = links.get(viewer.deviceId);
    link?.viewers.delete(viewerId);
    if (notify && link) relay(link.peer, { t: 'viewer-close', viewer: viewerId });
  }

  /** Ends a device link and every browser on it. */
  function endLink(deviceId, link, linkCode, linkReason, viewerCode = 4404, viewerReason = 'device-offline') {
    if (links.get(deviceId) === link) links.delete(deviceId);
    link.peer.close(linkCode, linkReason);
    for (const viewerId of [...link.viewers]) {
      const viewer = viewers.get(viewerId);
      viewers.delete(viewerId);
      viewer?.peer.close(viewerCode, viewerReason);
    }
    link.viewers.clear();
  }

  function onLinkText(deviceId, link, text) {
    const frame = parseEnvelope(text);
    if (!frame || typeof frame.viewer !== 'string') return link.peer.close(4400, 'protocol');
    const viewer = viewers.get(frame.viewer);
    const mine = viewer && viewer.deviceId === deviceId ? viewer : null;
    if (frame.t === 'msg') {
      if (!isObject(frame.d)) return link.peer.close(4400, 'protocol');
      if (mine) relay(mine.peer, { t: 'msg', d: frame.d });
      return undefined;
    }
    if (frame.t === 'drop') {
      if (!DROP_REASONS.has(frame.reason)) return link.peer.close(4400, 'protocol');
      if (mine) {
        removeViewer(frame.viewer, false);
        mine.peer.close(4403, frame.reason);
      }
      return undefined;
    }
    return link.peer.close(4400, 'protocol');
  }

  function handleLinkUpgrade(req, socket, head) {
    if (req.method !== 'GET') throw apiError('invalid_request', 'Unknown endpoint.', { status: 404 });
    const auth = authenticate(req, [DESKTOP_SCOPE]);
    if (cfg.scenario === 'remote-off') throw apiError('feature_not_in_plan', 'Remote access is not in your plan.');
    if (cfg.scenario === 'upstream-down') throw apiError('upstream_unavailable', 'The remote relay is unavailable.');
    checkHandshake(req);

    const deviceId = auth.device.id;
    const previous = links.get(deviceId);
    const peer = acceptUpgrade(req, socket, head);
    const link = { peer, familyId: auth.family.id, viewers: new Set() };
    links.set(deviceId, link);
    linkVersions.set(deviceId, String(req.headers['x-nano-client']).slice(CLIENT_ID.length + 1));
    if (previous) endLink(deviceId, previous, 4409, 'replaced');

    keepalive(peer);
    peer.on('text', (text) => onLinkText(deviceId, link, text));
    peer.on('binary', () => peer.close(4400, 'protocol'));
    peer.once('close', () => endLink(deviceId, link, 1000, ''));
    relay(peer, { t: 'hello', device: deviceId, maxFrame: MAX_PAYLOAD, maxViewers: MAX_VIEWERS_PER_DEVICE });
  }

  function handleViewerUpgrade(req, socket, head, deviceId) {
    if (req.method !== 'GET') throw apiError('invalid_request', 'Unknown endpoint.', { status: 404 });
    if (req.headers.origin !== undefined && req.headers.origin !== origin) throw apiError('invalid_request', 'Origin not allowed.', { status: 403 });
    if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') throw apiError('invalid_request', 'Cross-site requests are not allowed.', { status: 403 });
    if (cfg.scenario === 'remote-off') throw apiError('feature_not_in_plan', 'Remote access is not in your plan.');
    checkHandshake(req);

    const peer = acceptUpgrade(req, socket, head);
    const link = links.get(deviceId);
    const device = devices.get(deviceId);
    if (!link || !device || families.get(link.familyId)?.revoked) return peer.close(4404, 'device-offline');
    if (link.viewers.size >= MAX_VIEWERS_PER_DEVICE || viewers.size >= MAX_VIEWERS_PER_USER) return peer.close(4429, 'limit');

    const viewerId = `vw_${token(16)}`;
    const record = { peer, deviceId, window: { start: now(), count: 0 } };
    viewers.set(viewerId, record);
    link.viewers.add(viewerId);
    keepalive(peer);
    peer.on('binary', () => peer.close(4400, 'protocol'));
    peer.on('text', (text) => {
      const frame = parseEnvelope(text);
      if (!frame || frame.t !== 'msg' || !isObject(frame.d)) return peer.close(4400, 'protocol');
      if (!viewers.has(viewerId)) return undefined;
      const current = now();
      if (current - record.window.start >= 60_000) record.window = { start: current, count: 0 };
      record.window.count += 1;
      if (record.window.count > VIEWER_MESSAGES_PER_MINUTE) {
        removeViewer(viewerId, true);
        return peer.close(4429, 'rate');
      }
      relay(link.peer, { t: 'msg', viewer: viewerId, d: frame.d });
      return undefined;
    });
    peer.once('close', () => removeViewer(viewerId, true));
    relay(peer, { t: 'ready', viewer: viewerId, device: { id: deviceId, name: device.name } });
    relay(link.peer, { t: 'viewer-open', viewer: viewerId });
    return undefined;
  }

  function handleRemoteDevices(res) {
    if (cfg.scenario === 'remote-off') throw apiError('feature_not_in_plan', 'Remote access is not in your plan.');
    const list = [...families.values()]
      .filter((family) => !family.revoked)
      .map((family) => {
        const device = devices.get(family.deviceId);
        return {
          id: device.id,
          name: device.name,
          platform: null,
          appVersion: linkVersions.get(device.id) ?? null,
          lastSeenAt: device.lastSeenAt,
          online: links.has(device.id),
        };
      });
    sendJson(res, 200, { devices: list });
  }

  function handleRemoteLab(res) {
    const rows = [...families.values()]
      .filter((family) => !family.revoked && links.has(family.deviceId))
      .map((family) => {
        const device = devices.get(family.deviceId);
        const link = `/remote/index.html#device=${encodeURIComponent(device.id)}&amp;lang=en&amp;theme=system`;
        return `<li><a href="${link}">${escapeHtml(device.name)}</a> <code>${escapeHtml(device.id)}</code></li>`;
      })
      .join('');
    const hint = remoteRoot ? '' : '<p>No remote UI is served: start the server with <code>--remote-ui &lt;dir&gt;</code>.</p>';
    sendHtml(
      res,
      200,
      'Remote lab',
      `<h1>Remote access lab</h1><p>Devices with an open remote link. This page is a development stand-in for the Devices tab of Nano Web.</p>${hint}` +
        (rows ? `<ul>${rows}</ul>` : '<p>No device is linked. Switch on remote access in Nano Desktop.</p>'),
    );
  }

  async function serveRemoteUi(pathname, method, res) {
    const missing = () => apiError('invalid_request', 'Not found.', { status: 404 });
    if (!remoteRoot) throw missing();
    let relative;
    try {
      relative = decodeURIComponent(pathname.slice('/remote/'.length));
    } catch {
      throw apiError('invalid_request', 'Malformed path.');
    }
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    if (relative.includes('\0') || relative.includes('\\')) throw missing();
    const normalized = path.posix.normalize(relative);
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw missing();
    let real;
    try {
      real = await fs.promises.realpath(path.join(remoteRoot, ...normalized.split('/')));
    } catch {
      throw missing();
    }
    if (real !== remoteRoot && !real.startsWith(remoteRoot + path.sep)) throw missing();
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) throw missing();
    res.writeHead(200, {
      'content-type': REMOTE_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (method === 'HEAD') return res.end();
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
    return undefined;
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', origin);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (pathname === '/.well-known/oauth-authorization-server' && method === 'GET') return sendJson(res, 200, metadata());
    if (pathname === '/connect/authorize') {
      if (method === 'GET') return handleAuthorizeGet(url, res);
      if (method === 'POST') return handleAuthorizePost(req, res);
    }
    if (pathname === '/connect/token' && method === 'POST') return handleToken(req, res);
    if (pathname === '/connect/revoke' && method === 'POST') return handleRevoke(req, res);
    if (pathname === '/cloud' && method === 'GET') return handleCloudPage(url, res);
    if (pathname === '/api/hermes/remote/devices' && method === 'GET') return handleRemoteDevices(res);
    if (pathname === '/remote-lab' && method === 'GET') return handleRemoteLab(res);
    if (pathname === '/remote' && method === 'GET') return redirect(res, '/remote/');
    if (pathname.startsWith('/remote/') && (method === 'GET' || method === 'HEAD')) return serveRemoteUi(pathname, method, res);

    if (pathname === `${API}/meta` && method === 'GET') return sendJson(res, 200, meta());
    if (!pathname.startsWith(`${API}/`)) throw apiError('invalid_request', 'Unknown endpoint.', { status: 404 });

    const rest = pathname.slice(API.length);
    const auth = authenticate(req, requiredScopes(rest));
    if (rest === '/me' && method === 'GET') {
      const me = clone(FIXTURE.me);
      me.workspaces = clone(workspaces);
      me.device = { ...auth.device };
      return sendJson(res, 200, me);
    }
    if (rest === '/devices' && method === 'GET') {
      const active = [...families.values()].filter((family) => !family.revoked).map((family) => ({ ...devices.get(family.deviceId) }));
      return sendJson(res, 200, { devices: active });
    }
    const deviceMatch = /^\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(rest);
    if (deviceMatch && method === 'DELETE') {
      const family = [...families.values()].find((f) => f.deviceId === deviceMatch[1] && !f.revoked);
      if (!family) throw apiError('invalid_request', 'Unknown device.', { status: 404 });
      revokeFamily(family.id);
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    const wsMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,64})\/(.+)$/.exec(rest);
    if (!wsMatch) throw apiError('invalid_request', 'Unknown endpoint.', { status: 404 });
    const workspace = workspaceFor(wsMatch[1]);
    const sub = wsMatch[2];
    if (sub === 'entitlements' && method === 'GET') return sendJson(res, 200, baseEntitlements(workspace.id));
    if (sub === 'usage' && method === 'GET') return sendJson(res, 200, usageView(workspace.id));
    if (sub === 'media/dictation' && method === 'POST') return handleDictation(req, res, workspace);
    if (sub === 'cloud/launch' && method === 'POST') {
      if (!baseEntitlements(workspace.id).features.cloud) throw apiError('feature_not_in_plan', 'Nano Cloud is not in your plan.');
      const code = token(24);
      const expiresAt = now() + CLOUD_CODE_TTL_MS;
      cloudCodes.set(code, { expiresAt, familyId: auth.family.id, workspaceId: workspace.id });
      return sendJson(res, 200, { url: `${origin}/cloud?code=${code}`, expiresAt: iso(expiresAt) });
    }
    if (sub === 'gateway/v1/chat/completions' && method === 'POST') return handleChat(req, res, auth, workspace);
    if (sub === 'gateway/v1/models' && method === 'GET') return handleModels(res, workspace);
    throw apiError('invalid_request', 'Unknown endpoint.', { status: 404 });
  }

  const server = http.createServer((req, res) => {
    res.on('finish', () => {
      if (cfg.log) cfg.log(`${req.method} ${String(req.url ?? '').split('?')[0]} ${res.statusCode}`);
    });
    // DNS-rebinding guard: only the exact loopback authority answers.
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('Bad host');
    }
    route(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error && error.__nano) return sendApiError(res, error);
      sendApiError(res, apiError('internal', 'Internal error.'));
    });
  });
  server.requestTimeout = 60_000;

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try {
      if (req.headers.host !== new URL(origin).host) {
        socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
        return;
      }
      const pathname = new URL(req.url ?? '/', origin).pathname;
      if (cfg.log) cfg.log(`UPGRADE ${pathname}`);
      const viewerMatch = REMOTE_VIEWER_PATH.exec(pathname);
      if (pathname === REMOTE_LINK_PATH) handleLinkUpgrade(req, socket, head);
      else if (viewerMatch) handleViewerUpgrade(req, socket, head, viewerMatch[1]);
      else throw apiError('invalid_request', 'Unknown endpoint.', { status: 404 });
    } catch (error) {
      refuseUpgrade(socket, error && error.__nano ? error : apiError('internal', 'Internal error.'));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', () => resolve(undefined));
  });
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;

  return {
    port,
    origin,
    getCredits: () => credits,
    setCredits: (value) => {
      credits = Math.max(0, Math.floor(value));
    },
    setPlan: (value) => {
      plan = value === 'paid' ? 'paid' : 'free';
    },
    removeWorkspace: (id) => {
      const index = workspaces.findIndex((workspace) => workspace.id === id);
      if (index >= 0) workspaces.splice(index, 1);
    },
    close: () =>
      new Promise((resolve) => {
        for (const peer of peers) peer.destroy();
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

function parseCli(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--port':
        out.port = Number(value);
        index += 1;
        break;
      case '--plan':
        out.plan = value;
        index += 1;
        break;
      case '--credits':
        out.credits = Number(value);
        index += 1;
        break;
      case '--access-ttl':
        out.accessTtlSeconds = Number(value);
        index += 1;
        break;
      case '--scenario':
        out.scenario = value;
        index += 1;
        break;
      case '--stream-delay':
        out.streamDelayMs = Number(value);
        index += 1;
        break;
      case '--remote-ui':
        out.remoteUiDir = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument ${flag}. Usage: server.mjs [--port N] [--plan free|paid] [--credits N] [--access-ttl SECONDS] [--scenario default|client-too-old|upstream-down|remote-off] [--stream-delay MS] [--remote-ui DIR]`);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const options = parseCli(process.argv.slice(2));
    const running = await startNanoDevServer({ ...options, log: (line) => console.log(line) });
    console.log(`Synthetic Nano development server on ${running.origin} (plan ${options.plan ?? 'free'}). Set PIUI_NANO_ISSUER=${running.origin} for a debug build.`);
    const stop = () => void running.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
