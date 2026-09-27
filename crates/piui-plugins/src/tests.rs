//! Contract fixtures shared with the TypeScript mirror, whole-package rules
//! and the example plugins in `examples/plugins/`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use crate::manifest::{Permission, ProblemCode, parse_manifest};
use crate::package::{
    PackageFile, archive_files, code_hash, load_folder, safe_package_path, validate_files,
};
use crate::theme::THEME_TOKENS;
use crate::zip::writer::{Entry, write};

const PIUI: &str = "0.1.1";

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixtures() -> PathBuf {
    repository().join("contracts/fixtures/plugins")
}

fn fixture(name: &str) -> Vec<u8> {
    fs::read(fixtures().join(name)).expect("fixture")
}

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A private temporary folder, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "piui-plugins-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("scratch");
        Self(path)
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("folders");
        fs::write(path, bytes).expect("file");
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn valid_fixtures_pass_every_rule() {
    let minimal = parse_manifest(&fixture("valid-minimal.json"), PIUI).expect("minimal");
    assert!(minimal.compatible);
    assert_eq!(minimal.manifest.permissions, vec![Permission::Commands]);
    let full = parse_manifest(&fixture("valid-full.json"), PIUI).expect("full");
    assert_eq!(full.acp_agents.len(), 1);
    assert_eq!(
        full.manifest.contributes.node_types[0].timeout_seconds(),
        30
    );
    assert!(full.manifest.contributes.commands[0].uses_backend());
    assert!(!full.manifest.contributes.commands[1].uses_backend());
    // A newer PiUI keeps the plugin listed but not compatible.
    let later = parse_manifest(&fixture("valid-minimal.json"), "1.0.0").expect("later");
    assert!(!later.compatible);
}

#[test]
fn version_two_adds_status_items_keybindings_and_renderers() {
    use crate::manifest::StatusAlignment;
    let v2 = parse_manifest(&fixture("valid-v2.json"), "0.2.2").expect("v2");
    let contributes = &v2.manifest.contributes;
    assert_eq!(v2.manifest.schema_version, 2);
    assert_eq!(contributes.status_items.len(), 2);
    assert_eq!(
        contributes.status_items[0].command.as_deref(),
        Some("count")
    );
    assert_eq!(
        contributes.status_items[1].alignment,
        Some(StatusAlignment::Start)
    );
    assert_eq!(contributes.keybindings[0].key, "Mod+Alt+Shift+W");
    assert_eq!(
        contributes.renderers[0].tool_names,
        ["get_weather", "mcp__weather__forecast"]
    );
    assert!(v2.manifest.has(Permission::UiStatus) && v2.manifest.has(Permission::UiRenderer));
    // Unknown fields stay errors in the new contributions too.
    let base: Value = serde_json::from_slice(&fixture("valid-v2.json")).expect("v2");
    for pointer in [
        "/contributes/statusItems/0",
        "/contributes/keybindings/0",
        "/contributes/renderers/0",
    ] {
        let mut manifest = base.clone();
        manifest
            .pointer_mut(pointer)
            .and_then(Value::as_object_mut)
            .expect(pointer)
            .insert("unexpected".into(), json!(true));
        let bytes = serde_json::to_vec(&manifest).expect("json");
        assert!(
            parse_manifest(&bytes, PIUI).is_err(),
            "unknown field at {pointer:?}"
        );
    }
    // A v1 manifest never gains the v2 permissions.
    let mut v1 = base;
    v1["schemaVersion"] = json!(1);
    v1["contributes"] =
        json!({ "commands": [{ "id": "count", "title": "Count", "insertText": "x" }] });
    v1["permissions"] = json!(["commands", "ui.status"]);
    let problems = parse_manifest(&serde_json::to_vec(&v1).expect("json"), PIUI)
        .expect_err("ui.status is a v2 permission");
    assert_eq!(problems[0].code, ProblemCode::Shape);
}

#[test]
fn invalid_fixtures_fail_with_the_shared_first_code() {
    let expected: Value =
        serde_json::from_slice(&fixture("expected.json")).expect("expected codes");
    let codes = expected["codes"].as_object().expect("codes");
    let listed = fs::read_dir(fixtures())
        .expect("fixtures")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with("invalid-"))
        .collect::<Vec<_>>();
    assert_eq!(
        listed.len(),
        codes.len(),
        "every invalid fixture has an expected code"
    );
    for (name, code) in codes {
        let problems = parse_manifest(&fixture(name), PIUI).expect_err(name);
        assert_eq!(
            Some(problems[0].code.as_str()),
            code.as_str(),
            "{name}: {problems:?}"
        );
        if name.starts_with("invalid-semantic-") {
            assert_ne!(
                problems[0].code,
                ProblemCode::Shape,
                "{name} must pass the schema"
            );
        }
    }
}

