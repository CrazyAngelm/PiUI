//! Plugin node steps (orchestration v6.5, ADR-032).
//!
//! A `plugin` step names a node type of an installed plugin. The host admits
//! it only in a trusted, live project outside safe mode while the plugin is
//! enabled, verified and still declares the node type (with `node.run`), and
//! checks the configuration against the node type's declared fields; every
//! refusal is certain because nothing ran. The plugin's contained backend
//! receives the same document a script reads on stdin plus the node
//! configuration and returns text or one JSON object, recorded exactly like a
//! script's stdout. Like a script it is host work outside the team, uses the
//! coordinator's lease and dispatch, and becomes uncertain (never replayed)
//! when its outcome is not observed. This crate never starts a process.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::coordinator::{check_run_revision, ensure_active};
use crate::executors::{ScriptDependency, host_step, script_dependencies};
use crate::{Coordinator, CoordinatorError, Revision, Run, ScriptLease, StepExecutor};

/// The plugin is not installed, disabled, not verified, incompatible, or no
/// longer declares the node type (or `node.run`); nothing ran.
pub const PLUGIN_UNAVAILABLE: &str = "plugin-unavailable";
/// The node configuration does not match the node type's fields; nothing ran.
pub const PLUGIN_CONFIG_INVALID: &str = "plugin-config-invalid";
/// A dependency result could not be read; nothing ran.
pub const PLUGIN_INPUT_UNAVAILABLE: &str = "plugin-input-unavailable";
/// The backend could not start or initialize; the node did not run.
pub const PLUGIN_START_FAILED: &str = "plugin-start-failed";
/// The backend answered `node/run` with an error (its message is the detail).
pub const PLUGIN_NODE_FAILED: &str = "plugin-node-failed";
/// The node did not answer within its timeout; the backend was stopped.
pub const PLUGIN_NODE_TIMEOUT: &str = "plugin-node-timeout";

/// Largest encoded node configuration.
pub const MAX_PLUGIN_CONFIG_BYTES: usize = 64 * 1024;
/// Most configuration keys of one node.
pub const MAX_PLUGIN_CONFIG_KEYS: usize = 30;
const MAX_PLUGIN_ID_CHARS: usize = 100;

fn plugin_id_valid(id: &str) -> bool {
    id.len() <= MAX_PLUGIN_ID_CHARS
        && id.split('.').count() <= 8
        && id.split('.').all(|segment| slug_valid(segment, 64))
}

fn slug_valid(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= maximum
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && bytes.first() != Some(&b'-')
        && bytes.last() != Some(&b'-')
}

fn key_valid(key: &str) -> bool {
    let mut characters = key.chars();
    key.len() <= 64
        && characters
            .next()
            .is_some_and(|first| first.is_ascii_lowercase())
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// Self-contained shape rules of a plugin executor; the node type's own
/// fields are checked by the host at admission.
pub(crate) fn validate_plugin_executor(
    plugin_id: &str,
    node_type: &str,
    config: &Map<String, Value>,
) -> Result<(), &'static str> {
    if !plugin_id_valid(plugin_id) {
        return Err("a plugin id is lowercase segments of letters, digits and hyphens");
    }
    if !slug_valid(node_type, 48) {
        return Err("a node type id is lowercase letters, digits and hyphens");
    }
    if config.len() > MAX_PLUGIN_CONFIG_KEYS || !config.keys().all(|key| key_valid(key)) {
        return Err("a plugin node configuration has at most 30 field keys");
    }
    if !config
        .values()
        .all(|value| value.is_string() || value.is_number() || value.is_boolean())
    {
        return Err("plugin node configuration values are strings, numbers or booleans");
    }
    if serde_json::to_vec(config).map_or(usize::MAX, |bytes| bytes.len()) > MAX_PLUGIN_CONFIG_BYTES
    {
        return Err("a plugin node configuration is at most 64 KiB");
    }
    Ok(())
}

/// A durably leased plugin node step. The configuration comes from the
/// frozen run snapshot, never from later edits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginStepLease {
    pub run_id: String,
    pub run_revision: Revision,
    pub task_revision: Revision,
    pub lease_id: String,
    pub step_id: String,
    pub step_name: String,
    pub plugin_id: String,
    pub node_type: String,
    pub config: Map<String, Value>,
    pub inputs: BTreeMap<String, Value>,
    pub dependencies: Vec<ScriptDependency>,
}

