import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import {
  NANO_REMOTE_CHANNELS,
  NANO_REMOTE_COMMANDS,
  NANO_REMOTE_LIMITS,
  NANO_REMOTE_SHELL_CONTRACTS,
  NANO_REMOTE_SUBPROTOCOL,
  nanoRemoteProofMessage,
  nanoRemoteViewerSocketPath,
} from '../../../contracts/nano-remote-v1';

/**
 * Test stand for the remote shell. One process plays the two ends the browser never talks to
 * directly: the Nano server relay (HTTP static files plus the WebSocket of one device) and the
 * desktop (hello, challenge, proof, approval, welcome, then every request answered by the UI Lab
 * host, which is the same fake of the Rust host the desktop UI is developed against).
 *
 * Everything the desktop side decides is computed here independently of the bundle: the pairing
 * code, the signature check, the command allowlist. A synthetic stand is not a real relay or a
 * real desktop; its evidence is reported as synthetic.
 */

const root = fileURLToPath(new URL('../../..', import.meta.url));
const bundleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist-remote');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MOUNT = '/vendor/nano-remote/';
export const DEVICE_ID = 'dev_e2e';
export const DEVICE_NAME = 'Test desktop';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export type ApprovalMode = 'manual' | 'auto';

export interface LabOptions {
  approval: ApprovalMode;
  /** Shell numbers sent in the welcome; a different one must keep the shell from mounting. */
  shell: Record<string, number>;
}

export interface Recorded {
  readonly command: string;
  readonly args: unknown;
}

/** One browser connection as the desktop sees it. */
export class Viewer {
  code = '';
  fingerprint = '';
  label = '';
  welcomed = false;
  closed: number | undefined;
  readonly requests: Recorded[] = [];
  readonly events: { channel: string; payload: unknown }[] = [];
  private nonce = '';
  private publicKey: Buffer | undefined;
  private stopEvents: (() => void)[] = [];
  private fragments: Buffer[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private proven = false;

  constructor(
    readonly id: string,
    private readonly socket: Duplex,
    private readonly lab: RemoteLab,
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.dispose());
    socket.on('error', () => this.dispose());
    this.envelope({ t: 'ready', viewer: id, device: { id: DEVICE_ID, name: DEVICE_NAME } });
  }

  /** The person pressed Allow on the desktop. */
  approve(): void {
    if (!this.proven || this.welcomed) return;
    this.send({
      k: 'welcome',
      proto: 1,
      device: { id: DEVICE_ID, name: DEVICE_NAME },
      app: { version: '0.0.0-e2e' },
      grant: 'once',
      shell: { ...NANO_REMOTE_SHELL_CONTRACTS, ...this.lab.options.shell },
      commands: [...NANO_REMOTE_COMMANDS],
      channels: [...NANO_REMOTE_CHANNELS],
    });
    this.welcomed = true;
    for (const channel of NANO_REMOTE_CHANNELS) {
      void this.lab.host().then((host) => host.listen(channel, (payload) => {
        this.events.push({ channel, payload });
        this.send({ k: 'ev', ch: channel, p: payload });
      })).then((stop) => {
        if (this.closed === undefined) this.stopEvents.push(stop);
        else stop();
      });
    }
  }

  deny(): void {
    this.send({ k: 'denied', reason: 'denied' });
    this.close(4403);
  }

  bye(reason: 'kicked' | 'disabled' | 'signed-out' | 'quit'): void {
    this.send({ k: 'bye', reason });
    this.close(4403);
  }

  /** Pushes an event the way the desktop does when something changes there. */
  push(channel: string, payload: unknown): void {
    this.send({ k: 'ev', ch: channel, p: payload });
  }

  close(code: number): void {
    if (this.closed !== undefined) return;
    const frame = Buffer.alloc(2);
    frame.writeUInt16BE(code);
    this.write(0x8, frame);
    this.dispose(code);
    this.socket.end();
  }

  private dispose(code = 1006): void {
    this.closed ??= code;
    for (const stop of this.stopEvents.splice(0)) stop();
  }

  private send(message: unknown): void {
    this.envelope({ t: 'msg', d: message });
  }

