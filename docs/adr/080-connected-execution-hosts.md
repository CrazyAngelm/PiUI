# ADR-080 — Connected execution hosts: the security core

Status: Proposed by Stage 9A of the unified-shell plan, 2026-11-15; accepted
when root commits the stage after its reviews. Corrected on 2026-11-16 after
the four reviews of the core: the journal lock lifetime and deletion
(decision 8), the identity first use (decision 2), framing (decision 3) and
the end of a relay direction (decision 6). The result document lists each
finding with its proof.

**Numbering.** The unified-shell branch called this record ADR-064. `master` already has ADR-064
(chat and project marks), so the record carries ADR-080 on `master`; the code, the
contracts and the result document were renumbered with it. The unified-shell branch's
own ADR-060, ADR-061 and ADR-064 and ADR-065 still collide with `master`'s and are
renumbered when that branch is merged.

A connected execution host is another Nano Desktop of the same account. Its
owner enabled remote execution on it and paired it with a controlling Desktop
at both computers (`FABLE_PLAN.md` Stage 9). This record fixes the part of the
feature that has to be correct regardless of the relay, the Tauri host and the
interface:

- the end-to-end channel;
- pairing with human verification;
- identity custody;
- framing;
- the grant and its policy;
- command identity with intent before effect.

The implementation is the independent crate `crates/piui-remote-host`. The
contracts are `contracts/nano-host-v1.ts`, the protocol inside TLS, and
`contracts/nano-hosts-v1.ts`, the relay wire, which is a proposal. Their
vectors are in `contracts/fixtures/unified-shell/nano-host-v1.json` and
`nano-hosts-v1.json`. The design input was the Stage 9 handoff
(`execution-devices-design/handoff.md`). It was treated as a proposal, and the
deviations from it are listed below.

## Context

- **The server must not be able to read or redirect execution.** FABLE item 7
  keeps content off the server and encrypts it between the owner's devices.
  The relay authenticates requests, not device keys:
  - a device token proves only that a request came from an active device of
    user U with scope S;
  - the server keeps the key directory and could substitute a key in it.

  So the directory is untrusted for end-to-end authentication. An OAuth
  device is never execution authority on a target. ADR-062 (`master`) chose
  differently for browser access: the server sees chat content in transit,
  and end-to-end encryption was deferred. That trade-off does not carry over
  to running agents on another computer.
- **The building blocks exist.**
  - rustls 0.23.45 with ring 0.17.14 provides TLS 1.3 with RFC 7250 raw public
    keys on both sides (`AlwaysResolves*RawPublicKeys`,
    `requires_raw_public_keys`, `verify_tls13_signature_with_raw_key`) and RFC
    9266 exporters.
  - ed25519-dalek 2.2.0 is already in the lock.
  - keyring 3.6.3 is compiled only for Windows and macOS (`piui-nano`, target
    gated).
- **No custom cryptographic primitive.** The Matrix SAS method is published
  and reviewed. vodozemac implements its building blocks: X25519 with a
  contributory check, HKDF-SHA-256 and HMAC-SHA-256. The Matrix blog of
  2026-02 warns that an audit is not a blanket proof, so the contributory and
  invalid-point checks are verified in the selected code itself (below).
- **No invented limits.** Retry, expiry, queue, concurrency, file-size and
  timeout values need protocol authority or a measurement. Those still open
  are V1–V4 of the handoff.

## Decision

1. **An independent crate that is pure host support.** `piui-remote-host` has
   no listener, HTTP client, scheduler, agent loop, provider client or generic
   remote procedure call, and `unsafe_code` is forbidden. It is sans-IO: the
   host feeds bytes in and sends bytes out over the outer relay (outgoing
   HTTPS, implemented later). Nothing in it reaches the WebView.

