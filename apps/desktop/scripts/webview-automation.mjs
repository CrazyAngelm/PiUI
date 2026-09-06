import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';

const RETRYABLE_WINDOWS_REMOVE_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

function writeResponse(response, statusCode, body = undefined, headers = undefined) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.once('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveBody(JSON.parse(text));
      } catch (error) {
        rejectBody(error);
      }
    });
    request.once('aborted', () => rejectBody(new Error('Automation request was aborted.')));
    request.once('error', rejectBody);
  });
}

function errorFromBrowser(payload) {
  const message = typeof payload?.message === 'string' && payload.message.length > 0
    ? payload.message
    : 'WebView automation command failed.';
  const error = new Error(message);
  if (typeof payload?.name === 'string' && payload.name.length > 0) error.name = payload.name;
  return error;
}

export async function createWebviewAutomationServer({ allowedOrigin, commandBoundMs }) {
  if (typeof allowedOrigin !== 'string' || !allowedOrigin.startsWith('http://127.0.0.1:')) {
    throw new Error('WebView automation requires an explicit loopback page origin.');
  }
  if (!Number.isSafeInteger(commandBoundMs) || commandBoundMs <= 0) {
    throw new Error('WebView automation requires a positive command bound.');
  }

  // 32 random bytes are the transport capability. Rust accepts exactly the
  // corresponding 64-character hexadecimal form before injecting the client.
  const token = randomBytes(32).toString('hex');
  let currentClient;
  let readyGeneration = 0;
  let waitingPoll;
  let queuedCommand;
  let pendingCommand;
  let nextCommandId = 0;
  let closed = false;

  const corsHeaders = {
    'access-control-allow-origin': allowedOrigin,
    vary: 'Origin',
  };

  function rejectPending(error) {
    if (pendingCommand === undefined) return;
    clearTimeout(pendingCommand.timer);
    const reject = pendingCommand.reject;
    pendingCommand = undefined;
    queuedCommand = undefined;
    reject(error);
  }

  function closeWaitingPoll(statusCode) {
    if (waitingPoll === undefined) return;
    const response = waitingPoll.response;
    waitingPoll = undefined;
    if (!response.writableEnded) writeResponse(response, statusCode, undefined, corsHeaders);
  }

  function deliverQueuedCommand() {
    if (
      queuedCommand === undefined
      || waitingPoll === undefined
      || currentClient === undefined
      || waitingPoll.clientId !== currentClient.id
      || pendingCommand?.clientId !== currentClient.id
    ) return;
    const response = waitingPoll.response;
    const command = queuedCommand;
    waitingPoll = undefined;
    queuedCommand = undefined;
    writeResponse(response, 200, JSON.stringify(command), {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8',
    });
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.origin !== allowedOrigin) {
        writeResponse(response, 403);
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix)) {
        writeResponse(response, 404, undefined, corsHeaders);
        return;
      }
      const route = url.pathname.slice(prefix.length);

      if (request.method === 'POST' && route === 'ready') {
        const body = await readJsonBody(request);
        if (
          body === null
          || typeof body !== 'object'
          || typeof body.clientId !== 'string'
          || body.clientId.length === 0
          || typeof body.href !== 'string'
          || !body.href.startsWith(`${allowedOrigin}/`)
          || typeof body.webviewVersion !== 'string'
          || !/^(?:unknown|[0-9]+(?:\.[0-9]+)+)$/.test(body.webviewVersion)
        ) {
          writeResponse(response, 400, undefined, corsHeaders);
          return;
        }
        if (currentClient?.id !== body.clientId) {
          closeWaitingPoll(409);
          rejectPending(new Error('The WebView navigation replaced an in-flight automation command.'));
          currentClient = { id: body.clientId, href: body.href, webviewVersion: body.webviewVersion };
          readyGeneration += 1;
        } else {
          currentClient = { ...currentClient, href: body.href, webviewVersion: body.webviewVersion };
        }
        writeResponse(response, 204, undefined, corsHeaders);
        return;
      }

      if (request.method === 'GET' && route === 'next') {
        const clientId = url.searchParams.get('clientId');
        if (clientId === null || currentClient?.id !== clientId) {
          writeResponse(response, 409, undefined, corsHeaders);
          return;
        }
        closeWaitingPoll(409);
        const poll = { clientId, response };
        waitingPoll = poll;
        response.once('close', () => {
          if (waitingPoll === poll) waitingPoll = undefined;
        });
        deliverQueuedCommand();
        return;
      }

      if (request.method === 'POST' && route === 'result') {
        const body = await readJsonBody(request);
        if (
          body === null
          || typeof body !== 'object'
          || typeof body.clientId !== 'string'
          || !Number.isSafeInteger(body.id)
          || pendingCommand?.id !== body.id
          || pendingCommand.clientId !== body.clientId
          || currentClient?.id !== body.clientId
          || typeof body.ok !== 'boolean'
        ) {
          writeResponse(response, 409, undefined, corsHeaders);
          return;
        }
        const completion = pendingCommand;
        pendingCommand = undefined;
        clearTimeout(completion.timer);
        writeResponse(response, 204, undefined, corsHeaders);
        if (body.ok) completion.resolve(body.value);
        else completion.reject(errorFromBrowser(body.error));
        return;
      }

      writeResponse(response, 404, undefined, corsHeaders);
    } catch {
      if (!response.headersSent) writeResponse(response, 400, undefined, corsHeaders);
      else response.destroy();
    }
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error('Could not bind the WebView automation loopback server.');
  }
  const endpoint = `http://127.0.0.1:${address.port}/${token}`;

  function command(kind, payload = {}) {
    if (closed) return Promise.reject(new Error('WebView automation is closed.'));
    if (currentClient === undefined) return Promise.reject(new Error('No WebView automation page is ready.'));
    if (pendingCommand !== undefined || queuedCommand !== undefined) {
      return Promise.reject(new Error('WebView automation permits only one in-flight command.'));
    }
    const id = ++nextCommandId;
    const clientId = currentClient.id;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        if (pendingCommand?.id !== id) return;
        pendingCommand = undefined;
        queuedCommand = undefined;
        rejectCommand(new Error(`${kind} exceeded the WebView automation command bound.`));
      }, commandBoundMs);
      pendingCommand = { id, clientId, resolve: resolveCommand, reject: rejectCommand, timer };
      queuedCommand = { id, kind, ...payload };
      deliverQueuedCommand();
    });
  }

  return {
    port: address.port,
    token,
    endpoint,
    get currentPage() { return currentClient === undefined ? undefined : { ...currentClient }; },
    get generation() { return readyGeneration; },
    evaluate(expression) {
      if (typeof expression !== 'string') return Promise.reject(new TypeError('Automation expression must be a string.'));
      return command('evaluate', { expression });
    },
    dispatchKey(key) {
      if (key === null || typeof key !== 'object' || typeof key.key !== 'string' || typeof key.code !== 'string') {
        return Promise.reject(new TypeError('Automation key must include key and code strings.'));
      }
      return command('dispatchKey', { key });
    },
    reload() {
      return command('reload');
    },
    async close() {
      if (closed) return;
      closed = true;
      closeWaitingPoll(410);
      rejectPending(new Error('WebView automation closed before command completion.'));
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

export function removeOwnedFixtureRoot(
  fixtureRoot,
  canonicalArea,
  {
    exists = existsSync,
    canonicalize = realpathSync,
    remove = (path) => rmSync(path, { recursive: true, force: true }),
  } = {},
) {
  if (!exists(fixtureRoot)) return;
  const expectedFixture = resolve(fixtureRoot);
  const canonicalFixture = canonicalize(fixtureRoot);
  const areaRelation = relative(canonicalArea, canonicalFixture);
  if (
    areaRelation === ''
    || areaRelation.startsWith('..')
    || isAbsolute(areaRelation)
    || relative(expectedFixture, canonicalFixture) !== ''
  ) {
    throw new Error('The E2E fixture removal target escaped its exact repository-owned run directory.');
  }
  remove(canonicalFixture);
}

export async function removeDirectoryWithRetries(
  path,
  { remove, wait, boundMs, retryDelayMs, now = () => performance.now() },
) {
  if (typeof remove !== 'function' || typeof wait !== 'function' || typeof now !== 'function') {
    throw new TypeError('Fixture cleanup requires remove, wait, and clock functions.');
  }
  if (!Number.isSafeInteger(boundMs) || boundMs <= 0 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new TypeError('Fixture cleanup requires positive integer bounds.');
  }
  const deadline = now() + boundMs;
  while (true) {
    try {
      remove(path);
      return;
    } catch (error) {
      const remaining = deadline - now();
      if (!RETRYABLE_WINDOWS_REMOVE_CODES.has(error?.code) || remaining <= 0) throw error;
      await wait(Math.min(retryDelayMs, remaining));
    }
  }
}
