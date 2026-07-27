use piui_extensions::{ManifestValidator, PackageSource};
use piui_runtime::{PiExtensionOrigin, PiExtensionResource};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

const MANIFEST_FILE: &str = "piui.manifest.json";
const MAX_MANIFEST_PACKAGES: usize = 128;

/// The complete currently supported declarative surface. Native package paths,
/// raw handlers, icons, conditions, and manifest JSON never cross this DTO.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUiContributionCatalog {
    pub commands: Vec<PiUiCommandContribution>,
    pub composer_actions: Vec<PiUiComposerActionContribution>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUiCommandContribution {
    pub extension_id: String,
    pub extension_name: String,
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub command_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUiComposerActionContribution {
    pub extension_id: String,
    pub extension_name: String,
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub command_id: String,
    pub command_name: String,
    pub order: i32,
}

/// Validates enabled, globally installed package manifests and projects only
/// the Tier-1A declarative fields understood by this PiUI build. A missing or
/// invalid optional manifest disables its UI contribution, never its Pi backend.
pub fn project_global_contributions(resources: &[PiExtensionResource]) -> PiUiContributionCatalog {
    project_manifest_roots(package_manifest_roots(resources))
}

fn project_manifest_roots(roots: Vec<PathBuf>) -> PiUiContributionCatalog {
    let Ok(validator) = ManifestValidator::bundled() else {
        return PiUiContributionCatalog::default();
    };

    let mut seen_roots = HashSet::new();
    let manifests = roots
        .into_iter()
        .filter(|root| seen_roots.insert(root.clone()))
        .filter(|root| root.join(MANIFEST_FILE).is_file())
        .filter_map(|root| {
            validator
                .validate_package(&root, PackageSource::TrustedInstalled)
                .manifest
        })
        .filter(supports_current_tier_1a)
        .collect::<Vec<_>>();
    let extension_id_counts = manifests
        .iter()
        .fold(HashMap::new(), |mut counts, manifest| {
            *counts.entry(manifest.id.clone()).or_insert(0usize) += 1;
            counts
        });

    let mut catalog = PiUiContributionCatalog::default();
    for manifest in manifests
        .into_iter()
        .filter(|manifest| extension_id_counts.get(&manifest.id) == Some(&1))
    {
        let command_names: HashMap<_, _> = manifest
            .commands
            .iter()
            .map(|command| (command.id.as_str(), command.pi_command.as_str()))
            .collect();
        catalog.commands.extend(
            manifest
                .commands
                .iter()
                .map(|command| PiUiCommandContribution {
                    extension_id: manifest.id.clone(),
                    extension_name: manifest.name.clone(),
                    id: command.id.clone(),
                    title: command.title.clone(),
                    description: command.description.clone(),
                    command_name: command.pi_command.clone(),
                }),
        );
        catalog
            .composer_actions
            .extend(manifest.composer_actions.iter().filter_map(|action| {
                command_names
                    .get(action.command_id.as_str())
                    .map(|command_name| PiUiComposerActionContribution {
                        extension_id: manifest.id.clone(),
                        extension_name: manifest.name.clone(),
                        id: action.id.clone(),
                        title: action.title.clone(),
                        description: action.description.clone(),
                        command_id: action.command_id.clone(),
                        command_name: (*command_name).to_owned(),
                        order: action.order,
                    })
            }));
    }
    catalog.commands.sort_by(|left, right| {
        left.extension_id
            .cmp(&right.extension_id)
            .then_with(|| left.id.cmp(&right.id))
    });
    catalog.composer_actions.sort_by(|left, right| {
        left.order
            .cmp(&right.order)
            .then_with(|| left.extension_id.cmp(&right.extension_id))
            .then_with(|| left.id.cmp(&right.id))
    });
    catalog
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

fn supports_current_tier_1a(manifest: &piui_extensions::ValidatedManifest) -> bool {
    if manifest.has_required_features
        || manifest.pi_engine_range.is_some()
        || manifest.host_api_engine_range.is_some()
    {
        // This slice cannot yet prove Pi/Host API compatibility or negotiate
        // required feature flags, so it fails closed to backend-only mode.
        return false;
    }
    let Some(current) = parse_version(env!("CARGO_PKG_VERSION")) else {
        return false;
    };
    version_range_matches(&manifest.piui_engine_range, current)
}

fn parse_version(value: &str) -> Option<Version> {
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(Version {
        major,
        minor,
        patch,
    })
}

fn version_range_matches(range: &str, current: Version) -> bool {
    let mut saw_comparator = false;
    for token in range.split_whitespace() {
        let (operator, version_text) = [">=", "<=", ">", "<", "="]
            .into_iter()
            .find_map(|operator| token.strip_prefix(operator).map(|value| (operator, value)))
            .unwrap_or(("=", token));
        let Some(version) = parse_version(version_text) else {
            return false;
        };
        saw_comparator = true;
        let matches = match operator {
            ">=" => current >= version,
            "<=" => current <= version,
            ">" => current > version,
            "<" => current < version,
            "=" => current == version,
            _ => false,
        };
        if !matches {
            return false;
        }
    }
    saw_comparator
}

fn package_manifest_roots(resources: &[PiExtensionResource]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for resource in resources {
        if roots.len() >= MAX_MANIFEST_PACKAGES {
            break;
        }
        if !resource.enabled || resource.origin != PiExtensionOrigin::Package {
            continue;
        }
        let Some(root) = resource.package_root() else {
            continue;
        };
        if seen.insert(root.to_path_buf()) {
            roots.push(root.to_path_buf());
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::{MANIFEST_FILE, project_manifest_roots};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn package_root() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("piui-contribution-{nonce}"));
        fs::create_dir_all(&root).expect("create package");
        root
    }

    fn safe_manifest() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "id": "test.safe",
            "name": "Safe extension",
            "version": "1.0.0",
            "engines": { "piui": ">=0.1.0" },
            "permissions": ["session.read"],
            "contributes": {
                "commands": [{
                    "id": "test.safe.status",
                    "title": "Show status",
                    "description": "Show the extension status.",
                    "handler": "pi-command:status"
                }],
                "composerActions": [{
                    "id": "test.safe.statusAction",
                    "title": "Status",
                    "command": "test.safe.status",
                    "order": 120
                }]
            }
        })
    }

    #[test]
    fn projects_only_safe_declarative_fields() {
        let root = package_root();
        let manifest = safe_manifest();
        fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).expect("encode manifest"),
        )
        .expect("write manifest");

        let catalog = project_manifest_roots(vec![root.clone(), root.clone()]);
        assert_eq!(catalog.commands.len(), 1);
        assert_eq!(catalog.commands[0].command_name, "status");
        assert_eq!(catalog.composer_actions.len(), 1);
        assert_eq!(catalog.composer_actions[0].command_name, "status");
        let output = format!("{catalog:?}");
        assert!(!output.contains("pi-command:"));
        assert!(!output.contains(root.to_string_lossy().as_ref()));
        fs::remove_dir_all(root).expect("remove package");
    }

    #[test]
    fn duplicate_extension_ids_fail_closed_instead_of_shadowing() {
        let first = package_root();
        let second = package_root();
        let bytes = serde_json::to_vec(&safe_manifest()).expect("encode manifest");
        fs::write(first.join(MANIFEST_FILE), &bytes).expect("write first manifest");
        fs::write(second.join(MANIFEST_FILE), &bytes).expect("write second manifest");

        let catalog = project_manifest_roots(vec![first.clone(), second.clone()]);
        assert!(catalog.commands.is_empty());
        assert!(catalog.composer_actions.is_empty());
        fs::remove_dir_all(first).expect("remove first package");
        fs::remove_dir_all(second).expect("remove second package");
    }

    #[test]
    fn incompatible_or_unnegotiated_manifest_degrades_to_backend_only() {
        let root = package_root();
        let mut manifest = safe_manifest();
        manifest["engines"]["piui"] = serde_json::Value::String(">=9.0.0".into());
        fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).expect("encode incompatible manifest"),
        )
        .expect("write manifest");
        assert!(
            project_manifest_roots(vec![root.clone()])
                .commands
                .is_empty()
        );

        manifest["engines"]["piui"] = serde_json::Value::String(">=0.1.0 <1".into());
        manifest["requires"] = serde_json::json!(["future.capability"]);
        fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).expect("encode required feature manifest"),
        )
        .expect("write manifest");
        assert!(
            project_manifest_roots(vec![root.clone()])
                .commands
                .is_empty()
        );
        fs::remove_dir_all(root).expect("remove package");
    }

    #[test]
    fn invalid_optional_manifest_degrades_to_no_contributions() {
        let root = package_root();
        let mut manifest = safe_manifest();
        manifest["contributes"]["commands"][0]["handler"] =
            serde_json::Value::String("pi-command:unsafe command".into());
        fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).expect("encode manifest"),
        )
        .expect("write manifest");

        let catalog = project_manifest_roots(vec![root.clone()]);
        assert!(catalog.commands.is_empty());
        assert!(catalog.composer_actions.is_empty());
        fs::remove_dir_all(root).expect("remove package");
    }
}