2. **One Ed25519 identity per installation, held only by an OS store.**
   - A pin is the exact 44-byte DER SubjectPublicKeyInfo (RFC 8410). Only that
     encoding is accepted, and its key must decode to a point that is not of
     small order (ed25519-dalek `is_weak`).
   - The secret is a PKCS#8 v2 document in zeroizing memory.
   - `KeyCustody` accepts only an `IdentitySecretStore` that declares a durable
     `CustodyBackend`: the Windows Credential Manager, the macOS Keychain, or
     the Secret Service once enabled. Otherwise custody fails with
     `NotDurable` and the feature stays off. No file store exists.
   - A stored secret that does not load is never replaced silently, since a
     new key would invalidate every pin. A store that does not return what it
     accepted has the new secret deleted and fails closed.
   - **One owner of the entry at a time.** Each custody operation runs in one
     exclusive ownership of the store entry (`IdentitySecretStore::own`),
     across every handle and process. The first use is one transaction: load,
     and for an empty entry generate, save, read back and, after a mismatch,
     delete. So two first uses end with one identity, and a cleanup removes
     only its own write. The OS stores give no such ownership (residual
     risks), so their implementation must add it. A lock per handle or per
     process is not enough.

3. **The channel: TLS 1.3 with mutual raw public keys over an abstract byte
   transport.**
   - The target is the TLS server, the controller the TLS client.
   - Settings:
     - TLS 1.3 only;
     - handshake signatures Ed25519 only;
     - client authentication mandatory;
     - exactly one presented key, with no chain;
     - fixed ALPN `nano-host/1`, offered and then required by both sides,
       because a rustls server proceeds without ALPN when the client offered
       none.
   - No resumption, tickets, PSK, 0-RTT or SNI:
     - client: `Resumption::disabled`, `enable_sni = false`,
       `enable_early_data = false`;
     - server: `NoServerSessionStorage`, `send_tls13_tickets = 0`,
       `max_tls13_tickets = 0`, `max_early_data_size = 0`, no half-RTT data;
     - a resumed handshake or a received server name fails the channel.
   - **Pins.** A pairing channel only observes the peer key
     (`ObserveForPairing`). Every other channel requires byte equality with the
     pin, checked in the verifier and again after the handshake
     (`PeerKeyChanged`).
   - **Framing.** Messages are framed with a 4-byte big-endian length. The
     limit is `MAX_API_BODY` (2 MiB), the existing Desktop API document cap.
     However the bytes are split, the decoder reads a prefix first and copies
     payload bytes only after accepting it, so a refused prefix copies none of
     the bytes behind it. Its first error is final. rustls' own 64 KiB send
     buffer is lifted because the protocol already bounds a message.
   - Every error is terminal: recovery is a new channel with a full
     handshake.

