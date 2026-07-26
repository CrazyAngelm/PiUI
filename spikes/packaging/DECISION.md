# SPIKE-07 decision note — inventory only

**Status:** partial evidence; no managed-runtime packaging decision is approved.

This spike supplies a static Python 3.13 inventory/provenance harness. By default it proves only that a deliberately selected local launcher or executable can be resolved, hashed, and wrapper-inspected without execution, and that a *separately supplied, untrusted* manifest can locally bind an explicit standalone file to a declared host target, provenance claim, and capability-probe fixture hash. It cannot cryptographically verify upstream provenance, signing, or acquisition.

`--allow-version-execution` is an explicitly dangerous diagnostic opt-in which runs arbitrary selected local code as `candidate --version`. Its output is marked `collection_mode: untrusted-version-execution`; it is not a safe, offline, or trusted report. It is not required for static inventory.

## Classification rule

`manifest-bound-standalone-candidate` requires every condition below:

1. the executable was supplied explicitly (never selected from `PATH`);
2. it is not a detected text/npm/shell wrapper;
3. SHA-256 equals the manifest artifact hash;
4. manifest target equals host OS/architecture;
5. distribution is exactly `official-standalone`; and
6. provenance declares `sha256-verified`.

`pi` selected from `PATH`, including an npm shim, is always `system-or-npm-shim`; an explicit wrapper is also classified that way. An explicit non-wrapper without all binding evidence is `custom-unverified`.

A candidate is **not verified or managed**. Before it can be a candidate, the manifest must pass the complete v1 structural check: compatibility, artifact identity/target/hash/filename, HTTPS provenance references and claim, plus capability-probe contract/fixture hash. Structural validity does not establish that any provenance claim is true. `managed_verification.verified` is always `false` with `unproven_no_signed_acquisition_pipeline`, including when a manifest hash and its self-declared provenance claim match. The harness intentionally does **not** infer ownership from filename, install location, version text, or a manifest alone. It outputs neither selected path nor command output/environment content; `assert_sanitized_report()` enforces this report boundary and rejects any successful report claiming managed verification.

## Not demonstrated / not claimed

- No artifact was downloaded, installed, updated, sidecar-packaged, signed, notarized, or SBOM-generated.
- No upstream checksum, signature, or provenance was fetched or cryptographically verified by this harness; a manifest declaration is untrusted input until a future signed acquisition pipeline verifies it.
- No managed sidecar launch, config/package/session parity, antivirus/quarantine behavior, package size, cold-start/RSS, update, or rollback succeeded.
- The capability probe is only linked by opaque ID and manifest fixture digest. SPIKE-10 must establish the safe RPC contract and capture the actual fixture.

## Required exit evidence before Windows/Linux release

1. For each target, acquire an official standalone artifact using an audited offline/reproducible pipeline; verify published upstream SHA-256 before packaging and record immutable URL/tag/checksum evidence.
2. Package as a versioned app-managed/sidecar runtime and prove managed/system config, package, and session-root parity without exposing paths/secrets in diagnostics.
3. Windows: x64 (then ARM64 if supported), signature verification, WebView/bootstrap interaction, long/non-ASCII paths, locked-file/antivirus and quarantine handling, executable naming, Job Object cleanup.
4. Linux: chosen AppImage/deb/rpm formats, executable permission, WebKitGTK/distro preflight, Wayland/X11, symlink/case sensitivity, process-group cleanup.
5. On both platforms: version plus SPIKE-10 capability probe linkage; tampered hash/signature rejection; failed install/update recovery; atomic runtime update; explicit rollback to prior runtime; no update during a running turn; launch failure fallback to system/custom runtime.
6. Produce real SBOM/provenance and signing records in CI only after their generators and verification gates exist. Do not represent this template as either record.

The independent [observed npm evidence packet](../../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/README.md) is a locally authored sanitized summary reporting an isolated registry-tarball signature observation. It retains no raw material for independent upstream cryptographic verification; this harness neither produces nor authorizes it. It does not alter the inventory-only decision or any required exit evidence above.

This leaves R-09 and R-18 **open**. Per `docs/12_OPEN_RISKS.md`, public Windows/Linux release is no-go until signed/tested install-update-rollback evidence exists.
