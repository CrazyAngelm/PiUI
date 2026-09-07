# File format and workflow

The canonical machine-readable contract is `contracts/system-file-v3.schema.json` in the PiUI checkout. It is a standalone versioned exchange format, not an internal store dump or new runtime protocol. JSON was chosen because PiUI already uses typed JSON contracts, schema tooling can reject misspelled fields, and Git diffs are straightforward. XML adds no needed capability here. Unknown fields and unsupported versions are rejected; there is no YAML coercion, template evaluation, include loader or automatic environment expansion.

Top level: `format: "piui-system"`, `version: 3`, `name`, `agents`, `connections`, optional `orchestrator` (agent ID) and `inheritTeamConnections` (boolean). The orchestrator defaults to the first file agent when omitted. It is a coordinator identity, not automatic execution order.

Each agent has a unique local `id`, a `profile`, a `task`, and optional `position: {x,y}` with finite nonnegative canvas coordinates. Profile fields: required `name`, `harness`, `model`, `permissionMode`, `instructions`, `toolPolicy: {rules:[]}`; optional `modelProvider`, `baseInstructions`, `reasoning`, `serviceTier`, `resourceRules`. Do not add internal profile IDs or `allowedSpawnProfileIds`: delegation edges compile those automatically.

Tool rules contain `tool`, `decision` (`allow`/`deny`), `enforcement` (`native`/`coordinator`/`advisory`/`unsupported`), `mandatory` (boolean). Resource rules contain `kind` (`skill`/`mcp`), `id`, `enabled`. Empty native rules mean native defaults, not no tools. Once native rules are present, allowed entries define the allowlist; deny-only rules do not mean 'all except this tool'. Required advisory/unsupported policies cannot be enforced.

Connections are `{from,to,kind}` using local agent IDs:

| Kind | Meaning |
| --- | --- |
| `result` | The target waits for the source task's successful completion and receives its dependency result through the native history resolver. |
| `send` | The source may send messages to the target; does not schedule or wait. |
| `observe` | The source may observe/wait for the target; distinct from sending. |
| `spawn` | The source may request another instance of the target profile through workspace tools; the target also has its ordinary initial pipeline task. |

Result edges form a DAG. Messaging may be bidirectional. Non-spawn self edges, unknown references and duplicate connections are rejected. Files use local IDs; import makes fresh system/profile identities and does not overwrite another saved system. Export → import → export preserves semantic settings and positions, not native history or store revisions. No live file watcher or write-back to the source file is implied. Save stores the draft through PiUI's existing atomic host transaction; Run is separate.

Use `examples/systems/single.piui.json`, `mixed-review.piui.json` or `parallel-synthesis.piui.json` in the repository as structural starting points, not runnable tasks as-is. Replace model placeholders with verified available native IDs and rewrite the task to the user's actual goal. The Prime example uses native authority; 'do not edit' is an instruction, not a sandbox.

Validation has layers: JSON syntax/schema → references/DAG/delegation/static adapter compatibility → host save validation → native runtime preflight. `pnpm system:check path` does not launch anything and cannot prove the last layer. The UI and CLI share the parser. Codex absolute skill paths need review when moving files between computers; exports contain user instructions and resource names/paths, so inspect their contents before sharing publicly.

Runtime model/reasoning catalogs come from each adapter. The composer uses workspace settings v16 and catalogs v18; workspace v15 adds Hermes while previous contracts stay frozen. Graph suggestions reuse observed native catalogs and explicit IDs remain allowed for offline authoring. Fast is model-dependent in Prime, and an unsupported required Fast request fails at preflight. Pi native append instructions use a host-owned temporary file, never a second agent loop.

Version 2 added `input`; version 3 adds Hermes. Both earlier versions remain valid imports. Reusable profiles also accept `whenToCall`, `inputInstructions`, and `expectedResult`.
