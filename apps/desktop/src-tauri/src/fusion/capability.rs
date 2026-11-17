//! What a Fusion role is effectively allowed to do (ADR-076), per adapter
//! and permission preset, derived from what each bridge actually launches
//! (not from a rank number):
//!
//! - Claude Code `read-only` is `--permission-mode plan` and
//!   `workspace-write` is `acceptEdits`; in both, PiUI lets approvals only be
//!   denied (`strictPermissions` in `claude.mjs`), so commands, MCP tools,
//!   web tools and reads outside the folder never run. `full-access` is
//!   `bypassPermissions`.
//! - Codex `read-only` / `workspace-write` are the `:read-only` /
//!   `:workspace` profiles with `approvalPolicy: never` and network off:
//!   commands run inside the sandbox, which can read the whole disk. For a
//!   sidekick in these presets `codex.mjs` switches every configured MCP
//!   server off (their processes run outside the sandbox). `full-access` is
//!   `:danger-full-access`.
//! - Pi runs only with full access. Nano `read-only` has read tools only;
//!   Nano `native` asks the person (approval guard) before bash, write and
//!   edit.
//! - A sidekick never delegates (no native subagents, verified at launch)
//!   and never runs work past its turn; plugin MCP and the board are off.
//!   `native` presets are the person's own configuration and are unknown.
//!
//! Admission compares every dimension except reads: by the person's decision
//! (ADR-076) a sidekick may read outside the project folder even when the
//! lead cannot; the allowance still shows it. A sandboxed command is covered
//! by a lead that may make the sandbox's writes, since with reads exempt the
//! sandbox confines its effects to those writes (network off). When the
//! requested sidekick preset
//! exceeds the lead, the sidekick is narrowed to the strongest preset of its
//! harness that fits; only a dimension no preset can bring under the lead
//! refuses the pair, and the refusal names it.

