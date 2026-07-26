# Security policy

## Supported versions

PiUI is currently an early developer preview. Security fixes are developed on `main`; there is no supported packaged release line yet.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability or include credentials, prompts, session JSONL, private paths, exploit payloads, or reproduction artifacts containing user data.

When this repository is hosted with private vulnerability reporting enabled, use the host's **Security → Report a vulnerability** flow. If that flow is unavailable, contact the repository maintainers through the host's private contact mechanism and share only the minimum redacted information needed to establish impact.

Include, where safe:

- a concise description and affected component;
- impact and attack prerequisites;
- a minimal redacted reproduction;
- suggested mitigation, if known.

## In scope

Examples of in-scope reports include:

- a WebView bypass of allowlisted host commands;
- exposure of credentials, raw environments, session content, or local paths;
- unsafe project trust, extension, or renderer behavior;
- Pi JSONL corruption, silent concurrent-write merging, or process-tree escape;
- unsafe archive/update/provenance or platform-handle behavior.

## Handling expectations

Maintainers will acknowledge a valid report privately, assess severity, work on a fix, and coordinate disclosure where practical. PiUI does not promise a response-time SLA while it remains a developer preview.

## Safe research

Test only against systems, projects, accounts, and session data you are authorized to use. Do not send credentials or real session transcripts to public trackers.
