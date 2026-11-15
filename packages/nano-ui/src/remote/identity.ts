/**
 * The browser's identity for Nano remote access (ADR-062).
 *
 * One non-extractable ECDSA P-256 key pair per browser profile. The private key
 * never leaves WebCrypto: this module can only ask it to sign. The public key
 * goes to the desktop, which stores it as the grant of an approved browser.
 * Nothing here talks to the network.
 */

const DATABASE = 'nano-remote';
const STORE = 'keys';
const RECORD = 'viewer-v1';
const ALPHABET = /^[A-Za-z0-9_-]*$/;
const LABEL_LIMIT = 60;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url without padding; anything else is `undefined`. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!ALPHABET.test(text) || text.length % 4 === 1) return undefined;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** Byte length of the UTF-8 form of `text`; cheap for short strings. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Six digits both screens show: `u32_be(SHA-256(rawKey || nonce)[0..4]) mod 1000000`.
 * The browser computes it from its own key, so a relay that swaps the key
 * produces a code that differs from the one on the computer.
 */
export async function pairingCode(rawKey: Uint8Array, nonce: string, subtle: SubtleCrypto = crypto.subtle): Promise<string | undefined> {
  const nonceBytes = fromBase64Url(nonce);
  if (nonceBytes === undefined || nonceBytes.length === 0) return undefined;
  const joined = new Uint8Array(rawKey.length + nonceBytes.length);
  joined.set(rawKey);
  joined.set(nonceBytes, rawKey.length);
  const digest = new Uint8Array(await subtle.digest('SHA-256', joined));
  return String(new DataView(digest.buffer).getUint32(0, false) % 1_000_000).padStart(6, '0');
}

/** First 16 hex characters of SHA-256 of the raw public key; the desktop shows the same value. */
export async function keyFingerprint(rawKey: Uint8Array, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(rawKey)));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Untrusted text becomes a short single-line label. */
export function sanitizeLabel(value: string): string {
  const clean = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, LABEL_LIMIT)
    .join('')
    .trim();
  return clean === '' ? 'Browser' : clean;
}

export interface LabelEnvironment {
  readonly userAgent?: string;
  readonly userAgentData?: { readonly brands?: readonly { readonly brand: string }[]; readonly platform?: string };
}

const BRAND_NAMES: readonly (readonly [RegExp, string])[] = [
  [/microsoft edge|^edge$/i, 'Edge'],
  [/google chrome|^chrome$/i, 'Chrome'],
  [/opera/i, 'Opera'],
  [/firefox/i, 'Firefox'],
  [/safari/i, 'Safari'],
  [/brave/i, 'Brave'],
];

function brandFromData(data: LabelEnvironment['userAgentData']): string | undefined {
  for (const entry of data?.brands ?? []) {
    for (const [pattern, name] of BRAND_NAMES) if (pattern.test(entry.brand)) return name;
  }
  return undefined;
}

function brandFromAgent(agent: string): string {
  if (/Edg(?:e|A|iOS)?\//.test(agent)) return 'Edge';
  if (/OPR\/|Opera/.test(agent)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(agent)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(agent)) return 'Chrome';
  if (/Safari\//.test(agent)) return 'Safari';
  return 'Browser';
}

function systemFromAgent(agent: string): string | undefined {
  if (/Android/i.test(agent)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(agent)) return 'iOS';
  if (/Windows/i.test(agent)) return 'Windows';
  if (/CrOS/i.test(agent)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/i.test(agent)) return 'macOS';
  if (/Linux|X11/i.test(agent)) return 'Linux';
  return undefined;
}

/** "Chrome · Android": what the person sees on the computer when deciding. */
export function browserLabel(environment: LabelEnvironment | undefined = typeof navigator === 'undefined' ? undefined : (navigator as LabelEnvironment)): string {
  const agent = environment?.userAgent ?? '';
  const browser = brandFromData(environment?.userAgentData) ?? brandFromAgent(agent);
  const system = environment?.userAgentData?.platform?.trim() || systemFromAgent(agent);
  return sanitizeLabel(system ? `${browser} · ${system}` : browser);
}

// ---------------------------------------------------------------------------
// Key storage
// ---------------------------------------------------------------------------

export interface KeyStore {
  /** The stored pair, or `undefined` when there is none. */
  load(): Promise<CryptoKeyPair | undefined>;
  /** Stores `pair` unless another tab stored one first; answers the pair that is stored. */
  saveIfAbsent(pair: CryptoKeyPair): Promise<CryptoKeyPair>;
}

function isKeyPair(value: unknown): value is CryptoKeyPair {
  if (typeof value !== 'object' || value === null) return false;
  const { privateKey, publicKey } = value as { privateKey?: CryptoKey; publicKey?: CryptoKey };
  const curve = (key: CryptoKey | undefined): boolean => {
    const algorithm = key?.algorithm as { name?: string; namedCurve?: string } | undefined;
    return algorithm?.name === 'ECDSA' && algorithm.namedCurve === 'P-256';
  };
  return privateKey?.type === 'private' && publicKey?.type === 'public' && curve(privateKey) && curve(publicKey)
    && privateKey.extractable === false && privateKey.usages.includes('sign');
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable.'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
  });
}