4. **Pairing: commitment-first SAS with bilateral human confirmation.**
   - **Order of messages.**
     1. The controller sends `pairing.start`, carrying the v1 algorithms
        (`curve25519-hkdf-sha256`, `sha256`, `hkdf-hmac-sha256.v2`,
        `decimal`) and its view of the account, the target host and its own
        device.
     2. The target checks the algorithms, then the identities against its own
        view. It sends `pairing.accept`, a commitment to its ephemeral key and
        to the exact `pairing.start` bytes.
     3. The controller reveals its key.
     4. The target reveals its key. The controller checks the commitment.
   - **The transcript.** Both sides derive the code from the X25519 secret
     over a transcript that binds:
     - the protocol and the algorithms;
     - the account, the target host and the controller device;
     - both exact TLS keys and both ephemeral keys;
     - the RFC 9266 `tls-exporter` of this TLS session.

     Each variable part is length-prefixed (`|len:value`). The MAC info
     carries the sender role. The MAC input is the sender's TLS key as the
     receiver observed it. Any substitution by a relay that terminated TLS
     changes the code and the MAC keys.
   - **Confirmation at the target.** The controller shows three numbers. The
     target's owner types them; the comparison is constant time. A typing
     error can be corrected. A well-formed wrong code ends the attempt
     (`mismatched-sas`), and a new attempt is a new channel with new keys.
   - **MACs and pins.**
     - The target sends its MAC only after a match.
     - The controller verifies it, then asks its owner whether the target
       showed that the codes match.
     - Only after "yes" does the controller store the pin and send its own
       MAC. Without this second confirmation, a relay that ran its own
       exchange with the controller could send a valid MAC and get its key
       pinned.
     - The target verifies the controller's MAC, then stores the grant
       (`pending-registration`), registers it and sends `pairing.paired`.
   - **Failure and cancellation.** Any message out of turn, a non-canonical
     message, a bad key, a bad commitment or a bad MAC ends pairing with
     nothing stored. So does `pairing.cancel` while the controller's MAC is
     unsent. No side retries by itself.
   - **Building blocks.** The X25519 agreement, HKDF-SHA-256 and HMAC-SHA-256
     come from vodozemac 0.11.2 `sas` with default features off. vodozemac's
     `was_contributory` check refuses small-order points. The crate also
     requires the canonical encoding (top bit clear, u < 2^255 − 19) and
     refuses a reflected key equal to the receiver's own.
   - **Not Matrix.** The messages and transcript are this protocol's own and
     are not Matrix-interoperable; only the method follows `m.sas.v1`.

5. **vodozemac is pinned to `=0.11.2`, not 0.11.1.** The assignment preferred
   0.11.1 on the premise that 0.11.2 needs Rust 1.96. That holds only for the
   `main` branch, whose manifest still says 0.11.2.
   - **The published 0.11.2 is compatible.**
     - It is on crates.io, not yanked, `cksum cafdb687…bab2f`.
     - It declares `rust-version = "1.89"` in the index, the tag manifest and
       the crate.
     - Its `src/sas.rs` and `src/types/curve25519.rs` are byte-identical to
       0.11.0 and 0.11.1.
   - **What it changes.**
     - It enables `zeroize` on its RustCrypto dependencies, hmac and sha2
       among them, which the SAS MAC uses.
     - It fixes a panic in `Ed25519PublicKey::from_base64`.
     - It clears Olm key material.

     None of the changed code is called here.
   - **Verified.** All tests and all mutations ran against 0.11.2. Reverting
     to 0.11.1 is a one-line change.

6. **Relay frames have a strict sequence.**
   - Each direction of a channel numbers `{seq, data}` from 1 in steps of 1,
     up to `Number.MAX_SAFE_INTEGER`. `data` is canonical non-empty unpadded
     base64url.
   - The receiver accepts exactly the next number. A repeated, missing or
     reordered frame, or other data, ends the channel. `Inbound` enforces
     this: after its first violation it refuses every later frame. Recovery
     is a new channel with a full handshake and a new `Inbound`.
   - The relay sees only these frames. The command id, kind and body stay
     inside TLS.

7. **Authority is a verified local grant on a pinned channel.**
   - **Authorization.** `authorize` is the only source of
     `AuthorizedController`, a value that is neither `Clone` nor stored and is
     consumed per command. It checks, in this order:
     1. remote execution is enabled;
     2. the channel is a pinned target channel;
     3. the channel key equals the grant's pin;
     4. the grant is `active`;
     5. its account and host equal the target's current sign-in and
        registration.
   - **Per command.**
     - The project must be selected and still trusted at that moment.
     - The harness must have a ceiling, and the request must stay within it.
     - The ceiling is compared exactly like `spawn_permissions_subset`:
       `native` only with `native` of the same harness, otherwise
       incomparable. Above that, `full-access` ⊇ `workspace-write` ⊇
       `read-only`, and network access may not exceed the ceiling's.
     - A ceiling is a request to the native harness, not a sandbox.
   - **Local sessions are separate.** They are untouched, and nothing here
     schedules work.

