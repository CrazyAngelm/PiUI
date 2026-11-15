# Stage 9A result: security core of connected execution hosts

This is the result of the Stage 9A boundary of `FABLE_PLAN.md` in the Desktop
worktree (`codex/nano-unified-shell-cli`). The decision record is
[ADR-080](../adr/080-connected-execution-hosts.md); called ADR-064 in the unified-shell branch and
renumbered on `master` (see its numbering note). Nothing was staged or committed. No application, GUI,
Operator API, installed app, production service, provider, credential store
or user history was touched. No paid turn ran. Every check used synthetic
keys and fixtures.

There are three proofs, of two sources:

1. **The original worker proof** of the reviewed source: a scratch
   workspace on Windows only (below and "Verification").
2. **Root's normal-workspace proof** of the same reviewed source, on Windows
   and Linux (below).
3. **The remediation proof** of the corrected source after the four reviews
   ("Remediation after the four reviews"), on Linux and Windows.

The two earlier proofs do not cover the corrected source.

The implementation worker first compiled and tested the crate in a scratch
workspace while root retained the shared manifests. That original proof used:

- the workspace is `<task-scratch>/device-security-core/build`,
  with one member and a copy of the repository lock resolved for it;
- the target directory is the shared `<shared-rust-target>`;
- the crate and fixtures are copied in by `scripts/sync.sh`.

Root subsequently registered the crate in the ordinary workspace and resolved
the normal lock offline, retaining the unrelated locked dependencies. Root's
Windows proof of the reviewed source in that workspace: 74 unit tests and one
cross-crate compatibility test passed; Clippy with warnings denied and
formatting passed. The compatibility
test compares all 128 fixture permission combinations with the real coordinator's
`spawn_permissions_subset`, with empty tool/resource/delegation lists. It does
not claim that file/network ceilings alone cover those other policies.

Root's lock audit preserved all 587 other package identities. Cargo's initial
resolution also unified an unrelated Windows package; root restored the original
`iana-time-zone` binding to `windows-core` 0.62.2 and verified the final lock with
locked offline metadata. Only the two necessary thiserror package versions were
replaced. The exact 47 additions and two replacements are recorded in
`root-lock-verification.json`.

Raw outputs are under the evidence root
`<task-evidence>/cli/device-security-core/`.
Root's workspace results for the reviewed source are `root-workspace-tests.log`
and `root-workspace-clippy.log`. Linux (WSL, Rust 1.94.1) also passed 74 unit tests,
the cross-crate compatibility test and locked offline Clippy with warnings
denied: `root-linux-check-2.log`, exit 0. The first Linux invocation stopped
before compilation because the non-login shell lacked rustup in PATH; the
second explicitly selected the installed Linux toolchain. Neither run touched
an OS credential store, a provider or the installed application.
The original worker's 21 mutation checks remain scratch evidence, not a second
run against the integrated workspace.

## Remediation after the four reviews (2026-11-16)

Four independent reviews of the frozen source (`device-core-review/`, with
reports in `reviews/device-core-sol-1` to `-4`) found five faults in the code
and a stale proof boundary in this document. Each fault was first reproduced
by regression tests against the reviewed code (red) and then fixed (green).
The correction stayed inside the crate, its two contracts, ADR-080 and this
document. No dependency, lock entry or fixture changed, and the lock is
still `dc6f495f…6813`. Raw outputs are under
`<task-evidence>/cli/device-core-remediation/`.

| # | Finding (reviews) | Result | Fix |
|---|---|---|---|
| 1 | P1: the journal lock died with `CommandJournal` while an `IntentGuard` still ran its command (all four) | Reproduced, fixed | The locked file is part of the state that the journal and every guard share; the last of them releases it |
| 2 | P1: `destroy` released `journal.lock` and then deleted it, so a holder that opened it in between and a later opener locked different files (sol-1, sol-2) | Reproduced with a fixed interleaving, fixed | One lock file per grant, `<grantId>.lock` beside the directory, empty and never deleted. Destroy removes the entries and the directory under the lock; a failed destroy returns the journal still locked |
| 3 | P2: the first use of the identity store (load, save, read back, delete) was not exclusive across `KeyCustody` handles. Two first uses could return two identities, and a cleanup could delete the other's key (all four) | Reproduced with a scripted store, fixed in the core | `IdentitySecretStore::own` returns an exclusive `OwnedSecretEntry`, and each custody operation runs in one ownership. The ownership that an OS store must provide across processes is specified (ADR-080, decision 2 and residual risks); no OS store implementation exists |
| 4 | P2: the decoder appended a whole input before reading its length prefix (all four) | Reproduced, fixed | The prefix is read into four bytes first, only the declared payload is copied, and the first error is final |
| 5 | P2: `Inbound` accepted frames after a sequence or data violation (sol-2, -3, -4) | Reproduced, fixed | The first violation is kept and returned for every later frame. Recovery is a new channel with a new `Inbound` |
| 6 | The proof boundary still said "scratch, Windows only" after root's workspace proof (sol-1, -3, -4) | Fixed | The three proofs are separated above and in "Proof boundary" |

