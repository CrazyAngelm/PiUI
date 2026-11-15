import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/fixtures/nano-remote-v1.json';
import { nanoRemoteProofMessage } from '../../../../contracts/nano-remote-v1';
import { browserLabel, fromBase64Url, keyFingerprint, openIdentity, pairingCode, sanitizeLabel, toBase64Url, type KeyStore } from './identity';

const encoder = new TextEncoder();

function memoryStore(): KeyStore & { pair: CryptoKeyPair | undefined; saves: number } {
  const store = {
    pair: undefined as CryptoKeyPair | undefined,
    saves: 0,
    async load() {
      return store.pair;
    },
    async saveIfAbsent(pair: CryptoKeyPair) {
      store.saves += 1;
      store.pair ??= pair;
      return store.pair;
    },
  };
  return store;
}

async function verifier(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

describe('base64url', () => {
  it('round-trips every length without padding', () => {
    for (let length = 0; length <= 70; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256);
      const text = toBase64Url(bytes);
      expect(text).not.toMatch(/[=+/]/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  it('refuses padding, other alphabets and impossible lengths', () => {
    expect(fromBase64Url('AAAA=')).toBeUndefined();
    expect(fromBase64Url('AA+A')).toBeUndefined();
    expect(fromBase64Url('AA/A')).toBeUndefined();
    expect(fromBase64Url('A')).toBeUndefined();
    expect(fromBase64Url('AAAAA')).toBeUndefined();
    expect(fromBase64Url('')).toEqual(new Uint8Array());
  });
});

describe('pairing vector', () => {
  const key = fromBase64Url(fixture.pairingVector.key) ?? new Uint8Array();

  it('decodes to the 65-byte uncompressed point', () => {
    expect(key).toHaveLength(65);
    expect(key[0]).toBe(0x04);
    expect(key[1]).toBe(0x01);
    expect(key[64]).toBe(0x40);
  });

  it('reproduces the code and the fingerprint the desktop computes', async () => {
    expect(await pairingCode(key, fixture.pairingVector.nonce)).toBe(fixture.pairingVector.code);
    expect(await keyFingerprint(key)).toBe(fixture.pairingVector.fingerprint);
  });

  it('changes the code when the key or the nonce changes', async () => {
    const other = new Uint8Array(key);
    other[10] ^= 0xff;
    expect(await pairingCode(other, fixture.pairingVector.nonce)).not.toBe(fixture.pairingVector.code);
    expect(await pairingCode(key, toBase64Url(new Uint8Array(32).fill(0xab)))).not.toBe(fixture.pairingVector.code);
  });

  it('is six digits with leading zeros kept, and refuses a malformed nonce', async () => {
    const codes = await Promise.all(Array.from({ length: 40 }, (_, index) => pairingCode(key, toBase64Url(new Uint8Array(32).fill(index)))));
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(await pairingCode(key, 'not base64!')).toBeUndefined();
    expect(await pairingCode(key, '')).toBeUndefined();
  });

  it('shares the proof message with the contract helper', () => {
    const { deviceId, viewerId, nonce, message } = fixture.proofMessage;
    expect(nanoRemoteProofMessage(deviceId, viewerId, nonce)).toBe(message);
  });
});

describe('identity', () => {
  it('signs with a P-256 key the desktop can verify, in the 64-byte r||s form', async () => {
    const identity = await openIdentity({ store: null });
    const raw = await identity.publicKeyRaw();
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0x04);
    const { deviceId, viewerId, nonce, message } = fixture.proofMessage;
    expect(message).toBe(nanoRemoteProofMessage(deviceId, viewerId, nonce));
    const signature = fromBase64Url(await identity.sign(message)) ?? new Uint8Array();
    expect(signature).toHaveLength(64);
    const algorithm = { name: 'ECDSA', hash: 'SHA-256' };
    expect(await crypto.subtle.verify(algorithm, await verifier(raw), signature, encoder.encode(message))).toBe(true);
    for (const changed of [
      nanoRemoteProofMessage('dev_other', viewerId, nonce),
      nanoRemoteProofMessage(deviceId, 'vw_other', nonce),
      nanoRemoteProofMessage(deviceId, viewerId, 'other'),
    ]) {
      expect(await crypto.subtle.verify(algorithm, await verifier(raw), signature, encoder.encode(changed))).toBe(false);
    }
    expect(await crypto.subtle.verify(algorithm, await verifier(raw), signature.slice(0, 63), encoder.encode(message))).toBe(false);
  });

  it('generates a non-extractable private key and stores it once', async () => {
    const store = memoryStore();
    const identity = await openIdentity({ store });
    expect(identity.persistent).toBe(true);
    expect(store.saves).toBe(1);
    const stored = store.pair;
    expect(stored?.privateKey.extractable).toBe(false);
    expect(stored?.privateKey.usages).toEqual(['sign']);
    await expect(crypto.subtle.exportKey('pkcs8', stored?.privateKey as CryptoKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('jwk', stored?.privateKey as CryptoKey)).rejects.toThrow();
  });

  it('keeps the same key across opens', async () => {
    const store = memoryStore();
    const first = await (await openIdentity({ store })).publicKeyRaw();
    const second = await (await openIdentity({ store })).publicKeyRaw();
    expect(second).toEqual(first);
    expect(store.saves).toBe(1);
  });

  it('uses the key another tab stored first', async () => {
    const winner = memoryStore();
    await openIdentity({ store: winner });
    const store = {
      async load() {
        return undefined;
      },
      async saveIfAbsent() {
        return winner.pair as CryptoKeyPair;
      },
    };
    const identity = await openIdentity({ store });
    expect(await identity.publicKeyRaw()).toEqual(await (await openIdentity({ store: winner })).publicKeyRaw());
  });

  it('falls back to a memory key when storage fails, and says so', async () => {
    const broken: KeyStore = {
      async load() {
        throw new Error('blocked');
      },
      async saveIfAbsent() {
        throw new Error('blocked');
      },
    };
    const identity = await openIdentity({ store: broken });
    expect(identity.persistent).toBe(false);
    expect(await identity.sign('x')).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('marks a memory-only identity as not persistent', async () => {
    expect((await openIdentity({ store: null })).persistent).toBe(false);
  });

  it('reports a missing WebCrypto as unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      await expect(openIdentity({ store: null })).rejects.toMatchObject({ name: 'IdentityUnavailableError' });
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

describe('labels', () => {
  const chromeAndroid = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

  it('names the browser and the system', () => {
    expect(browserLabel({ userAgent: chromeAndroid })).toBe('Chrome · Android');
    expect(browserLabel({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' })).toBe('Safari · iOS');
    expect(browserLabel({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0' })).toBe('Edge · Windows');
    expect(browserLabel({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0' })).toBe('Firefox · Linux');
    expect(browserLabel({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' })).toBe('Safari · macOS');
  });

  it('prefers client hints and skips the grease brand', () => {
    const userAgentData = { brands: [{ brand: 'Not A;Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }], platform: 'Android' };
    expect(browserLabel({ userAgent: '', userAgentData })).toBe('Chrome · Android');
    expect(browserLabel({ userAgent: chromeAndroid, userAgentData: { brands: [{ brand: 'Microsoft Edge' }], platform: 'Windows' } })).toBe('Edge · Windows');
  });

  it('falls back to a plain word', () => {
    expect(browserLabel({ userAgent: '' })).toBe('Browser');
    expect(browserLabel(undefined)).toBe('Browser');
  });

  it('keeps labels short, single-line and printable', () => {
    expect(sanitizeLabel('  Chrome\n· Android\u0007\t ')).toBe('Chrome · Android');
    expect(sanitizeLabel('')).toBe('Browser');
    expect(sanitizeLabel('\n\t')).toBe('Browser');
    const long = sanitizeLabel('😀'.repeat(100));
    expect(Array.from(long)).toHaveLength(60);
  });
});