8. **The command journal: intent before effect, and no automatic replay after
   ambiguity.**
   - **Location and lock.** One app-owned directory per grant
     (`<app_data>/remote-host-v1/journal/<grantId>/`), separate from every
     rebuildable index.
     - One process holds the journal: it has an exclusive OS lock on
       `<grantId>.lock` beside the directory. The lock lasts as long as the
       journal or any command it admitted, so a running command keeps it
       after the journal value is gone.
     - The lock file stays empty and is never deleted, not even with the
       grant. So every holder locks the same file, and destroy removes the
       entries and the directory while it still holds the lock. A destroy
       that fails returns the journal, still locked.
   - **Binding.** A command is bound to its random UUIDv4 id by SHA-256 over
     the domain, the grant, the kind, the id and the command's canonical bytes.
     Only the digest is stored, so no chat body is kept for deduplication.
   - **Files and admission.**
     - For a new id, a create-only intent file is written and synced. Only
       then does the effect run, and a create-only settlement file records the
       outcome.
     - The same id with the same digest returns the recorded outcome, or
       "in progress" while the effect runs.
     - A different digest is a conflict.
   - **Unresolved entries.** An intent without an outcome after a restart, or
     an unreadable entry, is unresolved. It never runs again automatically;
     the host reconciles it with the owner stores and records an outcome. A
     readable outcome is never replaced.
   - **Owner-store ids.** They are derived deterministically (UUIDv8 over the
     same parts). A repeated command keeps the owner store's own duplicate
     refusal even if the journal was lost.
   - **Durability.** It is claimed for a process crash only: the directory is
     not synced (R4).
   - **No limits.** There is no expiry, retry, size or concurrency limit.

## Threat model

| Adversary or fault | What stops it |
|---|---|
| The relay terminates TLS on both sides and forwards the pairing messages | Each side's transcript has the other TLS keys and exporter, so the codes differ and the typed code fails (`mismatched-sas`); tested |
| The relay impersonates the target to the controller and runs its own exchange | The real target never shows a match, and the controller owner's "no" ends it before any pin; tested |
| The relay chooses its ephemeral key after seeing the other's (grinding) | Commitment first: the target commits before the controller reveals, and the controller reveals before the target. A MITM gets one 2^-39 chance per attempt, and every attempt needs both owners; tested for mismatch, order and replay |
| A substituted key in the server directory | Never trusted; the pin comes only from SAS and MAC |
| Reflection, small-order, non-canonical or all-zero ephemeral keys | `invalid-key` (canonical check, reflection check, vodozemac contributory check); tested with 9 small-order and non-canonical encodings from the fixture |
| Small-order or malformed identity keys | Refused before observation or pinning |
| Role confusion (the controller acting as target, or a pairing over a pinned channel) | Roles are fixed by the TLS side, the MAC info carries the sender role, and pairing refuses pinned channels and the wrong role; tested |
| Mismatched account, host or controller device | `identity-mismatch` at the target, and different transcripts otherwise; tested |
| Reordered, replayed, dropped or altered TLS records | TLS AEAD failure, and the strict relay sequence; tested (`DecryptError`) |
| Wrong ALPN, no ALPN, a missing client key, a bad handshake signature, SNI, resumption, 0-RTT | Each fails the channel; tested |
| A changed peer key on an ordinary channel | `PeerKeyChanged`; the grant is unchanged |
| An OAuth device or server record presented as authority | Not accepted: only `authorize` over a pinned channel and an active local grant |
| A crash between intent and effect | Unresolved, never replayed; tested with a real child process crash |
| A repeated command id with other bytes | Conflict; tested |
| A second holder of a journal while a command of the first still runs | Every admitted command holds the lock too; tested |
| An open of a journal that races its destroy | The lock file is never deleted, so every holder locks the same file; tested with a fixed interleaving |
| Two first uses of the identity store at once | One exclusive ownership per operation; tested with in-memory stores only (residual risks) |
| An oversized length prefix arriving with its payload | Refused before any payload byte is copied; tested |
| Frames after a relay sequence violation | Refused, because the violation ends the direction; tested in the crate and over TLS |