Regression tests, red on the reviewed code and green on the corrected one:

| Test | # | Red: the reviewed code |
|---|---|---|
| `journal::tests::an_outstanding_guard_keeps_the_journal_locked` | 1 | Failed on drvfs and ext4: "a second holder could reconcile or delete the running command" |
| `journal::tests::every_holder_after_a_destroy_locks_the_same_file` | 2 | Failed on drvfs and ext4: "a third opener holds the journal while the second still does" |
| `journal::tests::a_failed_destroy_keeps_the_journal_locked_and_can_continue` | 2 | Not run: the reviewed `destroy` released the lock before removing the directory, and a failure after that returned no journal (`journal: None`). So this test cannot be written against it |
| `identity::tests::two_first_uses_of_one_entry_return_its_one_identity` | 3 | Failed: two first uses returned two different identities |
| `identity::tests::a_failed_first_use_never_removes_another_identity` | 3 | Failed: a returned identity was no longer stored |
| `framing::tests::a_refused_prefix_copies_none_of_its_payload` | 4 | Failed: 21 bytes buffered after the refusal |
| `framing::tests::a_failed_decoder_refuses_everything_after` | 4 | Failed: after `TooLarge` the decoder still held 10 bytes, the refused prefix and the next message |
| `framing::tests::many_messages_in_one_call_are_all_delivered` | 4 | Passed, as intended: it guards the fix against losing messages |
| `relay::tests::a_gap_ends_the_direction` | 5 | Failed: the expected frame was accepted after a gap |
| `relay::tests::a_repeat_ends_the_direction` | 5 | Failed: the next frame was accepted after a repeat |
| `relay::tests::non_canonical_data_ends_the_direction` | 5 | Failed: a valid frame was accepted after empty data |
| `relay::tests::exhaustion_stays_and_recovery_starts_again_at_frame_one` | 5 | Passed, as intended: exhaustion already stayed, and a new `Inbound` is strict |
| `tests::a_relay_sequence_violation_ends_the_channel_until_a_new_handshake` | 5 | Failed: the channel continued after a repeated frame; the fresh handshake part was not reached |

How the faults were reproduced:

- **Journal.** The tests use the real `CommandJournal`, its OS file lock
  (`File::try_lock`: `flock` on Linux, `LockFileEx` on Windows) and real
  files in a temporary directory. The destroy race is not timed. A
  `#[cfg(test)]` step inside `destroy`, right after it gives up the lock,
  opens a second holder, and the test then asks whether a third opener can
  hold the journal at the same time.
- **Identity.** No OS store is touched. In red, a scripted store with one
  shared entry ran the operations of two handles in a fixed order that the
  reviewed trait allowed. That order cannot happen under the new contract,
  so the green tests keep the test names and claims and exercise a
  conforming in-memory store. Handle 0 takes the ownership and waits in it
  until handle 1 has asked for it. The step log then shows that handle 1
  was owned only after handle 0 released, one key was stored, and a failed
  first use deleted only its own write.
- **Framing and relay.** The tests feed the real `Decoder` and `Inbound`:
  prefix and payload in one call, every split of the prefix, several valid
  messages in one call, and every input after each fatal error. The
  two-endpoint test frames a real controller's first TLS flight and repeats
  that frame. The target's `Inbound` refuses the repeat and the next frame.
  Then new channels with new `Outbound` and `Inbound` state complete a full
  pinned handshake and carry a message.

## Outcome

