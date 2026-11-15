import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../contracts/fixtures/nano-remote-v1.json';
import { NANO_REMOTE_CLOSE, NANO_REMOTE_LIMITS, nanoRemoteProofMessage } from '../../../../contracts/nano-remote-v1';
import {
  RemoteConnection,
  closeReasonFor,
  exceedsFrame,
  shellMatches,
  type ConnectionState,
  type RemoteGap,
  type RemoteSocket,
} from './connection';
import { fromBase64Url, openIdentity, pairingCode } from './identity';

const DEVICE = fixture.proofMessage.deviceId;
const VIEWER = fixture.proofMessage.viewerId;
const NONCE = fixture.pairingVector.nonce;
const DEVICE_NAME = 'Nano Desktop on Windows';

const WELCOME = {
  k: 'welcome',
  proto: 1,
  device: { id: DEVICE, name: DEVICE_NAME },
  app: { version: '0.3.1' },
  grant: 'always',
  shell: fixture.shellContracts,
  commands: fixture.commands,
  channels: fixture.channels,
};

class FakeSocket implements RemoteSocket {
  onopen: RemoteSocket['onopen'] = null;
  onmessage: RemoteSocket['onmessage'] = null;
  onclose: RemoteSocket['onclose'] = null;
  onerror: RemoteSocket['onerror'] = null;
  readonly sent: string[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  /** What the relay delivers to the browser. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' || frame instanceof ArrayBuffer ? frame : JSON.stringify(frame) } as MessageEvent);
  }

  inner(message: unknown): void {
    this.receive({ t: 'msg', d: message });
  }

  drop(code: number, reason = ''): void {
    this.onclose?.({ code, reason } as CloseEvent);
  }

  /** The inner messages this browser sent, in order. */
  get messages(): Record<string, unknown>[] {
    return this.sent.map((text) => (JSON.parse(text) as { t: string; d: Record<string, unknown> }).d);
  }

  get requests(): Record<string, unknown>[] {
    return this.messages.filter((message) => message.k === 'req');
  }
}

const opened: RemoteConnection[] = [];

async function open() {
  const identity = await openIdentity({ store: null });
  const socket = new FakeSocket();
  const connection = new RemoteConnection({ url: 'wss://nano.test/socket', deviceId: DEVICE, identity, label: 'Chrome · Android', createSocket: () => socket });
  const states: ConnectionState[] = [];
  connection.onState((state) => states.push(state));
  connection.start();
  opened.push(connection);
  return { identity, socket, connection, states };
}

type Context = Awaited<ReturnType<typeof open>>;

/** Plays the desktop up to the point where it has verified the proof; answers the browser's key. */
async function handshake(context: Context): Promise<string> {
  const { socket } = context;
  socket.receive({ t: 'ready', viewer: VIEWER, device: { id: DEVICE, name: DEVICE_NAME } });
  await vi.waitFor(() => expect(socket.messages).toHaveLength(1));
  const hello = socket.messages[0] as { k: string; proto: number; key: string; label: string };
  expect(hello).toMatchObject({ k: 'hello', proto: 1, label: 'Chrome · Android' });
  socket.inner({ k: 'challenge', nonce: NONCE });
  await vi.waitFor(() => expect(socket.messages).toHaveLength(2));
  const proof = socket.messages[1] as { k: string; sig: string };
  expect(proof.k).toBe('proof');
  const key = await crypto.subtle.importKey('raw', new Uint8Array(fromBase64Url(hello.key) ?? []), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new Uint8Array(fromBase64Url(proof.sig) ?? []),
    new TextEncoder().encode(nanoRemoteProofMessage(DEVICE, VIEWER, NONCE)),
  );
  expect(valid).toBe(true);
  return hello.key;
}

async function welcomed(): Promise<Context> {
  const context = await open();
  await handshake(context);
  context.socket.inner(WELCOME);
  expect(context.connection.state.kind).toBe('welcomed');
  return context;
}

afterEach(() => {
  // Ending every session clears its timers, so no handle outlives the test.
  for (const connection of opened.splice(0)) connection.close();
  vi.useRealTimers();
});

describe('handshake', () => {
  it('proves possession of the key bound to the device and viewer ids, then mounts on welcome', async () => {
    const context = await open();
    await handshake(context);
    context.socket.inner(WELCOME);
    expect(context.states.map((state) => state.kind)).toEqual(['welcomed']);
    expect(context.connection.commands).toEqual(fixture.commands);
    expect(context.connection.channels).toEqual(fixture.channels);
  });

  it('shows the code it computed from its own key while the person decides', async () => {
    const context = await open();
    const key = await handshake(context);
    const expected = (await pairingCode(fromBase64Url(key) ?? new Uint8Array(), NONCE)) ?? '';
    context.socket.inner({ k: 'approval', code: expected, expiresIn: 120 });
    expect(context.connection.state).toEqual({ kind: 'approval', code: expected, deviceName: DEVICE_NAME, expiresIn: 120 });
    context.socket.inner(WELCOME);
    expect(context.connection.state.kind).toBe('welcomed');
  });

  it('refuses a host whose code differs from the one computed here', async () => {
    const context = await open();
    const key = await handshake(context);
    const expected = (await pairingCode(fromBase64Url(key) ?? new Uint8Array(), NONCE)) ?? '';
    context.socket.inner({ k: 'approval', code: expected === '000000' ? '000001' : '000000', expiresIn: 120 });
    expect(context.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });
    expect(context.socket.closedWith?.code).toBe(1000);
  });

  it('reports a denied pairing once and ignores the drop that follows', async () => {
    for (const reason of ['denied', 'timeout', 'busy'] as const) {
      const context = await open();
      await handshake(context);
      context.socket.inner({ k: 'denied', reason });
      context.socket.drop(NANO_REMOTE_CLOSE.dropped, 'denied');
      expect(context.states).toEqual([{ kind: 'denied', reason }]);
    }
  });

  it('refuses a ready frame for another device or with a bad viewer id', async () => {
    const wrongDevice = await open();
    wrongDevice.socket.receive({ t: 'ready', viewer: VIEWER, device: { id: 'dev_other', name: 'x' } });
    expect(wrongDevice.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });
    const wrongViewer = await open();
    wrongViewer.socket.receive({ t: 'ready', viewer: 'bogus', device: { id: DEVICE, name: 'x' } });
    expect(wrongViewer.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });
  });

  it('refuses frames out of order, binary frames, invalid JSON and oversized frames', async () => {
    const early = await open();
    early.socket.inner({ k: 'challenge', nonce: NONCE });
    expect(early.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });
    const welcomeFirst = await open();
    welcomeFirst.socket.inner(WELCOME);
    expect(welcomeFirst.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });
    const binary = await open();
    binary.socket.receive(new ArrayBuffer(4));
    expect(binary.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });
    const broken = await open();
    broken.socket.receive('{not json');
    expect(broken.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });
    const huge = await open();
    huge.socket.receive('x'.repeat(NANO_REMOTE_LIMITS.maxFrameBytes + 1));
    expect(huge.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });
  });

  it('refuses a welcome for another device and keeps unknown shell numbers out of the shell', async () => {
    const other = await open();
    await handshake(other);
    other.socket.inner({ ...WELCOME, device: { id: 'dev_other', name: 'x' } });
    expect(other.connection.state).toEqual({ kind: 'closed', reason: 'protocol' });

    const older = await open();
    await handshake(older);
    older.socket.inner({ ...WELCOME, shell: { ...fixture.shellContracts, workspace: 14 } });
    const state = older.connection.state;
    expect(state.kind).toBe('welcomed');
    if (state.kind === 'welcomed') expect(shellMatches(state.welcome.shell)).toBe(false);

    const missing = await open();
    await handshake(missing);
    missing.socket.inner({ ...WELCOME, shell: { workspace: 15 } });
    const missingState = missing.connection.state;
    if (missingState.kind === 'welcomed') expect(shellMatches(missingState.welcome.shell)).toBe(false);
    else expect.unreachable();
  });

  it('times out when the relay never says ready', async () => {
    vi.useFakeTimers();
    const context = await open();
    vi.advanceTimersByTime(20_001);
    expect(context.connection.state).toEqual({ kind: 'closed', reason: 'network' });
  });
});

