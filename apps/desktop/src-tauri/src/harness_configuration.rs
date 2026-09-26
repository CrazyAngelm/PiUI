//! Adapter-owned configuration validation. Never infer capabilities from model text.
use crate::orchestration_scheduler::OrchestrationSchedulerError;
use crate::workspace_api::HarnessCapabilities;
use piui_orchestration::{
    AgentOperationCapabilities, AgentProfile, Harness, NativeBridgeCapabilities, PolicyEnforcement,
    ToolDecision,
};
use piui_runtime::workspace_runtime::Enforcement;
#[derive(Clone)]
pub(crate) struct LaunchPolicy {
    pub(crate) allowed_tools: Option<Vec<String>>,
    pub(crate) coordinator: bool,
    /// Adapter-owned native subagent setting of a managed run; `None` keeps
    /// the native default.
    pub(crate) native_subagents: Option<bool>,
}

pub(crate) const PI_NATIVE_TOOL_NAMES: &[&str] =
    &["read", "bash", "edit", "write", "grep", "find", "ls"];
const PI_READ_ONLY_TOOL_NAMES: &[&str] = &["read", "grep", "find", "ls"];
const PRIME_NATIVE_TOOL_NAMES: &[&str] = &["ipython", "workspace"];
/// Claude Code built-in tools that `--tools` can restrict, plus the managed
/// `workspace` coordinator. `Agent` is absent on purpose: managed runs always
/// disable native subagents and delegate through the coordinator instead.
pub(crate) const CLAUDE_NATIVE_TOOL_NAMES: &[&str] = &[
    "AskUserQuestion",
    "Bash",
    "Edit",
    "ExitPlanMode",
    "Glob",
    "Grep",
    "NotebookEdit",
    "PowerShell",
    "Read",
    "Skill",
    "TaskOutput",
    "TaskStop",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Write",
    "workspace",
];
/// Claude Code asks before running these; read-only and workspace-write
/// sessions can only deny such prompts, so the tools can never run there.
const CLAUDE_PROMPTED_COMMAND_TOOLS: &[&str] = &["Bash", "PowerShell"];
/// Plan mode (read-only) never changes files.
const CLAUDE_FILE_WRITE_TOOLS: &[&str] = &["Edit", "Write", "NotebookEdit"];
/// The effort vocabulary of the Claude Code adapter. The native catalog
/// decides which of these a selected model actually supports.
pub(crate) const CLAUDE_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

fn literal_native_tool_names<'a>(
    profile: &AgentProfile,
    native: &HarnessCapabilities,
) -> Result<Vec<&'a str>, OrchestrationSchedulerError> {
    if !native.tool_policy.supported || native.tool_policy.enforcement != Enforcement::Native {
        return Ok(Vec::new());
    }
    let tools = match profile.harness {
        Harness::Pi => PI_NATIVE_TOOL_NAMES,
        Harness::PrimeAgent => PRIME_NATIVE_TOOL_NAMES,
        Harness::ClaudeCode => CLAUDE_NATIVE_TOOL_NAMES,
        // ACP has no per-session tool restriction contract.
        Harness::Codex | Harness::Hermes | Harness::Acp(_) => &[],
    };
    Ok(tools.to_vec())
}

/// An allow rule that Claude Code's permission engine can never satisfy in the
/// requested mode. This is Claude Code's own engine, not an OS sandbox.
fn claude_allow_is_unsatisfiable(mode: piui_orchestration::PermissionMode, tool: &str) -> bool {
    use piui_orchestration::PermissionMode::{ReadOnly, WorkspaceWrite};
    (matches!(mode, ReadOnly | WorkspaceWrite) && CLAUDE_PROMPTED_COMMAND_TOOLS.contains(&tool))
        || (mode == ReadOnly && CLAUDE_FILE_WRITE_TOOLS.contains(&tool))
}

fn validate_native_tool_rules(
    profile: &AgentProfile,
    supported: &[&str],
) -> Result<(), OrchestrationSchedulerError> {
    let native_rules = profile
        .tool_policy
        .rules
        .iter()
        .filter(|rule| rule.enforcement == PolicyEnforcement::Native)
        .collect::<Vec<_>>();
    for rule in &native_rules {
        // Exact equality rejects commas, globs, aliases, and unknown extension
        // names. The Pi bridge repeats this validation before building argv.
        if !supported.contains(&rule.tool.as_str()) {
            return Err(OrchestrationSchedulerError::unsupported());
        }
        if profile.harness == Harness::Pi
            && profile.permission_mode == piui_orchestration::PermissionMode::ReadOnly
            && rule.decision == ToolDecision::Allow
            && !PI_READ_ONLY_TOOL_NAMES.contains(&rule.tool.as_str())
        {
            return Err(OrchestrationSchedulerError::unsupported());
        }
        if profile.harness == Harness::ClaudeCode
            && rule.decision == ToolDecision::Allow
            && claude_allow_is_unsatisfiable(profile.permission_mode, &rule.tool)
        {
            return Err(OrchestrationSchedulerError::unsupported());
        }
        if native_rules
            .iter()
            .any(|other| other.tool == rule.tool && other.decision != rule.decision)
        {
            return Err(OrchestrationSchedulerError::unsupported());
        }
    }
    Ok(())
}

