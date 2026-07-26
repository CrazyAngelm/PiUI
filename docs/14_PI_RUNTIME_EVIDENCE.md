# 14. Pi runtime evidence inventory and activation boundary

## Purpose

This is a **read-only evidence inventory**, not a managed-runtime manifest and not permission to execute Pi. It records public facts used to plan a future managed Pi release. No PiUI product/runtime path has downloaded, unpacked, installed, executed, or trusted any artifact described here; the separately recorded npm packet is a local, non-authorizing summary only.

The controlling decision remains [`../spikes/PHASE0_GATE.md`](../spikes/PHASE0_GATE.md). Until its evidence conditions are accepted, PiUI must not launch a Pi binary, send an RPC prompt, open an existing Pi session through Pi, or mutate session JSONL.

## Observed public upstream inventory

The installed package is `@earendil-works/pi-coding-agent` `0.81.1`; it is a global npm installation and **not** a PiUI-managed runtime. Its local directory contains no retained npm integrity metadata, detached signature, SBOM, or provenance record, so PiUI must never promote it to a trusted runtime.

A sanitized, exact-byte **locally authored summary** is checked in at [`../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/`](../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/). It reports an isolated dependency graph with scripts ignored and an observed `npm audit signatures` success for the stated subject. The offline validator and crate-private intake prove only bounded regular local-file access, manifest-order byte-count/SHA-256 binding, fixed npm SRI/signature-key fields, and repository/tag/commit/workflow consistency. The packet retains no raw registry signature/key material or Sigstore DSSE/Rekor material, so these checks do **not** independently cryptographically verify an upstream assertion. It is neither a PiUI trust root nor a release authorization.

The official GitHub release API for [`v0.81.1`](https://github.com/earendil-works/pi/releases/tag/v0.81.1) advertises standalone archives and SHA-256 digests, including:

| Target archive | GitHub API SHA-256 |
|---|---|
| `pi-windows-x64.zip` | `6c46cca1fa94234982e56dc60a453d4bc57dc45efc2e16f97bbc6eace7a7de60` |
| `pi-windows-arm64.zip` | `875dfb42e2ad20e81430365cce48c5ddcab560c3b9ee474d2d5c7ff6345269eb` |
| `pi-linux-x64.tar.gz` | `1f6e23d9ec0668a13cea9c786e3d54c1fc679b8e22e7f6bfade0349f4807cbf2` |
| `pi-linux-arm64.tar.gz` | `c049e132c85466224d57d19f7924909b0c0fdbc9bed8e091ddc361830704b392` |

The release also exposes `SHA256SUMS`, a source archive, and install package metadata. This is useful candidate inventory only. GitHub API metadata and a checksum file served from the same release are **not** an independently verified PiUI trust root.

The public tag `v0.81.1` resolves to commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`; GitHub reports the tag as lightweight and the commit verification as `unsigned`. The local summary reports the tarball SRI `sha512-r6ovAsZOgAqbC/aU6s+/dPnv/sGZBuWyZNvi3pXjpbuX5wvp3XvGkQI7/VLvX2o9XpmpFaPUxKNym1WfkN/P8A==`, npm key ID `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`, and an SLSA subject naming repository `https://github.com/earendil-works/pi`, tag `refs/tags/v0.81.1`, that commit, and workflow `.github/workflows/build-binaries.yml`. Those fields are locally consistency-checked only; the repository has no retained raw material to independently authenticate their upstream cryptography. They establish neither a PiUI-pinned identity policy nor approval or a production signer.

The local npm report describes only that stated registry-tarball subject; it does **not** authenticate that tarball, the global installed tree, Node itself, any GitHub standalone archive, any PiUI-managed artifact, or a future release. No published detached release signature, signed checksum manifest, digest-bound SPDX/CycloneDX SBOM, signed rollback policy, revocation list, or PiUI-approved channel manifest was established during this inventory.

## Required provenance work before managed-runtime enablement

A release owner must provide and approve all of the following before any Pi executable becomes launchable:

1. A PiUI-signed release/channel manifest with exact archive URL, archive and unpacked-file digests, target triple, source commit, supported PiUI/RPC compatibility range, release sequence, and prior approved rollback target.
2. Cryptographic verification of the upstream source: signature/attestation certificate chain, Rekor inclusion, and a strict identity policy binding repository, exact tag, commit, and workflow. If npm is involved, verify registry signature/SRI independently; PiUI itself must never run `npm install`.
3. A digest-bound SPDX or CycloneDX SBOM plus license and vulnerability review.
4. Atomic installation into an app-managed root, complete-bundle verification, no-follow native directory/file handles, and a launch path bound to the verified handle rather than a mutable filename.
5. Signed revocation/downgrade/rollback policy, a retained last-known-good artifact, and tested failed-update recovery.
6. Platform-specific Windows and Linux containment reports for the **actual** supervisor and packaged runtime.

These requirements are intentionally stronger than a version string, an npm installation, `PATH`, a GitHub asset digest, or a self-declared manifest.

## In-repo bundle-verifier progress does not establish provenance

PiUI now has a non-launching v2 bundle verifier for **test-only signed fixtures**. It authenticates exact manifest bytes with a domain-separated Ed25519 signature, requires a complete bounded installed-tree inventory, rejects unexpected/unsafe/case-ambiguous entries and inspectable hardlinks, and revalidates the full tree before a test-only supervisor permit can be considered. Production still has zero trusted keys, no artifact downloader/installer, no archive/SBOM/attestation validation, no signer/channel/sequence/revocation policy, and no handle-bound launch path. The verifier is therefore a fail-closed installation-checking building block, not approval for any public upstream archive listed above. See [`15_HANDLE_BOUND_RUNTIME.md`](15_HANDLE_BOUND_RUNTIME.md) for the boundary that must replace path-based verification before launch.

## First permitted runtime experiment after provenance approval

Only after the requirements above and Phase 0 approval, the first runtime action is a contained, ephemeral **capability probe**, not a session continuation:

```text
pi --mode rpc --no-session --offline --no-approve --no-context-files \
  --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools
```

It may issue only documented getters such as `get_state`, `get_available_models`, `get_available_thinking_levels`, and `get_commands`. It must use LF-only JSONL framing, separate stderr, native process containment, sanitised diagnostics, and a timeout/escalation path. It must not send `prompt`, `bash`, session creation/switch/fork/clone commands, authentication commands, or load an existing JSONL session.

`--no-session` prevents session persistence, but it is not an OS sandbox and does not replace the containment, trust, or provenance gates above. PiUI currently implements only the data-side fixed-whitelist LF JSONL coordinator for this whitelist (`piui-runtime::read_only_probe`): it creates four host-owned getter frames, accepts bounded fragmented stdout, rejects malformed/uncorrelated traffic, and requires clean EOF before producing a sanitized capability snapshot. It has no process, executable, session, or Tauri launch API.

## In-repo transport progress does not activate a runtime

The deterministic fake runtime now replays its own simulated stdout through a bounded, fragmented LF JSONL codec, allowlisted event validation, and EOF completion before UI state is projected. Malformed output forces a local failed state rather than accepting a later synthetic lifecycle event. This is useful adapter coverage for a future contained pipe, but it neither downloads nor executes Pi, verifies an artifact, supplies a production key, proves containment, opens a session, or changes any Phase 0 gate condition above.
