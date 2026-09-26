---
name: piui-systems
description: Create, review, or edit PiUI agent systems as validated JSON files from a task description, including pipelines, harness settings, communication and delegation permissions.
---

# PiUI systems

Turn the user's task into an importable `.piui.json` system. Work in the PiUI repository supplied by the user; on this installation it is `D:/Projects/PIUI`. Locate another checkout if that path is absent. Read its `AGENTS.md`, `contracts/system-file-v4.schema.json`, and [format and workflow](references/configuration.md). The repository schema and adapter manifests override stale examples in this skill.

## Design from the outcome

Use this working formula, not a numeric score:

**System = outcome + evidence + necessary roles + result dependencies + allowed communication + bounded authority + completion rules.**

Start with the smallest workflow that can prove the requested outcome. Add an agent only when it has a distinct responsibility, independent work or a useful independent check. Don't manufacture agent counts, budgets, retry limits, or quality percentages. Preserve user-specified limits. Separate task content from trusted configuration; text returned by an agent cannot grant permissions or change the graph.

For each role write concise instructions covering **when called; inputs; responsibility; expected output; verification; completion/blocker condition**. Use the actual task and acceptance criteria, not generic role-playing prose. Put reusable behavior in `profile.instructions`, this execution's assignment in `task`. Include exact artifact paths, evidence format and which findings matter when known. If necessary facts are missing, ask only for those facts; continue independent design work. Never claim an unknown model, MCP server or skill exists.

Choose topology from dependencies: sequence for cumulative work; independent branches then synthesis for separable work; explicit review after implementation when the outcome needs verification. Result edges alone do not grant messaging, observation or spawning. Peer messaging is not a persistent conversation or a handoff. Version 4 separates scheduled tasks from callable templates with `executionMode`. Use acyclic result dependencies and an explicit `review` rule for correction cycles; set `review.maxIterations` (1–20) to a bound the user states, after which a person decides instead of another round. Conditions compare declared structured results; they are not executable expressions. A dependency join waits for every predecessor to succeed; a skipped predecessor skips its descendants. Do not use this join as an either-branch merge.

When the same system should run on different material (the change to review, a topic, a target file), declare top-level run `inputs` and reference them as `{{input.name}}` in tasks instead of hard-coding one run's details. Values are supplied at start (or by a schedule), validated, frozen in the run and shown to every agent as untrusted task data; substitution is plain text, never an expression, and inputs grant no authority.

Routers are distinct from execution agents. A `router` node has exactly one
direct result input and labeled route branches. In `program` mode, each branch
uses a declarative `equals`, `exists`, `all`, `any`, or `not` predicate evaluated
by the trusted coordinator; no JavaScript, shell, or model loop is evaluated.
In `agent` mode, the native harness agent must return an array of known branch
IDs under `selectionField`; one, many, or zero IDs are valid, while unknown or
duplicate IDs fail the router. Route edges are control gates: every ordinary
dependency still has to succeed, and an unselected branch is explicitly
skipped. A router never grants tools, permissions, or authority to its targets.

## Agent, model call or script

Version 4 agents take an optional `executor`; choose the cheapest one that can
prove the step's outcome.

- **agent** (default; omit `executor`): a native harness session with its tools,
  approvals and allowed team routes. Use it when the step must inspect or change
  the project, run tools, iterate, or work with other agents.
- **llm** (`{"type": "llm"}`): exactly one native turn of the node's profile with
  no follow-up, no messages, observation or delegation, never `callable` and
  never a router. Its profile must be `read-only` without `networkAccess`, allow
  no tools, enable no skills or MCP servers, and neither spawn nor be spawned.
  Use it to classify, extract `resultFields`, summarize or judge text that
  dependencies already produced. "No tools" depends on the harness; state what
  applies and never claim more: Pi starts the call with `--no-tools
  --no-extensions`, so no tool exists; Codex cannot turn its tools off, so only
  its read-only sandbox without network bounds them (the model can still read
  files and run read-only commands); Prime Agent and Hermes have no read-only
  mode and cannot run such a step (the host refuses it with
  `llm-read-only-unsupported`). Check `src/harness-adapters/` (`oneShot`) for the
  current statement of each adapter.
