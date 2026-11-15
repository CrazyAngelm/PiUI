/**
 * One browser <-> desktop session over the Nano relay (ADR-062, nano-remote v1).
 *
 * The connection owns a single WebSocket, runs the pairing handshake of
 * contracts/nano-remote-v1.ts section 3.3, and afterwards carries requests and
 * events of the allowlisted host API. It never logs a frame and never keeps a
 * frame after it is handled. The server only relays; trust is decided by the
 * desktop from the key this browser proves it holds.
 */
import {
  NANO_REMOTE_CLOSE,
  NANO_REMOTE_LIMITS,
  NANO_REMOTE_PROTOCOL,
  NANO_REMOTE_SHELL_CONTRACTS,
  NANO_REMOTE_SUBPROTOCOL,
  nanoRemoteProofMessage,
  type NanoRemoteDeniedReasonV1,
  type NanoRemoteRefusalCodeV1,
  type NanoRemoteShellContractsV1,
  type NanoRemoteViewerMessageV1,
  type NanoRemoteWebToServerV1,
  type NanoRemoteWelcomeV1,
} from '../../../../contracts/nano-remote-v1';
import { fromBase64Url, pairingCode, toBase64Url, utf8Length, type ViewerIdentity } from './identity';

/** Why a session ended. The first four come from the computer, the rest from the relay or the network. */
export type ClosedReason =
  | 'kicked'
  | 'disabled'
  | 'signed-out'
  | 'quit'
  | 'denied'
  | 'protocol'
  | 'unauthorized'
  | 'device-offline'
  | 'idle'
  | 'replaced'
  | 'limited'
  | 'too-big'
  | 'restart'
  | 'network'
  | 'local';

export type ConnectionState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'approval'; readonly code: string; readonly deviceName: string; readonly expiresIn: number }
  | { readonly kind: 'denied'; readonly reason: NanoRemoteDeniedReasonV1 }
  | { readonly kind: 'welcomed'; readonly welcome: NanoRemoteWelcomeV1 }
  | { readonly kind: 'closed'; readonly reason: ClosedReason };

/** Refusals of this layer: the contract's codes plus the one only a browser can produce. */
export type RemoteLocalCode = NanoRemoteRefusalCodeV1 | 'remote-timeout';

/** What the transport module needs from a welcomed session. */
export interface RemoteLink {
  readonly commands: readonly string[];
  readonly channels: readonly string[];
  request(command: string, args: Record<string, unknown>): Promise<unknown>;
  onEvent(handler: (channel: string, payload: unknown) => void): () => void;
}

/** The part of `WebSocket` the connection uses; tests supply a scripted one. */
export interface RemoteSocket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string, protocol: string) => RemoteSocket;

export interface RemoteConnectionOptions {
  readonly url: string;
  readonly deviceId: string;
  readonly identity: ViewerIdentity;
  /** Shown on the computer next to the pairing code. */
  readonly label: string;
  readonly createSocket?: SocketFactory | undefined;
}

