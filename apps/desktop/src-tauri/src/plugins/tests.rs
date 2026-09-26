//! Plugin host: install and trust, update rules, integrity, development
//! mode, settings, themes, panel files, safe mode, the shared registry
//! fixture and backend commands with the example plugins.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::api::{command_result, registry_view, review_view};
use super::*;

const PIUI: &str = "0.1.1";

fn example(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../examples/plugins")
        .join(name)
}

/// A private app data folder and a scratch area, removed on drop.
struct Fixture {
    root: PathBuf,
    plugins: PluginsState,
}

impl Fixture {
    fn new(name: &str, safe_mode: bool) -> Self {
        let root =
            std::env::temp_dir().join(format!("piui-plugins-host-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let plugins =
            PluginsState::open(&root.join("app-data"), safe_mode, PIUI).expect("plugin host");
        Self { root, plugins }
    }

    /// Copies an example into the scratch area so tests can change it.
    fn copy(&self, name: &str) -> PathBuf {
        let target = self.root.join("sources").join(name);
        let files = piui_plugins::package::read_folder(&example(name)).expect("example files");
        piui_plugins::package::write_package(&target, &files).expect("copy");
        target
    }

    fn install(&self, source: ReviewSource, path: &Path) -> String {
        let (staging_id, staged) = self.plugins.stage(source, path).expect("stages");
        self.plugins
            .install(
                self.plugins.revision(),
                &staging_id,
                &staged.package.code_hash,
            )
            .expect("installs")
            .0
    }

    fn entry(&self, id: &str) -> super::api::PluginEntryDto {
        registry_view(&self.plugins)
            .expect("view")
            .plugins
            .into_iter()
            .find(|plugin| plugin.id == id)
            .expect("listed")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.plugins.begin_shutdown();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn edit_manifest(folder: &Path, change: impl FnOnce(&mut Value)) {
    let path = folder.join("piui-plugin.json");
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(&path).expect("manifest")).expect("json");
    change(&mut manifest);
    fs::write(path, serde_json::to_vec_pretty(&manifest).expect("json")).expect("write");
}

#[test]
fn install_copies_into_app_data_after_a_review_that_shows_everything() {
    let fixture = Fixture::new("install", false);
    let source = fixture.copy("hello-command");
    let (staging_id, staged) = fixture
        .plugins
        .stage(ReviewSource::Folder, &source)
        .expect("stages");
    let review = review_view(&fixture.plugins, &staging_id, &staged);
    assert_eq!(review.id, "example.hello-command");
    assert_eq!(review.publisher, "PiUI examples");
    assert_eq!(
        review
            .permissions
            .iter()
            .map(|permission| permission.as_str())
            .collect::<Vec<_>>(),
        [
            "commands",
            "ui.panel",
            "ui.settings",
            "chat.read",
            "notifications"
        ]
    );
    let backend = review.backend.expect("backend command line");
    assert!(backend.command_line.args[0].ends_with("main.mjs"));
    assert!(
        backend.command_line.args[0].contains("plugins-v1")
            && backend.command_line.args[0].contains("packages"),
        "the backend runs from PiUI's copy, not the chosen folder: {:?}",
        backend.command_line
    );
    assert!(review.update.is_none() && !review.already_installed);
    assert_eq!(
        review.contributes.commands,
        ["Say hello", "Thank the agent"]
    );

    fixture
        .plugins
        .install(fixture.plugins.revision(), &staging_id, &review.code_hash)
        .expect("installs");
    let entry = fixture.entry("example.hello-command");
    assert!(entry.enabled && entry.active, "{:?}", entry.problems);
    assert_eq!(entry.source, "installed");
    assert_eq!(entry.settings.get("greeting"), Some(&json!("Hello")));
    let panel_url = entry.contributes.panels[0].url.clone().expect("panel url");
    assert!(
        panel_url.ends_with("/example.hello-command/ui/index.html?panel=hello"),
        "{panel_url}"
    );
    // The source folder can go away: PiUI runs its own copy.
    fs::remove_dir_all(&source).expect("remove source");
    assert!(fixture.plugins.active("example.hello-command").is_ok());
    // Installing the same package again is not an update.
    let (again, staged) = fixture
        .plugins
        .stage(ReviewSource::Folder, &example("hello-command"))
        .expect("stages again");
    assert!(review_view(&fixture.plugins, &again, &staged).already_installed);
    fixture.plugins.discard(&again);
}

#[test]
fn an_update_shows_new_permissions_and_code_and_keeps_valid_settings() {
    let fixture = Fixture::new("update", false);
    let source = fixture.copy("hello-command");
    let id = fixture.install(ReviewSource::Folder, &source);
    fixture
        .plugins
        .set_settings(
            fixture.plugins.revision(),
            &id,
            &json!({"greeting": "Hey"})
                .as_object()
                .cloned()
                .expect("values"),
            false,
        )
        .expect("stores settings");
    edit_manifest(&source, |manifest| {
        manifest["version"] = json!("1.1.0");
        manifest["permissions"]
            .as_array_mut()
            .expect("permissions")
            .push(json!("network"));
    });
    fs::write(source.join("backend/main.mjs"), "// changed\n").expect("change code");
    let (staging_id, staged) = fixture
        .plugins
        .stage(ReviewSource::Folder, &source)
        .expect("stages");
    let review = review_view(&fixture.plugins, &staging_id, &staged);
    let update = review.update.expect("an update");
    assert_eq!(update.from_version, "1.0.0");
    assert_eq!(
        update
            .permissions_added
            .iter()
            .map(|permission| permission.as_str())
            .collect::<Vec<_>>(),
        ["network"]
    );
    assert!(update.code_changed);
    fixture
        .plugins
        .install(fixture.plugins.revision(), &staging_id, &review.code_hash)
        .expect("updates");
    let entry = fixture.entry(&id);
    assert_eq!(entry.version, "1.1.0");
    assert_eq!(entry.settings.get("greeting"), Some(&json!("Hey")));
    let packages = fs::read_dir(fixture.root.join("app-data/plugins-v1/packages"))
        .expect("packages")
        .count();
    assert_eq!(packages, 1, "the previous copy is removed");
}

#[test]
fn a_package_changed_after_review_or_after_install_is_not_trusted() {
    let fixture = Fixture::new("integrity", false);
    let source = fixture.copy("hello-command");
    let (staging_id, staged) = fixture
        .plugins
        .stage(ReviewSource::Folder, &source)
        .expect("stages");
    assert_eq!(
        fixture.plugins.install(
            fixture.plugins.revision(),
            &staging_id,
            "0".repeat(64).as_str()
        ),
        Err(PluginsError::TrustChanged)
    );
    // The staging copy was edited between review and install.
    let (staging_id, staged_again) = fixture
        .plugins
        .stage(ReviewSource::Folder, &source)
        .expect("stages");
    let staging = fixture.plugins.install_root(&staged_again);
    let copy = fixture
        .root
        .join("app-data/plugins-v1/staging")
        .join(staging.file_name().expect("name"));
    fs::write(copy.join("backend/main.mjs"), "// tampered\n").expect("tamper");
    assert_eq!(
        fixture.plugins.install(
            fixture.plugins.revision(),
            &staging_id,
            &staged_again.package.code_hash
        ),
        Err(PluginsError::TrustChanged)
    );
    let _ = staged;
    // An installed copy that changes on disk stays listed but inactive.
    let id = fixture.install(ReviewSource::Folder, &source);
    let package = fs::read_dir(fixture.root.join("app-data/plugins-v1/packages"))
        .expect("packages")
        .flatten()
        .next()
        .expect("package")
        .path();
    fs::write(
        package.join("backend/main.mjs"),
        "// tampered after install\n",
    )
    .expect("tamper");
    let reopened = PluginsState::open(&fixture.root.join("app-data"), false, PIUI).expect("reopen");
    let acp = crate::acp_agents::AcpAgents::open(&fixture.root.join("acp")).expect("acp");
    reopened.verify(&acp);
    let entry = registry_view(&reopened)
        .expect("view")
        .plugins
        .into_iter()
        .find(|plugin| plugin.id == id)
        .expect("listed");
    assert!(!entry.active);
    assert_eq!(entry.problems[0].code, ProblemCode::Integrity);
}

#[test]
fn invalid_and_incompatible_packages_are_refused_with_every_problem() {
    let fixture = Fixture::new("invalid", false);
    let source = fixture.copy("hello-command");
    edit_manifest(&source, |manifest| {
        manifest["contributes"]["panels"][0]["unknown"] = json!(true);
    });
    let Err(PluginsError::Invalid(problems)) = fixture.plugins.stage(ReviewSource::Folder, &source)
    else {
        panic!("an unknown field is refused");
    };
    assert_eq!(problems[0].code, ProblemCode::Shape);
    edit_manifest(&source, |manifest| {
        manifest["contributes"]["panels"][0]
            .as_object_mut()
            .expect("panel")
            .remove("unknown");
        manifest["engines"]["piui"] = json!(">=9.0.0");
    });
    assert_eq!(
        fixture
            .plugins
            .stage(ReviewSource::Folder, &source)
            .map(|_| ()),
        Err(PluginsError::Incompatible(">=9.0.0".into()))
    );
    assert!(
        fs::read_dir(fixture.root.join("app-data/plugins-v1/staging"))
            .map_or(true, |mut entries| entries.next().is_none())
    );
}

#[test]
fn a_zip_package_installs_like_a_folder() {
    let fixture = Fixture::new("zip", false);
    let files = piui_plugins::package::read_folder(&example("midnight-theme")).expect("files");
    let mut archive = Vec::new();
    {
        // A tiny stored archive written by the crate's test writer is not
        // reachable here; build one with flate2-free stored entries.
        let mut central = Vec::new();
        for file in &files {
            let name = format!("midnight/{}", file.path);
            let crc = crc32(&file.bytes);
            let offset = u32::try_from(archive.len()).expect("offset");
            let size = u32::try_from(file.bytes.len()).expect("size");
            let name_length = u16::try_from(name.len()).expect("name");
            archive.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
            archive.extend_from_slice(&[20, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
            archive.extend_from_slice(&crc.to_le_bytes());
            archive.extend_from_slice(&size.to_le_bytes());
            archive.extend_from_slice(&size.to_le_bytes());
            archive.extend_from_slice(&name_length.to_le_bytes());
            archive.extend_from_slice(&0_u16.to_le_bytes());
            archive.extend_from_slice(name.as_bytes());
            archive.extend_from_slice(&file.bytes);
            central.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&name_length.to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let directory_offset = u32::try_from(archive.len()).expect("offset");
        let count = u16::try_from(files.len()).expect("count");
        let directory_size = u32::try_from(central.len()).expect("size");
        archive.extend_from_slice(&central);
        archive.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        archive.extend_from_slice(&[0; 4]);
        archive.extend_from_slice(&count.to_le_bytes());
        archive.extend_from_slice(&count.to_le_bytes());
        archive.extend_from_slice(&directory_size.to_le_bytes());
        archive.extend_from_slice(&directory_offset.to_le_bytes());
        archive.extend_from_slice(&0_u16.to_le_bytes());
    }
    let path = fixture.root.join("midnight.zip");
    fs::write(&path, archive).expect("zip");
    let id = fixture.install(ReviewSource::Zip, &path);
    let entry = fixture.entry(&id);
    assert!(entry.active);
    assert_eq!(entry.contributes.themes.len(), 2);
    assert!(
        entry.backend.is_none(),
        "a theme-only plugin has no backend"
    );
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFF_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[test]
fn disable_and_remove_stop_contributions_and_delete_only_piui_copies() {
    let fixture = Fixture::new("remove", false);
    let id = fixture.install(ReviewSource::Folder, &example("midnight-theme"));
    fixture
        .plugins
        .set_theme(
            fixture.plugins.revision(),
            Some((id.clone(), "midnight".into())),
        )
        .expect("theme");
    assert_eq!(
        fixture.plugins.set_theme(
            fixture.plugins.revision(),
            Some((id.clone(), "unknown".into()))
        ),
        Err(PluginsError::NotFound)
    );
    fixture
        .plugins
        .set_enabled(fixture.plugins.revision(), &id, false)
        .expect("disable");
    assert!(!fixture.entry(&id).active);
    assert_eq!(
        fixture.plugins.active(&id).map(|_| ()),
        Err(PluginsError::Inactive)
    );
    assert_eq!(
        fixture
            .plugins
            .set_enabled(fixture.plugins.revision() + 1, &id, true),
        Err(PluginsError::Conflict)
    );
    fixture
        .plugins
        .remove(fixture.plugins.revision(), &id)
        .expect("remove");
    let view = registry_view(&fixture.plugins).expect("view");
    assert!(view.plugins.is_empty());
    assert!(
        view.active_theme.is_none(),
        "removing a plugin clears its theme"
    );
    assert_eq!(
        fs::read_dir(fixture.root.join("app-data/plugins-v1/packages"))
            .expect("packages")
            .count(),
        0
    );
    assert!(
        example("midnight-theme").join("piui-plugin.json").is_file(),
        "the source is untouched"
    );
}

#[test]
fn development_plugins_run_in_place_and_permission_changes_need_a_review() {
    let fixture = Fixture::new("development", false);
    let folder = fixture.copy("hello-command");
    let id = fixture.install(ReviewSource::Development, &folder);
    let entry = fixture.entry(&id);
    assert_eq!(entry.source, "development");
    assert!(entry.active);
    assert!(
        !fixture.root.join("app-data/plugins-v1/packages").exists()
            || fs::read_dir(fixture.root.join("app-data/plugins-v1/packages"))
                .expect("packages")
                .count()
                == 0
    );
    // Code changes reload without a review.
    fs::write(folder.join("ui/panel.css"), "body { margin: 0; }\n").expect("edit");
    assert!(fixture.plugins.reload(&id).expect("reload").is_none());
    assert!(fixture.entry(&id).active);
    // A new permission keeps it inactive until reviewed again.
    edit_manifest(&folder, |manifest| {
        manifest["permissions"]
            .as_array_mut()
            .expect("permissions")
            .push(json!("network"));
    });
    let (staging_id, staged) = fixture
        .plugins
        .reload(&id)
        .expect("reload")
        .expect("a review");
    assert!(!fixture.entry(&id).active);
    fixture
        .plugins
        .install(
            fixture.plugins.revision(),
            &staging_id,
            &staged.package.code_hash,
        )
        .expect("trusts the change");
    assert!(fixture.entry(&id).active);
    // An installed plugin with the same id cannot be loaded unpacked.
    assert_eq!(
        fixture
            .plugins
            .stage(ReviewSource::Folder, &folder)
            .map(|_| ()),
        Err(PluginsError::Duplicate)
    );
}

#[test]
fn settings_are_checked_and_panels_need_their_permission() {
    let fixture = Fixture::new("settings", false);
    let source = fixture.copy("hello-command");
    edit_manifest(&source, |manifest| {
        manifest["permissions"] = json!([
            "commands",
            "ui.panel",
            "ui.settings",
            "chat.read",
            "notifications"
        ]);
    });
    let id = fixture.install(ReviewSource::Folder, &source);
    let values = |value: Value| value.as_object().cloned().expect("values");
    let resolved = fixture
        .plugins
        .set_settings(
            fixture.plugins.revision(),
            &id,
            &values(json!({"prepareText": true})),
            true,
        )
        .expect("valid");
    assert_eq!(resolved.get("greeting"), Some(&json!("Hello")));
    assert!(matches!(
        fixture.plugins.set_settings(fixture.plugins.revision(), &id, &values(json!({"greeting": 3})), false),
        Err(PluginsError::InvalidSettings(_, key)) if key == "greeting"
    ));
    assert!(matches!(
        fixture.plugins.set_settings(fixture.plugins.revision(), &id, &values(json!({"secret": "x"})), false),
        Err(PluginsError::InvalidSettings(_, key)) if key == "secret"
    ));
}

#[test]
fn panel_files_come_only_from_the_ui_folder_of_an_active_plugin() {
    let fixture = Fixture::new("panel", false);
    let id = fixture.install(ReviewSource::Folder, &example("hello-command"));
    let page = fixture
        .plugins
        .panel_file(&id, "ui/index.html")
        .expect("page");
    assert!(page.html);
    assert_eq!(page.base, "example.hello-command/ui/");
    let policy = piui_plugins::csp::panel_policy(piui_plugins::csp::plugin_origin(), &page.base);
    assert!(
        policy.contains("/example.hello-command/ui/;") && policy.ends_with("sandbox allow-scripts")
    );
    assert!(
        fixture
            .plugins
            .panel_file(&id, "ui/panel.js")
            .is_some_and(|file| !file.html)
    );
    for outside in [
        "backend/main.mjs",
        "piui-plugin.json",
        "ui/../backend/main.mjs",
        "ui",
        "ui/missing.js",
    ] {
        assert!(
            fixture.plugins.panel_file(&id, outside).is_none(),
            "{outside}"
        );
    }
    fixture
        .plugins
        .set_enabled(fixture.plugins.revision(), &id, false)
        .expect("disable");
    assert!(fixture.plugins.panel_file(&id, "ui/index.html").is_none());
}

#[test]
fn safe_mode_lists_plugins_read_only_and_activates_none() {
    let fixture = Fixture::new("safe", false);
    let id = fixture.install(ReviewSource::Folder, &example("hello-command"));
    let safe = PluginsState::open(&fixture.root.join("app-data"), true, PIUI).expect("safe host");
    let acp = crate::acp_agents::AcpAgents::open(&fixture.root.join("acp")).expect("acp");
    safe.verify(&acp);
    let view = registry_view(&safe).expect("view");
    assert!(view.safe_mode && view.checked);
    let entry = view
        .plugins
        .iter()
        .find(|plugin| plugin.id == id)
        .expect("listed");
    assert!(entry.enabled && !entry.active);
    assert!(entry.contributes.panels[0].url.is_none());
    assert_eq!(safe.active(&id).map(|_| ()), Err(PluginsError::SafeMode));
    assert!(safe.panel_file(&id, "ui/index.html").is_none());
    assert!(
        safe.node_spec("example.pipeline-pack", "json-transform")
            .is_none()
    );
}

#[test]
fn plugin_acp_agents_join_the_harness_registry_and_leave_with_the_plugin() {
    let fixture = Fixture::new("acp", false);
    let acp = crate::acp_agents::AcpAgents::open(&fixture.root.join("acp")).expect("acp");
    let id = fixture.install(ReviewSource::Folder, &example("acp-agent"));
    fixture.plugins.sync_acp(&acp);
    let agent = acp
        .views()
        .into_iter()
        .find(|view| view.descriptor.id.as_str() == "opencode")
        .expect("registered");
    assert_eq!(agent.source, crate::acp_agents::AgentSource::Plugin);
    assert_eq!(
        agent.plugin.as_ref().map(|plugin| plugin.id.as_str()),
        Some(id.as_str())
    );
    assert!(
        !agent.trusted,
        "a plugin agent still needs its command line trusted"
    );
    assert!(fixture.entry(&id).contributes.acp_agents[0].registered);
    assert!(matches!(
        acp.remove(acp.revision(), agent.descriptor.id),
        Err(crate::acp_agents::RegistryError::PluginOwned)
    ));
    fixture
        .plugins
        .set_enabled(fixture.plugins.revision(), &id, false)
        .expect("disable");
    fixture.plugins.sync_acp(&acp);
    assert!(
        acp.views()
            .iter()
            .all(|view| view.descriptor.id.as_str() != "opencode")
    );
}

#[test]
fn command_answers_are_checked() {
    assert_eq!(
        command_result(&json!({"text": "Hi", "notice": "Done"}))
            .expect("valid")
            .text
            .as_deref(),
        Some("Hi")
    );
    for invalid in [
        json!("text"),
        json!({"text": 1}),
        json!({"other": true}),
        json!({"notice": "x".repeat(501)}),
    ] {
        assert!(command_result(&invalid).is_err(), "{invalid}");
    }
    assert!(command_result(&json!({"text": "a".repeat(16 * 1024 + 1)})).is_err());
}

#[tokio::test]
async fn a_backend_command_runs_contained_with_the_trusted_permissions() {
    let fixture = Fixture::new("command", false);
    let id = fixture.install(ReviewSource::Folder, &example("hello-command"));
    let (stored, package, root) = fixture.plugins.active(&id).expect("active");
    let spec = fixture
        .plugins
        .backend_spec(&stored, &package, &root)
        .expect("backend");
    assert!(spec.entry.starts_with(&root));
    let answer = fixture
        .plugins
        .supervisor()
        .call(
            &spec,
            "command/execute",
            json!({"commandId": "say-hello", "context": {"chat": {"id": "c1", "title": "Release notes"}}}),
            COMMAND_TIMEOUT,
            None,
        )
        .await
        .expect("answers");
    let result = command_result(&answer).expect("valid answer");
    assert_eq!(
        result.notice.as_deref(),
        Some("Hello to “Release notes” from the Hello command plugin!")
    );
    let (state, _, log) = fixture.plugins.supervisor().status(&id);
    assert_eq!(state, super::supervisor::BackendState::Running);
    assert!(
        log.iter()
            .any(|entry| entry.event == super::supervisor::LogEvent::BackendStarted)
    );
    fixture.plugins.supervisor().stop(&id).await;
    assert_ne!(
        fixture.plugins.supervisor().status(&id).0,
        super::supervisor::BackendState::Running
    );
}

/// The registry view is golden JSON shared with the TypeScript contract
/// (`contracts/fixtures/plugins-v1.json`).
#[test]
fn registry_view_matches_the_shared_contract_fixture() {
    let fixture = Fixture::new("fixture", false);
    fixture.install(ReviewSource::Folder, &example("midnight-theme"));
    let mut view =
        serde_json::to_value(registry_view(&fixture.plugins).expect("view")).expect("json");
    view["plugins"][0]["installedAt"] = json!("2026-09-27T00:00:00Z");
    view["plugins"][0]["log"] = json!([]);
    let expected: Value = serde_json::from_str(include_str!(
        "../../../../../contracts/fixtures/plugins-v1.json"
    ))
    .expect("fixture");
    assert_eq!(
        view,
        expected,
        "update the fixture with:\n{}",
        serde_json::to_string_pretty(&view).unwrap_or_default()
    );
}
