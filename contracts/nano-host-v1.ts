/**
 * Nano host protocol 1, `nano-host/1` (ADR-080, Stage 9A security core).
 *
 * The end-to-end protocol between two Nano Desktops of one account: the
 * controller, where the owner works, and a target execution host, another
 * Desktop whose owner enabled remote execution on it and paired the two at
 * both computers. It runs inside TLS 1.3 with mutual raw public keys. The
 * relay of `nano-hosts-v1.ts` carries only opaque TLS bytes and authenticates
 * nothing end to end: its key directory is untrusted, and an OAuth device is
 * never execution authority.
 *
 * Only the Rust hosts speak this protocol. The WebView never receives an
 * identity key, a SAS secret, a channel binding, a MAC or a frame.
 *
 * Implementation: `crates/piui-remote-host` (channel, pairing, framing,
 * identifiers, command identity and journal, grant policy). Vectors:
 * `fixtures/unified-shell/nano-host-v1.json`, produced by an independent
 * Python standard-library generator from published sources (RFC 7748 6.1,
 * RFC 8032 7.1 TEST 1, RFC 8410 10.1, RFC 9562 B.2) and checked by the
 * crate's tests.
 *
 * The pairing follows the Matrix `m.sas.v1` design with the current Matrix
 * algorithms, built on vodozemac 0.11.2, but its messages and transcript are
 * this protocol's own: it is NOT interoperable with Matrix clients.
 *
 * This file freezes only what the security core decides. Open, for root at
 * integration: the arguments, canonical bytes and controller projections of
 * each command; the read commands and events; the envelope that carries
 * commands, journal answers and outcomes; the WebView <-> host forms on both
 * computers; key rotation. Nothing here is a scheduler, a queue or a generic
 * remote procedure call.
 */
import type { PermissionMode, Revision } from './orchestration-v6';

export const NANO_HOST_PROTOCOL_VERSION = 1 as const;
/** The only TLS ALPN identifier and the protocol label of every transcript. */
export const NANO_HOST_PROTOCOL = 'nano-host/1' as const;
export const NANO_HOST_ALPN = NANO_HOST_PROTOCOL;

// ---------------------------------------------------------------------------
// Encodings and identifiers
// ---------------------------------------------------------------------------

/**
 * The only binary text encoding: base64url without padding (RFC 4648
 * section 5). Exactly one text per value is accepted: no padding, no other
 * alphabet, no non-zero trailing bits.
 */
export type NanoBase64UrlV1 = string;

/**
 * An identity key: the canonical text of the exact 44-byte DER
 * SubjectPublicKeyInfo of an Ed25519 key (RFC 8410 section 4; fixed prefix
 * `302a300506032b6570032100`), 59 characters. The key must decode to a curve
 * point that is not of small order. A pin compares these bytes exactly.
 */
export type NanoHostSpkiV1 = string;

/**
 * Server-issued OAuth device id: `dev_` and 22 base64url characters that
 * encode 128 bits (the server's `GenerateDeviceId`). Names an installation;
 * never authority by itself.
 */
export type NanoDeviceIdV1 = `dev_${string}`;
/** Server-issued execution host id, same shape (`nano-hosts-v1.ts`). */
export type NanoHostIdV1 = `hst_${string}`;
/** Grant id, same shape, drawn by the target from the system random generator. */
export type NanoHostGrantIdV1 = `hgr_${string}`;
/** The server's opaque `NanoUserV1.id`: non-empty, no control character. */
export type NanoAccountIdV1 = string;
/**
 * A command id: canonical lowercase hyphenated UUID of version 4 with the RFC
 * 9562 variant, drawn by the controller for each effectful command. The same
 * id is reused when the controller repeats that command.
 */
export type NanoHostCommandIdV1 = string;

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

/**
 * The TLS server is the target, the TLS client the controller.
 *
 * TLS profile (rustls 0.23 with the ring provider), every rule fail-closed:
 * - TLS 1.3 only, with the ring provider's default cipher suites
 *   (TLS13_AES_256_GCM_SHA384, TLS13_AES_128_GCM_SHA256,
 *   TLS13_CHACHA20_POLY1305_SHA256) and groups (X25519, secp256r1,
 *   secp384r1);
 * - both sides present and require an RFC 7250 raw public key: exactly one
 *   {@link NanoHostSpkiV1}, no chain; handshake signatures Ed25519 only;
 * - ALPN {@link NANO_HOST_ALPN} offered and required by both sides;
 * - no resumption, session tickets, PSK, early data or SNI; a resumed
 *   handshake or a client that sends a server name is refused;
 * - a pairing channel only observes the peer key and authorizes nothing;
 *   every other channel requires the peer key to equal its pin byte for byte;
 * - every error ends the channel; recovery is a new channel with a full
 *   handshake. Records that the relay drops, repeats, reorders or alters fail
 *   TLS record protection.
 */
