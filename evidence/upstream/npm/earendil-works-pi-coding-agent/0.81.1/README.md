# Observed upstream npm evidence packet

This exact-byte packet is a **locally authored, sanitized summary** about the
public npm package `@earendil-works/pi-coding-agent` version `0.81.1`. It records
that an isolated dependency graph used ignored scripts and that an `npm audit
signatures` success was observed. `observed-success` is a reported collection
outcome, not independently verifiable proof in this repository.

The receipt binds every sanitized JSON attachment by manifest order, byte count,
and SHA-256. The local validator checks only that bounded local files are regular,
not redirected, and structurally consistent with the fixed package/version/SRI,
signature-key identifier, and SLSA subject values. It also checks that the SRI
bytes equal the recorded SLSA SHA-512 subject.

The packet deliberately does **not** retain raw npm registry metadata, an npm
signature and public-key record, a Sigstore DSSE envelope/certificate, or a Rekor
inclusion proof. It therefore cannot cryptographically authenticate any upstream
claim, a tarball, an installed global package, Node, a GitHub standalone archive,
or any PiUI-managed artifact. Upstream cryptographic verification remains
external work for a future release policy.

This is not a PiUI release authorization or trust root. It creates no signer,
key, channel, rollback, acquisition, installation, process, or session capability.
The repository's offline validator checks this packet without using npm or a network.