describe('shell contract', () => {
  it('matches only the compiled-in numbers', () => {
    expect(shellMatches(fixture.shellContracts)).toBe(true);
    expect(shellMatches({ ...fixture.shellContracts, models: 18 })).toBe(false);
    expect(shellMatches({ ...fixture.shellContracts, history: 2 })).toBe(false);
  });
});

describe('requests', () => {
  it('sends an allowlisted command and resolves with the host value', async () => {
    const { connection, socket } = await welcomed();
    const answer = connection.request('workspace_command_v15', { command: { type: 'catalog' } });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
    expect(socket.requests[0]).toEqual({ k: 'req', id: 1, cmd: 'workspace_command_v15', args: { command: { type: 'catalog' } } });
    socket.inner({ k: 'res', id: 1, ok: true, value: { projects: [] } });
    await expect(answer).resolves.toEqual({ projects: [] });
  });

  it('rejects with what the host said, unchanged', async () => {
    const { connection, socket } = await welcomed();
    const answer = connection.request('bootstrap_v10', {});
    socket.inner({ k: 'res', id: 1, ok: false, error: { code: 'remote-not-allowed' } });
    await expect(answer).rejects.toEqual({ code: 'remote-not-allowed' });
  });

  it('refuses commands outside the welcome without sending them', async () => {
    const { connection, socket } = await welcomed();
    await expect(connection.request('nano_remote_set_enabled_v1', {})).rejects.toEqual({ code: 'remote-not-allowed' });
    await expect(connection.request('add_project_v10', {})).rejects.toEqual({ code: 'remote-not-allowed' });
    expect(socket.requests).toHaveLength(0);
  });

  it('refuses a request before the welcome', async () => {
    const context = await open();
    await expect(context.connection.request('bootstrap_v10', {})).rejects.toEqual({ code: 'remote-not-connected' });
  });

  it('refuses arguments that cannot be sent or are too large, without sending', async () => {
    const { connection, socket } = await welcomed();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(connection.request('bootstrap_v10', cyclic)).rejects.toEqual({ code: 'remote-invalid' });
    await expect(connection.request('bootstrap_v10', { blob: 'x'.repeat(NANO_REMOTE_LIMITS.maxFrameBytes) })).rejects.toEqual({ code: 'remote-too-large' });
    expect(socket.requests).toHaveLength(0);
  });

  it('keeps at most eight requests on the wire and sends the rest as answers arrive', async () => {
    const { connection, socket } = await welcomed();
    const answers = Array.from({ length: 10 }, (_, index) => connection.request('get_session_catalog', { n: index }));
    for (const answer of answers) answer.catch(() => undefined); // Ending the session rejects the unanswered ones.
    await vi.waitFor(() => expect(socket.requests).toHaveLength(NANO_REMOTE_LIMITS.maxInFlight));
    expect(socket.requests.map((request) => request.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    socket.inner({ k: 'res', id: 1, ok: true, value: 'one' });
    await expect(answers[0]).resolves.toBe('one');
    expect(socket.requests).toHaveLength(9);
    socket.inner({ k: 'res', id: 2, ok: true, value: 'two' });
    expect(socket.requests).toHaveLength(10);
    await expect(answers[1]).resolves.toBe('two');
  });

  it('gives up on a request after the timeout and frees its place', async () => {
    const { connection, socket } = await welcomed();
    vi.useFakeTimers();
    const answer = connection.request('get_session_catalog', {});
    const caught = answer.catch((error: unknown) => error);
    vi.advanceTimersByTime(NANO_REMOTE_LIMITS.requestTimeoutMs + 1);
    await expect(caught).resolves.toEqual({ code: 'remote-timeout' });
    expect(socket.requests).toHaveLength(1);
    // A late answer for a settled request is ignored.
    socket.inner({ k: 'res', id: 1, ok: true, value: 'late' });
  });

  it('rejects pending and queued requests when the connection ends', async () => {
    const { connection, socket, states } = await welcomed();
    const answers = Array.from({ length: 10 }, () => connection.request('get_session_catalog', {}).catch((error: unknown) => error));
    socket.drop(1006);
    for (const outcome of await Promise.all(answers)) expect(outcome).toEqual({ code: 'remote-not-connected' });
    expect(states.at(-1)).toEqual({ kind: 'closed', reason: 'network' });
    await expect(connection.request('bootstrap_v10', {})).rejects.toEqual({ code: 'remote-not-connected' });
  });
});

describe('large results', () => {
  const slices = (text: string, size: number): string[] => {
    const characters = Array.from(text);
    const out: string[] = [];
    for (let start = 0; start < characters.length; start += size) out.push(characters.slice(start, start + size).join(''));
    return out;
  };

  it('joins parts in seq order whatever order they arrive in, across multi-byte text', async () => {
    const { connection, socket } = await welcomed();
    const value = { text: 'привет 😀 мир '.repeat(30), list: [1, 2, 3] };
    const parts = slices(JSON.stringify(value), 40);
    expect(parts.length).toBeGreaterThan(3);
    const answer = connection.request('get_timeline_page', {});
    const order = [...parts.keys()].reverse();
    for (const seq of order) socket.inner({ k: 'part', id: 1, seq, last: seq === parts.length - 1, ok: true, data: parts[seq] });
    await expect(answer).resolves.toEqual(value);
  });

  it('rejects with the host error when the parts carry a failure', async () => {
    const { connection, socket } = await welcomed();
    const answer = connection.request('get_timeline_page', {});
    socket.inner({ k: 'part', id: 1, seq: 0, last: false, ok: false, data: '{"code":' });
    socket.inner({ k: 'part', id: 1, seq: 1, last: true, ok: false, data: '"io"}' });
    await expect(answer).rejects.toEqual({ code: 'io' });
  });

  it('waits for a missing slice and refuses slices past the end or broken JSON', async () => {
    const { connection, socket } = await welcomed();
    const pending = connection.request('get_timeline_page', {}).catch((error: unknown) => error);
    socket.inner({ k: 'part', id: 1, seq: 1, last: true, ok: true, data: '2]' });
    socket.inner({ k: 'part', id: 1, seq: 0, last: false, ok: true, data: '[1,' });
    await expect(pending).resolves.toEqual([1, 2]);

    const beyond = connection.request('get_timeline_page', {}).catch((error: unknown) => error);
    socket.inner({ k: 'part', id: 2, seq: 3, last: false, ok: true, data: 'x' });
    socket.inner({ k: 'part', id: 2, seq: 0, last: true, ok: true, data: 'y' });
    await expect(beyond).resolves.toEqual({ code: 'remote-invalid' });

    const broken = connection.request('get_timeline_page', {}).catch((error: unknown) => error);
    socket.inner({ k: 'part', id: 3, seq: 0, last: true, ok: true, data: '{not json' });
    await expect(broken).resolves.toEqual({ code: 'remote-invalid' });
  });

  it('ignores parts for requests it did not make and malformed parts', async () => {
    const { connection, socket } = await welcomed();
    socket.inner({ k: 'part', id: 99, seq: 0, last: true, ok: true, data: '1' });
    const answer = connection.request('get_timeline_page', {}).catch((error: unknown) => error);
    socket.inner({ k: 'part', id: 1, seq: -1, last: true, ok: true, data: '1' });
    await expect(answer).resolves.toEqual({ code: 'remote-invalid' });
  });
});

describe('events', () => {
  it('delivers advertised channels to every listener and survives a throwing one', async () => {
    const { connection, socket } = await welcomed();
    const seen: unknown[] = [];
    connection.onEvent(() => {
      throw new Error('listener bug');
    });
    const stop = connection.onEvent((channel, payload) => seen.push([channel, payload]));
    socket.inner({ k: 'ev', ch: 'piui://workspace-event', p: { type: 'text-delta', text: 'hi' } });
    expect(seen).toEqual([['piui://workspace-event', { type: 'text-delta', text: 'hi' }]]);
    stop();
    socket.inner({ k: 'ev', ch: 'piui://workspace-event', p: 1 });
    expect(seen).toHaveLength(1);
  });

  it('drops channels the welcome did not advertise', async () => {
    const { connection, socket } = await welcomed();
    const seen: unknown[] = [];
    connection.onEvent((channel) => seen.push(channel));
    socket.inner({ k: 'ev', ch: 'piui://nano-remote-v1', p: {} });
    socket.inner({ k: 'ev', ch: 'piui://secret', p: {} });
    socket.inner({ k: 'ev', p: {} });
    expect(seen).toEqual([]);
  });

  it('tells every listener when the host skipped an event, without ending or re-pairing the session', async () => {
    const { connection, socket, states } = await welcomed();
    const sent = socket.sent.length;
    const statesBefore = states.length;
    const seen: RemoteGap[] = [];
    connection.onGap(() => {
      throw new Error('listener bug');
    });
    const stop = connection.onGap((gap) => seen.push(gap));
    socket.inner({ k: 'gap', ch: 'piui://workspace-event', sid: 'ses_1' });
    socket.inner({ k: 'gap', ch: 'piui://session-catalog' });
    expect(seen).toEqual([
      { channel: 'piui://workspace-event', sessionId: 'ses_1' },
      { channel: 'piui://session-catalog', sessionId: undefined },
    ]);
    // The same socket keeps serving: nothing is sent, no new state, still welcomed.
    expect(socket.sent).toHaveLength(sent);
    expect(socket.closedWith).toBeUndefined();
    expect(connection.state.kind).toBe('welcomed');
    expect(states).toHaveLength(statesBefore);
    stop();
    socket.inner({ k: 'gap', ch: 'piui://workspace-event', sid: 'ses_2' });
    expect(seen).toHaveLength(2);
  });

  it('reads a gap without a usable session id as a gap of the whole channel and drops unadvertised ones', async () => {
    const { connection, socket } = await welcomed();
    const seen: RemoteGap[] = [];
    connection.onGap((gap) => seen.push(gap));
    socket.inner({ k: 'gap', ch: 'piui://workspace-event', sid: 7 });
    socket.inner({ k: 'gap', ch: 'piui://workspace-event', sid: '' });
    socket.inner({ k: 'gap', ch: 'piui://secret', sid: 'ses_1' });
    socket.inner({ k: 'gap', ch: 'piui://nano-remote-v1' });
    socket.inner({ k: 'gap', sid: 'ses_1' });
    socket.inner({ k: 'gap', ch: 4 });
    expect(seen).toEqual([
      { channel: 'piui://workspace-event', sessionId: undefined },
      { channel: 'piui://workspace-event', sessionId: undefined },
    ]);
    expect(connection.state.kind).toBe('welcomed');
  });

  it('ignores a gap before the welcome', async () => {
    const context = await open();
    const seen: RemoteGap[] = [];
    context.connection.onGap((gap) => seen.push(gap));
    context.socket.receive({ t: 'ready', viewer: VIEWER, device: { id: DEVICE, name: DEVICE_NAME } });
    context.socket.inner({ k: 'gap', ch: 'piui://workspace-event', sid: 'ses_1' });
    expect(seen).toEqual([]);
  });

  it('ignores unknown inner kinds after the welcome', async () => {
    const { connection, socket } = await welcomed();
    socket.inner({ k: 'future-thing', x: 1 });
    socket.receive({ t: 'future-envelope' });
    expect(connection.state.kind).toBe('welcomed');
  });
});

describe('ending', () => {
  it('turns bye into a typed reason and closes the socket', async () => {
    for (const reason of ['kicked', 'disabled', 'signed-out', 'quit'] as const) {
      const { socket, states } = await welcomed();
      socket.inner({ k: 'bye', reason });
      expect(states.at(-1)).toEqual({ kind: 'closed', reason });
      expect(socket.closedWith?.code).toBe(1000);
      socket.drop(NANO_REMOTE_CLOSE.dropped, reason);
      expect(states.filter((state) => state.kind === 'closed')).toHaveLength(1);
    }
  });

  it('maps close codes to reasons', () => {
    expect(closeReasonFor(4400, '')).toBe('protocol');
    expect(closeReasonFor(4401, '')).toBe('unauthorized');
    expect(closeReasonFor(4403, 'kicked')).toBe('kicked');
    expect(closeReasonFor(4403, 'disabled')).toBe('disabled');
    expect(closeReasonFor(4403, 'denied')).toBe('denied');
    expect(closeReasonFor(4403, 'something else')).toBe('protocol');
    expect(closeReasonFor(4404, '')).toBe('device-offline');
    expect(closeReasonFor(4408, '')).toBe('idle');
    expect(closeReasonFor(4409, '')).toBe('replaced');
    expect(closeReasonFor(4429, '')).toBe('limited');
    expect(closeReasonFor(1009, '')).toBe('too-big');
    expect(closeReasonFor(1012, '')).toBe('restart');
    expect(closeReasonFor(1006, '')).toBe('network');
    expect(closeReasonFor(1000, '')).toBe('network');
  });

  it('reports a local close once', async () => {
    const { connection, states } = await welcomed();
    connection.close();
    connection.close();
    expect(states.filter((state) => state.kind === 'closed')).toEqual([{ kind: 'closed', reason: 'local' }]);
  });

  it('measures frames in UTF-8 bytes', () => {
    expect(exceedsFrame('x'.repeat(NANO_REMOTE_LIMITS.maxFrameBytes))).toBe(false);
    expect(exceedsFrame('x'.repeat(NANO_REMOTE_LIMITS.maxFrameBytes + 1))).toBe(true);
    expect(exceedsFrame('я'.repeat(NANO_REMOTE_LIMITS.maxFrameBytes / 2))).toBe(false);
    expect(exceedsFrame('я'.repeat(NANO_REMOTE_LIMITS.maxFrameBytes / 2 + 1))).toBe(true);
  });
});