pub(crate) fn launch_policy(
    profile: &AgentProfile,
    native: &HarnessCapabilities,
) -> Result<(NativeBridgeCapabilities, LaunchPolicy), OrchestrationSchedulerError> {
    if !native.prompt.supported || !native.models.supported {
        return Err(OrchestrationSchedulerError::unavailable());
    }
    if profile.base_instructions.is_some() && profile.harness != Harness::Codex {
        return Err(OrchestrationSchedulerError::unsupported());
    }
    // Claude Code runs only at standard speed: fast mode can use paid extra
    // usage, so a speed setting is refused before anything is launched.
    if profile.service_tier.is_some()
        && matches!(
            profile.harness,
            Harness::Pi | Harness::Hermes | Harness::ClaudeCode | Harness::Acp(_)
        )
    {
        return Err(OrchestrationSchedulerError::unsupported());
    }
    // Claude Code runs only Anthropic models (through the user's subscription)
    // and only its own effort vocabulary.
    if profile.harness == Harness::ClaudeCode
        && (profile
            .reasoning
            .as_deref()
            .is_some_and(|level| !CLAUDE_EFFORT_LEVELS.contains(&level))
            || profile
                .model_provider
                .as_deref()
                .is_some_and(|provider| provider != "anthropic"))
    {
        return Err(OrchestrationSchedulerError::unsupported());
    }
    if profile.network_access
        && (profile.harness != Harness::Codex
            || !matches!(
                profile.permission_mode,
                piui_orchestration::PermissionMode::ReadOnly
                    | piui_orchestration::PermissionMode::WorkspaceWrite
            ))
    {
        return Err(OrchestrationSchedulerError::unsupported());
    }
    if profile.resource_rules.iter().any(|rule| {
        rule.id.trim().is_empty()
            || match profile.harness {
                // Claude Code and ACP expose no per-session skill or MCP overrides.
                Harness::Pi | Harness::Hermes | Harness::ClaudeCode | Harness::Acp(_) => true,
                Harness::PrimeAgent => rule.kind != piui_orchestration::ResourceKind::Skill,
                Harness::Codex => match rule.kind {
                    piui_orchestration::ResourceKind::Skill => {
                        !std::path::Path::new(&rule.id).is_absolute()
                    }
                    piui_orchestration::ResourceKind::Mcp => !rule
                        .id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
                },
            }
    }) {
        return Err(OrchestrationSchedulerError::unsupported());
    }
    if !profile.instructions.trim().is_empty() && !native.instructions.supported {
        return Err(OrchestrationSchedulerError::unsupported());
    }
    let permission_modes = permission_modes(profile.harness);
    if !permission_modes.contains(&profile.permission_mode) {
        return Err(OrchestrationSchedulerError::unsupported());
    }

    let supported_native_tools = literal_native_tool_names(profile, native)?;
    validate_native_tool_rules(profile, &supported_native_tools)?;
    let workspace_tool_denied = native.tool_policy.supported
        && profile.tool_policy.rules.iter().any(|rule| {
            rule.enforcement == PolicyEnforcement::Native
                && rule.decision == ToolDecision::Deny
                && rule.tool == "workspace"
        });
    // An ACP agent receives the workspace tool as an HTTP MCP server; the
    // bridge refuses a managed start when the agent does not accept one.
    let coordinator = matches!(
        profile.harness,
        Harness::PrimeAgent
            | Harness::Codex
            | Harness::Hermes
            | Harness::ClaudeCode
            | Harness::Acp(_)
    ) && !workspace_tool_denied;
    let agent_operations = AgentOperationCapabilities {
        roster: coordinator,
        send: coordinator,
        observe: coordinator,
        spawn: coordinator,
    };
    let coordinator_enforced_tools = if coordinator {
        vec![
            "orchestration.roster".into(),
            "orchestration.send".into(),
            "orchestration.observe".into(),
            "orchestration.spawn".into(),
        ]
    } else {
        Vec::new()
    };
    // This list is adapter-owned truth. Never derive it from profile text:
    // doing so would let a declaration attest its own arbitrary tool name.
    let native_enforced_tools = supported_native_tools
        .iter()
        .map(|tool| (*tool).to_owned())
        .collect();
    let capabilities = NativeBridgeCapabilities {
        permission_modes,
        native_enforced_tools,
        coordinator_enforced_tools,
        agent_operations,
    };
    piui_orchestration::validate_profile_capabilities(profile, &capabilities)
        .map_err(|_| OrchestrationSchedulerError::unsupported())?;

    let native_rules = profile
        .tool_policy
        .rules
        .iter()
        .filter(|rule| rule.enforcement == PolicyEnforcement::Native)
        .collect::<Vec<_>>();
    let allowed_tools = if native.tool_policy.supported && !native_rules.is_empty() {
        let mut tools = native_rules
            .iter()
            .filter(|rule| rule.decision == ToolDecision::Allow)
            .map(|rule| rule.tool.clone())
            .collect::<Vec<_>>();
        if coordinator && !tools.iter().any(|tool| tool == "workspace") {
            tools.push("workspace".into());
        }
        tools.sort();
        tools.dedup();
        Some(tools)
    } else {
        None
    };
    // Managed Claude Code runs never use the native Agent tool, with or
    // without the coordinator: delegation must stay admission-checked.
    let native_subagents = (profile.harness == Harness::ClaudeCode).then_some(false);
    Ok((
        capabilities,
        LaunchPolicy {
            allowed_tools,
            coordinator,
            native_subagents,
        },
    ))
}

