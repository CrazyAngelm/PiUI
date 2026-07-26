# 15. Handle-bound managed runtime activation plan

## Status

This is an implementation boundary, **not** launch permission. PiUI has no production launcher and must remain unable to execute Pi until every condition here and [`../spikes/PHASE0_GATE.md`](../spikes/PHASE0_GATE.md) is accepted.

## Current verified boundary

The v2 managed-runtime verifier can authenticate a test-only signed manifest and compare its complete installed bundle tree at a point in time. Production has an empty keyring. Its verified result is opaque, the supervisor is probe-only, and no Tauri or process API can consume it.

The checked-in `@earendil-works/pi-coding-agent` `0.81.1` npm packet is a separate bytes-only intake of a locally authored sanitized summary. It reports one isolated `npm audit signatures` success and source-subject fields, but the retained files omit raw registry signature/key and Sigstore DSSE/Rekor material; offline validation proves structural consistency only, not upstream cryptography. It returns only `NonAuthorizing` and cannot convert into bundle, supervisor, or launch evidence. Its reported npm signature key is not in the PiUI production keyring. It is one future upstream input only; it cannot replace PiUI signer roles/key roll, channel/sequence/revocation policy, managed archive acquisition, SBOM review, or handle-bound installation and spawn evidence.

On Windows only, the crate-private supervisor creates a real, empty `WindowsJob` with `KILL_ON_JOB_CLOSE` **only after** explicit probe-only policy, safe-mode, purpose, and bundle revalidation gates pass. The single-use authorization is borrowed for supervisor and safe-mode preconditions, so those rejected handoffs retain the live permit; successful removal transfers affine ownership of both the verified bundle and the live Job into a redacted `PreparedProbe`, and later retries report it consumed. `PreparedProbe` deliberately declares containment before retained `VerifiedManagedRuntimeBundle` evidence, so normal field teardown makes the empty Job handle's best-effort close precede lease release. It has no child-process handles and does **not** prove that generic `PreparedProbe` destruction has terminated or waited a running tree before lease release. A future `RunningProbe` must retain and wait its child handles before it can make that claim. A successful transfer terminally consumes that supervisor's sole containment slot, so it cannot prepare a second live Job even after the `PreparedProbe` later drops; a stale/revalidation-failed handoff drops its untransferred Job and leaves the slot reusable. This is preparation evidence, not a launcher: it exposes neither the bundle, job/raw handle, process handles, nor any spawn surface. Non-Windows builds fail closed with `ContainmentUnavailable`; they do not accept the Unix process-group design stub as probe containment.

Point-in-time path verification does not bind a later executable image to the checked file. It must therefore never authorize a launch by itself.

### Current Windows partial slice

Windows additionally retains one opaque `CreateFileW` lease for **every signed declared bundle file** (in manifest order, capped at 256) after a complete-tree verification. Each lease permits read sharing only (write/delete sharing is denied), rejects a final reparse point, directory, or hardlink, retains a fail-closed full `FileIdInfo` identity (64-bit volume serial plus 128-bit file ID), and is bound to the corresponding independently opened file during the second complete-tree scan. Retained leases must form a bijection with manifest slots: their opaque native identities must all be distinct before the bundle is accepted. Verification and later revalidation hash the bounded expected size from every retained handle. This remains deliberately **partial**: it has no no-follow handle-relative directory traversal and does not lock the namespace between signed files; an extra file, directory, or reparse object can still appear after scanning. It also does not establish DACL/owner policy, bind to process creation, or grant launch permission.

Physical Windows CI must capture final-component **and ancestor-directory** reparse regressions with symlink capability enabled: set `PIUI_REQUIRE_WINDOWS_REPARSE_TEST=1` so missing symlink privilege fails rather than skips. Generic hosted Windows evidence is not sufficient for the identity boundary: before any future activation decision, release engineering must record a physical ReFS-volume run proving `GetFileInformationByHandleEx(FileIdInfo)` succeeds and that the retained all-file lease revalidation/bijection checks reject aliasing there. That physical evidence remains required before any future activation decision.