- **`crates/piui-remote-host`** (new; 16 Rust files in `src`, the
  cross-crate test and `Cargo.toml`; no
  `unsafe`; no listener, HTTP, scheduler, agent loop, provider or generic
  RPC):
  - `identity.rs`:
    - the exact Ed25519 SPKI type, refusing malformed and small-order keys;
    - the PKCS#8 identity key;
    - `KeyCustody` over a typed `IdentitySecretStore`, failing closed without
      a durable OS backend. No file store. Each operation runs in one
      exclusive ownership of the store entry (`own`), which an OS store
      implementation must provide across processes.
  - `tls.rs`: the sans-IO `SecureChannel`. TLS 1.3 with mutual RFC 7250 raw
    keys; ALPN `nano-host/1` required; no resumption, tickets, 0-RTT or SNI.
    Pairing channels only observe the peer key; all others are pinned. The
    RFC 9266 channel binding is exported. Every error is terminal.
  - `framing.rs`: a length-prefixed message stream bounded by a caller-given
    limit. Each prefix is checked before any byte of its payload is copied,
    and the first error is final.
  - `relay.rs`: the `{seq, data}` frames of the relay, strictly in order.
    The first violation ends that direction.
  - `pairing/`:
    - commitment-first SAS on vodozemac 0.11.2;
    - the transcript binds account, target host, controller device, both
      exact TLS keys, both ephemeral keys, the channel binding and the
      protocol;
    - the code is typed at the target, and the controller's owner confirms;
    - controller and target state machines; no retry.
  - `policy.rs`:
    - grant records;
    - `authorize`, the only path to an `AuthorizedController`;
    - trusted-project admission;
    - permission ceilings with the `spawn_permissions_subset` rule.
  - `journal.rs`:
    - durable command identity bound by digest, with no plaintext stored;
    - an intent before effect, with create-only and synced files;
    - unresolved entries are never replayed;
    - a single process holds the lock of `<grantId>.lock`, until the journal
      and every admitted command are dropped;
    - the journal is destroyed with its grant, and the empty lock file stays.
  - `ids.rs`, `b64.rs`: the identifier shapes, UUIDv8 derived ids and strict
    unpadded base64url.
- **`contracts/nano-host-v1.ts`**: the protocol inside TLS as implemented:
  - channel profile, framing and identifiers;
  - pairing messages, codes, labels and derivations;
  - command kinds, binding digest, derived ids and outcomes;
  - journal records and storage, with the retained lock file;
  - the identity custody ownership;
  - policy and refusals.

  The command arguments, projections, events and envelope are explicitly
  left open.
- **`contracts/nano-hosts-v1.ts`**: the relay wire. Marked as a proposal,
  because the server does not implement it. It covers routes, DTOs, stream
  events, frame rules and error codes, and sets no rate or volume limit (V2).
- **`contracts/fixtures/unified-shell/nano-host-v1.json`** (48 892 bytes) and
  **`nano-hosts-v1.json`** (3 910 bytes). They are generated by
  `scripts/gen_host_fixtures.py`, using the Python standard library only, from
  published sources:
  - RFC 7748 6.1 X25519;
  - RFC 8032 7.1 TEST 1 and RFC 8410 10.1 keys;
  - RFC 9562 B.2 UUIDv8.

  The generator implements HKDF (RFC 5869), HMAC, the Matrix decimal mapping
  and the transcript independently of the Rust code. Regenerating them gives
  byte-identical files (`fixtures-regen.txt`).
- **`docs/adr/080-connected-execution-hosts.md`**: decisions, threat model,
  residual risks, rejected alternatives and deviations from the handoff.

### vodozemac 0.11.2 instead of 0.11.1

The assignment preferred `=0.11.1` because "v0.11.2 requires 1.96". That is
true only of the `main` branch. The published 0.11.2 is a better choice:

- **Publication.** It is on crates.io, released 2026-11-05 and not yanked.
  Its checksum `cafdb6875115a436251b280d741286a9cec7fc4daab0588ea26481dd8e2bab2f`
  equals the downloaded `.crate`.
- **MSRV.** It declares `rust-version = "1.89"` in the index, the tag manifest
  and the crate.
