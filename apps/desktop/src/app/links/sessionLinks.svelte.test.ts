import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionLinksOperationError,
  type LinkedChatV1,
  type SessionLinksChangedV1,
  type SessionLinksClient,
  type SessionLinksCommandV1,
  type SessionLinksResultV1,
} from '../../host-api/sessionLinksClient';
import { LINK_ERROR_COPY, SessionLinks, linkErrorCopy } from './sessionLinks.svelte';

const child: LinkedChatV1 = { sessionId: 'child', title: 'Review', harness: 'codex', kind: 'agent', relation: 'child', state: 'idle', pending: 0 };
const asParent: LinkedChatV1 = { sessionId: 'lead', title: 'Lead', harness: 'pi', kind: 'agent', relation: 'parent', state: 'running', pending: 0 };
const asBranch: LinkedChatV1 = { ...asParent, kind: 'branch' };
const asPeer: LinkedChatV1 = { sessionId: 'friend', title: 'Friend', harness: 'pi', kind: 'peer', relation: 'peer', state: 'idle', pending: 2 };

function setup() {
  const documents = new Map<string, LinkedChatV1[]>();
  const calls: SessionLinksCommandV1[] = [];
  let enabled = true;
  let readOnly = false;
  let failWith: unknown;
  let listener: ((event: SessionLinksChangedV1) => void) | undefined;
  let gate: Promise<void> | undefined;
  const client: SessionLinksClient = {
    async request(command): Promise<SessionLinksResultV1> {
      calls.push(command);
      if (gate) await gate;
      if (failWith !== undefined) throw failWith;
      switch (command.op) {
        case 'find':
          return { type: 'links', sessionId: command.sessionId, chats: structuredClone(documents.get(command.sessionId) ?? []), revision: calls.length };
        case 'settings':
          return { type: 'settings', enabled, readOnly };
        case 'update':
          enabled = command.enabled;
          return { type: 'settings', enabled, readOnly };
        default:
          return { type: 'done' };
      }
    },
    onChanged(handler) {
      listener = handler;
      return Promise.resolve(() => undefined);
    },
  };
  return {
    client,
    documents,
    calls,
    finds: () => calls.filter((call) => call.op === 'find').length,
    fail: (cause: unknown) => (failWith = cause),
    heal: () => (failWith = undefined),
    readOnly: (value: boolean) => (readOnly = value),
    emit: (sessionId: string) => listener?.({ sessionId, revision: 99 }),
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe('linked chats store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads a chat once and de-duplicates concurrent loads', async () => {
    const fake = setup();
    fake.documents.set('a', [child]);
    const links = new SessionLinks(fake.client);
    expect(links.peek('a')).toBeUndefined();
    await Promise.all([links.load('a'), links.load('a')]);
    await links.load('a');
    expect(fake.finds()).toBe(1);
    expect(links.peek('a')).toEqual([child]);
    expect(links.revisionOf('a')).toBe(1);
  });

  it('knows the parent of an agent or branch child and nothing else', async () => {
    const fake = setup();
    fake.documents.set('agent', [asParent]);
    fake.documents.set('branch', [asBranch]);
    fake.documents.set('peer', [asPeer]);
    fake.documents.set('lead', [child]);
    const links = new SessionLinks(fake.client);
    await Promise.all(['agent', 'branch', 'peer', 'lead', 'none'].map((id) => links.load(id)));
    expect(links.parentOf('agent')).toBe('lead');
    expect(links.parentOf('branch')).toBe('lead');
    expect(links.parentOf('peer')).toBeUndefined();
    expect(links.parentOf('lead')).toBeUndefined();
    expect(links.parentOf('none')).toBeUndefined();
    expect(links.parentOf('unloaded')).toBeUndefined();
    expect(links.isAgentChild('agent')).toBe(true);
    expect(links.isAgentChild('branch')).toBe(false);
    expect(links.isAgentChild('peer')).toBe(false);
    expect(links.isAgentChild('lead')).toBe(false);
  });

  it('refreshes loaded chats when the host reports a change and ignores the others', async () => {
    const fake = setup();
    const links = new SessionLinks(fake.client);
    await links.load('a');
    fake.documents.set('a', [child]);
    fake.emit('a');
    fake.emit('stranger');
    await vi.advanceTimersByTimeAsync(0);
    expect(links.peek('a')).toEqual([child]);
    expect(fake.calls.filter((call) => call.op === 'find' && call.sessionId === 'stranger')).toHaveLength(0);
  });

  it('joins changes that arrive during a read with one more read', async () => {
    const fake = setup();
    const links = new SessionLinks(fake.client);
    await links.load('a');
    const release = fake.hold();
    fake.emit('a');
    fake.emit('a');
    fake.emit('a');
    fake.documents.set('a', [asPeer]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(links.peek('a')).toEqual([asPeer]);
    expect(fake.finds()).toBe(3);
  });

  it('keeps what it knew when a read fails and does not retry a failed load at once', async () => {
    const fake = setup();
    fake.documents.set('a', [child]);
    const links = new SessionLinks(fake.client);
    fake.fail(new SessionLinksOperationError('unavailable', 'x'));
    await links.load('a');
    await links.load('a');
    expect(fake.finds()).toBe(1);
    expect(links.peek('a')).toBeUndefined();
    fake.heal();
    vi.advanceTimersByTime(10_001);
    await links.load('a');
    expect(links.peek('a')).toEqual([child]);
    fake.fail(new SessionLinksOperationError('unavailable', 'x'));
    await links.refresh('a');
    expect(links.peek('a')).toEqual([child]);
  });

  it('acts through the client, refreshes both chats and reports a fixed copy per code', async () => {
    const fake = setup();
    const links = new SessionLinks(fake.client);
    expect(await links.link('a', 'b')).toEqual({ ok: true });
    expect(await links.unlink('a', 'b')).toEqual({ ok: true });
    expect(await links.send('a', 'b', 'Hello')).toEqual({ ok: true, queued: false });
    expect(await links.deliver('a', 'b')).toEqual({ ok: true });
    expect(fake.calls.filter((call) => call.op !== 'find').map((call) => call.op)).toEqual(['link', 'unlink', 'send', 'deliver']);
    expect(fake.calls).toContainEqual({ op: 'send', fromSessionId: 'a', toSessionId: 'b', text: 'Hello' });
    expect(fake.calls).toContainEqual({ op: 'deliver', sessionId: 'a', fromSessionId: 'b' });
    expect(links.peek('a')).toEqual([]);
    expect(links.peek('b')).toEqual([]);

    fake.fail(new SessionLinksOperationError('busy', 'host words'));
    expect(await links.send('a', 'b', 'Hello')).toEqual({ ok: false, error: LINK_ERROR_COPY.busy });
    fake.fail(new SessionLinksOperationError('read-only', 'host words'));
    expect(await links.link('a', 'b')).toEqual({ ok: false, error: LINK_ERROR_COPY['read-only'] });
    fake.fail(new Error('boom'));
    expect(await links.unlink('a', 'b')).toEqual({ ok: false, error: LINK_ERROR_COPY.unavailable });
  });

  it('tells a queued message from a delivered one by the peer waiting count', async () => {
    const fake = setup();
    // The host keeps the text on the peer's link back to the sender when the peer cannot take it now.
    const waiting = (pending: number): LinkedChatV1[] => [{ ...asPeer, sessionId: 'a', pending }];
    const links = new SessionLinks(fake.client);
    fake.documents.set('b', waiting(0));
    expect(await links.send('a', 'b', 'Delivered')).toEqual({ ok: true, queued: false });

    const request = fake.client.request.bind(fake.client);
    fake.client.request = async (command) => {
      if (command.op === 'send') fake.documents.set('b', waiting((fake.documents.get('b')?.[0]?.pending ?? 0) + 1));
      return request(command);
    };
    expect(await links.send('a', 'b', 'Queued')).toEqual({ ok: true, queued: true });
    expect(links.peek('b')?.[0]?.pending).toBe(1);
    // Texts that were already waiting do not make a delivered message look queued.
    fake.client.request = request;
    expect(await links.send('a', 'b', 'Delivered')).toEqual({ ok: true, queued: false });
  });

  it('has fixed copy for every error code, none of it the host text', () => {
    const codes = ['invalid-operation', 'unknown-session', 'authority-denied', 'depth-limit', 'child-limit', 'harness-unavailable', 'not-allowed', 'busy', 'unavailable', 'read-only', 'io'] as const;
    for (const code of codes) {
      expect(LINK_ERROR_COPY[code], code).toMatch(/^[A-Z].+\.$/);
      expect(linkErrorCopy(new SessionLinksOperationError(code, 'host words'))).toBe(LINK_ERROR_COPY[code]);
    }
    expect(Object.keys(LINK_ERROR_COPY).sort()).toEqual([...codes].sort());
  });

  it('reads and writes the preference, restoring it on a refusal', async () => {
    const fake = setup();
    const links = new SessionLinks(fake.client);
    await links.setEnabled(false);
    expect(fake.calls).toHaveLength(0);
    await links.loadSettings();
    await links.loadSettings();
    expect(fake.calls.filter((call) => call.op === 'settings')).toHaveLength(1);
    expect(links.settings).toMatchObject({ enabled: true, readOnly: false, loaded: true, error: '' });
    await links.setEnabled(false);
    expect(links.settings.enabled).toBe(false);
    fake.fail(new SessionLinksOperationError('io', 'x'));
    await links.setEnabled(true);
    expect(links.settings).toMatchObject({ enabled: false, error: LINK_ERROR_COPY.io });
  });

  it('is read-only when the preference cannot be read or the host says so', async () => {
    const broken = setup();
    broken.fail(new SessionLinksOperationError('unavailable', 'x'));
    const failed = new SessionLinks(broken.client);
    await failed.loadSettings();
    expect(failed.settings).toMatchObject({ loaded: true, readOnly: true, error: LINK_ERROR_COPY.unavailable });
    await failed.setEnabled(false);
    expect(broken.calls.filter((call) => call.op === 'update')).toHaveLength(0);

    const safe = setup();
    safe.readOnly(true);
    const links = new SessionLinks(safe.client);
    await links.loadSettings();
    await links.setEnabled(false);
    expect(links.settings).toMatchObject({ readOnly: true, enabled: true });
    expect(safe.calls.filter((call) => call.op === 'update')).toHaveLength(0);
  });
});