use super::model::{FusionPair, FusionRefusal, FusionRoleName};
use piui_runtime::workspace_runtime::{HarnessKind, PermissionMode};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Writes {
    None,
    Workspace,
    /// Anywhere, each change approved by the person in the app.
    Approved,
    Anywhere,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Reads {
    Workspace,
    Anywhere,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Shell {
    /// No command runs (requests can only be declined).
    None,
    /// Any command, inside a sandbox that writes nothing.
    ReadOnlySandbox,
    /// Any command, inside a sandbox that writes only the project folder.
    WorkspaceSandbox,
    /// Unconfined, each command approved by the person in the app.
    Approved,
    Unrestricted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Network {
    None,
    Approved,
    Full,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Mcp {
    None,
    /// The MCP servers configured in this harness by the person.
    Configured,
}

/// A dimension a refusal names (reads are never compared, ADR-076).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Dimension {
    Writes,
    Shell,
    Network,
    Mcp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities {
    pub writes: Writes,
    pub reads: Reads,
    pub shell: Shell,
    pub network: Network,
    pub mcp: Mcp,
}

const fn caps(
    writes: Writes,
    reads: Reads,
    shell: Shell,
    network: Network,
    mcp: Mcp,
) -> Capabilities {
    Capabilities {
        writes,
        reads,
        shell,
        network,
        mcp,
    }
}

const FULL: Capabilities = caps(
    Writes::Anywhere,
    Reads::Anywhere,
    Shell::Unrestricted,
    Network::Full,
    Mcp::Configured,
);

/// The effective capabilities of a preset (`None`: not offered by this
/// harness, or `native`, which is the person's own configuration).
pub(crate) const fn capabilities(
    harness: HarnessKind,
    mode: PermissionMode,
) -> Option<Capabilities> {
    use PermissionMode::{FullAccess, Native, ReadOnly, WorkspaceWrite};
    match (harness, mode) {
        (_, FullAccess) => Some(FULL),
        (HarnessKind::ClaudeCode, ReadOnly) => Some(caps(
            Writes::None,
            Reads::Workspace,
            Shell::None,
            Network::None,
            Mcp::None,
        )),
        (HarnessKind::ClaudeCode, WorkspaceWrite) => Some(caps(
            Writes::Workspace,
            Reads::Workspace,
            Shell::None,
            Network::None,
            Mcp::None,
        )),
        (HarnessKind::Codex, ReadOnly) => Some(caps(
            Writes::None,
            Reads::Anywhere,
            Shell::ReadOnlySandbox,
            Network::None,
            Mcp::None,
        )),
        (HarnessKind::Codex, WorkspaceWrite) => Some(caps(
            Writes::Workspace,
            Reads::Anywhere,
            Shell::WorkspaceSandbox,
            Network::None,
            Mcp::None,
        )),
        (HarnessKind::Nano, ReadOnly) => Some(caps(
            Writes::None,
            Reads::Anywhere,
            Shell::None,
            Network::None,
            Mcp::None,
        )),
        (HarnessKind::Nano, Native) => Some(caps(
            Writes::Approved,
            Reads::Anywhere,
            Shell::Approved,
            Network::Approved,
            Mcp::None,
        )),
        _ => None,
    }
}

/// The built-in tool set a Claude Code sidekick runs with in a shell-less
/// preset: what makes the matrix rows above true (ADR-076). The bridge passes
/// it as `--tools` (no Bash, PowerShell or other code runner exists in the
/// session, whatever the person's own permission rules pre-approve) with
/// `--strict-mcp-config` and no MCP configuration (no MCP server), drops the
/// person's user and local setting sources, and stops the session if its
/// init tool list holds anything else. `None`: not restricted this way.
pub(crate) fn claude_sidekick_tools(permission: PermissionMode) -> Option<Vec<String>> {
    let read = ["Read", "Glob", "Grep", "TodoWrite"];
    let write = ["Edit", "Write", "NotebookEdit"];
    let tools: Vec<&str> = match permission {
        PermissionMode::ReadOnly => read.to_vec(),
        PermissionMode::WorkspaceWrite => read.iter().chain(write.iter()).copied().collect(),
        PermissionMode::Native | PermissionMode::FullAccess => return None,
    };
    Some(tools.into_iter().map(str::to_owned).collect())
}

const fn writes_le(a: Writes, b: Writes) -> bool {
    matches!(
        (a, b),
        (Writes::None, _)
            | (_, Writes::Anywhere)
            | (Writes::Workspace, Writes::Workspace)
            | (Writes::Approved, Writes::Approved)
    )
}

/// A person-approved unconfined command is covered only by the same or an
/// unrestricted shell. A sandboxed command is covered
/// by a lead that may make the sandbox's writes (reads are exempt, network is
/// off in every sandbox preset).
const fn shell_le(a: Shell, b: Shell, lead_writes: Writes) -> bool {
    matches!(
        (a, b),
        (Shell::None, _)
            | (_, Shell::Unrestricted)
            | (
                Shell::ReadOnlySandbox,
                Shell::ReadOnlySandbox | Shell::WorkspaceSandbox
            )
            | (Shell::WorkspaceSandbox, Shell::WorkspaceSandbox)
            | (Shell::Approved, Shell::Approved)
    ) || match a {
        Shell::ReadOnlySandbox => true,
        Shell::WorkspaceSandbox => writes_le(Writes::Workspace, lead_writes),
        _ => false,
    }
}

/// The first dimension in which the sidekick exceeds the lead (`None`: it
/// does not). MCP servers are configured per harness, so another harness's
/// servers are covered only by a lead that may run anything.
pub(crate) fn exceeds(
    sidekick: Capabilities,
    sidekick_harness: HarnessKind,
    lead: Capabilities,
    lead_harness: HarnessKind,
) -> Option<Dimension> {
    if !writes_le(sidekick.writes, lead.writes) {
        return Some(Dimension::Writes);
    }
    // Reads are shown, not compared (ADR-076, the person's decision).
    if !shell_le(sidekick.shell, lead.shell, lead.writes) {
        return Some(Dimension::Shell);
    }
    if sidekick.network > lead.network {
        return Some(Dimension::Network);
    }
    let mcp_covered = match (sidekick.mcp, lead.mcp) {
        (Mcp::None, _) => true,
        (Mcp::Configured, Mcp::Configured) => {
            sidekick_harness == lead_harness || lead.shell == Shell::Unrestricted
        }
        (Mcp::Configured, Mcp::None) => false,
    };
    (!mcp_covered).then_some(Dimension::Mcp)
}

/// The sidekick presets of a harness, strongest first.
const fn sidekick_presets(harness: HarnessKind) -> &'static [PermissionMode] {
    use PermissionMode::{FullAccess, Native, ReadOnly, WorkspaceWrite};
    match harness {
        HarnessKind::ClaudeCode | HarnessKind::Codex => &[FullAccess, WorkspaceWrite, ReadOnly],
        HarnessKind::Pi => &[FullAccess],
        HarnessKind::Nano => &[FullAccess, Native, ReadOnly],
        _ => &[],
    }
}

/// What a pair runs with once admitted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Admitted {
    /// The sidekick's launch preset (lower than requested when narrowed).
    pub sidekick_mode: PermissionMode,
    /// `None` for a same-harness `native` pair (the person's configuration).
    pub capabilities: Option<Capabilities>,
}

pub(crate) type Refused = (FusionRefusal, FusionRoleName, Option<Dimension>);

/// Admission of a pair (ADR-043, ADR-076). `codex_sandbox`: Codex's Windows
/// sandbox is configured (or the platform needs none).
pub(crate) fn admit(pair: &FusionPair, codex_sandbox: bool) -> Result<Admitted, Refused> {
    let FusionPair { lead, sidekick, .. } = pair;
    if !lead.harness.supports_sidekick_tool() {
        return Err((
            FusionRefusal::LeadHarnessUnsupported,
            FusionRoleName::Lead,
            None,
        ));
    }
    let presets = sidekick_presets(sidekick.harness);
    if presets.is_empty() {
        return Err((
            FusionRefusal::SidekickHarnessUnsupported,
            FusionRoleName::Sidekick,
            None,
        ));
    }
    let requested = sidekick.permission_mode;
    // The same harness's native mode is the same policy on both roles.
    if lead.permission_mode == PermissionMode::Native {
        return if requested == PermissionMode::Native && lead.harness == sidekick.harness {
            Ok(Admitted {
                sidekick_mode: requested,
                capabilities: None,
            })
        } else {
            Err((
                FusionRefusal::ExplicitModesRequired,
                FusionRoleName::Lead,
                None,
            ))
        };
    }
    if !presets.contains(&requested) && requested != PermissionMode::Native {
        // Pi has full access only; Nano has no edit-only mode.
        return Err((
            FusionRefusal::SidekickNeedsFullAccess,
            FusionRoleName::Sidekick,
            None,
        ));
    }
    if sidekick.harness == HarnessKind::Codex
        && requested == PermissionMode::WorkspaceWrite
        && !codex_sandbox
    {
        return Err((
            FusionRefusal::CodexSandboxUnverified,
            FusionRoleName::Sidekick,
            None,
        ));
    }
    let Some(lead_caps) = capabilities(lead.harness, lead.permission_mode) else {
        return Err((
            FusionRefusal::ExplicitModesRequired,
            FusionRoleName::Lead,
            None,
        ));
    };
    // Candidates: the requested preset, then every weaker one. A requested
    // `native` (the person's own settings, unknown) never becomes full access.
    let start = presets
        .iter()
        .position(|mode| *mode == requested)
        .unwrap_or_else(|| usize::from(presets.first() == Some(&PermissionMode::FullAccess)));
    let mut last = None;
    for mode in &presets[start.min(presets.len())..] {
        let skip_unsandboxed = sidekick.harness == HarnessKind::Codex
            && *mode == PermissionMode::WorkspaceWrite
            && !codex_sandbox;
        let Some(candidate) = capabilities(sidekick.harness, *mode).filter(|_| !skip_unsandboxed)
        else {
            continue;
        };
        match exceeds(candidate, sidekick.harness, lead_caps, lead.harness) {
            None => {
                return Ok(Admitted {
                    sidekick_mode: *mode,
                    capabilities: Some(candidate),
                });
            }
            Some(dimension) => last = Some(dimension),
        }
    }
    Err((
        FusionRefusal::SidekickExceedsLead,
        FusionRoleName::Sidekick,
        last,
    ))
}