After pairing, the server can still drop, delay or reorder frames (the
channel closes), see metadata (who talks to whom, when and how much) and deny
service. It cannot read or change content or impersonate a device.

## Residual risks

- **Human factors.**
  - SAS is 39 bits (Matrix `decimal`). Its strength depends on the owner
    typing what the controller shows and answering the second question
    honestly.
  - The UI text of both prompts belongs to root. The controller question
    must name the target computer and ask whether it showed a match.
  - Pairing needs both computers at hand. Remote pairing is open question 4
    of the handoff.
- **Windows roaming.** keyring 3.6.3's Windows backend writes
  `CRED_PERSIST_ENTERPRISE` (`windows.rs:246`). Microsoft documents that this
  persistence follows the user to other computers with a roaming profile. A
  roaming identity key would give two installations one identity. The
  platform store gate must decide whether to accept this, detect it, or use
  a local-machine store; keyring 3.6.3 offers no other persistence.
- **Linux.**
  - `piui-nano` compiles keyring only for Windows and macOS. On Linux the
    feature stays off. This is configuration, not a platform limit.
  - keyring 3.6.3 supports the Secret Service through:
    - `sync-secret-service`: dbus-secret-service 4.0.0-rc.2 on Linux, which
      needs libdbus, or `vendored`;
    - `async-secret-service`: secret-service 4 with zbus 4, which needs
      `tokio` or `async-io` and `crypto-rust` or `crypto-openssl`.
  - Both are gated to linux, freebsd and openbsd targets, and enabling sync
    and async together is a `compile_error` (`lib.rs:202`).
  - Without a backend, the default store is a mock (`lib.rs:269`), which is
    exactly why custody requires a declared durable backend.
- **Identity store ownership.** keyring 3.6.3 has neither a create-if-absent
  nor a lock, and on every platform a write replaces an existing entry:
  - `windows.rs:98` and `macos.rs:65`: "The new credential replaces any
    existing one in the store";
  - `secret_service.rs:145-162`: it looks for a matching item and otherwise
    calls `create_item` with `replace` set.

  So decision 2's ownership needs its own cross-process lock, for example an
  exclusive OS lock on an app-owned file that holds no secret and is never
  deleted. No store implementation exists yet; the tests exercise custody
  against the contract with in-memory stores in one process only. A program
  that writes the same entry without that lock is not covered.
- **Retained journal lock files.** Each grant that opened a journal leaves an
  empty `<grantId>.lock` in `<app_data>/remote-host-v1/journal/` after it is
  deleted. The file holds no secret and no command data; its name is the
  grant id. There is one such entry per grant, with no cleanup, since
  removing the file safely would need another lock that is never removed.
- **Durability.** A power loss right after an intent or settlement write can
  lose the directory entry (R4).
- **Compiled but unused code.** vodozemac always compiles its Olm, Megolm and
  HPKE code. None of it is called, and only `vodozemac::sas` and
  `Curve25519PublicKey` are used.

## Alternatives rejected

