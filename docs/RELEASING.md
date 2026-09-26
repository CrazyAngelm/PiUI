# Releasing PiUI

This guide is for the repository owner. A release is a Git tag `vX.Y.Z`; the
[Release workflow](../.github/workflows/release.yml) builds every platform and
publishes one GitHub **pre-release**. Code signing and signed automatic updates
are optional: they switch on only when the secrets and variables below exist.
Without them the workflow publishes the same unsigned build as before, and the
application never checks for updates.

Windows is the primary, verified platform. Linux packages build in CI, but
native agent lifecycle containment is only verified on Windows. macOS is
experimental (ad-hoc signed, not notarized). Releases stay pre-releases until
the Windows build is code-signed.

## What a release produces

| Job | Runner | Produces |
| --- | --- | --- |
| `verify` | Ubuntu | Fails unless the tag equals every declared version (`scripts/check-version.mjs --tag`) and `CHANGELOG.md` has a section for it. |
| `windows` | Windows | All quality gates (repo audit, spec, `pnpm check`, tests, contract tests, rustfmt, clippy, `cargo test --workspace`), then `PiUI_X.Y.Z_x64-setup.exe` (NSIS, per-user install) and `PiUI_X.Y.Z_windows_x86_64.exe` (portable). Authenticode-signed when a certificate is configured; `…-setup.exe.sig` when update signing is configured. |
| `linux` | Ubuntu 22.04 | `PiUI_X.Y.Z_amd64.deb` and `PiUI_X.Y.Z_amd64.AppImage`, plus `.sig` files when update signing is configured. |
| `macos` | macOS | Experimental `PiUI_X.Y.Z_universal.dmg` (Apple Silicon and Intel), plus `PiUI_X.Y.Z_universal.app.tar.gz` and its `.sig` when update signing is configured. A failure here never blocks the release. |
| `publish` | Ubuntu | Verifies each job's checksums, writes one `SHA256SUMS.txt` for all files, writes `latest.json` when update signatures exist, and creates the pre-release with generated notes (`scripts/release-feed.mjs`). With `latest.json` it also refreshes the rolling update-channel release (tag `updater` by default). |

Each build job also uploads its files as a workflow artifact
(`PiUI-vX.Y.Z-<platform>`), so a failed publish can be inspected or retried.

## One-time setup

Add secrets and variables under **Settings → Secrets and variables → Actions**.
Secrets stay encrypted; variables are plain text and must not hold secrets.
Never commit keys, certificates or passwords; `.gitignore` already excludes
`*.key`, `*.pem`, `*.pfx` and `*.p12`, and `pnpm repo:check` rejects private keys.

### Signed automatic updates

Do this **before** tagging the first release that should update itself: a build
can only verify updates with the public key it was built with. A build released
without the key never checks for updates, and its users update manually once.

1. Generate the updater key pair on a trusted machine (choose a strong password
   when asked):

   ```bash
   pnpm tauri signer generate -w ~/.tauri/piui-updater.key
   ```

   This writes the private key `~/.tauri/piui-updater.key` and the public key
   `~/.tauri/piui-updater.key.pub`. Back up the private key and its password
   offline, in two places. If it is lost, installed builds can no longer be
   updated and every user must reinstall manually.
2. Add the secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `piui-updater.key`;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password.
3. Add the variables:
   - `PIUI_UPDATER_PUBKEY`: the contents of `piui-updater.key.pub` (one base64 line);
   - `PIUI_UPDATER_ENDPOINT`:
     `https://github.com/CrazyAngelm/PiUI/releases/download/updater/latest.json`
     (GitHub's `releases/latest/download/…` skips pre-releases, so the workflow
     keeps `latest.json` on a rolling release instead);
   - optional `PIUI_UPDATER_CHANNEL_TAG` if that rolling release should use a
     tag other than `updater` (keep the endpoint in sync).

When all three values exist, the release builds contain the updater
(`plugins.updater` with the public key and endpoint) and the bundler signs the
update artifacts. If only some exist, the build log says which are missing and
the release is built without updates; malformed values fail the build.

What users get: Settings → About shows the version, **Check for updates**,
release notes and **Download and restart** behind a confirmation. **Check for
updates automatically** is off by default; when turned on, PiUI checks well after
start and once a day, and only shows a notice. Every download is verified
against the built-in public key before anything runs; PiUI stops running chats
and pipeline steps as it does on quit, installs and restarts.

### Windows code signing (Authenticode)

Pick **one** method.

**A. Certificate file (`.pfx`)** — an OV or exportable certificate:

1. Encode it: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("piui-signing.pfx")) | Set-Clipboard`
2. Secrets: `WINDOWS_CERTIFICATE` (that base64 text) and
   `WINDOWS_CERTIFICATE_PASSWORD`.
3. Optional variable `PIUI_WINDOWS_TIMESTAMP_URL` (RFC 3161; default
   `http://timestamp.digicert.com`).

The workflow imports the certificate into the runner's user store for the build
only and deletes the decoded file at once. Certificates on hardware tokens (most
EV certificates) cannot be exported; use method B or sign locally.

**B. Azure Artifact Signing** (formerly Trusted Signing):

1. Variables: `PIUI_AZURE_SIGNING_ENDPOINT` (for example
   `https://weu.codesigning.azure.net/`), `PIUI_AZURE_SIGNING_ACCOUNT`,
   `PIUI_AZURE_SIGNING_PROFILE` (certificate profile).