impl PluginStepLease {
    /// The `node/run` parameters: the script stdin document
    /// (`inputs`, `dependencies: {<stepId>: {text, data}}`, `step`) plus
    /// `nodeType`, `config` and `run`. The host adds `project` only for a
    /// plugin with a project permission.
    pub fn node_run_params(&self) -> Value {
        let dependencies = self
            .dependencies
            .iter()
            .map(|dependency| {
                (
                    dependency.step_id.clone(),
                    json!({ "text": dependency.text, "data": dependency.data }),
                )
            })
            .collect::<Map<_, _>>();
        json!({
            "nodeType": self.node_type,
            "config": self.config,
            "inputs": self.inputs,
            "dependencies": dependencies,
            "step": { "id": self.step_id, "name": self.step_name },
            "run": { "id": self.run_id },
        })
    }
}

/// The identity of a leased host-executed step, for the dispatch, release
/// and rejection transitions scripts and plugin nodes share.
pub trait HostStepLease {
    fn run_id(&self) -> &str;
    fn step_id(&self) -> &str;
    fn task_revision(&self) -> Revision;
    fn lease_id(&self) -> &str;
}

impl HostStepLease for ScriptLease {
    fn run_id(&self) -> &str {
        &self.run_id
    }
    fn step_id(&self) -> &str {
        &self.step_id
    }
    fn task_revision(&self) -> Revision {
        self.task_revision
    }
    fn lease_id(&self) -> &str {
        &self.lease_id
    }
}

impl HostStepLease for PluginStepLease {
    fn run_id(&self) -> &str {
        &self.run_id
    }
    fn step_id(&self) -> &str {
        &self.step_id
    }
    fn task_revision(&self) -> Revision {
        self.task_revision
    }
    fn lease_id(&self) -> &str {
        &self.lease_id
    }
}

impl Coordinator {
    /// Durably leases the next deterministic ready task when it is a plugin
    /// node, before the host checks the plugin or starts anything. Other
    /// work returns `ExecutorMismatch`. A restored lease becomes uncertain
    /// rather than replayable. Dispatch, completion, release and rejection
    /// use the transitions scripts use.
    pub fn lease_next_plugin_step(
        run: &mut Run,
        expected_run_revision: Revision,
        lease_id: String,
    ) -> Result<Option<PluginStepLease>, CoordinatorError> {
        check_run_revision(run, expected_run_revision)?;
        ensure_active(run)?;
        if lease_id.trim().is_empty() {
            return Err(CoordinatorError::EmptyId { kind: "lease" });
        }
        Self::advance_automatic_steps(run);
        let Some(step_id) = Self::ready_task_ids(run).first().map(|id| (*id).to_owned()) else {
            return Ok(None);
        };
        let step = host_step(run, &step_id)?;
        let Some(StepExecutor::Plugin {
            plugin_id,
            node_type,
            config,
        }) = step.executor.clone()
        else {
            return Err(CoordinatorError::ExecutorMismatch { step_id });
        };
        let dependencies = script_dependencies(run, &step);
        let inputs = run.inputs.clone();
        let Some(task) = run.tasks.iter_mut().find(|task| task.step_id == step_id) else {
            return Err(CoordinatorError::InvalidRunData {
                reason: "pipeline step has no task",
            });
        };
        task.lease_id = Some(lease_id.clone());
        task.revision += 1;
        run.revision += 1;
        Ok(Some(PluginStepLease {
            run_id: run.id.clone(),
            run_revision: run.revision,
            task_revision: task.revision,
            lease_id,
            step_id,
            step_name: step.name,
            plugin_id,
            node_type,
            config,
            inputs,
            dependencies,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn executor_shape_rules() {
        let valid = config(json!({ "pick": "a, b", "limit": 3, "strict": true }));
        assert_eq!(
            validate_plugin_executor("example.pipeline-pack", "json-transform", &valid),
            Ok(())
        );
        for id in ["", "Example.x", "x..y", "-x", "x.-y", &"a.".repeat(9)] {
            assert!(
                validate_plugin_executor(id, "json-transform", &valid).is_err(),
                "{id}"
            );
        }
        for node in ["", "Json", "json_transform", "-x", &"a".repeat(49)] {
            assert!(
                validate_plugin_executor("example.pack", node, &valid).is_err(),
                "{node}"
            );
        }
        for invalid in [
            json!({ "nested": { "a": 1 } }),
            json!({ "list": [1] }),
            json!({ "nothing": null }),
            json!({ "Bad-Key": 1 }),
            json!({ "text": "x".repeat(70 * 1024) }),
        ] {
            assert!(
                validate_plugin_executor("example.pack", "node", &config(invalid.clone())).is_err(),
                "{invalid}"
            );
        }
        let many = (0..31)
            .map(|index| (format!("k{index}"), json!(index)))
            .collect::<Map<_, _>>();
        assert!(validate_plugin_executor("example.pack", "node", &many).is_err());
    }
}
