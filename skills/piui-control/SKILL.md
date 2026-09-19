---
name: piui-control
description: Create, launch, inspect and control PiUI native agents, teams and graph pipelines directly through the local API, without UI automation. Use for executing or managing PiUI systems; portable file authoring alone uses piui-systems.
---

# PiUI operator

Work in the user's PiUI checkout (on this installation `D:/Projects/PIUI`). Read
`docs/AGENT_API.md` for activation, method parameters, retries and recovery. The
CLI is `node scripts/agent-api.mjs`; it uses the existing desktop host, not a new
harness. Use the already configured `PIUI_AGENT_API_CONNECTION` or the API port/token
environment. Do not display credentials. If disabled, enable the built host using
the documented starter after an ordinary close; do not start another instance
against live app data. Do not kill the user's running sessions to enable access.

## Workflow

- Establish the requested result and evidence of completion. Discover workspaces
  with `call workspace` and `{ "type": "catalog" }`, then native models/resources
  with `call models`. Preserve user-specified harness/model/settings; never invent
  catalog entries or silently remove unsupported requirements.
- For a new system, read `skills/piui-systems/SKILL.md` and the current portable v4
  schema. Choose topology from actual dependencies. Sequential result edges pass
  native evidence, parallel independent tasks can feed a synthesis node, callable
  agents need explicit spawn authority. Result edges do not grant send/observe/spawn.
  Do not manufacture agent counts, budgets, retries or other numerical policies.
- Write the portable JSON and `prepare <file> <workspaceId> <new-plan.json>`. This
  validates through the same parser as UI import. Retain this plan: it contains
  stable graph and run IDs. `save <plan>` is atomic and does not run anything.
  `run <plan>` launches immediately. If the user requested execution, perform all
  three steps; file creation alone is incomplete. File-only requests stop at prepare.
- Track the returned run using `getRun` and `waitRun` with its current revision and
  a caller-appropriate timeout. Inspect `workspace` snapshots for actual replies,
  tool progress and approval/input requests. Sessions have `runId` and `memberId`.
  Use `usage` for actual native counters. Do not equate accepted/running/idle with
  task success. Report uncertainty, denied policy, failed tasks or required input.
- On loss of connection, query the saved IDs before retrying. Never generate another
  plan to recover an unknown outcome. Existing IDs/revisions preserve identity;
  duplicate starts are refused. Do not fabricate successful results or history refs.

## Control and changes

Use `workspace` send/steer/follow-up and approval responses through the typed host.
Pause/resume/decide/repeat use `controlFlow`; stop work through `cancelRun` or
`cancelTask`. Request cancellation does not happen merely because the CLI times out.
Choose these operations from the user's intent. Do not auto-approve unrelated
commands, grant project trust implicitly, or broaden native permissions to unblock.
Registration creates a restricted project; an explicit user trust decision is
required before `setProjectTrust` grants execution in that directory.

For an existing saved system, fetch full profiles/team/pipeline/launch command and
use one `saveGraph` with their `expectedRevision` values. Import/prepare always
creates a new system. Edits affect later runs; active runs retain their frozen graph.
Conflicts need a fresh read and intentional reconciliation, not blind overwrite.

The operator capability belongs to the external controlling agent. Never install
it as a resource in managed child profiles: they use the existing authenticated
coordinator tools and same-or-less delegation checks. Disabled skills are not a
filesystem sandbox, and cross-harness native defaults are not comparable. Never
edit internal stores, global auth/config or native history to implement an API action.

## Windows restart recovery

Prefer the **PiUI (Operator API)** desktop entry. Install it with the repository's
`scripts/install-agent-api-shortcut.ps1` without launching/stopping PiUI. An ordinary
shortcut does not opt into the API. `ECONNREFUSED` with an existing connection file
means access is unavailable, not that native work stopped. Do not launch a second
host. After the user closes PiUI normally when safe, the starter checks `ping` and
publishes a new connection atomically. `-ClearStaleConnection` is cleanup-only and
refuses while PiUI is running. Never replay prepare/run to restore connectivity.