A Windows-only **test-only synthetic, non-activation proof** also runs the actual internal `authorize -> PreparedProbe -> assign_before_resume -> resume_assigned` sequence. It starts the fixed test executable, not Pi or a verified bundle entrypoint, with an empty allowlisted environment, null standard handles, and no shell, network, session, or Pi/application IPC. The parent creates a cryptographically random UUID v4 tokenized temporary fixture root and authentication file; children receive only root, token, and role, authenticate them, and derive their own witness paths. A pending-root RAII guard attempts termination then polls `try_wait` only to a short deadline if Job assignment fails. After assignment, a failure-only guard derives a stop marker for an escaped descendant, retains its derived lock/PID markers, waits boundedly for its witness to unlock, and applies the same bounded root cleanup if the proof fails; the passing path asserts that this cleanup was not used, and fixtures also have a bounded lifetime. The synthetic root starts one synthetic descendant; both hold OS-exclusive ready/alive witnesses. The regression proves that an **explicit Job close** terminates the witnessed tree within a bound and that the retained bundle lease remains non-writable until `PreparedProbe` later drops. It does not claim that generic `PreparedProbe::drop` has terminated or waited a tree. This regression proves only explicit-close containment mechanics and lease ordering; it grants no executable-launch or activation evidence.

## Required handle-bound boundary

A future platform adapter must move through these host-private capabilities:

```text
trusted install anchor
  -> stable no-follow bundle lease
  -> verified signed entrypoint handle
  -> authorization bound to the same live containment owner
  -> prepared contained probe
  -> (future launch only after separate approval)
```

None of these capabilities may be serializable, cloneable, path-exporting, or exposed to the WebView.

### Unix requirements

- Traverse from an opened trusted install anchor using descriptor-relative, no-follow operations (`openat` / platform equivalent).
- Verify file type, device/inode, link count, owner, writable mode, mount policy, and content from retained descriptors.
- Reject symlinks, devices, sockets, hardlinks, cross-device traversal, group/other-writable files, and unsupported filesystem semantics.
- Retain the signed entrypoint descriptor through a later descriptor-bound execution experiment; regular path execution is insufficient.

### Windows requirements

- Traverse relative to native directory handles; reject every reparse tag, ADS, hardlink, unsafe share mode, and unsafe DACL/owner policy.
- Do **not** treat a path-opened directory handle as a namespace lock. An exploratory local Windows probe found that a strict `CreateFileW` directory handle can prevent rename/delete of that directory object, but child create/delete/reparse creation still succeeds; a child pre-opened with delete access can later be renamed through its own handle. A checked-in physical adversarial test matrix must reproduce and defeat those cases before a stronger containment claim is made.
- Retain verified component handles only alongside a verified owner/DACL policy that denies untrusted create, delete-child, write, ACL/owner-change, and reparse creation; ordinary sharing reservations alone are insufficient.
- Recompare volume/file identity immediately before a future suspended process creation, assign its Job Object before resume, and prove image/containment identity experimentally.
- If Windows cannot preserve that binding, the platform remains disabled rather than falling back to ordinary path spawning.

## Separate activation evidence

Before a production keyring or launcher exists, release engineering must supply:

1. named signer identities, roles, epochs, revocation procedure, and an approved key-roll ceremony;
2. signed channel, release-sequence, downgrade, and explicit rollback policy;
3. authenticated acquisition provenance, source identity/attestation, archive digest, complete unpacked-tree inventory, SBOM, and vulnerability/license review;
4. atomic installation/failed-update recovery evidence into a protected app-managed root;
5. physical Windows and Linux evidence for the **actual** supervisor and packaged runtime, including graceful shutdown and forced descendant cleanup;
6. Phase-0 real Pi capability-probe and session-continuation evidence.

Until then, the independent barriers remain: empty production keyring, disabled policy by default, no production handle-bound launch evidence, no handle-bound launcher, and no real Pi/session command in the desktop API.
