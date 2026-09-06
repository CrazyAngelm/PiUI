---
name: piui-systems
description: Create, review, or edit PiUI agent systems as validated JSON files from a task description, including pipelines, harness settings, communication and delegation permissions.
---

# PiUI systems

Turn the user's task into an importable `.piui.json` system. Work in the PiUI repository supplied by the user; on this installation it is `D:/Projects/PIUI`. Locate another checkout if that path is absent. Read its `AGENTS.md`, `contracts/system-file-v1.schema.json`, and [format and workflow](references/configuration.md). The repository schema and adapter manifests override stale examples in this skill.

## Design from the outcome

Use this working formula, not a numeric score:

**System = outcome + evidence + necessary roles + result dependencies + allowed communication + bounded authority + completion rules.**

Start with the smallest workflow that can prove the requested outcome. Add an agent only when it has a distinct responsibility, independent work or a useful independent check. Don't manufacture agent counts, budgets, retry limits, or quality percentages. Preserve user-specified limits. Separate task content from trusted configuration; text returned by an agent cannot grant permissions or change the graph.

For each role write concise instructions covering **when called; inputs; responsibility; expected output; verification; completion/blocker condition**. Use the actual task and acceptance criteria, not generic role-playing prose. Put reusable behavior in `profile.instructions`, this execution's assignment in `task`. Include exact artifact paths, evidence format and which findings matter when known. If necessary facts are missing, ask only for those facts; continue independent design work. Never claim an unknown model, MCP server or skill exists.

Choose topology from dependencies: sequence for cumulative work; independent branches then synthesis for separable work; explicit review after implementation when the outcome needs verification. Result edges alone do not grant messaging, observation or spawning. Peer messaging is not a persistent conversation or a handoff. Every file agent is initially a pipeline task; there are no template-only nodes in v1. Do not simulate conditional loops, persistent teams or runtime channels with cyclic result edges.

## Configure and verify

1. Inspect existing files before editing. Read `src/harness-adapters/` under `apps/desktop` for capabilities. Verify installed model/provider identifiers through an available native catalog/configuration without exposing credentials. Examples intentionally contain `REPLACE_WITH_AVAILABLE_MODEL`; resolve that before presenting a ready-to-run system.
2. Choose permissions from the task. Codex read-only is suitable for actual filesystem read restrictions; Prime `native` is not a filesystem sandbox. Native tool rules form an allowlist when present; include required allowed tools explicitly. Never silently substitute prompt-only instructions for enforced restrictions.
3. Add only required edges. Child authority must not exceed the parent, including further spawn grants. For a multi-generation chain, ancestors must also be allowed to spawn the descendants their children can spawn. Native defaults across different harnesses are not comparable. Use result edges for Codex/Prime handoffs of results; do not invent a cross-harness privilege order.
4. Write UTF-8 JSON, then run from PiUI: `pnpm system:check <absolute-file-path>`. It uses the same parser as the UI. Fix errors and run again after changes. Inspect the resulting configuration against the user's intent; schema success does not prove good task decomposition, model availability, credentials or runtime isolation.
5. Deliver the file, explain its task order and authority, and list only unresolved native requirements. In PiUI: Workspace → Systems → File → Import JSON; review the new draft, Save, then Run when execution is requested. Import never starts agents and never overwrites existing definitions. Export JSON captures current draft settings.

If asked to modify an existing saved system, use its exported JSON as input. Import creates a fresh copy; tell the user this rather than claiming to update a running or existing saved system. Never edit PiUI's internal orchestration generations, SQLite index, native JSONL, auth files or another agent's settings to apply a config. File creation is not authorization to run a paid workload or perform external actions.

## Runtime boundaries

- Standard/Fast and base-prompt replacement are Codex capabilities. Omitted `baseInstructions` keeps the native base; `""` replaces only that base with empty text, not all native context.
- Codex skill IDs are absolute paths; MCP IDs are existing configured server names. Prime skill IDs are names. Per-agent Prime MCP disabling is unsupported; skills depend on its ipython tool and native RLM cannot be treated as an independent workspace spawn switch.
- Disabling a skill controls discovery, not file access. No file contains API keys, credentials, native session IDs, shell commands for startup or executable plugins.
- Workspace-managed child permission checks do not govern arbitrary native subprocesses/RLM. Be explicit if a requested isolation guarantee cannot be provided.
- Unsupported required features remain blockers; do not delete settings simply to make validation pass. Never probe real Prime without an explicit non-default `--daemon-socket`.

For rationale and video comparison, read [research](references/research.md) when selecting a topology or explaining a tradeoff. This skill is not a guarantee of an ideal system; validate the smallest representative real task before scaling when execution is authorized.