  private envelope(frame: unknown): void {
    this.write(0x1, Buffer.from(JSON.stringify(frame), 'utf8'));
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = readFrame(this.buffer);
      if (frame === undefined) return;
      this.buffer = this.buffer.subarray(frame.size);
      if (frame.opcode === 0x8) {
        this.dispose(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005);
        this.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        this.write(0xa, frame.payload);
        continue;
      }
      if (frame.opcode === 0xa) continue;
      this.fragments.push(frame.payload);
      if (!frame.fin) continue;
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.handle(text);
    }
  }

  private handle(text: string): void {
    let frame: { t?: unknown; d?: unknown };
    try {
      frame = JSON.parse(text) as { t?: unknown; d?: unknown };
    } catch {
      this.close(4400);
      return;
    }
    if (frame.t !== 'msg' || typeof frame.d !== 'object' || frame.d === null) {
      this.close(4400);
      return;
    }
    const message = frame.d as Record<string, unknown>;
    switch (message.k) {
      case 'hello':
        return this.onHello(message);
      case 'proof':
        return this.onProof(message);
      case 'req':
        return void this.onRequest(message);
      default:
        this.close(4400);
    }
  }

  private onHello(message: Record<string, unknown>): void {
    const raw = typeof message.key === 'string' ? Buffer.from(message.key, 'base64url') : Buffer.alloc(0);
    if (message.proto !== 1 || raw.length !== 65 || raw[0] !== 4 || typeof message.label !== 'string' || this.nonce !== '') {
      this.close(4400);
      return;
    }
    this.publicKey = raw;
    this.label = message.label;
    this.fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    this.nonce = randomBytes(32).toString('base64url');
    this.code = pairingCode(raw, this.nonce);
    this.send({ k: 'challenge', nonce: this.nonce });
  }

  private onProof(message: Record<string, unknown>): void {
    if (this.publicKey === undefined || this.proven || typeof message.sig !== 'string') {
      this.close(4400);
      return;
    }
    const signature = Buffer.from(message.sig, 'base64url');
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: this.publicKey.subarray(1, 33).toString('base64url'), y: this.publicKey.subarray(33, 65).toString('base64url') },
      format: 'jwk',
    });
    const text = nanoRemoteProofMessage(DEVICE_ID, this.id, this.nonce);
    if (signature.length !== 64 || !verify('sha256', Buffer.from(text, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature)) {
      this.close(4401);
      return;
    }
    this.proven = true;
    this.lab.proofs += 1;
    this.send({ k: 'approval', code: this.code, expiresIn: NANO_REMOTE_LIMITS.pairingSeconds });
    if (this.lab.options.approval === 'auto') this.approve();
  }

  private async onRequest(message: Record<string, unknown>): Promise<void> {
    const { id, cmd } = message;
    if (!this.welcomed || typeof id !== 'number' || typeof cmd !== 'string') {
      this.close(4400);
      return;
    }
    const args = typeof message.args === 'object' && message.args !== null ? message.args as Record<string, unknown> : {};
    this.requests.push({ command: cmd, args });
    this.lab.requests.push({ command: cmd, args });
    if (!(NANO_REMOTE_COMMANDS as readonly string[]).includes(cmd)) {
      this.send({ k: 'res', id, ok: false, error: { code: 'remote-not-allowed' } });
      return;
    }
    try {
      const host = await this.lab.host();
      const value = await host.invoke(cmd, args);
      this.answer(id, true, value);
    } catch (error) {
      this.answer(id, false, error);
    }
  }

  private answer(id: number, ok: boolean, value: unknown): void {
    const body = JSON.stringify(ok ? { k: 'res', id, ok: true, value } : { k: 'res', id, ok: false, error: value ?? null });
    if (Buffer.byteLength(body) <= NANO_REMOTE_LIMITS.singleResultBytes) {
      this.envelope({ t: 'msg', d: JSON.parse(body) });
      return;
    }
    const data = JSON.stringify(ok ? value : value ?? null);
    const pieces = splitUtf8(data, NANO_REMOTE_LIMITS.partBytes);
    pieces.forEach((piece, seq) => this.send({ k: 'part', id, seq, last: seq === pieces.length - 1, ok, data: piece }));
  }
}

/** The six-digit code both screens show: u32 big-endian of SHA-256(key || nonce)[0..4], mod 1e6. */
export function pairingCode(rawKey: Buffer, nonce: string): string {
  const digest = createHash('sha256').update(rawKey).update(Buffer.from(nonce, 'base64url')).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** Splits a string into pieces of at most `limit` UTF-8 bytes without cutting a character. */
function splitUtf8(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > limit) {
      pieces.push(current);
      current = '';
      size = 0;
    }
    current += character;
    size += bytes;
  }
  pieces.push(current);
  return pieces;
}

interface ParsedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  readonly size: number;
}

/** RFC 6455 client frame (always masked). `undefined` until the whole frame has arrived. */
function readFrame(buffer: Buffer): ParsedFrame | undefined {
  if (buffer.length < 2) return undefined;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== undefined) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { fin, opcode, payload, size: offset + length };
}