- **SAS built by hand from ring primitives** (the handoff's alternative): more
  of our own cryptographic glue. vodozemac provides the reviewed contributory
  check, HKDF and HMAC.
- **Matrix interoperability** (`m.key.verification.*` events): no peer needs
  it, and it would import Matrix event semantics.
- **Trusting the server directory or the OAuth device (TOFU through the
  server):** a compromised server could pair itself, which ADR-062 rejected
  too.
- **Self-signed X.509 certificates instead of raw public keys:** they add
  certificate parsing and validity semantics with nothing to validate.
- **Comparison-only confirmation, where both owners press "match":** typing
  at the target forces its owner to read the code. The controller question
  covers the other direction.
- **Emoji SAS:** it cannot be typed and needs a localized table.
- **Dropping a duplicate relay frame** (the handoff's `cursor_verdict`): an
  honest sender never repeats a frame, and TLS would refuse the duplicate
  anyway. The channel ends instead.
- **Storing command bodies for deduplication:** replaced by the binding
  digest.
- **Attempt limits or lockouts for pairing:** not invented. Each attempt
  needs both owners' actions and gives a MITM 2^-39.
- **A file fallback for the identity key, encrypted or not:** rejected. The
  feature fails closed instead.
- **Deleting the journal lock file with the grant.** On Linux a process that
  opened the old file keeps its lock on the unlinked file, and a later open
  creates and locks a new one, so two processes hold the journal at once.
  The empty lock file is kept instead.
- **A mutex per custody handle or per process for the first use.** It does
  not exclude another handle of the same OS entry or another process.

## Deviations from the handoff

| Handoff | Here | Why |
|---|---|---|
| A duplicate frame is dropped (`cursor_verdict`) | It ends the channel | Senders never repeat a frame; TLS refuses duplicates |
| The controller verifies the target MAC after the owner's "yes" | Verified on arrival, before asking | Never ask the owner about an unauthenticated peer |
| The controller pins after sending its MAC | It pins before sending | A target grant never exists without a controller pin; a break between them is resolved by `GET hosts` listing the grant |
| `argsDigest` over the accepted bytes | `bindingDigest`, which also covers the grant, kind and id | Binds the id to exactly one command of one grant |
| `pairing-closed` | `pairing.cancel` with `window-closed`, inside TLS | One cancellation path |
| Any X25519 key that vodozemac accepts | Canonical encoding and no reflection | Fewer accepted encodings; a reflected message is refused |
| Exporter context unspecified | Empty context | RFC 8446 7.5: the same value as no context |
| Typed harness and project | Opaque `HarnessId` and `ProjectId`, compared exactly | Their grammar belongs to the host |
| The grant id is created with the grant record (step 7) | Drawn when target pairing starts, sent only in `pairing.paired` | A failed system random generator stops pairing before any key is exchanged |
| `applied{ids, revision?}` | `applied{revision?}` | The derived id is in the intent record and derivable from the command id |
| Unreadable journal files: not covered | An unreadable intent stays unresolved until the grant is deleted; an unreadable settlement may be replaced by reconciliation, a readable one never | Nothing guesses an outcome |
| vodozemac 0.11.1 | 0.11.2 | Decision 5 |

## Consequences

- **The shared lock must gain 47 entries.**
  - 31 new crates and 13 second versions of crypto crates already present:
    ed25519-dalek 3, curve25519-dalek 5, sha2 0.11 and digest 0.11 beside
    their current versions.
  - A forced bump of thiserror and thiserror-impl from 2.0.19 to 2.0.21:
    vodozemac requires `^2.0.20`.
  - The member itself.

  The highest declared rust-version is 1.89, so the crate declares
  `rust-version = "1.89"` above the workspace's 1.88; the toolchain is
  1.94.1. Root registered the crate in the ordinary workspace and resolved
  its lock offline. The native host does not use this core until the later
  command, transport and OS-store integration is accepted.
- **Additive changes** that root serializes:
  - `executionHosts` in `NanoCapabilitiesV1`;
  - the scopes of `nano-hosts-v1.ts`;
  - `contracts/README.md` and `docs/10_ADR.md` index entries;
  - section 13 of `NANO_DESKTOP_API.md` with the server.
- **Not decided here**:
  - the arguments and projections of each command;
  - read commands and events;
  - the controller-facing envelope;
  - reconciliation per kind;
  - revocation effects on running work;
  - key rotation flows;
  - the relay client and server;
  - the Tauri integration and UI;
  - V1–V4, R4 and R5.

See `docs/nano-unified-shell/DEVICE_SECURITY_CORE_RESULT.md` for the proof
and its boundary.