export type NanoHostChannelRoleV1 = 'target' | 'controller';

/**
 * RFC 9266 `tls-exporter` of the channel. It is never sent; it enters the
 * pairing transcript, so pairing binds to this exact TLS session. The empty
 * context gives the same value as no context (RFC 8446 section 7.5).
 */
export const NANO_HOST_CHANNEL_BINDING = {
  label: 'EXPORTER-Channel-Binding',
  context: '',
  length: 32,
} as const;

// ---------------------------------------------------------------------------
// Framing inside TLS
// ---------------------------------------------------------------------------

/**
 * A message is a 4-byte big-endian payload length followed by the payload,
 * one UTF-8 JSON document. An empty payload or a declared length above
 * {@link NANO_HOST_MAX_MESSAGE_BYTES} ends the channel before any payload
 * byte is buffered; so does a stream that ends inside a message.
 */
export const NANO_HOST_LENGTH_PREFIX_BYTES = 4;

/**
 * The largest payload. Not a new limit: it is `MAX_API_BODY` of
 * `crates/piui-nano/src/net.rs`, the Desktop API document cap that the cloud
 * stream applies per event too, and it changes only with that cap (open value
 * V3: large snapshots).
 */
export const NANO_HOST_MAX_MESSAGE_BYTES = 2_097_152;

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * The v1 algorithm set; `pairing.start` must carry exactly these values.
 * `curve25519-hkdf-sha256` and `hkdf-hmac-sha256.v2` are the current Matrix
 * SAS algorithms; no deprecated MAC or curve method exists here.
 */
export const NANO_HOST_PAIRING_ALGORITHMS = {
  keyAgreement: 'curve25519-hkdf-sha256',
  hash: 'sha256',
  mac: 'hkdf-hmac-sha256.v2',
  sas: 'decimal',
} as const;

/**
 * Messages of a pairing channel, each one framed message. The encoding is
 * canonical: `type` first, then the fields in the order written here, no
 * whitespace, strings escaped as serde_json writes them. Other bytes, an
 * unknown field or a missing field are `invalid-message`.
 *
 * Order (C = controller, T = target; both owners at their computers):
 * 1. C sends `pairing.start` with its view of the account, the target host
 *    and its own device. T refuses other algorithms (`unknown-method`), then
 *    any identity that differs from its own view (`identity-mismatch`): its
 *    sign-in, its host registration and the controller device the relay
 *    announced for the channel.
 * 2. T sends `pairing.accept` with its commitment.
 * 3. C sends `pairing.key`, its ephemeral key.
 * 4. T sends `pairing.key`; C checks the commitment against it and the exact
 *    `pairing.start` bytes it sent (`mismatched-commitment`).
 * 5. Both derive the code. C shows it; T's owner types it on T.
 * 6. T sends `pairing.mac`, only after the typed code matched.
 * 7. C verifies it (`key-mismatch`), then asks its owner whether T showed
 *    that the codes matched. Only after "yes" does C store the pin durably
 *    and send its own `pairing.mac`.
 * 8. T verifies it, records the grant durably, registers it with the server
 *    and sends `pairing.paired`.
 *
 * Either side may send `pairing.cancel` until C's MAC is sent; after that T
 * decides alone, and C keeps its stored pin only if the server then lists a
 * grant of T for C. A message out of turn ends pairing with
 * `unexpected-message`. An ended pairing stores nothing, and no side retries
 * by itself: a new attempt is a new channel with new ephemeral keys.
 */
export type NanoHostPairingMessageV1 =
  | {
      readonly type: 'pairing.start';
      readonly keyAgreement: 'curve25519-hkdf-sha256';
      readonly hash: 'sha256';
      readonly mac: 'hkdf-hmac-sha256.v2';
      readonly sas: 'decimal';
      readonly accountId: NanoAccountIdV1;
      readonly hostId: NanoHostIdV1;
      readonly controllerDeviceId: NanoDeviceIdV1;
    }
  | { readonly type: 'pairing.accept'; readonly commitment: NanoBase64UrlV1 }
  | { readonly type: 'pairing.key'; readonly key: NanoBase64UrlV1 }
  | { readonly type: 'pairing.mac'; readonly mac: NanoBase64UrlV1 }
  | { readonly type: 'pairing.paired'; readonly grantId: NanoHostGrantIdV1 }
  | { readonly type: 'pairing.cancel'; readonly code: NanoHostCancelCodeV1 };