- **SAS code.** `src/sas.rs` is byte-identical in 0.11.0, 0.11.1, the 0.11.2
  tag and the published 0.11.2. So is `src/types/curve25519.rs`. Only Olm
  files, `cipher/key.rs` and the base64 parsing in `types/ed25519.rs` differ,
  and none of them is used.
- **Security fix.** It enables `zeroize` on the RustCrypto crates. Its
  changelog says: "Without it, sensitive data in those crates was not fully
  zeroized." hmac and sha2 back our SAS MAC.

Every result below was produced with 0.11.2. Pinning 0.11.1 instead is a
one-line change. Its scratch lock is kept as `Cargo.lock.vodozemac-0.11.1`,
and its earlier 21/21 mutation run as `mutations-vodozemac-0.11.1.json` in
the evidence.

## Verification

### Reviewed source: original worker proof (scratch, Windows 11, rustc and cargo 1.94.1)

| Check | Result | Raw output |
|---|---|---|
| `cargo test -p piui-remote-host --locked` | 74 passed, 0 failed | `test.txt`, `test-list.txt` |
| `cargo clippy -p piui-remote-host --all-targets --locked -- -D warnings` | clean | `clippy.txt` |
| `cargo fmt -p piui-remote-host --check` | clean | `fmt.txt` |
| Mutation check: 21 fail-closed rules disabled one at a time | 21/21 killed, all compiled | `mutations.json`, `mutations-run.txt` |
| `tsc 5.9.2 --noEmit --strict` on both contracts | clean | `contracts-check.txt` |
| Contract parity script (TS against fixtures and Rust serde names) | 28/28 | `contracts-check.txt` |
| Fixture regeneration | byte-identical | `fixtures-regen.txt` |

### Corrected source: remediation proof

| Check | Result | Raw output |
|---|---|---|
| Red: reviewed code plus the regression tests, `cargo test -p piui-remote-host --locked --offline --no-fail-fast`, Linux (WSL2, drvfs) | 86 unit tests: 76 passed, 10 failed, exactly the 10 expected; 1 integration test passed | `red/red-linux-test.log`, `red/red-summary.md` |
| Red: the same binary, `journal::` with TMPDIR on native ext4 | 13: 11 passed, the 2 journal regressions failed | `red/red-linux-test.log` |
| Green: the same `cargo test`, Linux (WSL2, drvfs) | 87 unit tests passed, 0 failed; 1 integration test passed | `green/green-linux.log` |
| Green: the same binary, `journal::` on native ext4 | 14 passed, 0 failed | `green/green-linux.log` |
| Green: `cargo clippy -p piui-remote-host --all-targets --locked --offline -- -D warnings`, Linux | clean | `green/green-linux.log` |
| `cargo fmt -p piui-remote-host --check` | clean | `green/static-checks.txt` |
| Contract parity script, remediation copy (TS against fixtures and Rust names) | 28/28 (the original script: 27/28, failing only its 'journal files' check, which still expects `LOCK_FILE`) | `green/static-checks.txt` |
| `tsc --noEmit --strict` on both contracts | clean (tsc 5.9.2) | `green/static-checks.txt` |
| Green: the same `cargo test`, Windows 11 (MSVC), in root's warm workspace target | 87 unit tests passed, 0 failed; 1 integration test passed | `green/green-windows.log` |
| Green: the same Clippy, Windows | clean | `green/green-windows.log` |

All runs used Rust 1.94.1, `CARGO_BUILD_JOBS=1` and `CARGO_INCREMENTAL=0`,
on Linux in the existing Linux core target and on Windows in root's existing
workspace target (`<shared-rust-target>`), with only `piui-remote-host`
built. No scratch workspace and no new target were created. Both green
platforms ran the same corrected source (`green/green-source-hashes.txt`).
The first green attempt
(`green/green-linux-attempt1-compile-error.log`) did not compile
(`&Box<dyn OwnedSecretEntry>` is not coerced to `&dyn OwnedSecretEntry`).
The fix is the explicit `&*` in `KeyCustody::load` and `load_or_create`.
The mutation check was not repeated on the corrected source.

Tests per module:

| Module | Reviewed source | Corrected source |
|---|---|---|
| `tests` (two-endpoint) | 24 | 25 |
| `journal::tests` | 11 (one of them, `crash_child`, is the entry point of the crashing child process) | 14 |
| `identity::tests` | 8 | 10 |
| `tests::vectors` | 8 | 8 |
| `ids::tests` | 6 | 6 |
| `relay::tests` | 4 | 8 |
| `framing::tests` | 3 | 6 |
| `pairing::tests` | 3 | 3 |
| `pairing::transcript::tests` | 3 | 3 |
| `policy::tests` | 3 | 3 |
| `b64::tests` | 1 | 1 |
| **Unit tests** | **74** | **87** |
| `tests/coordinator_permissions.rs` (cross-crate) | 1 | 1 |

Required cases and where they are:

- **Published vectors** (`tests::vectors`):
  - RFC 8410 and RFC 8032 keys;
  - RFC 7748 6.1 through vodozemac's X25519;
  - the RFC 9562 UUIDv8 example;
  - the transcript, SAS bytes, decimals, commitment, both MAC keys and MACs,
    and canonical messages of an RFC 7748 based exchange, against the
    independent generator;
  - 128 ceiling rows;
  - derived ids, binding digests, outcomes and relay examples.
- **Two endpoints** over an in-memory transport: pinned channels with 300 KiB
  and 2 MiB messages. Sending a message one byte over the limit is refused,
  writes nothing and leaves the channel usable. The decoder refuses an
  empty or oversized length prefix before it copies any byte of the
  payload, however the input is split, and refuses all input after its
  first error (`framing::tests`; the channel maps every framing error to its
  terminal failure). Full pairing runs through TLS, after which the stored
  pins open ordinary channels.
- **MITM and key substitution:**
  - a relay that terminates TLS and forwards gets `mismatched-sas`;
  - a relay that runs its own exchanges is stopped by the controller owner's
    "no";
  - a relay with other keys cannot open pinned channels;
  - a forwarding relay carries only ciphertext in frame order.
- **Commitment grinding and order:**
  - a key other than the committed one gets `mismatched-commitment`, and so
    does a rewritten `pairing.start`;
  - keys out of order, and replays, get `unexpected-message`.
- **Mismatched identity, role and account:** `identity-mismatch` for the
  account, host and device; `unknown-method`; non-canonical messages; a
  pairing over a pinned channel or with the wrong role; authorization
  refusals for the account, host, inactive grant and changed key.
- **All-zero and weak peers:** the fixture's 9 small-order and non-canonical
  encodings, a reflected key, malformed keys, and the all-zero and
  small-order identity keys.
- **Denied bilateral confirmation:** either owner declines; a typing error is
  correctable, while a wrong code ends the attempt; nothing is stored.
- **Fail closed:**
  - peer change (`CertificateUnknown` alert on both sides);
  - a bad signature (`DecryptError` alert);
  - reorder and replay of TLS records (`DecryptError`);
  - an absent client key;
  - wrong or missing ALPN;
  - SNI;
  - attempted resumption with 0-RTT;
  - a reflected, altered or short MAC;
  - relay frames after a gap, a repeat or bad data, in the crate and between
    TLS endpoints; recovery only by a new channel and handshake.
- **Identity custody** (in-memory stores only): two overlapping first uses
  through two handles end with one identity, and a failed first use removes
  only its own write.
- **Journal:**
  - an intent is recorded before the effect and settled once;
  - the same identity returns the prior outcome;
  - a conflict;
  - a real child-process crash leaves the intent unresolved;
  - unreadable entries;
  - a single holder, also while a command runs after its journal value is
    dropped;
  - every holder after a destroy locks the same file;
  - no command text is stored on disk;
  - destroy while busy, and a failed destroy that keeps the lock and can be
    continued.

What the mutation check cannot isolate, because a second layer catches the
same fault:

- the pin check in the verifier: `establish` repeats it;
- `client_auth_mandatory`: `establish` requires the key;
- `sync_all`: there is no power-loss simulation;
- `create_new` as a second guard against re-execution.

## Dependency evidence

`dependencies.txt` lists every entry with its version, the repository's
versions, rust-version, edition, license and checksum. The shared lock must
gain **47 entries**:

- **31 new crates.** Among them are vodozemac 0.11.2, x25519-dalek 3.0.0,
  hkdf 0.13.0, hmac 0.13.0, hpke 0.14.1, aes 0.9.4, chacha20poly1305 0.11.0,
  matrix-pickle 0.2.3 and prost 0.14.6.