type LabHostModule = { createLabHost(options: { scenario: string; ambient: boolean }): HostLike };
interface HostLike {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(channel: string, handler: (payload: unknown) => void): Promise<() => void>;
}

export class RemoteLab {
  readonly options: LabOptions = { approval: 'manual', shell: {} };
  readonly viewers: Viewer[] = [];
  /** Every request any browser sent, in order. */
  readonly requests: Recorded[] = [];
  /** Handshakes whose proof the desktop side verified. */
  proofs = 0;
  /** Upgrade attempts the relay refused, with the reason. */
  readonly refused: string[] = [];
  private vite: ViteDevServer | undefined;
  private labHost: Promise<HostLike> | undefined;
  private server: Server | undefined;

  constructor(private readonly origin: () => string) {}

  get url(): string {
    return this.origin();
  }

  /** The page of the remote shell, as the Nano Web iframe loads it. */
  launch(theme: 'light' | 'dark' = 'light', language: 'en' | 'ru' = 'en'): string {
    return `${this.origin()}${MOUNT}index.html#device=${DEVICE_ID}&lang=${language}&theme=${theme}`;
  }

  /** The UI Lab host: the desktop UI's own fake of the Rust host, loaded through Vite like a unit test does. */
  host(): Promise<HostLike> {
    this.labHost ??= (async () => {
      this.vite = await createViteServer({
        configFile: false,
        root: join(root, 'apps', 'desktop'),
        logLevel: 'silent',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      const module = await this.vite.ssrLoadModule('/src/host-api/lab/labHost.ts') as LabHostModule;
      return module.createLabHost({ scenario: 'demo', ambient: false });
    })();
    return this.labHost;
  }

  /** Resolves with the next browser that connects after the ones already seen. */
  async nextViewer(timeoutMs = 20_000): Promise<Viewer> {
    const seen = this.viewers.length;
    const deadline = Date.now() + timeoutMs;
    while (this.viewers.length <= seen) {
      if (Date.now() > deadline) throw new Error('No browser connected to the test relay.');
      await new Promise((done) => setTimeout(done, 25));
    }
    return this.viewers[seen] as Viewer;
  }

  attach(server: Server): void {
    this.server = server;
    server.on('upgrade', (request, socket) => this.upgrade(request, socket));
    server.on('request', (request, response) => void this.serve(request.url ?? '/', response));
  }

  private refuse(socket: Duplex, reason: string): void {
    this.refused.push(reason);
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }

  private upgrade(request: IncomingMessage, socket: Duplex): void {
    const path = (request.url ?? '').split('?')[0];
    if (path !== nanoRemoteViewerSocketPath(DEVICE_ID)) return this.refuse(socket, 'path');
    // The relay only accepts its own pages: the browser sends the page origin.
    if (request.headers.origin !== this.origin()) return this.refuse(socket, 'origin');
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((item) => item.trim());
    if (!protocols.includes(NANO_REMOTE_SUBPROTOCOL)) return this.refuse(socket, 'subprotocol');
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') return this.refuse(socket, 'key');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${NANO_REMOTE_SUBPROTOCOL}\r\n\r\n`,
    );
    this.viewers.push(new Viewer(`vw_${randomBytes(9).toString('base64url')}`, socket, this));
  }

  private async serve(url: string, response: import('node:http').ServerResponse): Promise<void> {
    let path: string;
    try {
      path = decodeURIComponent(url.split('?')[0] ?? '/');
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!path.startsWith(MOUNT)) {
      response.writeHead(404).end();
      return;
    }
    const relative = normalize(path.slice(MOUNT.length) || 'index.html');
    const file = resolve(bundleDir, relative);
    if (file !== bundleDir && !file.startsWith(bundleDir + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  }

  async close(): Promise<void> {
    for (const viewer of this.viewers) viewer.close(1001);
    await new Promise<void>((done) => (this.server === undefined ? done() : this.server.close(() => done())));
    this.server?.closeAllConnections();
    await this.vite?.close();
  }
}

export async function startRemoteLab(preferredPort: number): Promise<RemoteLab> {
  let address = '';
  const lab = new RemoteLab(() => address);
  const server = createHttpServer();
  lab.attach(server);
  const listen = (port: number) => new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', fail);
      done();
    });
  });
  try {
    await listen(preferredPort);
  } catch {
    await listen(0);
  }
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('The test relay has no port.');
  address = `http://127.0.0.1:${bound.port}`;
  // Loading the Lab takes a moment; do it before the first browser asks for a document.
  void lab.host();
  return lab;
}