/** IndexedDB `nano-remote` / `keys` / `viewer-v1`; `undefined` when the browser has no IndexedDB. */
export function indexedDbKeyStore(factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): KeyStore | undefined {
  if (factory === undefined) return undefined;
  return {
    async load() {
      const database = await openDatabase(factory);
      try {
        const value = await new Promise<unknown>((resolve, reject) => {
          const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed.'));
        });
        return isKeyPair(value) ? value : undefined;
      } finally {
        database.close();
      }
    },
    async saveIfAbsent(pair) {
      const database = await openDatabase(factory);
      return new Promise<CryptoKeyPair>((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        let stored = pair;
        const existing = store.get(RECORD);
        existing.onsuccess = () => {
          if (isKeyPair(existing.result)) stored = existing.result;
          else store.put({ privateKey: pair.privateKey, publicKey: pair.publicKey }, RECORD);
        };
        transaction.oncomplete = () => {
          database.close();
          resolve(stored);
        };
        const failed = () => {
          database.close();
          reject(transaction.error ?? new Error('IndexedDB write failed.'));
        };
        transaction.onerror = failed;
        transaction.onabort = failed;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export class IdentityUnavailableError extends Error {
  constructor() {
    super('WebCrypto is unavailable.');
    this.name = 'IdentityUnavailableError';
  }
}

export interface ViewerIdentity {
  /** False when the key lives in memory only: every connection then needs approval on the computer. */
  readonly persistent: boolean;
  /** The 65-byte uncompressed P-256 point. */
  publicKeyRaw(): Promise<Uint8Array>;
  /** Signature over the UTF-8 form of `message`, IEEE P1363 `r || s`, base64url. */
  sign(message: string): Promise<string>;
}

export interface OpenIdentityOptions {
  /** `undefined`: IndexedDB when present. `null`: memory only. */
  readonly store?: KeyStore | null | undefined;
  readonly subtle?: SubtleCrypto | undefined;
}

let persistenceRequested = false;
function requestPersistence(): void {
  if (persistenceRequested) return;
  persistenceRequested = true;
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    // Persistence is a hint; the key still works without it.
  }
}

export async function openIdentity(options: OpenIdentityOptions = {}): Promise<ViewerIdentity> {
  const subtle = options.subtle ?? globalThis.crypto?.subtle;
  if (subtle === undefined) throw new IdentityUnavailableError();
  const generate = (): Promise<CryptoKeyPair> => subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const store = options.store === undefined ? indexedDbKeyStore() : options.store ?? undefined;
  let pair: CryptoKeyPair | undefined;
  let persistent = false;
  if (store !== undefined) {
    try {
      pair = (await store.load()) ?? (await store.saveIfAbsent(await generate()));
      persistent = true;
      requestPersistence();
    } catch {
      // Private browsing, blocked storage or a clone failure: continue with a memory key.
      pair = undefined;
    }
  }
  const keys = pair ?? (await generate());
  let rawKey: Promise<Uint8Array> | undefined;
  return {
    persistent,
    publicKeyRaw() {
      rawKey ??= subtle.exportKey('raw', keys.publicKey).then((buffer) => new Uint8Array(buffer));
      return rawKey;
    },
    async sign(message) {
      const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(message));
      return toBase64Url(new Uint8Array(signature));
    },
  };
}