- **13 second versions** of crates already locked: base64 0.23.1,
  block-buffer 0.12.1, const-oid 0.10.3, cpufeatures 0.3.1, crypto-common
  0.2.2, curve25519-dalek 5.0.0, digest 0.11.3, ed25519 3.0.0, ed25519-dalek
  3.0.0, fiat-crypto 0.3.0, rand_core 0.10.1, sha2 0.11.1 and signature
  3.0.0.
- **A forced bump** of thiserror and thiserror-impl, 2.0.19 → 2.0.21:
  vodozemac requires `^2.0.20`.
- **The member itself.**

The highest declared rust-version among them is 1.89 (vodozemac, aes). The
crate declares 1.89 above the workspace's 1.88; the pinned toolchain is
1.94.1. Licenses are MIT, Apache-2.0 and BSD-3-Clause variants. The repository
versions of rustls 0.23.45, ring 0.17.14, ed25519-dalek 2.2.0, subtle 2.6.1,
zeroize 1.9.0 and uuid 1.24.0 are reused unchanged. The resolver reported no
failure.

`sources.txt` holds the sha256 of every primary source read:

- RFC 5869, 7250, 7748, 8032, 8410, 9266 and 9562;
- the Matrix specification and the 2026-02 blog post;
- the crates.io index entries of vodozemac;
- `sas.rs` of 0.11.0, 0.11.1 and the 0.11.2 tag;
- both published crates;
- Microsoft's `CREDENTIALW` page.

The OS store findings (keyring 3.6.3, read in source, with no store touched
and no prompt shown) are in ADR-080's residual risks:

- **Windows.** The backend uses `CRED_PERSIST_ENTERPRISE`, which roams with
  roaming profiles.
- **Linux.** It needs a Secret Service feature:
  - sync: dbus-secret-service 4.0.0-rc.2, needing libdbus or `vendored`;
  - async: zbus 4 with `tokio` or `async-io` and `crypto-rust` or
    `crypto-openssl`;
  - enabling both is a `compile_error`;
  - without a backend the default store is a mock.

## Integration status and remaining gates

1. **Root `Cargo.toml`.** Registered `crates/piui-remote-host`, retaining its
   `rust-version = "1.89"`. Its test-only coordinator dependency proves the
   shared permission rules directly.
2. **`Cargo.lock`.** Resolved offline by Cargo, including thiserror 2.0.21.
   The actual workspace tests and locked Clippy pass.
3. **Indexes.** Add an index entry for ADR-080 to `docs/10_ADR.md`, and add
   `nano-host-v1.ts`, `nano-hosts-v1.ts` and their fixtures to
   `contracts/README.md`.
4. **Additive contract edits:**
   - `executionHosts` in `NanoCapabilitiesV1` (`nano-server-v1.ts`);
   - the host and control scopes;
   - section 13 of `docs/NANO_DESKTOP_API.md` together with the server.
5. **Parity tests across crates.** The registered crate now compares
   `policy::within_ceiling` against `piui_orchestration`'s
   `spawn_permissions_subset` over the 128 ceiling rows. Host integration still
   must verify:
   - the `MessageLimit` that the integration passes to `SecureChannel`
     against `piui_nano::net::MAX_API_BODY` and the contract's
     `NANO_HOST_MAX_MESSAGE_BYTES` (2 097 152). `MAX_API_BODY` is
     `pub(crate)` today. The crate's tests pin only their own `MAX_MESSAGE`
     to the fixture.
6. **The corrected source** passed its tests and Clippy on Linux and
   Windows in the ordinary workspace (Remediation proof).
7. **Later gates.**
   - Continuous Linux CI for this crate; the current Linux process check passed.
   - The platform store integration: keyring features and the roaming
     decision. `piui-nano` compiles keyring only for Windows and macOS.
   - The OS store implementation of `IdentitySecretStore::own`, with an
     ownership that spans processes (ADR-080, residual risks). keyring alone
     cannot provide it.
   - The host admission path: it must compose `authorize`, `admit_project`
     and `admit_permissions` freshly for every command before `begin`. The
     crate tests these predicates one by one; `begin` itself takes only the
     grant authorization (review sol-3).
   - The decision on vodozemac 0.11.2.

## Runnable test plan (after root adds the member and the lock)

