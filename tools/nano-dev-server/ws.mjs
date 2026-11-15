// A zero-dependency subset of RFC 6455 for the synthetic Nano development server
// and its tests: the opening handshake, text and binary messages with
// fragmentation, ping/pong, close, and a payload cap. No extensions, no
// compression. Node >= 22. Not a general WebSocket library.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** One frame or one reassembled message above this closes with 1009. */
export const MAX_PAYLOAD = 262_144;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** `Sec-WebSocket-Accept` for a client key (RFC 6455 section 4.2.2). */
export function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/** A syntactically valid client key: 16 random bytes in base64. */
export function isClientKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(value);
}

function encodeFrame(opcode, payload, masked) {
  const length = payload.length;
  const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  const maskBit = masked ? 0x80 : 0;
  if (lengthBytes === 0) {
    header[1] = maskBit | length;
  } else if (lengthBytes === 2) {
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!masked) return Buffer.concat([header, payload]);
  const mask = crypto.randomBytes(4);
  mask.copy(header, header.length - 4);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4];
  return Buffer.concat([header, body]);
}

/** One complete text frame. `masked` is true for frames a client sends. */
export function encodeText(text, masked = false) {
  return encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'), masked);
}

export function encodeBinary(data, masked = false) {
  return encodeFrame(OP_BINARY, Buffer.from(data), masked);
}

export function encodePing(payload = Buffer.alloc(0), masked = false) {
  return encodeFrame(OP_PING, Buffer.from(payload), masked);
}

export function encodePong(payload = Buffer.alloc(0), masked = false) {
  return encodeFrame(OP_PONG, Buffer.from(payload), masked);
}

export function encodeClose(code, reason = '', masked = false) {
  const text = Buffer.from(reason, 'utf8').subarray(0, 120);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(OP_CLOSE, payload, masked);
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Incremental frame parser. `push(chunk)` returns the events the chunk
 * completed, in order: `{ type: 'text', text }`, `{ type: 'binary', data }`,
 * `{ type: 'ping', data }`, `{ type: 'pong', data }`, `{ type: 'close', code,
 * reason }` and, once, `{ type: 'error', code }` (1002 protocol, 1007 text
 * that is not UTF-8, 1009 too large) after which the reader ignores input.
 *
 * `expectMasked` is true on the server side (RFC 6455: a client's frames must
 * be masked) and false on the client side (a server's frames must not be).
 */
export class FrameReader {
  constructor({ expectMasked, maxPayload = MAX_PAYLOAD }) {
    this.expectMasked = expectMasked;
    this.maxPayload = maxPayload;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentBytes = 0;
    this.failed = false;
  }

  push(chunk) {
    const events = [];
    if (this.failed) return events;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const fail = (code) => {
      this.failed = true;
      this.buffer = Buffer.alloc(0);
      events.push({ type: 'error', code });
    };
    while (!this.failed) {
      const buffer = this.buffer;
      if (buffer.length < 2) break;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if ((first & 0x70) !== 0) return fail(1002), events;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return fail(1009), events;
        length = Number(big);
        offset = 10;
      }
      if (masked !== this.expectMasked) return fail(1002), events;
      if (length > this.maxPayload) return fail(1009), events;
      const isControl = opcode >= 0x8;
      if (isControl && (!fin || length > 125)) return fail(1002), events;
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) break;
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      this.buffer = buffer.subarray(offset + maskLength + length);

      if (isControl) {
        if (opcode === OP_CLOSE) {
          if (payload.length === 1) return fail(1002), events;
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          let reason = '';
          try {
            reason = textDecoder.decode(payload.subarray(2));
          } catch {
            return fail(1007), events;
          }
          events.push({ type: 'close', code, reason });
        } else if (opcode === OP_PING) {
          events.push({ type: 'ping', data: payload });
        } else if (opcode === OP_PONG) {
          events.push({ type: 'pong', data: payload });
        } else {
          return fail(1002), events;
        }
        continue;
      }

      if (opcode === OP_CONTINUATION) {
        if (this.fragments.length === 0) return fail(1002), events;
      } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (this.fragments.length !== 0) return fail(1002), events;
        this.fragmentOpcode = opcode;
      } else {
        return fail(1002), events;
      }
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxPayload) return fail(1009), events;
      this.fragments.push(payload);
      if (!fin) continue;
      const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
      const kind = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentBytes = 0;
      if (kind === OP_TEXT) {
        let text;
        try {
          text = textDecoder.decode(message);
        } catch {
          return fail(1007), events;
        }
        events.push({ type: 'text', text });
      } else {
        events.push({ type: 'binary', data: message });
      }
    }
    return events;
  }
}

/**
 * One end of an upgraded connection. Events: `text` (string), `binary`
 * (Buffer), `pong`, and `close` (`{ code, reason }`, once, when the socket
 * ends; `code` is 1006 when the peer never sent a close frame).
 *
 * `role: 'server'` sends unmasked frames and requires masked input;
 * `role: 'client'` is the opposite. With `queue: true` every event is also
 * kept for `next()` (tests).
 */