/// File permission presets the adapter enforces for `harness`.
fn permission_modes(harness: Harness) -> Vec<piui_orchestration::PermissionMode> {
    match harness {
        Harness::Pi => vec![
            piui_orchestration::PermissionMode::Native,
            piui_orchestration::PermissionMode::ReadOnly,
            piui_orchestration::PermissionMode::FullAccess,
        ],
        // ACP agents keep their own permission settings; the protocol cannot
        // prove a read-only or workspace-write preset.
        Harness::PrimeAgent | Harness::Hermes | Harness::Acp(_) => {
            vec![piui_orchestration::PermissionMode::Native]
        }
        // Claude Code: the user's configured mode, plan, acceptEdits and
        // bypassPermissions. Its permission engine is not an OS sandbox.
        Harness::Codex | Harness::ClaudeCode => vec![
            piui_orchestration::PermissionMode::Native,
            piui_orchestration::PermissionMode::ReadOnly,
            piui_orchestration::PermissionMode::WorkspaceWrite,
            piui_orchestration::PermissionMode::FullAccess,
        ],
    }
}

/// Launch policy of an `llm` step (orchestration v6.2): exactly one native
/// turn with no collaboration and the least authority the adapter enforces.
///
/// Definition validation already requires a read-only, network-denied
/// profile that allows no tools, enables no skills or MCP servers and holds
/// no spawn templates; a harness without a read-only mode (Prime Agent,
/// Hermes) is refused here before anything starts. The turn gets no
/// coordinator tool and no native subagents. Where the adapter enforces a
/// native tool allowlist (Pi: `--no-tools --no-extensions`; Claude Code:
/// `--tools ""` with strict MCP configuration) it is empty, so no tool runs.
/// Codex has no restrictive tool contract: its native tools stay available
/// and only its read-only sandbox bounds them. The presentation manifests in
/// `src/harness-adapters/` state this per harness.
pub(crate) fn one_shot_launch_policy(
    profile: &AgentProfile,
    native: &HarnessCapabilities,
) -> Result<(NativeBridgeCapabilities, LaunchPolicy), OrchestrationSchedulerError> {
    use piui_orchestration::PermissionMode::ReadOnly;
    if !permission_modes(profile.harness).contains(&ReadOnly) {
        return Err(OrchestrationSchedulerError::llm_read_only_unsupported());
    }
    // Stored runs are re-checked here even though validation holds these.
    if profile.permission_mode != ReadOnly
        || profile.network_access
        || !profile.allowed_spawn_profile_ids.is_empty()
        || profile.resource_rules.iter().any(|rule| rule.enabled)
        || profile
            .tool_policy
            .rules
            .iter()
            .any(|rule| rule.decision == ToolDecision::Allow)
    {
        return Err(OrchestrationSchedulerError::unsupported());
    }
    let (capabilities, mut policy) = launch_policy(profile, native)?;
    let tools_enforced =
        native.tool_policy.supported && native.tool_policy.enforcement == Enforcement::Native;
    policy.allowed_tools = tools_enforced.then(Vec::new);
    policy.coordinator = false;
    policy.native_subagents = Some(false);
    Ok((capabilities, policy))
}
