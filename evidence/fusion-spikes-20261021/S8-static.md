# S8 (static part) - Lead discipline without losing delegation authority

Paths are relative to `D:\Projects\PIUI\` unless stated. Static reading only; no model was run.

## Question

Which restrictions on the lead session still let the broker admit a workspace-write sidekick under the monotonic ("same-or-less") admission rule in `crates/piui-orchestration/src/validation.rs`? Dimensions: permission modes, tool allowlists, Claude Code `plan` mode, network access, disabled resources, native subagents, delegation. Also: does Claude Code `plan` mode let the model call MCP tools (static evidence only)?

## Method

- Read `authorize_spawn` (`crates/piui-orchestration/src/validation.rs:608-644`) and `spawn_permissions_subset` (648-710).
- Read `crates/piui-orchestration/src/types.rs` (`PermissionMode`, line 75), `apps/desktop/src-tauri/src/harness_configuration.rs` (`launch_policy`, `permission_modes`), and `crates/piui-runtime/bridge/claude.mjs`.
- Read `crates/piui-runtime/bridge/CONTRACT.md:385-402`, `claude.test.mjs`, and `claude --help` (installed Claude Code 2.1.302).
- Where an ordinary chat is the lead, I assume the broker synthesizes a lead `AgentProfile` from the session record. An ordinary chat has only `permission_mode` (`workspace_store.rs:33`) and launches with no tool rules, no resource rules, `network_access=false` and `native_subagents=None` (`workspace_api.rs:755-769`).

## Findings

### 1. What `spawn_permissions_subset` actually checks (validation.rs:648-710)

1. **File authority (650-656).** Exactly these (parent, child) pairs pass:
   - `Native -> Native` only if both are the same harness;
   - `FullAccess -> ReadOnly | WorkspaceWrite | FullAccess`;
   - `WorkspaceWrite -> ReadOnly | WorkspaceWrite`;
   - `ReadOnly -> ReadOnly`;
   - everything else is false.

   Note: a `Native` parent never admits a non-Native child, and a non-Native parent never admits a `Native` child.
2. **Network (660).** `child.network_access && !parent.network_access` fails. It does not compare the other direction.
3. **Deny rules (664-674).** Every parent Deny rule must reappear on the child with the same tool, Deny, the same enforcement kind, and mandatory if the parent's was mandatory. Denials cannot disappear.
4. **Native allowlist (675-696).**
   - If the parent has **any** native rules, the child must have a non-empty native rule list. A rule-less child would restore the harness default tool set.
   - Every child **Allow** must be an exact (tool, Allow) pair on the parent.
   - So a lead allowlist without `Edit` / `Write` makes a child with `Edit` an escalation. The child is rejected.
   - If the parent has **no** native rules (the ordinary-chat case), the check is skipped and the child may carry any allowlist.
5. **Resources (697-704).** Every parent resource rule with `!enabled` must exist on the child as the same kind and id, also disabled. A child with an extra disabled rule is fine.
6. **Delegation (706-709).** `child.allowed_spawn_profile_ids` must be a subset of the parent's. For an ordinary lead (empty set) the sidekick must have none.

**What it does not compare:** `native_subagents`, `service_tier`, model, reasoning, instructions, `base_instructions`, harness (other than for `Native`), or host tools / MCP. These need separate broker checks.

`authorize_spawn` (608-644) additionally requires the *requested* profile id in the spawner's `allowed_spawn_profile_ids` (627-636). That applies to managed profiles only, not to a broker-owned sidekick.

### 2. Permission modes and what each harness can actually express

- The four values are `Native`, `ReadOnly`, `WorkspaceWrite`, `FullAccess` (`types.rs:75-80`; the runtime copy is `workspace_runtime.rs:310-315`).
- Per-harness support is in `permission_modes` (`harness_configuration.rs:272-293`):
  - Pi: Native, ReadOnly, FullAccess (no WorkspaceWrite);
  - Prime, Hermes, ACP: Native only;
  - Codex and Claude Code: all four.
- A workspace-write sidekick is therefore only possible on **Codex or Claude Code**.
- **Claude Code mapping** (`claude.mjs:45-52`):

  | PiUI mode | Claude `--permission-mode` |
  |-----------|---------------------------|
  | native | none (user's own default; unverified) |
  | read-only | `plan` |
  | workspace-write | `acceptEdits` |
  | full-access | `bypassPermissions` |

  So **`plan` is representable** as PiUI `ReadOnly` (CONTRACT.md:385-388). The applied mode is verified at handshake and on every `system/init` (`claude.mjs:508-510, 873-875`).
- In `read-only` and `workspace-write`, approvals offer only deny/cancel (`claude.mjs:1048-1050`, CONTRACT.md:389-391). So a workspace-write Claude sidekick can `Edit` / `Write` (acceptEdits) but can never run `Bash` / `PowerShell` (the prompt is auto-denied; `harness_configuration.rs:44-46`). A sidekick that must run tests needs `FullAccess` (bypassPermissions), which requires a FullAccess lead.
- Claude's own CLI also offers `auto`, `manual` and `dontAsk` (`claude --help` `--permission-mode` choices). PiUI does not map them. `dontAsk` would be the natural "only pre-approved tools" lead, but it is not a PiUI `PermissionMode`, so it would need an enum plus contract change, and it still would have no slot in the `spawn_permissions_subset` lattice.

### 3. Does plan mode permit MCP tools? (static evidence only)

- How PiUI wires a host tool: it registers it on a session-scoped HTTP MCP server and pre-approves it with an allow rule, `--allowed-tools mcp__piui-workspace__<tool>` (`claude.mjs:1399-1411`; asserted for the board tool at `claude.test.mjs:840`).
- Nothing in the repo or `claude --help` states whether a plan-mode session honors that allow rule for a non-read-only MCP tool.
  - The only plan-mode use in repo is `llm` steps, which pass `--tools "" --strict-mcp-config` so **no** MCP server runs (CONTRACT.md:396-399).
  - The `claude.test.mjs` host-tool tests do not set `permissionMode: read-only` (the only read-only test there is the init-mode-drift fixture, line 908).
- The `--help` text for `--permission-prompts` says only that "the permission mode still decides everything else".
- If the allow rule were not honored in plan mode, the call would arrive as a `can_use_tool` request. Under `strictPermissions` the UI could offer only deny/cancel (`claude.mjs:1048-1050`), so the call would effectively be refused.
- **Two PiUI-side bridge changes are needed regardless of mode** for a new `sidekick` tool: add it to the pre-approved `hostTools` list (`claude.mjs:1409`) and to the `mcp__*` deny exception (`claude.mjs:1415`). Today an allowlist with no coordinator and no board tool denies all `mcp__*`.
- Verdict: **unverified at runtime.** Needs one live probe: start Claude Code with `--permission-mode plan --allowed-tools mcp__piui-workspace__x` and call the tool.

### 4. Which "strict lead" options are monotonic-compatible with a workspace-write sidekick

Assume sidekick = {permission: WorkspaceWrite, allowlist includes Edit/Write, network false, native_subagents false, no spawn ids}.

| # | Strict-lead option | Admits workspace-write sidekick? | Why |
|---|--------------------|----------------------------------|-----|
| A | Lead = `ReadOnly` (Claude `plan`) | **No** | File rule: `(ReadOnly, WorkspaceWrite)` is false (`validation.rs:654`). Only a read-only sidekick is admitted. |
| B | Lead = `Native` | **No** | `(Native, WorkspaceWrite)` falls into `_ => false`. Only a Native same-harness sidekick is admitted, and Native Claude means "the user's own default", which may or may not auto-approve edits. |
| C | Lead = `WorkspaceWrite` or `FullAccess` | **Yes** | Admitted by 652-653. This is the minimum lead authority that admits the sidekick. |
| D | Lead with a native allowlist **excluding** Edit/Write (Claude `--tools`) | **No** | Child Allow must be in the parent's Allow set (690-693). |
| E | Lead with an explicit **Deny** on Edit/Write | **No** | The child must carry the same Deny (664-674), so it cannot edit. |
| F | Lead allowlist that **includes** Edit/Write but drops Bash, PowerShell, WebFetch, WebSearch, NotebookEdit, Skill, TodoWrite, `Agent` etc. | **Yes** | Child Allow is a subset (no new tools). This narrows lead authority on non-file tools without blocking the sidekick. It does not stop the lead from writing files. Also note: when a parent allowlist exists the child must have one too (688-689), which the sidekick already needs for `--strict-mcp-config`. |
| G | Lead `network_access=false` (Codex only; Claude cannot express network policy: `claude.mjs:55-57`) | **Yes** | Child network must be false; compatible. |
| H | Lead disables resources (skills / MCP) via `resource_rules` (Codex skills+MCP, Prime skills only; rejected for Claude / Pi / Hermes / ACP: `harness_configuration.rs:161-179`, `claude.mjs:61`) | **Yes** | The sidekick must replicate those disabled rules (697-704). It is more restrictive, never an escalation. |
| I | Lead `native_subagents=false` | **Yes (not checked)** | `spawn_permissions_subset` ignores it. The sidekick is set to false by policy anyway. A lead with it enabled and a sidekick with it disabled is also fine (child has less). |
| J | Lead delegation (`allowed_spawn_profile_ids`) empty | **Yes** | The sidekick needs none. Delegation authority for the sidekick is the broker's `sidekick` host tool, not a profile. |
| K | "Lead can write only after the user approves each edit" (Claude default mode) | Not expressible | `Native` is the only PiUI value for "user's default"; see B. |
| L | "Lead must delegate all edits to the sidekick" enforced by the host | Not expressible by restriction | Any restriction removing the lead's own write capability (A, D, E) also removes the sidekick's by the subset rule. Only instruction text (advisory) or a non-monotonic exemption achieves it. |

### 5. The structural conflict

The monotonic rule requires `authority(lead) >= authority(sidekick)`. "Lead discipline" means the lead *should not use* the authority it must hold. Within the existing lattice that gap can only be closed by:

1. **Advisory discipline.** Instructions, lead `Skill` / `Bash` / `Web*` removal (option F), and board / UI messaging. The lead still can `Edit` / `Write` (workspace-write or full-access).
2. **A different admission rule for the sidekick, bounded by user-granted authority rather than by the lead's effective authority.** E.g. the sidekick mode is chosen by the person at Fusion setup and capped by the lead's *pre-discipline* (baseline) mode, while the lead itself runs narrower (for example `plan`). This is a **confused-deputy** shape: the read-only lead causes writes via the sidekick. It breaks the AGENTS.md rule that delegated authority must be same-or-less than the delegator's current authority, and the "no false promise of a sandbox" priority. It needs an ADR and an explicit per-session user consent, and `spawn_permissions_subset` cannot be reused as is.

## Conclusion

- A workspace-write sidekick is admitted **only if the lead is WorkspaceWrite or FullAccess**, on Codex or Claude Code (the only harnesses that offer workspace-write).
- Compatible "strict lead" restrictions: lead allowlist keeps `Edit` and `Write` and drops the rest (F), network false, disabled resources replicated on the sidekick, native subagents off, no delegation profiles, and instruction-level discipline.
- Incompatible: plan / `ReadOnly` lead (A), a Native lead for a non-Native sidekick (B), and any lead allowlist or Deny that removes `Edit` / `Write` (D, E). Claude plan mode is representable (`ReadOnly`) but cannot front a write-capable sidekick under monotonic admission.
- Truly "lead cannot write, sidekick can" requires a non-monotonic, user-consented rule (section 5, point 2) or a new lead mode such as `dontAsk` that has no place in the current lattice. Neither exists today.
- Missing broker-side checks to add around the reused function: native_subagents (child must be false), host-tool set (child has no board / sidekick), plugin MCP (none), same-harness-or-explicitly-comparable modes for Native, and a recheck on every reopen against the lead's *current* mode.

## Unverified

- Runtime behavior of Claude Code `plan` with a pre-approved MCP tool call (section 3). Needs a live probe.
- What Native means for the lead's user setup (the user's default mode; the bridge only passes no flag, `claude.mjs:43-44`).
- Whether `--restricted` (in `claude --help`; removes Bash, PowerShell and other code-running tools and confines file tools to the working directories) is stable enough to harden the sidekick. PiUI does not use it today.
- Whether the `Agent` deny also blocks the legacy `Task` alias on the installed CLI (`claude.mjs:99` names both).
- Cross-harness equivalence of "workspace-write": for Codex it is a real sandbox (`codex.mjs:1256-1262, 1353-1368`), for Claude only its permission engine (`CONTRACT.md:389-391`). The subset rule treats them as equal.