/**
 * Why pairing ended. `window-closed` is the target's answer to a pairing
 * channel that arrives while its owner has no pairing window open.
 */
export type NanoHostCancelCodeV1 =
  | 'user'
  | 'mismatched-sas'
  | 'mismatched-commitment'
  | 'key-mismatch'
  | 'identity-mismatch'
  | 'unknown-method'
  | 'invalid-key'
  | 'unexpected-message'
  | 'invalid-message'
  | 'window-closed';

/**
 * Ephemeral keys (`pairing.key`): the 32-byte X25519 public key (RFC 7748),
 * a fresh one per attempt, in its canonical encoding: the unused top bit is
 * clear and the little-endian u-coordinate is below 2^255 - 19. A key equal
 * to the receiver's own key is refused, and so is a key for which X25519 is
 * not contributory (an all-zero shared secret from a small-order point, as
 * vodozemac checks). All of these are `invalid-key`.
 */
export const NANO_HOST_EPHEMERAL_KEY_BYTES = 32;

/**
 * A field of a transcript string: `|`, the byte length of the value as ASCII
 * decimal without leading zeros, `:`, then the value's UTF-8 bytes. Each
 * string is a fixed ASCII label followed by its fields in a fixed order.
 * Ephemeral keys and the channel binding appear as {@link NanoBase64UrlV1};
 * TLS keys as {@link NanoHostSpkiV1}. Each side builds the strings from its
 * own observation, so any difference (including a TLS key substituted by a
 * relay that terminated TLS) changes the code and both MAC keys.
 *
 * - Commitment (`pairing.accept`): SHA-256 of
 *   `NANO_HOST_PAIRING_COMMITMENT_V1` + target ephemeral key + the exact
 *   `pairing.start` bytes.
 * - SAS info: `NANO_HOST_PAIRING_SAS_V1` + protocol + key agreement + hash +
 *   MAC method + SAS method + account + host + controller device + target TLS
 *   key + controller TLS key + target ephemeral key + controller ephemeral
 *   key + channel binding.
 * - MAC info of a sender: `NANO_HOST_PAIRING_MAC_V1` + protocol + sender role
 *   ({@link NanoHostChannelRoleV1}) + account + host + controller device +
 *   target TLS key + controller TLS key + channel binding + `tls-spki`.
 * - MAC input of a sender: its TLS key text as the receiver observed it.
 */
export const NANO_HOST_PAIRING_LABELS = {
  commitment: 'NANO_HOST_PAIRING_COMMITMENT_V1',
  sas: 'NANO_HOST_PAIRING_SAS_V1',
  mac: 'NANO_HOST_PAIRING_MAC_V1',
  macKeyId: 'tls-spki',
} as const;

/**
 * Derivations, all from the X25519 shared secret of the two ephemeral keys
 * (vodozemac 0.11.2 `EstablishedSas`):
 * - SAS bytes: HKDF-SHA-256 (RFC 5869) without salt, info = SAS info, 6
 *   bytes;
 * - the code: three numbers from bytes b0..b4 (b5 unused, 39 bits),
 *   `(b0 << 5 | b1 >> 3) + 1000`, `((b1 & 7) << 10 | b2 << 2 | b3 >> 6) + 1000`,
 *   `((b3 & 63) << 7 | b4 >> 1) + 1000`, each from 1000 to 9191 (the Matrix
 *   `decimal` method);
 * - MAC key of a sender: HKDF-SHA-256 without salt, info = its MAC info, 32
 *   bytes; MAC: HMAC-SHA-256 of its MAC input, sent as 43 base64url
 *   characters and verified in constant time.
 *
 * The owner types twelve ASCII digits on the target; spaces and hyphens are
 * ignored. Other text, or a group outside 1000..9191, is refused and leaves
 * the attempt open for correction. A well-formed different code ends the
 * attempt with `mismatched-sas`. The comparison is constant time.
 */
export const NANO_HOST_SAS = {
  bytes: 6,
  numbers: 3,
  min: 1000,
  max: 9191,
  bits: 39,
} as const;

// ---------------------------------------------------------------------------
// Commands, identity binding and the journal
// ---------------------------------------------------------------------------

