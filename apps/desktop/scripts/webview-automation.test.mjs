import { describe, expect, it } from 'vitest';
import { createWebviewAutomationServer, removeDirectoryWithRetries, removeOwnedFixtureRoot } from './webview-automation.mjs';

const ORIGIN = 'http://127.0.0.1:43123';
const ORIGIN_HEADERS = { origin: ORIGIN };

async function announce(server, clientId, href = `${ORIGIN}/`) {
  return fetch(`${server.endpoint}/ready`, {
    method: 'POST',
    headers: { ...ORIGIN_HEADERS, 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ clientId, href, webviewVersion: '151.0.4129.107' }),
  });
}

describe('WebView automation loopback transport', () => {
  it('requires the exact page origin and round-trips one typed command', async () => {
    const server = await createWebviewAutomationServer({ allowedOrigin: ORIGIN, commandBoundMs: 1_000 });
    try {
      const denied = await fetch(`${server.endpoint}/ready`, {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:43124', 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ clientId: 'wrong-origin', href: `${ORIGIN}/` }),
      });
      expect(denied.status).toBe(403);

      const ready = await announce(server, 'page-one');
      expect(ready.status).toBe(204);
      expect(server.generation).toBe(1);
      expect(server.currentPage?.href).toBe(`${ORIGIN}/`);

      const resultPromise = server.evaluate('6 * 7');
      const next = await fetch(`${server.endpoint}/next?clientId=page-one`, { headers: ORIGIN_HEADERS });
      expect(next.status).toBe(200);
      const command = await next.json();
      expect(command).toMatchObject({ kind: 'evaluate', expression: '6 * 7' });

      const result = await fetch(`${server.endpoint}/result`, {
        method: 'POST',
        headers: { ...ORIGIN_HEADERS, 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ clientId: 'page-one', id: command.id, ok: true, value: 42 }),
      });
      expect(result.status).toBe(204);
      await expect(resultPromise).resolves.toBe(42);
    } finally {
      await server.close();
    }
  });

  it('rejects an in-flight command when navigation replaces its page client', async () => {
    const server = await createWebviewAutomationServer({ allowedOrigin: ORIGIN, commandBoundMs: 1_000 });
    try {
      expect((await announce(server, 'page-one')).status).toBe(204);
      const resultPromise = server.evaluate('document.title');
      const rejected = expect(resultPromise).rejects.toThrow('navigation replaced');
      expect((await announce(server, 'page-two')).status).toBe(204);
      await rejected;
      expect(server.generation).toBe(2);
    } finally {
      await server.close();
    }
  });
});

describe('bounded Windows fixture cleanup', () => {
  it('retries transient locks inside the caller-provided cleanup bound', async () => {
    let attempts = 0;
    let clock = 0;
    const waits = [];
    await removeDirectoryWithRetries('fixture', {
      remove() {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      },
      async wait(milliseconds) {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      now: () => clock,
      boundMs: 500,
      retryDelayMs: 100,
    });
    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 100]);
  });

  it('does not retry a non-transient removal failure', async () => {
    let attempts = 0;
    await expect(removeDirectoryWithRetries('fixture', {
      remove() {
        attempts += 1;
        throw Object.assign(new Error('invalid fixture path'), { code: 'EINVAL' });
      },
      async wait() {},
      boundMs: 500,
      retryDelayMs: 100,
    })).rejects.toThrow('invalid fixture path');
    expect(attempts).toBe(1);
  });

  it('surfaces the last transient error when the cleanup deadline is exhausted', async () => {
    let attempts = 0;
    let clock = 0;
    const waits = [];
    await expect(removeDirectoryWithRetries('fixture', {
      remove() {
        attempts += 1;
        throw Object.assign(new Error('still locked'), { code: 'EBUSY' });
      },
      async wait(milliseconds) {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      now: () => clock,
      boundMs: 250,
      retryDelayMs: 100,
    })).rejects.toThrow('still locked');
    expect(attempts).toBe(4);
    expect(waits).toEqual([100, 100, 50]);
  });

  it('rejects a lexical run directory that canonicalizes to another run', () => {
    let removed = false;
    expect(() => removeOwnedFixtureRoot('D:/repo/target/piui-e2e/101', 'D:/repo/target/piui-e2e', {
      exists: () => true,
      canonicalize: () => 'D:/repo/target/piui-e2e/202',
      remove: () => { removed = true; },
    })).toThrow('exact repository-owned run directory');
    expect(removed).toBe(false);
  });
});