2. Secrets for an app registration that has the signer role on that profile:
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`.

The workflow installs `artifact-signing-cli` 0.11.0 and Tauri calls it for the
executable, the installer and the uninstaller. When the certificate is valid the
Windows job records `signed`, the release notes say so, and
`prepare-windows-release.ps1 -RequireSignature` fails the build if any shipped
executable lacks a valid signature. Once Windows builds are signed, releases can
stop being pre-releases: remove `--prerelease` from the publish step.

### macOS (experimental)

The app is ad-hoc signed (`tauri.macos.conf.json`) and not notarized, so users
open it with right-click → **Open** the first time. Developer ID signing and
notarization are not wired into the workflow yet.

## Cutting a release

1. Set the new version everywhere it is declared: `package.json`,
   `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`,
   `[workspace.package]` in `Cargo.toml` (then run `cargo check` so `Cargo.lock`
   follows) and the client versions in `crates/piui-runtime/bridge/codex.mjs`
   and `hermes.mjs`. Contract and protocol versions are separate; do not bump
   them for a release.
2. Add `## [X.Y.Z] - YYYY-MM-DD` to `CHANGELOG.md` (the release notes and the
   in-app notes come from this section) and update the compare links.
3. Run `pnpm repo:check`; it names every declaration that disagrees.
4. Commit, push to `main` and wait for CI to pass.
5. Tag and push: `git tag -a vX.Y.Z -m "PiUI X.Y.Z"` then
   `git push origin vX.Y.Z`.
6. Follow the **Release** workflow run. When `publish` finishes, open the
   pre-release and check the files, the notes and `SHA256SUMS.txt`. With updates
   configured, open `…/releases/download/updater/latest.json` and check the
   version and URLs.

## Building a release locally

```bash
pnpm release:windows   # on Windows: NSIS installer + portable executable
pnpm release:linux     # on Linux: .deb + AppImage (needs the Tauri system packages)
pnpm release:macos     # on macOS: universal .app update archive + .dmg
node scripts/release-build.mjs windows --dry-run   # show what is enabled, build nothing
```

The same environment variables as in CI turn on signing locally:
`TAURI_SIGNING_PRIVATE_KEY` (or `TAURI_SIGNING_PRIVATE_KEY_PATH`),
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `PIUI_UPDATER_PUBKEY` and
`PIUI_UPDATER_ENDPOINT` for updates; `PIUI_WINDOWS_CERTIFICATE_THUMBPRINT` (a
certificate already in your Windows store, including a hardware token) or the
`PIUI_AZURE_SIGNING_*` and `AZURE_*` values for Authenticode.
`scripts/release-config.mjs` writes the resulting Tauri config fragment to
`target/release-config/` and passes it to `tauri build --config`; it prints
which features are on and never prints secret values. Output goes to
`artifacts/` with `SHA256SUMS.txt`. Follow the storage rules in
[AGENTS.md](../AGENTS.md) afterwards: keep the verified artifacts, delete the
superseded `target/` trees.

## Verifying a release

- **Checksums.** Linux: `sha256sum --check --ignore-missing SHA256SUMS.txt`;
  macOS: `shasum -a 256 --check --ignore-missing SHA256SUMS.txt`; Windows:
  `Get-FileHash .\PiUI_X.Y.Z_x64-setup.exe -Algorithm SHA256` and compare with
  the file's line.
- **Authenticode.** `Get-AuthenticodeSignature .\PiUI_X.Y.Z_x64-setup.exe`
  must report `Valid` and your certificate's subject.
- **Update signatures.** A `.sig` file and `PIUI_UPDATER_PUBKEY` are base64
  wrappers around minisign files:

  ```bash
  base64 -d PiUI_X.Y.Z_x64-setup.exe.sig > setup.minisig
  echo "$PIUI_UPDATER_PUBKEY" | base64 -d > piui-updater.pub
  minisign -V -p piui-updater.pub -m PiUI_X.Y.Z_x64-setup.exe -x setup.minisig
  ```

- **In the app.** Install the previous release, open Settings → About, choose
  **Check for updates**, confirm **Download and restart**, and check that PiUI
  restarts on the new version with chats, pipelines and settings intact.

## Rollback

- **Stop a bad update from spreading first.** Upload the previous release's
  `latest.json` to the update channel:
  `gh release upload updater latest.json --clobber` (or delete the asset, which
  makes checks fail harmlessly). Installed builds never downgrade on their own:
  the updater only installs newer versions, so fix forward with `X.Y.Z+1`.
- **Hide the release.** `gh release edit vX.Y.Z --draft` or delete its assets.
- **Manual downgrade.** Users can run the previous installer over the new
  version. A newer version may already have written data that an older one
  cannot read; say so in the notes and keep a copy of the app data folder when
  in doubt.
- **Lost or leaked updater key.** Installed builds trust only the public key
  they were built with. If the private key leaked, remove `latest.json` from the
  channel at once, generate a new key pair, publish a release that users install
  manually, and announce it. If the key is merely rotated while still safe, sign
  one release with the old key that already contains the new public key.
- **Leaked Authenticode certificate.** Revoke it with the issuer, replace the
  secrets and publish a new signed release.

## Known limits

- The update feed (`latest.json`) is served over HTTPS but is not signed; only
  the artifacts are. The Tauri CLI 2.11 does not record the signed version in
  update signatures, so the updater's `requireSignedVersion` check stays off: a
  tampered feed could offer an older validly signed build under a newer version
  number. Turn `requireSignedVersion` on once the Tauri CLI records the version
  and every offered release has been re-signed.
- The portable Windows executable updates by installing the NSIS build for the
  current user.
- Linux `.deb` updates use the system package installer, which may ask for a
  password; AppImage updates replace the AppImage file in place.
- macOS builds are not notarized; Linux and macOS agent lifecycle containment is
  not yet verified.