const CONNECT_MS = 20_000;
const STEP_MS = 15_000;
const VIEWER_ID = /^vw_[A-Za-z0-9_-]{8,64}$/;
const DENIED: readonly NanoRemoteDeniedReasonV1[] = ['denied', 'timeout', 'busy'];
const BYE: readonly string[] = ['kicked', 'disabled', 'signed-out', 'quit'];
const DROPS: readonly ClosedReason[] = ['denied', 'kicked', 'disabled', 'protocol'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refusal(code: RemoteLocalCode): { code: RemoteLocalCode } {
  return { code };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** True when `text` is longer than a relay frame may be (UTF-8 bytes). */
export function exceedsFrame(text: string): boolean {
  const limit = NANO_REMOTE_LIMITS.maxFrameBytes;
  if (text.length > limit) return true;
  return text.length * 3 > limit && utf8Length(text) > limit;
}

export function closeReasonFor(code: number, reason: string): ClosedReason {
  switch (code) {
    case NANO_REMOTE_CLOSE.protocol:
      return 'protocol';
    case NANO_REMOTE_CLOSE.unauthorized:
      return 'unauthorized';
    case NANO_REMOTE_CLOSE.dropped:
      return DROPS.find((item) => item === reason) ?? 'protocol';
    case NANO_REMOTE_CLOSE.deviceOffline:
      return 'device-offline';
    case NANO_REMOTE_CLOSE.idle:
      return 'idle';
    case NANO_REMOTE_CLOSE.replaced:
      return 'replaced';
    case NANO_REMOTE_CLOSE.limited:
      return 'limited';
    case NANO_REMOTE_CLOSE.tooBig:
      return 'too-big';
    case NANO_REMOTE_CLOSE.restart:
      return 'restart';
    default:
      return 'network';
  }
}

/** The shell mounts only when host and browser agree on every contract number. */
export function shellMatches(shell: NanoRemoteShellContractsV1): boolean {
  return (Object.keys(NANO_REMOTE_SHELL_CONTRACTS) as (keyof typeof NANO_REMOTE_SHELL_CONTRACTS)[]).every(
    (key) => shell[key] === NANO_REMOTE_SHELL_CONTRACTS[key],
  );
}

function parseWelcome(frame: Record<string, unknown>): NanoRemoteWelcomeV1 | undefined {
  const { device, app, shell } = frame;
  if (frame.proto !== NANO_REMOTE_PROTOCOL || !isRecord(device) || !isRecord(app) || !isRecord(shell)) return undefined;
  if (typeof device.id !== 'string' || typeof device.name !== 'string' || typeof app.version !== 'string') return undefined;
  if (frame.grant !== 'once' && frame.grant !== 'always') return undefined;
  if (!isStringArray(frame.commands) || !isStringArray(frame.channels)) return undefined;
  const number = (key: keyof NanoRemoteShellContractsV1): number => {
    const value = shell[key];
    return typeof value === 'number' ? value : -1;
  };
  return {
    k: 'welcome',
    proto: NANO_REMOTE_PROTOCOL,
    device: { id: device.id, name: device.name },
    app: { version: app.version },
    grant: frame.grant,
    // A missing number is a mismatch, which shows the "versions differ" screen, not a protocol error.
    shell: { workspace: number('workspace'), composer: number('composer'), settings: number('settings'), history: number('history'), models: number('models') },
    commands: frame.commands,
    channels: frame.channels,
  };
}

type Phase = 'connecting' | 'hello' | 'proof' | 'approval' | 'welcomed' | 'done';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Queued {
  readonly id: number;
  readonly frame: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface Assembly {
  ok: boolean;
  readonly parts: Map<number, string>;
  bytes: number;
  last: number | undefined;
}

export class RemoteConnection implements RemoteLink {
  private readonly options: RemoteConnectionOptions;
  private socket: RemoteSocket | undefined;
  private phase: Phase = 'connecting';
  private current: ConnectionState = { kind: 'connecting' };
  private viewerId = '';
  private deviceName = '';
  private rawKey: Uint8Array | undefined;
  private expectedCode: string | undefined;
  private welcome: NanoRemoteWelcomeV1 | undefined;
  private commandSet: ReadonlySet<string> = new Set();
  private channelSet: ReadonlySet<string> = new Set();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  private readonly states = new Set<(state: ConnectionState) => void>();
  private readonly events = new Set<(channel: string, payload: unknown) => void>();
  private readonly pending = new Map<number, Pending>();
  private readonly queue: Queued[] = [];
  private readonly assemblies = new Map<number, Assembly>();

  constructor(options: RemoteConnectionOptions) {
    this.options = options;
  }

  get state(): ConnectionState {
    return this.current;
  }

  get commands(): readonly string[] {
    return this.welcome?.commands ?? [];
  }

  get channels(): readonly string[] {
    return this.welcome?.channels ?? [];
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.states.add(handler);
    return () => this.states.delete(handler);
  }

  onEvent(handler: (channel: string, payload: unknown) => void): () => void {
    this.events.add(handler);
    return () => this.events.delete(handler);
  }

  /** Opens the socket. Call once, after the state handlers are registered. */
  start(): void {
    if (this.socket !== undefined || this.phase === 'done') return;
    let socket: RemoteSocket;
    try {
      socket = (this.options.createSocket ?? ((url, protocol) => new WebSocket(url, protocol)))(this.options.url, NANO_REMOTE_SUBPROTOCOL);
    } catch {
      this.finish({ kind: 'closed', reason: 'network' });
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => {
      void this.receive(event.data);
    };
    socket.onclose = (event) => this.fail(closeReasonFor(event.code, event.reason));
    socket.onerror = () => undefined; // A close event always follows.
    this.arm(CONNECT_MS);
  }

  /** Ends the session from this side. */
  close(): void {
    this.finish({ kind: 'closed', reason: 'local' });
  }

  request(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.is('welcomed')) return Promise.reject(refusal('remote-not-connected'));
    if (!this.commandSet.has(command)) return Promise.reject(refusal('remote-not-allowed'));
    const id = this.nextId++;
    let frame: string;
    try {
      const envelope: NanoRemoteWebToServerV1 = { t: 'msg', d: { k: 'req', id, cmd: command, args } };
      frame = JSON.stringify(envelope);
    } catch {
      return Promise.reject(refusal('remote-invalid'));
    }
    if (exceedsFrame(frame)) return Promise.reject(refusal('remote-too-large'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id, frame, resolve, reject });
      this.drain();
    });
  }

  // -------------------------------------------------------------------------

  private is(phase: Phase): boolean {
    return this.phase === phase;
  }

  private arm(milliseconds: number): void {
    this.disarm();
    this.timer = setTimeout(() => this.fail('network'), milliseconds);
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(state: ConnectionState): void {
    this.current = state;
    for (const handler of [...this.states]) {
      try {
        handler(state);
      } catch {
        // A faulty observer never stops the session.
      }
    }
  }

  private fail(reason: ClosedReason): void {
    this.finish({ kind: 'closed', reason });
  }

  private finish(state: ConnectionState): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.disarm();
    this.settleAll();
    const socket = this.socket;
    this.socket = undefined;
    this.publish(state);
    if (socket === undefined) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      // Already closed.
    }
  }

  private send(message: NanoRemoteViewerMessageV1): void {
    const envelope: NanoRemoteWebToServerV1 = { t: 'msg', d: message };
    try {
      this.socket?.send(JSON.stringify(envelope));
    } catch {
      this.fail('network');
    }
  }

  private async receive(data: unknown): Promise<void> {
    if (this.is('done')) return;
    try {
      if (typeof data !== 'string' || exceedsFrame(data)) return this.fail('protocol');
      const frame: unknown = JSON.parse(data);
      if (!isRecord(frame)) return this.fail('protocol');
      if (frame.t === 'ready') return await this.handleReady(frame);
      if (frame.t === 'msg') return await this.handleInner(frame.d);
      // Any other envelope kind is an additive extension: ignored.
    } catch {
      this.fail('protocol');
    }
  }

  private async handleReady(frame: Record<string, unknown>): Promise<void> {
    const { viewer, device } = frame;
    if (!this.is('connecting') || typeof viewer !== 'string' || !VIEWER_ID.test(viewer)) return this.fail('protocol');
    if (!isRecord(device) || device.id !== this.options.deviceId || typeof device.name !== 'string') return this.fail('protocol');
    this.viewerId = viewer;
    this.deviceName = device.name;
    this.rawKey = await this.options.identity.publicKeyRaw();
    if (!this.is('connecting')) return;
    this.phase = 'hello';
    this.send({ k: 'hello', proto: NANO_REMOTE_PROTOCOL, key: toBase64Url(this.rawKey), label: this.options.label });
    this.arm(STEP_MS);
  }

  private async handleInner(inner: unknown): Promise<void> {
    if (!isRecord(inner)) return;
    switch (inner.k) {
      case 'challenge':
        return await this.handleChallenge(inner);
      case 'approval':
        return this.handleApproval(inner);
      case 'denied':
        return this.handleDenied(inner);
      case 'welcome':
        return this.handleWelcome(inner);
      case 'res':
        return this.handleResult(inner);
      case 'part':
        return this.handlePart(inner);
      case 'ev':
        return this.handleEvent(inner);
      case 'bye':
        return this.handleBye(inner);
      default:
        // Unknown inner kinds are ignored (additive within v1).
        return;
    }
  }

  private async handleChallenge(frame: Record<string, unknown>): Promise<void> {
    const { nonce } = frame;
    if (!this.is('hello') || this.rawKey === undefined || typeof nonce !== 'string' || (fromBase64Url(nonce)?.length ?? 0) < 16) return this.fail('protocol');
    this.expectedCode = await pairingCode(this.rawKey, nonce);
    const signature = await this.options.identity.sign(nanoRemoteProofMessage(this.options.deviceId, this.viewerId, nonce));
    if (!this.is('hello')) return;
    this.phase = 'proof';
    this.send({ k: 'proof', sig: signature });
    this.arm(STEP_MS);
  }

  private handleApproval(frame: Record<string, unknown>): void {
    const { code, expiresIn } = frame;
    if (!this.is('proof') || typeof code !== 'string' || !/^\d{6}$/.test(code) || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return this.fail('protocol');
    // The code shown here is the one this browser computed from its own key. A relay that
    // substituted the key would make the computer show a different one, and a host that
    // disagrees with the local value is not a host to pair with.
    if (this.expectedCode === undefined || code !== this.expectedCode) return this.fail('protocol');
    const seconds = Math.min(Math.max(Math.round(expiresIn), 1), 600);
    this.phase = 'approval';
    this.arm(seconds * 1000 + STEP_MS);
    this.publish({ kind: 'approval', code: this.expectedCode, deviceName: this.deviceName, expiresIn: seconds });
  }

  private handleDenied(frame: Record<string, unknown>): void {
    if (!this.is('proof') && !this.is('approval')) return;
    const reason = DENIED.find((item) => item === frame.reason) ?? 'denied';
    this.finish({ kind: 'denied', reason });
  }

  private handleWelcome(frame: Record<string, unknown>): void {
    if (!this.is('proof') && !this.is('approval')) return this.fail('protocol');
    const welcome = parseWelcome(frame);
    if (welcome === undefined || welcome.device.id !== this.options.deviceId) return this.fail('protocol');
    this.welcome = welcome;
    this.commandSet = new Set(welcome.commands);
    this.channelSet = new Set(welcome.channels);
    this.phase = 'welcomed';
    this.disarm();
    this.publish({ kind: 'welcomed', welcome });
  }

  private handleBye(frame: Record<string, unknown>): void {
    const reason = BYE.find((item) => item === frame.reason);
    this.fail(reason === undefined ? 'network' : (reason as ClosedReason));
  }

  private handleEvent(frame: Record<string, unknown>): void {
    const { ch } = frame;
    if (!this.is('welcomed') || typeof ch !== 'string' || !this.channelSet.has(ch)) return;
    for (const handler of [...this.events]) {
      try {
        handler(ch, frame.p);
      } catch {
        // One faulty listener never stops the others; the payload is not logged.
      }
    }
  }

  // ---- requests ----------------------------------------------------------

  /** At most `maxInFlight` requests are on the wire; the rest wait here instead of being refused as busy. */
  private drain(): void {
    while (this.is('welcomed') && this.queue.length > 0 && this.pending.size < NANO_REMOTE_LIMITS.maxInFlight) {
      const item = this.queue.shift();
      if (item === undefined) return;
      const timer = setTimeout(() => this.settle(item.id, false, refusal('remote-timeout')), NANO_REMOTE_LIMITS.requestTimeoutMs);
      this.pending.set(item.id, { resolve: item.resolve, reject: item.reject, timer });
      try {
        this.socket?.send(item.frame);
      } catch {
        this.settle(item.id, false, refusal('remote-not-connected'));
      }
    }
  }

  private settle(id: number, ok: boolean, value: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    this.assemblies.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(value);
    else pending.reject(value);
    this.drain();
  }

  private settleAll(): void {
    const error = refusal('remote-not-connected');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const item of this.queue) item.reject(error);
    this.pending.clear();
    this.queue.length = 0;
    this.assemblies.clear();
  }

  private handleResult(frame: Record<string, unknown>): void {
    const { id, ok } = frame;
    if (!this.is('welcomed') || typeof id !== 'number') return;
    if (ok === true) this.settle(id, true, frame.value);
    else if (ok === false) this.settle(id, false, frame.error);
  }

  /** `part` frames carry slices of the JSON text of one large result; join them in `seq` order. */
  private handlePart(frame: Record<string, unknown>): void {
    const { id, seq, last, ok, data } = frame;
    if (!this.is('welcomed') || typeof id !== 'number' || !this.pending.has(id)) return;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || typeof data !== 'string' || typeof last !== 'boolean' || typeof ok !== 'boolean') {
      return this.settle(id, false, refusal('remote-invalid'));
    }
    let assembly = this.assemblies.get(id);
    if (assembly === undefined) {
      assembly = { ok, parts: new Map(), bytes: 0, last: undefined };
      this.assemblies.set(id, assembly);
    }
    if (assembly.parts.has(seq)) return;
    assembly.bytes += utf8Length(data);
    if (assembly.bytes > NANO_REMOTE_LIMITS.maxResultBytes) return this.settle(id, false, refusal('remote-too-large'));
    assembly.parts.set(seq, data);
    if (seq === 0) assembly.ok = ok;
    if (last) assembly.last = seq;
    const total = assembly.last;
    if (total === undefined) return;
    if ([...assembly.parts.keys()].some((key) => key > total)) return this.settle(id, false, refusal('remote-invalid'));
    if (assembly.parts.size !== total + 1) return; // A slice is still on its way.
    const text = Array.from({ length: total + 1 }, (_, index) => assembly.parts.get(index) ?? '').join('');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.settle(id, false, refusal('remote-invalid'));
    }
    this.settle(id, assembly.ok, value);
  }
}
