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

Resource discovery waits on native MCP startup (about ten seconds for Codex)
and never discards an answered model catalog: a failed or timed-out discovery
returns the models with an empty resource list and a visible warning. The
optional request field `part` splits one probe: `models` answers as soon as the
native catalog does and leaves discovery running in the same probe; the next
`resources` request for that workspace and harness collects it. Parallel
`models` requests queue one discovery each and `resources` requests claim them
oldest first (unclaimed discoveries expire after two minutes; without one the
host starts a new probe).
Model pickers use the split, so they never wait for MCP servers. A request
without `part` still answers both from one probe.

The workbench never remembers a degraded answer (resources replaced by the
warning): the next picker asks for the resources again and reuses the answered
models, the stored snapshot keeps the resources it had, and preflight reports
one "Could not verify the native catalog" instead of a missing resource per
rule. An explicit refresh never joins a split load in flight. The new-chat
composer shows that warning with Retry and keeps the models and any skills it
already listed. The UI Lab simulates both cases with `?catalog=slow` and
`?catalog=no-resources`.

Pickers (`cachedHarnessModels`) never wait for a catalog they have seen. A
project's last catalog (localStorage, seven days) shows at once while the probe
runs. A project without one gets the models the same harness listed for any
project as a provisional list (no resources; the spinner stays and this
project's answer replaces it). A completed in-memory catalog older than five
minutes, or answered before the harness's native version changed (a CLI update),
is shown at once and asked again in the background. A coded refusal
(`SIGN_IN_REQUIRED`, trust, safe mode) forgets the snapshots; a transient
failure (`RUNTIME_FAILED`, unknown) keeps them. Sign-in checks and preflight
never read a snapshot.

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

## Nano (host-served, no native discovery)

Nano is an additive `harness_models_v18` value (ADR-048, identity grammar v3).
Unlike every harness above it has no native catalog to probe: the models are the
server's four modes (`auto`, `free`, `fast`, `smart`) and the host serves them
from the signed-in account's entitlements (`GET .../entitlements` of the selected
workspace, cached by the account manager; no inference and no paid turn).

- Each **available** mode becomes `WorkspaceModel { id: <mode id>, provider:
  "nano", name: <mode name> }`. There are no thinking levels (`reasoning`
  options stay empty), no Fast (`supportsFast` is `false`) and no resources.
  A locked mode is not in the list; the picker shows tier, cost hint and lock
  reason from the account status (`nano-account-v1`), joined by mode id, so the
  v18 contract carries nothing Nano-specific.
- Signed out, offline without a cached snapshot, in safe mode, or when
  `features.localAgent` is false, the list is empty with the reason
  (`NANO_SIGN_IN_REQUIRED`, `SAFE_MODE` or a typed refusal) and no process is
  started. The catalog never touches the network on its own: it reads what the
  host already learned, and refreshing entitlements is an account action.
- A catalog row is not a guarantee of a successful turn: credits can run out and
  a plan can change between the catalog and the call, in which case the relay
  answers with a typed error (`nano_credits_exhausted`, `nano_mode_locked`).
  Imported settings naming a mode the account does not offer stay visible and
  are not silently removed, as for other harnesses. Concrete provider models
  behind a mode are never named.
