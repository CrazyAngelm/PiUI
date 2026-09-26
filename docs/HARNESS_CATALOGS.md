# Native settings catalogs

`harness_models_v18` is an additive host route. It accepts only a trusted
workspace ID and a typed harness identity; safe mode rejects runtime discovery.
The v11 workspace grammar and native history formats remain unchanged.

The response preserves model ID and provider together, native reasoning levels,
and resource IDs, names, default state and configurability. UI examples in an
adapter manifest are never used as a model's reasoning options. Catalog failures
remain visible and retryable. Imported settings missing from a catalog remain
visible and are not silently removed.

Codex reads `model/list`, `skills/list`, `config/read` (projected to MCP names and
enabled state only), and `mcpServerStatus/list`. Pi uses its RPC model/command
catalog and the installed Pi AI SDK's thinking-level resolver. Prime uses its
native model registry and resource services in catalog-only mode, without
creating an inference session or refreshing credentials over the network.
The catalog is the installed runtime's current view, not a guarantee of provider
authentication or a successful paid turn.

Resource switches are per-agent launch overrides. Prime skill names, Codex skill
paths and MCP names retain native identity. Pi skills and Codex arbitrary tools
are read-only where the adapter cannot enforce a per-session selection. Prime
MCP isolation is unsupported. These controls do not imply filesystem isolation.
Every required restriction is still checked by the existing host launch policy.

The host owns and disposes discovery processes. Prime receives an explicit
isolated supervisor address. Catalog discovery does not create a PiUI chat,
write native history, or submit a model prompt.

Catalog v14 carries `supportsFast` per model from the adapter. Prime uses its
native `supportsFastMode` resolver. Pi exposes no Fast service tier; Codex uses
its native service-tier override. Choosing another model clears incompatible Fast.

Version 18 adds Hermes; v14 remains a frozen compatibility document. Hermes uses native no-probe inventory and canonical custom-provider choice IDs. Its resource controls are read-only.

Claude Code is an additive v18 harness value (ADR-028). Its catalog is the
`initialize` control response of the user's own `claude` CLI, started without a
conversation and retired immediately: models keep the native alias as ID with
provider `anthropic` and the native effort levels; slash commands and skills are
read-only resources. `supportsFast` is always `false`: fast mode can use paid
extra usage and PiUI never offers it. The same handshake verifies the Claude
subscription login; any other login fails with `SIGN_IN_REQUIRED` and the fixed
sign-in guidance, and no catalog is returned. Nothing is written to Claude
Code's transcript directory.

The new-chat composer shows that verdict before the first message when Claude
Code is the selected harness: the host's cached verdict (the Claude Code catalog
`reason`, set by the last refused start or catalog check in this host process)
renders as "Not signed in — run `claude` in a terminal and use /login" with
**Check again**. Nothing is checked on mount: the status shares the catalog
request the composer's model picker makes anyway, and **Check again** is one
fresh catalog request (the same `initialize` handshake, no conversation and no
model turn); the newest verdict seen in the composer wins over the cached one.
An open chat needs no status: its CLI passed the same check when it started. A
cached verdict never blocks a start: every start checks the login again, and a
managed pipeline step refused this way fails with `harness-sign-in-required`
before any task text is written.