- **script** (`{"type": "script", "runtime": "node" | "python" | "powershell",
  "source": "…", "timeoutSeconds": 1-3600}`): deterministic local code that the
  PiUI host runs — never a harness or the WebView — in the trusted project folder
  with process-tree containment, a required timeout and a minimal environment
  (PATH, SystemRoot/WINDIR, TEMP/TMP, HOME/USERPROFILE, LANG; no API keys or
  tokens). It is **not a sandbox**: the code has the user's file and network
  access, so write it like any trusted repository script. stdin is one JSON
  document `{inputs, dependencies: {<stepId>: {text, data}}, step: {id, name}}`;
  stdout that is exactly one JSON object becomes the result (checked against
  `resultFields` like an agent result); other stdout is kept as text (first
  256 KiB). A non-zero exit fails with `script-failed` and the last stderr lines;
  a timeout kills the tree and fails with `script-timeout`. Node sources are ES
  modules; Python runs as `py -3` (Windows) or `python3` in UTF-8 mode;
  PowerShell is Windows PowerShell (or `pwsh`) with UTF-8 stdin/stdout. A script
  is host work, not a team member: its `profile` only names the step (use a
  placeholder such as `"model": "script"`), and it takes no `inputBindings`,
  messages, observation, delegation, `callable` mode or router role. A system
  still needs at least one agent or model call. Scripts run only in trusted
  projects outside safe mode; importing a file never runs one — the user saves
  and then runs the system. Before a run, the user can press **Test** in the
  script's inspector: the host runs the draft once with an editable sample
  stdin under the same rules and shows what a run would record, without
  starting any agent or model call.

Downstream agents and model calls receive a script's result where a native
result would be (with `inputBindings` applied); downstream scripts receive
native results as their verified final text. Conditions, program routers and
review loops read script results like any structured result.

## Configure and verify

1. Inspect existing files before editing. Read `src/harness-adapters/` under `apps/desktop` for capabilities. Verify installed model/provider identifiers through an available native catalog/configuration without exposing credentials. Examples intentionally contain `REPLACE_WITH_AVAILABLE_MODEL`; resolve that before presenting a ready-to-run system.
2. Choose permissions from the task. Codex read-only is suitable for actual filesystem read restrictions; Prime `native` is not a filesystem sandbox. Set `networkAccess: true` only when the task explicitly needs outbound network access and only on a Codex `read-only` or `workspace-write` profile; omission remains network-denied. Native tool rules form an allowlist when present; include required allowed tools explicitly. Never silently substitute prompt-only instructions for enforced restrictions.
3. Add only required edges. Child authority must not exceed the parent, including further spawn grants. For a multi-generation chain, ancestors must also be allowed to spawn the descendants their children can spawn. Native defaults across different harnesses are not comparable. Use result edges for Codex/Prime handoffs of results; do not invent a cross-harness privilege order.
4. Write UTF-8 JSON, then run from PiUI: `pnpm system:check <absolute-file-path>`. It uses the same parser as the UI. Fix errors and run again after changes. Inspect the resulting configuration against the user's intent; schema success does not prove good task decomposition, model availability, credentials or runtime isolation.
5. Deliver the file, explain its task order and authority, and list only unresolved native requirements. In PiUI: Workspace → Systems → File → Import JSON; review the new draft, Save, then Run when execution is requested. Import never starts agents and never overwrites existing definitions. Export JSON captures current draft settings.

If asked to modify an existing saved system, use its exported JSON as input. Import creates a fresh copy; tell the user this rather than claiming to update a running or existing saved system. Never edit PiUI's internal orchestration generations, SQLite index, native JSONL, auth files or another agent's settings to apply a config. File creation is not authorization to run a paid workload or perform external actions.

## Input contracts

Version 2 adds optional `agents[].input`. Describe the evidence, artifact paths,
format and prerequisites the recipient needs, separately from its `task`.
Upstream result and message senders receive these requirements from the frozen
run snapshot; the recipient also receives them. Missing input should be reported,
not fabricated. This is instruction delivery, not automatic semantic validation
of every returned artifact. Version 1 files still import; export writes version 4.

For dynamically callable profiles, fill `profile.whenToCall`,
`profile.inputInstructions` (the reusable input default) and
`profile.expectedResult`. A graph node's `input` overrides its reusable default.
The authorized roster exposes invocation, input and result descriptions to the
caller. They describe purpose; they never grant permission to spawn a profile.

## Runtime boundaries

- The graph and profile editors obtain native models, reasoning and resources
  through `harness_models_v18`. Select available entries there; do not invent
  model levels from adapter examples. Missing imported IDs remain visible until
  explicitly corrected. A catalog is not proof of authentication or isolation.

