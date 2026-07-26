# PiUI SPIKE-07 — static local runtime inventory

Static Python 3.13 harness for inventorying exactly one Pi candidate. By default it does **not execute** that candidate: it only resolves, hashes, and inspects its wrapper shape. It never downloads, installs, updates, invokes npm, inspects Pi configuration/packages/sessions, or scans directories. It writes a deliberately sanitized JSON report: no executable paths, current directory, environment values, raw `--version` output, prompts, or secrets.

## Use

```powershell
# Static-only: resolve/hash the installed `pi` command from PATH; it is not executed.
# Keep this machine-local output ignored and out of version control.
py -3.13 spikes/packaging/inventory.py --system-pi --output spikes/packaging/reports/current-machine-report.json

# Inspect one explicit candidate; even a matching manifest does not make it trusted.
py -3.13 spikes/packaging/inventory.py --pi C:\approved\pi.exe --output report.json

# At most produces a manifest-bound standalone candidate; never managed verification.
py -3.13 spikes/packaging/inventory.py --pi C:\approved\pi.exe `
  --runtime-manifest approved-runtime-manifest.json `
  --capability-probe-id pi-rpc-v1-fixture:sha256-0123 --output report.json

# DANGEROUS opt-in: executes arbitrary local candidate code with --version.
# Its report is marked untrusted-version-execution; do not call it safe, offline, or trusted.
py -3.13 spikes/packaging/inventory.py --pi C:\untrusted\pi.exe `
  --allow-version-execution --output untrusted-execution-report.json
```

Default reports use `collection_mode: static-no-execution` and `version_probe: {"status":"not_requested"}`. The opt-in probe invokes only `[candidate, "--version"]`, with stdin disconnected and a five-second timeout; it retains no raw output. It is still arbitrary local code execution, not a security check. Opt-in reports use `collection_mode: untrusted-version-execution`. Exit `0` means the selected file was readable and hashed; it does not mean Pi is compatible or trusted. Exit `2` means no candidate was found/readable.

## Manifest and provenance

`runtime-manifest.schema.json` is the schema; `runtime-manifest.template.json` is intentionally non-deployable placeholder data. The harness rejects incomplete manifests, unknown fields, malformed hashes/filenames/URLs, missing capability-probe linkage, and all other structural violations of the v1 schema before binding. A structurally valid local manifest is still an untrusted self-declaration: even a matching hash only produces `manifest-bound-standalone-candidate`, and `managed_verification.verified` is always `false`. `assert_sanitized_report()` also rejects any successful report that tries to claim managed verification. A signed acquisition pipeline must independently validate provenance and upstream hashes before any managed-runtime claim is possible. The harness performs only the narrow local binding checks described in `DECISION.md`.

The report's `capability_probe` is linkage, not a probe result. Supply only an opaque contract/fixture identifier; use no paths, RPC output, prompts, or credentials. The manifest requires the SHA-256 of the separately captured SPIKE-10 capability fixture.

## Local checks

```powershell
py -3.13 -m unittest discover -s spikes/packaging -p "test_*.py" -v
py -3.13 spikes/packaging/inventory.py --system-pi --output spikes/packaging/reports/current-machine-report.json
# The exported assertion rejects absolute paths and raw/path-like report fields.
py -3.13 -c "import sys; sys.path.insert(0, 'spikes/packaging'); import inventory, json; inventory.assert_sanitized_report(json.load(open('spikes/packaging/reports/current-machine-report.json', encoding='utf-8')))"
```

See `DECISION.md` for mandatory future Windows/Linux artifact, provenance, launch, update, and rollback tests. This spike makes no signing, SBOM, managed-sidecar, acquisition, or rollback-success claim. The separate checked-in [observed npm evidence packet](../../evidence/upstream/npm/earendil-works-pi-coding-agent/0.81.1/README.md) is a locally authored sanitized summary of one isolated registry-tarball observation; it retains no raw upstream cryptographic material, is not produced by this harness, and does not change this spike's non-managed classification.
