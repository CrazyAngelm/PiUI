# Native settings catalogs

`harness_models_v14` is an additive host route. It accepts only a trusted
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