#[test]
fn unknown_fields_are_refused_at_every_level_never_dropped() {
    let base: Value = serde_json::from_slice(&fixture("valid-full.json")).expect("full");
    let pointers = [
        "",
        "/engines",
        "/backend",
        "/ui",
        "/contributes",
        "/contributes/commands/0",
        "/contributes/settings/0",
        "/contributes/settings/3/options/0",
        "/contributes/panels/0",
        "/contributes/themes/0",
        "/contributes/templates/0",
        "/contributes/acpAgents/0",
        "/contributes/nodeTypes/0",
        "/contributes/nodeTypes/0/resultFields/0",
    ];
    for pointer in pointers {
        let mut manifest = base.clone();
        manifest
            .pointer_mut(pointer)
            .and_then(Value::as_object_mut)
            .expect(pointer)
            .insert("unexpected".into(), json!(true));
        let bytes = serde_json::to_vec(&manifest).expect("json");
        assert!(
            parse_manifest(&bytes, PIUI).is_err(),
            "unknown field at {pointer:?}"
        );
    }
}

#[test]
fn theme_tokens_match_the_schema_and_the_stylesheet() {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/piui-plugin-v1.schema.json"
    ))
    .expect("schema");
    let listed = schema["definitions"]["themeToken"]["enum"]
        .as_array()
        .expect("enum")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    assert_eq!(listed, THEME_TOKENS);
    let stylesheet =
        fs::read_to_string(repository().join("apps/desktop/src/styles/tokens.css")).expect("css");
    for token in THEME_TOKENS {
        assert!(
            stylesheet.contains(&format!("--piui-{token}:")),
            "{token} is a documented token"
        );
    }
    let v2: Value = serde_json::from_str(include_str!(
        "../../../contracts/piui-plugin-v2.schema.json"
    ))
    .expect("schema v2");
    assert_eq!(
        v2["definitions"]["themeToken"],
        schema["definitions"]["themeToken"]
    );
    let enumerated = |schema: &Value| {
        schema["properties"]["permissions"]["items"]["enum"]
            .as_array()
            .expect("permissions")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        enumerated(&v2),
        Permission::ALL.map(Permission::as_str).to_vec()
    );
    assert_eq!(
        enumerated(&schema),
        Permission::ALL
            .into_iter()
            .filter(|permission| !matches!(
                permission,
                Permission::UiStatus | Permission::UiRenderer
            ))
            .map(Permission::as_str)
            .collect::<Vec<_>>()
    );
}

#[test]
fn acp_descriptor_messages_match_the_harness_registry() {
    use piui_runtime::acp::AcpDescriptorError;
    for error in [
        AcpDescriptorError::Malformed,
        AcpDescriptorError::TooLarge,
        AcpDescriptorError::UnsupportedSchema,
        AcpDescriptorError::DisplayName,
        AcpDescriptorError::Program,
        AcpDescriptorError::Arguments,
        AcpDescriptorError::VersionArguments,
        AcpDescriptorError::VersionPattern,
        AcpDescriptorError::VerifiedRange,
        AcpDescriptorError::EnvironmentName,
        AcpDescriptorError::EnvironmentDenied,
        AcpDescriptorError::AuthHint,
        AcpDescriptorError::DocsUrl,
        AcpDescriptorError::CapabilityOverride,
    ] {
        assert_eq!(
            crate::manifest::acp_descriptor_message(error),
            error.to_string()
        );
    }
}