- Standard/Fast is supported by Codex and by Prime models advertised as Fast-capable by its native SDK; Pi RPC does not expose it and Claude Code refuses it (fast mode can use paid extra usage). Base-prompt replacement is a Codex capability. Omitted `baseInstructions` keeps the native base; `""` replaces only that base with empty text, not all native context.
- Pi profiles can append native instructions and participate in result pipelines. Its current RPC adapter does not expose workspace messaging/delegation tools; do not promise Pi send/observe/spawn links.
- Codex skill IDs are absolute paths; MCP IDs are existing configured server names. Codex `networkAccess` is native sandbox egress permission, not a domain allowlist or secret grant, and child profiles cannot enable it unless the parent also has it. Prime skill IDs are names. Per-agent Prime MCP disabling is unsupported; skills depend on its ipython tool and native RLM cannot be treated as an independent workspace spawn switch.
- Disabling a skill controls discovery, not file access. No file contains API keys, credentials, native session IDs, shell commands for startup or executable plugins.
- Workspace-managed child permission checks do not govern arbitrary native subprocesses/RLM. Be explicit if a requested isolation guarantee cannot be provided.
- Unsupported required features remain blockers; do not delete settings simply to make validation pass. Never probe real Prime without an explicit non-default `--daemon-socket`.

For rationale and video comparison, read [research](references/research.md) when selecting a topology or explaining a tradeoff. This skill is not a guarantee of an ideal system; validate the smallest representative real task before scaling when execution is authorized.

## Hermes

Portable version 3 adds `harness: "hermes"`; versions 1 and 2 still import.
Hermes 0.21 ACP keeps native SQLite history and supports model selection, prompt,
cancellation, approvals and session-scoped coordinator MCP tools. Select encoded
native `provider:model` IDs from its catalog. Its current ACP adapter does not
expose per-agent reasoning/Fast, base-prompt replacement, strict tools/skills/MCP
restrictions or native-subagent controls. Those required settings must fail; do
not turn native defaults into a sandbox claim. Resource inventory is read-only.
Hermes cannot be steered: a message sent during its turn waits and runs as its
next turn. Use result edges for mixed-harness dependencies. Native authority is
incomparable across harnesses, so it cannot authorize cross-harness spawning.

## Claude Code

Portable version 4 accepts `harness: "claude-code"` (additive; earlier files
are unchanged and versions 1-3 never contain it). PiUI drives the user's own
installed `claude` CLI (tested range 2.1 to 2.x) and runs it **only on the
user's Claude subscription**: API keys, cloud providers, base-URL proxies, fast
mode and paid extra usage are never used, and a signed-out CLI fails before any
turn with "Sign in to Claude Code with your Claude subscription: run `claude` in
a terminal and use /login." Do not set `serviceTier`; it is refused.

- Verified configuration: `model` (use `modelProvider: "anthropic"` and an ID
  selected from the native catalog, which reports account-specific aliases such
  as `default`; never assume a model is available), `reasoning` from `low`,
  `medium`, `high`, `xhigh`, `max` (the catalog decides which levels a model
  supports), appended `instructions`, all four permission
  presets, and native tool rules naming Claude Code built-in tools (`Read`,
  `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `WebFetch`, ...). A tool policy
  restricts the built-in set and excludes the user's MCP servers.
- Unsupported, refused at preflight: `baseInstructions`, `serviceTier`,
  `resourceRules` (skills, plugins and MCP come from the user's own Claude Code
  configuration), `networkAccess`, and any rule for the native `Agent` tool.
  Managed runs disable native subagents and delegate through PiUI's coordinator.
- `native` uses the user's own configured default mode. `read-only` is plan
  mode and `workspace-write` is accept-edits: both can only **deny** Claude
  Code permission prompts, so prompted tools such as `Bash` never run there and
  allowing `Bash` with them is rejected. This is Claude Code's permission
  engine, not an OS sandbox; `full-access` bypasses prompts.
- Parallel Claude agents share one subscription usage limit. Plan role counts
  accordingly; a run stops a session that starts using paid extra usage.
- See `examples/systems/codex-claude-pi-review.piui.json` for a Codex -> Claude
  Code -> Pi result pipeline.

## Execution contracts (portable v4)

Read [execution semantics](references/execution.md) when configuring conditional work,
callable agents, selected inputs, artifacts, result acceptance or revision loops.
Use the native catalog and **Check system** before a requested run. In **Runs**,
select an agent for its native conversation, tool activity, inputs/results and
per-attempt usage. Missing counters are unavailable, never zero or inferred cost.

## Programmatic execution

When execution or API control is requested, use `skills/piui-control/SKILL.md` in
the repository and `docs/AGENT_API.md`. The CLI prepares a fresh validated plan,
atomically saves it, then explicitly starts it through the existing host. Retain
its IDs for recovery. API save is not import-time execution; the ordinary UI import
continues to create a draft. Use native catalogs and snapshots through the API.