export class WsPeer extends EventEmitter {
  constructor(socket, { role, head, maxPayload = MAX_PAYLOAD, queue = false, autoPong = true }) {
    super();
    this.socket = socket;
    this.masked = role === 'client';
    this.autoPong = autoPong;
    this.reader = new FrameReader({ expectMasked: role === 'server', maxPayload });
    this.closeSent = false;
    this.closeInfo = null;
    this.finalClose = null;
    this.ended = false;
    this.queueing = queue;
    this.queue = [];
    this.waiters = [];
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#input(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this.#ended());
    if (head && head.length > 0) this.#input(head);
  }

  get open() {
    return !this.closeSent && !this.ended && !this.socket.destroyed;
  }

  /** Bytes written but not yet sent to the peer. */
  get buffered() {
    return this.socket.writableLength;
  }

  #emit(event) {
    if (this.queueing) {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(event);
      else this.queue.push(event);
    }
    switch (event.type) {
      case 'text':
        this.emit('text', event.text);
        break;
      case 'binary':
        this.emit('binary', event.data);
        break;
      case 'pong':
        this.emit('pong', event.data);
        break;
      case 'close':
        this.emit('close', { code: event.code, reason: event.reason });
        break;
      default:
        break;
    }
  }

  #input(chunk) {
    for (const event of this.reader.push(chunk)) {
      if (event.type === 'ping') {
        if (this.autoPong && this.open) this.socket.write(encodePong(event.data, this.masked));
      } else if (event.type === 'close') {
        this.closeInfo = { code: event.code, reason: event.reason };
        if (!this.closeSent) {
          this.closeSent = true;
          this.socket.write(encodeClose(event.code === 1005 ? 1000 : event.code, '', this.masked));
        }
        this.socket.end();
      } else if (event.type === 'error') {
        this.closeInfo ??= { code: event.code, reason: '' };
        this.close(event.code);
        return;
      } else {
        this.#emit(event);
      }
    }
  }

  #ended() {
    if (this.ended) return;
    this.ended = true;
    this.finalClose = this.closeInfo ?? { code: 1006, reason: '' };
    this.#emit({ type: 'close', code: this.finalClose.code, reason: this.finalClose.reason });
  }

  sendText(text) {
    if (!this.open) return false;
    this.socket.write(encodeText(text, this.masked));
    return true;
  }

  sendBinary(data) {
    if (!this.open) return false;
    this.socket.write(encodeBinary(data, this.masked));
    return true;
  }

  /** Bytes exactly as given (tests of malformed input). */
  sendRaw(bytes) {
    if (this.ended || this.socket.destroyed) return false;
    this.socket.write(bytes);
    return true;
  }

  ping(payload = Buffer.alloc(0)) {
    if (!this.open) return false;
    this.socket.write(encodePing(payload, this.masked));
    return true;
  }

  /** Sends a close frame, ends the socket, and destroys it after a second if the peer does not. */
  close(code = 1000, reason = '') {
    if (this.ended || this.socket.destroyed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      this.socket.write(encodeClose(code, reason, this.masked));
    }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  destroy() {
    this.socket.destroy();
  }

  /** The next queued event (`queue: true` only); rejects after `timeoutMs`. */
  next(timeoutMs = 2000) {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (event) => (clearTimeout(timer), resolve(event)) };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        reject(new Error(`no WebSocket event within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** The next text message parsed as JSON; fails on any other event. */
  async nextJson(timeoutMs = 2000) {
    const event = await this.next(timeoutMs);
    if (event.type !== 'text') throw new Error(`expected a text message, got ${event.type}${event.code ? ` ${event.code}` : ''}`);
    return JSON.parse(event.text);
  }

  /** Resolves with `{ code, reason }` once the connection is closed (also when it already is). */
  closed(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      if (this.finalClose) return resolve(this.finalClose);
      const timer = setTimeout(() => reject(new Error(`not closed within ${timeoutMs} ms`)), timeoutMs);
      this.once('close', (info) => (clearTimeout(timer), resolve(info)));
    });
  }
}

/**
 * Opens a WebSocket with an `http.request` upgrade, so a test can set any
 * header (Node's global `WebSocket` cannot send `Authorization`).
 *
 * Resolves `{ status, headers, body, ws }`. On `101`, `ws` is a client
 * `WsPeer` with a queue; on any other status the JSON body is in `body` and
 * `ws` is `null`.
 */
export function connectRaw(url, headers = {}, protocols = []) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        ...(protocols.length > 0 ? { 'sec-websocket-protocol': protocols.join(', ') } : {}),
        ...headers,
      },
    });
    request.once('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        reject(new Error('Sec-WebSocket-Accept does not match the key'));
        return;
      }
      resolve({ status: response.statusCode, headers: response.headers, body: null, ws: new WsPeer(socket, { role: 'client', head, queue: true }) });
    });
    request.once('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        resolve({ status: response.statusCode, headers: response.headers, body, ws: null });
      });
    });
    request.once('error', reject);
    request.end();
  });
}