```sh
# From the PIUI root, with the shared target directory.
export CARGO_TARGET_DIR="<shared-rust-target>"
cargo test -p piui-remote-host --locked
cargo clippy -p piui-remote-host --all-targets --locked -- -D warnings
cargo fmt -p piui-remote-host --check
python -I <evidence>/scripts/gen_host_fixtures.py <tmp>/nano-host-v1.json <tmp>/nano-hosts-v1.json
cmp <tmp>/nano-host-v1.json contracts/fixtures/unified-shell/nano-host-v1.json
cmp <tmp>/nano-hosts-v1.json contracts/fixtures/unified-shell/nano-hosts-v1.json
# The remediation copy: its 'journal files' check follows LOCK_SUFFIX.
node --experimental-strip-types <evidence>/../device-core-remediation/scripts/check_contracts.mjs .
# Optional, slow: mutation check (edit its BUILD path to a scratch copy first).
python -I <evidence>/scripts/mutate.py <out>/mutations.json
```

The tests need no network, no OS store and no provider. The journal crash
test starts the test binary itself as a child process. The journal lock
tests use the real OS file lock, so on Linux they should also run with
TMPDIR on a native file system (the remediation ran them on drvfs and on
ext4).

## Proof boundary

- **Proven**, each proof for its own source. All of them ran against
  vodozemac 0.11.2, rustls 0.23.45 and ring 0.17.14, with Rust 1.94.1.
  - The reviewed source, original worker proof: a scratch workspace on
    Windows only, with 74 tests, Clippy, formatting, contracts and 21/21
    mutations.
  - The reviewed source, root's proof: the ordinary workspace and lock, with
    74 unit tests, the cross-crate test and Clippy on Windows and on Linux
    (WSL).
  - The corrected source, remediation proof: the ordinary workspace and lock,
    with the red and green runs above. On Linux (WSL2), the tests ran on
    drvfs and the journal tests again on native ext4. On Windows 11, the
    green tests and Clippy ran in root's workspace target. The red run was
    Linux only.
  - None of the earlier proofs covers the corrected source. The mutation
    check was not repeated on it.
- **Not proven:**
  - a macOS build;
  - a real OS credential store, and the cross-process ownership of its entry
    that `IdentitySecretStore::own` requires. The custody tests use
    in-memory stores in one process;
  - the host admission path that composes `authorize`, `admit_project` and
    `admit_permissions` for every command (review sol-3);
  - a relay or server;
  - the Tauri host, the WebView or a native GUI;
  - two real machines or a real network;
  - durability against power loss (R4).
- **HKDF extraction step.** vodozemac hides the shared secret and has no
  constructor from a fixed secret, so no published vector reaches its SAS
  output directly. Coverage is in three parts:
  - RFC 7748 on its X25519;
  - the transcript, HKDF and HMAC vectors on that secret through ring,
    against an independent generator;
  - at runtime, `bytes` and `calculate_mac` equal HKDF and HMAC over
    `bytes_raw`.

  The remaining link, HKDF-Extract with no salt over the secret (`get_hkdf`:
  `Hkdf::new(None, shared_secret)`), is established by reading the source.
- **Mutation testing is not exhaustive.** 21 chosen rules were each disabled
  once, in the reviewed source only.
- **Cryptographic review.** The protocol composition (transcript,
  commitment, order, confirmations) is new. Root's four reviews read it
  without tools, from the frozen source. Their code findings are corrected
  above. They are not a formal cryptographic proof, and sol-1 notes that the
  upstream implementations and the fixture generator reached them as
  reports and hashes, not as source.
- **SAS strength.** A man in the middle succeeds in one attempt with
  probability 2^-39, and only if the owners act on that attempt.
- **Not Matrix.** The protocol is not Matrix-interoperable, and nothing
  claims it is.

## Open values (unchanged; no number was invented)

- V1: automatic reopening of the target's stream after a failure.
- V2: the relay rate and volume limit (by measurement).
- V3: snapshots above `MAX_API_BODY`.
- V4: make-before-break of streams.
- R4: directory sync on Windows without `unsafe`.
- R5: a deployment-mode signal for long relay streams.
- Owner questions 1–4 of the handoff: revocation of running work, the
  acceptance decision, plan gating and remote pairing.