fn manifest_with(extra: Value) -> Vec<u8> {
    let mut manifest: Value = serde_json::from_slice(&fixture("valid-minimal.json")).expect("base");
    if let (Some(target), Some(source)) = (manifest.as_object_mut(), extra.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    serde_json::to_vec_pretty(&manifest).expect("json")
}

#[test]
fn a_folder_package_checks_named_files_templates_and_hashes_its_code() {
    let package = Scratch::new("folder");
    package.write(
        "piui-plugin.json",
        &manifest_with(json!({
            "permissions": ["commands", "node.run"],
            "backend": { "entry": "backend/main.mjs" },
            "contributes": {
                "commands": [{ "id": "say-hello", "title": "Say hello", "insertText": "Hi" }],
                "nodeTypes": [{ "id": "echo", "title": "Echo" }],
                "templates": []
            }
        })),
    );
    let missing = load_folder(&package.0, PIUI).expect_err("backend file is missing");
    assert_eq!(missing[0].code, ProblemCode::FileMissing);
    assert_eq!(missing[0].subject.as_deref(), Some("backend/main.mjs"));

    package.write("backend/main.mjs", b"process.stdin.resume();\n");
    package.write(".git/HEAD", b"ref: refs/heads/main\n");
    let loaded = load_folder(&package.0, PIUI).expect("package");
    assert_eq!(
        loaded.files.len(),
        2,
        "version-control folders are not part of a package"
    );
    let again = load_folder(&package.0, PIUI).expect("package");
    assert_eq!(loaded.code_hash, again.code_hash);
    package.write("backend/main.mjs", b"process.stdin.resume(); // changed\n");
    let changed = load_folder(&package.0, PIUI).expect("package");
    assert_ne!(
        loaded.code_hash, changed.code_hash,
        "any code change changes the hash"
    );
}

#[test]
fn templates_must_be_system_files_v4() {
    let template = |text: &str| {
        let files = vec![
            PackageFile {
                path: "piui-plugin.json".into(),
                bytes: manifest_with(json!({
                    "contributes": {
                        "commands": [{ "id": "say-hello", "title": "Say hello", "insertText": "Hi" }],
                        "templates": [{ "id": "review", "title": "Review", "file": "templates/review.piui.json" }]
                    }
                })),
            },
            PackageFile {
                path: "templates/review.piui.json".into(),
                bytes: text.as_bytes().to_vec(),
            },
        ];
        validate_files(files, PIUI)
    };
    let valid =
        fs::read_to_string(repository().join("examples/systems/structured-review.piui.json"))
            .expect("example system");
    assert!(template(&valid).is_ok());
    for invalid in [
        "not json",
        r#"{"format":"piui-system","version":3,"name":"x","agents":[],"connections":[]}"#,
        r#"{"format":"piui-system","version":4,"name":"x","agents":[],"connections":[],"extra":1}"#,
    ] {
        let problems = template(invalid).expect_err(invalid);
        assert_eq!(problems[0].code, ProblemCode::Template, "{invalid}");
        assert_eq!(problems[0].subject.as_deref(), Some("review"));
    }
}

#[test]
fn package_paths_are_portable_and_never_escape() {
    for valid in [
        "piui-plugin.json",
        "ui/index.html",
        "backend/lib/util.mjs",
        ".well-known/x.txt",
    ] {
        assert!(safe_package_path(valid), "{valid}");
    }
    for invalid in [
        "",
        "/etc/passwd",
        "../x",
        "a/../b",
        "a//b",
        "a/./b",
        "C:/x",
        "a\\b",
        "ui/con.html",
        "nul",
        "Aux/x",
        "a/b.",
        "a/b ",
        "a/\u{7}",
        "a?b",
    ] {
        assert!(!safe_package_path(invalid), "{invalid}");
    }
    let files = vec![
        PackageFile {
            path: "piui-plugin.json".into(),
            bytes: fixture("valid-minimal.json"),
        },
        PackageFile {
            path: "Readme.txt".into(),
            bytes: b"a".to_vec(),
        },
        PackageFile {
            path: "README.txt".into(),
            bytes: b"b".to_vec(),
        },
    ];
    let problems = validate_files(files, PIUI).expect_err("case collision");
    assert_eq!(problems[0].code, ProblemCode::Path);
    let traversal = vec![PackageFile {
        path: "../piui-plugin.json".into(),
        bytes: fixture("valid-minimal.json"),
    }];
    assert_eq!(
        validate_files(traversal, PIUI).expect_err("escape")[0].code,
        ProblemCode::Path
    );
    let empty = validate_files(Vec::new(), PIUI).expect_err("no manifest");
    assert_eq!(empty[0].code, ProblemCode::NotAPackage);
}

#[test]
fn a_zip_package_may_wrap_its_files_in_one_folder() {
    let manifest = fixture("valid-minimal.json");
    let archive = write(&[
        Entry {
            name: "hello/",
            bytes: b"",
            deflate: false,
            unix_mode: None,
        },
        Entry {
            name: "hello/piui-plugin.json",
            bytes: &manifest,
            deflate: true,
            unix_mode: Some(0o100_644),
        },
        Entry {
            name: "hello/.git/config",
            bytes: b"[core]",
            deflate: false,
            unix_mode: None,
        },
    ]);
    let files = archive_files(&archive).expect("archive");
    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["piui-plugin.json"]
    );
    let package = validate_files(files.clone(), PIUI).expect("package");
    assert_eq!(package.code_hash, code_hash(&files));
    let escape = write(&[Entry {
        name: "../evil/piui-plugin.json",
        bytes: &manifest,
        deflate: false,
        unix_mode: None,
    }]);
    let problems =
        validate_files(archive_files(&escape).expect("readable"), PIUI).expect_err("escaping path");
    assert_eq!(problems[0].code, ProblemCode::Path);
}

#[cfg(unix)]
#[test]
fn folder_links_are_refused_not_followed() {
    let package = Scratch::new("link");
    package.write("piui-plugin.json", &fixture("valid-minimal.json"));
    std::os::unix::fs::symlink("/etc/hostname", package.0.join("host")).expect("link");
    let problems = load_folder(&package.0, PIUI).expect_err("link");
    assert_eq!(problems[0].code, ProblemCode::Path);
}

#[test]
fn every_example_plugin_is_a_valid_package() {
    let examples = repository().join("examples/plugins");
    let mut checked = 0;
    for entry in fs::read_dir(&examples).expect("examples") {
        let path = entry.expect("entry").path();
        if !path.join("piui-plugin.json").is_file() {
            continue;
        }
        let package = load_folder(&path, PIUI)
            .unwrap_or_else(|problems| panic!("{}: {problems:?}", path.display()));
        assert!(package.manifest.compatible, "{}", path.display());
        checked += 1;
    }
    assert!(checked >= 4, "the four example plugins are checked");
}