/**
 * The effectful command kinds the target journals. Reads are not journaled.
 * Arguments and canonical bytes per kind are open (root); a kind's name is
 * part of its binding digest, so renaming one is a protocol change.
 */
export const NANO_HOST_COMMAND_KINDS = [
  'createSession',
  'composer.send',
  'composer.remove',
  'interrupt',
  'respond',
  'runs.start',
  'runs.cancel',
  'runs.cancelTask',
  'runs.reject',
] as const;
export type NanoHostCommandKindV1 = (typeof NANO_HOST_COMMAND_KINDS)[number];

/**
 * The digest that binds a command to its id, stored instead of the command:
 * SHA-256 of `"nano-host-v1" 0x00 "command" 0x00 grantId 0x00 kind 0x00
 * commandId 0x00` followed by the canonical bytes of the command as the
 * target accepted it. No command text is kept for deduplication. The digest
 * is not secret: whoever reads the journal and guesses a whole command can
 * test the guess.
 */
export type NanoHostBindingDigestV1 = NanoBase64UrlV1;

/**
 * Owner-store ids derived from a command, so that a repeated command reaches
 * the owner store with the same key even if the journal was lost: the first
 * 16 bytes of SHA-256(`"nano-host-v1" 0x00 domain 0x00 grantId 0x00
 * commandId`) as an RFC 9562 version 8 UUID. Not secret; a controller cannot
 * aim it at an existing local id, which are all version 4.
 */
export const NANO_HOST_DERIVED_DOMAINS = {
  createSession: 'session',
  'composer.send': 'composer',
  'runs.start': 'run',
} as const satisfies Partial<Record<NanoHostCommandKindV1, string>>;
export type NanoHostDerivedDomainV1 =
  (typeof NANO_HOST_DERIVED_DOMAINS)[keyof typeof NANO_HOST_DERIVED_DOMAINS];

/** The recorded outcome of an admitted command. */
export type NanoHostCommandOutcomeV1 =
  /** The effect happened; `revision` when the owner store has one. */
  | { readonly type: 'applied'; readonly revision?: Revision }
  /** The effect certainly did not happen. Not repeated automatically. */
  | { readonly type: 'not-applied'; readonly reason: 'owner-refused' | 'absent-after-restart' }
  /** The effect may have happened. Never repeated. */
  | {
      readonly type: 'outcome-unknown';
      readonly reason: 'host-restarted' | 'delivery-uncertain' | 'effect-uncertain';
    }
  /** The grant was revoked before the effect started. */
  | { readonly type: 'cancelled-by-revocation' };

/**
 * Admission of a command id by the target's journal (one journal per grant):
 * - new id: the intent is written and synced before any effect; the effect
 *   runs; its outcome is recorded;
 * - same id, same binding digest: the recorded outcome, or "in progress"
 *   while it runs in this process;
 * - same id, different digest: conflict, nothing runs;
 * - an intent without outcome after a restart, or an entry that cannot be
 *   read: unresolved. It never runs again automatically; the host reconciles
 *   it with the owner stores and records an outcome. A recorded outcome is
 *   never replaced.
 * A policy refusal ({@link NanoHostPolicyRefusalV1}) is answered at once and
 * not journaled. The envelope of these answers to the controller is open.
 *
 * Storage, app-owned and separate from every rebuildable index:
 * `<app_data>/remote-host-v1/journal/<grantId>/`, two create-only files per
 * command, each written completely and synced before the next step. One
 * process holds a journal: it locks `<grantId>.lock` beside the directory
 * for as long as the journal or any command it admitted is open. The lock
 * file stays empty and is never deleted, not even with the grant, so every
 * later holder locks the same file. A file cut short by a crash does not
 * parse, so the entry reads as unresolved, never as a wrong outcome. The
 * directory itself is not synced: durability is claimed for a process crash,
 * not for a power loss (open question R4). Entries live as long as the grant
 * and are deleted with it; there is no expiry and no size limit.
 */
export interface NanoHostJournalIntentV1 {
  readonly version: 1;
  readonly grantId: NanoHostGrantIdV1;
  readonly commandId: NanoHostCommandIdV1;
  readonly kind: NanoHostCommandKindV1;
  readonly bindingDigest: NanoHostBindingDigestV1;
  /** Admission order within the journal, from 1. */
  readonly seq: number;
  /** Present exactly for the kinds of {@link NANO_HOST_DERIVED_DOMAINS}. */
  readonly derivedId?: string;
}

