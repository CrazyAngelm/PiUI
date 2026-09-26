# PiUI rework progress log

Branch: `rework/piui-2`. Plan: [PLAN_2026-09-26_RU.md](PLAN_2026-09-26_RU.md).
Decisions: §13 of the plan (owner delegated all decisions on 2026-09-26).
Hard requirement from the owner: **Claude Code runs only on the user's Claude
subscription** (never API keys / Bedrock / Vertex), see plan §8.4.

## Done

- `c77dd2d` — pending UX-audit fixes committed (unit 226/226, svelte-check 0,
  clippy clean, desktop lib tests 97/97).
- `fb50cef` — all host clients go through `host-api/transport.ts`; browser runs use
  the lazily loaded UI Lab host (`host-api/lab/`).

## In progress

- Ф0: UI Lab fake backend, bridge defect fixes, host stability fixes, CI switch to
  the workspace shell.

## Next

- Ф1: design system (tokens v2, bits-ui primitives, Lucide), new app shell.
