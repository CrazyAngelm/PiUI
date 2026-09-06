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
}

pub(crate) const PI_NATIVE_TOOL_NAMES: &[&str] =
    &["read", "bash", "edit", "write", "grep", "find", "ls"];
const PI_READ_ONLY_TOOL_NAMES: &[&str] = &["read", "grep", "find", "ls"];
const PRIME_NATIVE_TOOL_NAMES: &[&str] = &["ipython", "workspace"];

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
        Harness::Codex => &[],
    };
    Ok(tools.to_vec())
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
    if (profile.base_instructions.is_some() || profile.service_tier.is_some())
        && profile.harness != Harness::Codex
    {
        return Err(OrchestrationSchedulerError::unsupported());
    }
    if profile.resource_rules.iter().any(|rule| {
        rule.id.trim().is_empty()
            || match profile.harness {
                Harness::Pi => true,
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
    let permission_modes = match profile.harness {
        Harness::Pi => vec![
            piui_orchestration::PermissionMode::Native,
            piui_orchestration::PermissionMode::ReadOnly,
            piui_orchestration::PermissionMode::FullAccess,
        ],
        Harness::PrimeAgent => vec![piui_orchestration::PermissionMode::Native],
        Harness::Codex => vec![
            piui_orchestration::PermissionMode::Native,
            piui_orchestration::PermissionMode::ReadOnly,
            piui_orchestration::PermissionMode::WorkspaceWrite,
            piui_orchestration::PermissionMode::FullAccess,
        ],
    };
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
    let coordinator =
        matches!(profile.harness, Harness::PrimeAgent | Harness::Codex) && !workspace_tool_denied;
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
    Ok((
        capabilities,
        LaunchPolicy {
            allowed_tools,
            coordinator,
        },
    ))
}