/** `<commandId>.settled.json`, written after the effect. */
export interface NanoHostJournalSettledV1 {
  readonly version: 1;
  readonly commandId: NanoHostCommandIdV1;
  readonly bindingDigest: NanoHostBindingDigestV1;
  readonly outcome: NanoHostCommandOutcomeV1;
}

export const NANO_HOST_JOURNAL_FILES = {
  /** `<grantId>.lock`, beside the journal directory, never deleted. */
  lockSuffix: '.lock',
  intentSuffix: '.intent.json',
  settledSuffix: '.settled.json',
} as const;

// ---------------------------------------------------------------------------
// Grants and policy (target-local; never sent by the relay)
// ---------------------------------------------------------------------------

/**
 * File permissions and network access, as a ceiling or as a request. The
 * modes are `PermissionMode` of orchestration v6.
 */
export interface NanoHostPermissionsV1 {
  readonly permissionMode: PermissionMode;
  readonly networkAccess: boolean;
}

/**
 * A ceiling covers a request exactly as `spawn_permissions_subset` of
 * `piui-orchestration` compares a child profile with its parent: `native`
 * compares only with `native` of the same harness, anything else with
 * `native` on one side is `incomparable`; otherwise `full-access` covers all
 * three other modes, `workspace-write` covers itself and `read-only`, and
 * `read-only` covers itself; network access may not exceed the ceiling's.
 * A ceiling is a request to the native harness, not a sandbox.
 */
export type NanoHostCeilingResultV1 = 'ok' | 'incomparable' | 'exceeded';

/**
 * The owner's remote policy on a target. Projects must also be trusted at
 * the moment of admission; a harness without a ceiling is not allowed.
 * Local sessions are not affected by it.
 */
export interface NanoHostPolicyV1 {
  readonly enabled: boolean;
  /** Local project ids, sorted. */
  readonly allowedProjects: readonly string[];
  /** Keyed by the host's harness identity text (`codex`, `acp:gemini-cli`, ...). */
  readonly ceilings: Readonly<Record<string, NanoHostPermissionsV1>>;
}

export type NanoHostGrantStateV1 = 'pending-registration' | 'active' | 'revoking';

/** The target's durable record of one paired controller. */
export interface NanoHostGrantRecordV1 {
  readonly grantId: NanoHostGrantIdV1;
  readonly state: NanoHostGrantStateV1;
  readonly accountId: NanoAccountIdV1;
  readonly hostId: NanoHostIdV1;
  readonly controllerDeviceId: NanoDeviceIdV1;
  /** Verified at pairing: the pin of every channel of this grant. */
  readonly controllerSpki: NanoHostSpkiV1;
}

/**
 * Why a request is refused, in the order the target checks: remote execution
 * enabled; a pinned target channel; the channel key equals the grant's pin;
 * the grant is active; its account and host equal the target's current
 * sign-in and registration. Then, per command: project selected and still
 * trusted; harness has a ceiling; the permissions are within it.
 */
export type NanoHostPolicyRefusalV1 =
  | 'host-disabled'
  | 'channel-not-pinned'
  | 'peer-key-changed'
  | 'grant-inactive'
  | 'account-mismatch'
  | 'host-mismatch'
  | 'project-not-allowed'
  | 'project-not-trusted'
  | 'harness-not-allowed'
  | 'ceiling-incomparable'
  | 'ceiling-exceeded';

// ---------------------------------------------------------------------------
// Identity custody (no wire)
// ---------------------------------------------------------------------------

/**
 * Each installation has one Ed25519 identity key. Its secret, a PKCS#8 v2
 * document (RFC 5958), exists only in memory and in a durable OS credential
 * store: the Windows Credential Manager, the macOS Keychain, or the
 * freedesktop Secret Service once root enables a keyring backend for it.
 * There is no file store. Without a durable store the feature stays off. A
 * stored secret that does not load is never replaced silently, since a new
 * key would invalidate every pin of the installation; a store that does not
 * return the secret it accepted fails closed.
 *
 * The first use (read, and only for an empty entry create, write and read
 * back) holds one exclusive ownership of the store entry across every handle
 * and process, so two first uses end with one identity and a failed one
 * removes only its own write. The OS stores give no such ownership (a write
 * replaces the entry), so the store implementation must add a cross-process
 * lock that holds no secret; that implementation does not exist yet.
 */
export const NANO_HOST_IDENTITY_KEY = {
  algorithm: 'ed25519',
  spkiBytes: 44,
  secretFormat: 'pkcs8-v2',
} as const;
