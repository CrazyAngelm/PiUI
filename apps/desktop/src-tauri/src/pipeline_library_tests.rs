//! Pipeline library v1: the generation store (persistence, damaged
//! generations, validation, limits, idempotency, scope filtering) and the
//! host command's safe-mode and chat-ownership checks.

use super::*;
use crate::session_tools_test_support::Fixture;
use piui_index::TrustState;
use serde_json::json;

const NOW: &str = "2026-09-28T10:00:00.000Z";
const LATER: &str = "2026-09-28T11:00:00.000Z";

fn root(label: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("piui-pipeline-library-{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("test root");
    root
}

fn system() -> Value {
    json!({"format": "piui-system", "version": 4, "nodes": []})
}

fn draft(name: &str, scope: PipelineTemplateScopeV1) -> TemplateDraftV1 {
    TemplateDraftV1 {
        id: None,
        name: name.into(),
        description: None,
        scope,
        system: system(),
    }
}

fn workspace(id: &str) -> PipelineTemplateScopeV1 {
    PipelineTemplateScopeV1::Workspace {
        workspace_id: id.into(),
    }
}

fn generations(root: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = fs::read_dir(root.join(DIRECTORY))
        .expect("reads library directory")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| generation_from_path(path).is_some())
        .collect();
    paths.sort();
    paths
}

#[test]
fn templates_and_chats_persist_across_reopen() {
    let root = root("reopen");
    let library = PipelineLibrary::open(&root).expect("opens");
    let saved = library
        .save_template(draft("Review", PipelineTemplateScopeV1::Global), NOW)
        .expect("saves");
    assert!(Uuid::parse_str(&saved.id).is_ok());
    assert_eq!(saved.created_at, NOW);
    library
        .set_chat_default("ws-1", Some("launch-1"))
        .expect("sets default");
    library
        .set_chat_pipeline("chat-1", "ws-1", Some("launch-1"))
        .expect("binds chat");
    library
        .record_chat_run("chat-1", "ws-1", "run-1", NOW)
        .expect("records run");
    drop(library);

    let reopened = PipelineLibrary::open(&root).expect("reopens");
    let (templates, chat_default) = reopened.list("ws-1").expect("lists");
    assert_eq!(templates, vec![saved]);
    assert_eq!(chat_default.as_deref(), Some("launch-1"));
    let chat = reopened.chat("chat-1").expect("reads").expect("chat");
    assert_eq!(chat.launch_command_id.as_deref(), Some("launch-1"));
    assert_eq!(chat.runs.len(), 1);
    // Older generations are removed after each write.
    assert_eq!(generations(&root).len(), 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_damaged_newest_generation_is_skipped() {
    let root = root("damaged");
    let library = PipelineLibrary::open(&root).expect("opens");
    let saved = library
        .save_template(draft("Keep", PipelineTemplateScopeV1::Global), NOW)
        .expect("saves");
    drop(library);
    let directory = root.join(DIRECTORY);
    let current = generations(&root)
        .last()
        .and_then(|path| generation_from_path(path))
        .expect("a generation");
    fs::write(generation_path(&directory, current + 1), b"{not json").expect("writes damage");
    // Well-formed JSON that fails validation is skipped too.
    let mut invalid: Value = serde_json::from_slice(
        &fs::read(generation_path(&directory, current)).expect("reads current"),
    )
    .expect("parses current");
    invalid["generation"] = json!(current + 2);
    invalid["templates"][0]["system"]["format"] = json!("other");
    fs::write(
        generation_path(&directory, current + 2),
        serde_json::to_vec(&invalid).expect("serializes"),
    )
    .expect("writes invalid generation");

    let reopened = PipelineLibrary::open(&root).expect("reopens");
    assert_eq!(reopened.list("ws").expect("lists").0, vec![saved]);
    // The next write never reuses a damaged generation's number.
    reopened
        .save_template(draft("Next", PipelineTemplateScopeV1::Global), LATER)
        .expect("saves after damage");
    assert_eq!(
        generations(&root)
            .last()
            .and_then(|path| generation_from_path(path)),
        Some(current + 3)
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn template_validation_refuses_bad_drafts() {
    let root = root("validation");
    let library = PipelineLibrary::open(&root).expect("opens");
    let global = PipelineTemplateScopeV1::Global;
    let refused = |draft: TemplateDraftV1| library.save_template(draft, NOW).expect_err("refused");
    assert_eq!(refused(draft("   ", global.clone())), LibraryError::Invalid);
    assert_eq!(
        refused(draft(&"n".repeat(121), global.clone())),
        LibraryError::Invalid
    );
    let mut long_description = draft("Ok", global.clone());
    long_description.description = Some("d".repeat(501));
    assert_eq!(refused(long_description), LibraryError::Invalid);
    let mut not_object = draft("Ok", global.clone());
    not_object.system = json!(["piui-system"]);
    assert_eq!(refused(not_object), LibraryError::Invalid);
    let mut wrong_format = draft("Ok", global.clone());
    wrong_format.system = json!({"format": "n8n"});
    assert_eq!(refused(wrong_format), LibraryError::Invalid);
    let mut too_large = draft("Ok", global.clone());
    too_large.system = json!({"format": "piui-system", "blob": "x".repeat(MAX_TEMPLATE_BYTES)});
    assert_eq!(refused(too_large), LibraryError::Invalid);
    assert_eq!(refused(draft("Ok", workspace(""))), LibraryError::Invalid);
    assert_eq!(
        refused(draft("Ok", workspace("a\nb"))),
        LibraryError::Invalid
    );
    let mut unknown = draft("Ok", global.clone());
    unknown.id = Some("missing".into());
    assert_eq!(refused(unknown), LibraryError::NotFound);
    assert_eq!(
        library.delete_template("missing"),
        Err(LibraryError::NotFound)
    );
    assert_eq!(library.list(&"w".repeat(129)), Err(LibraryError::Invalid));

    let trimmed = library
        .save_template(draft("  Trimmed  ", global), NOW)
        .expect("saves");
    assert_eq!(trimmed.name, "Trimmed");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn replacing_a_template_keeps_its_id_and_creation_time() {
    let root = root("replace");
    let library = PipelineLibrary::open(&root).expect("opens");
    let saved = library
        .save_template(draft("First", PipelineTemplateScopeV1::Global), NOW)
        .expect("saves");
    let mut replacement = draft("Second", workspace("ws"));
    replacement.id = Some(saved.id.clone());
    replacement.description = Some("Now scoped".into());
    let replaced = library.save_template(replacement, LATER).expect("replaces");
    assert_eq!(replaced.id, saved.id);
    assert_eq!(replaced.created_at, NOW);
    assert_eq!(replaced.updated_at, LATER);
    assert_eq!(replaced.name, "Second");
    assert!(library.list("other").expect("lists").0.is_empty());
    library.delete_template(&saved.id).expect("deletes");
    assert!(library.list("ws").expect("lists").0.is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn the_library_holds_at_most_max_templates() {
    let root = root("limit");
    let library = PipelineLibrary::open(&root).expect("opens");
    for index in 0..MAX_TEMPLATES {
        library
            .save_template(
                draft(&format!("T{index}"), PipelineTemplateScopeV1::Global),
                NOW,
            )
            .expect("saves");
    }
    assert_eq!(
        library.save_template(draft("One more", PipelineTemplateScopeV1::Global), NOW),
        Err(LibraryError::Limit)
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn list_filters_by_scope_and_sorts_by_name_ignoring_case() {
    let root = root("scope");
    let library = PipelineLibrary::open(&root).expect("opens");
    for (name, scope) in [
        ("beta", PipelineTemplateScopeV1::Global),
        ("Alpha", workspace("ws-a")),
        ("gamma", workspace("ws-b")),
        ("Delta", PipelineTemplateScopeV1::Global),
    ] {
        library
            .save_template(draft(name, scope), NOW)
            .expect("saves");
    }
    let names = |workspace: &str| -> Vec<String> {
        library
            .list(workspace)
            .expect("lists")
            .0
            .into_iter()
            .map(|template| template.name)
            .collect()
    };
    assert_eq!(names("ws-a"), ["Alpha", "beta", "Delta"]);
    assert_eq!(names("ws-b"), ["beta", "Delta", "gamma"]);
    assert_eq!(names("ws-c"), ["beta", "Delta"]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn chat_defaults_are_set_and_removed_per_workspace() {
    let root = root("defaults");
    let library = PipelineLibrary::open(&root).expect("opens");
    library.set_chat_default("ws-a", Some("l-1")).expect("sets");
    library.set_chat_default("ws-b", Some("l-2")).expect("sets");
    library.set_chat_default("ws-a", None).expect("removes");
    assert_eq!(library.list("ws-a").expect("lists").1, None);
    assert_eq!(
        library.list("ws-b").expect("lists").1.as_deref(),
        Some("l-2")
    );
    assert_eq!(
        library.set_chat_default("ws-a", Some("")),
        Err(LibraryError::Invalid)
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn chat_runs_are_idempotent_bounded_and_survive_unbinding() {
    let root = root("runs");
    let library = PipelineLibrary::open(&root).expect("opens");
    assert_eq!(library.chat("chat").expect("reads"), None);
    library
        .set_chat_pipeline("chat", "ws", Some("launch"))
        .expect("binds");
    library
        .record_chat_run("chat", "ws", "run-1", NOW)
        .expect("records");
    let before = generations(&root);
    let repeated = library
        .record_chat_run("chat", "ws", "run-1", LATER)
        .expect("repeats");
    assert_eq!(repeated.runs.len(), 1);
    assert_eq!(repeated.runs[0].started_at, NOW);
    assert_eq!(generations(&root), before, "a repeated run writes nothing");

    let unbound = library
        .set_chat_pipeline("chat", "ws", None)
        .expect("unbinds")
        .expect("keeps the chat with runs");
    assert_eq!(unbound.launch_command_id, None);
    assert_eq!(unbound.runs.len(), 1);
    assert_eq!(
        library.record_chat_run("chat", "other-ws", "run-2", NOW),
        Err(LibraryError::NotFound)
    );

    for index in 2..=MAX_CHAT_RUNS + 1 {
        library
            .record_chat_run("chat", "ws", &format!("run-{index}"), NOW)
            .expect("records");
    }
    let chat = library.chat("chat").expect("reads").expect("chat");
    assert_eq!(chat.runs.len(), MAX_CHAT_RUNS);
    assert_eq!(chat.runs[0].run_id, "run-2", "the oldest run is dropped");

    // A chat with neither a binding nor runs is forgotten.
    assert_eq!(
        library
            .set_chat_pipeline("fresh", "ws", None)
            .expect("unbinds"),
        None
    );
    assert_eq!(library.chat("fresh").expect("reads"), None);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn consuming_runs_marks_known_ids_and_ignores_the_rest() {
    let root = root("consume");
    let library = PipelineLibrary::open(&root).expect("opens");
    for run in ["run-1", "run-2"] {
        library
            .record_chat_run("chat", "ws", run, NOW)
            .expect("records");
    }
    let chat = library
        .consume_chat_runs("chat", &["run-2".into(), "unknown".into()])
        .expect("consumes")
        .expect("chat");
    assert!(!chat.runs[0].consumed);
    assert!(chat.runs[1].consumed);
    let serialized = serde_json::to_value(&chat).expect("serializes");
    assert!(serialized["runs"][0].get("consumed").is_none());
    assert_eq!(serialized["runs"][1]["consumed"], json!(true));
    assert_eq!(
        library
            .consume_chat_runs("missing", &["run-1".into()])
            .expect("consumes"),
        None
    );
    assert_eq!(
        library.consume_chat_runs("chat", &["".into()]),
        Err(LibraryError::Invalid)
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn commands_decode_with_the_contract_shape() {
    let command: PipelineLibraryCommandV1 = serde_json::from_value(json!({
        "type": "saveTemplate",
        "template": {"name": "A", "scope": {"kind": "workspace", "workspaceId": "ws"}, "system": {"format": "piui-system"}}
    }))
    .expect("decodes");
    assert!(matches!(
        command,
        PipelineLibraryCommandV1::SaveTemplate { .. }
    ));
    assert!(
        serde_json::from_value::<PipelineLibraryCommandV1>(
            json!({"type": "list", "workspaceId": "ws", "extra": 1})
        )
        .is_err()
    );
    let result = PipelineLibraryResultV1::Chat {
        protocol: 1,
        chat: None,
    };
    assert_eq!(
        serde_json::to_value(result).expect("serializes"),
        json!({"type": "chat", "protocol": 1, "chat": null})
    );
    let library = PipelineLibraryResultV1::Library {
        protocol: 1,
        templates: Vec::new(),
        chat_default: Some("l".into()),
    };
    assert_eq!(
        serde_json::to_value(library).expect("serializes"),
        json!({"type": "library", "protocol": 1, "templates": [], "chatDefault": "l"})
    );
}

#[test]
fn safe_mode_allows_reads_and_refuses_changes() {
    let fixture = Fixture::new("pipeline-library-safe", true);
    let library = PipelineLibrary::open(&fixture.root.join("data")).expect("opens");
    let listed = dispatch(
        &fixture.state,
        &library,
        PipelineLibraryCommandV1::List {
            workspace_id: "ws".into(),
        },
    )
    .expect("lists in safe mode");
    assert!(matches!(listed, PipelineLibraryResultV1::Library { .. }));
    dispatch(
        &fixture.state,
        &library,
        PipelineLibraryCommandV1::Chat {
            session_id: "chat".into(),
        },
    )
    .expect("reads a chat in safe mode");
    let refused = dispatch(
        &fixture.state,
        &library,
        PipelineLibraryCommandV1::SetChatDefault {
            workspace_id: "ws".into(),
            launch_command_id: Some("l".into()),
        },
    )
    .expect_err("refused");
    assert_eq!(refused.code, "SAFE_MODE");
}

#[test]
fn chat_commands_require_the_chat_of_that_workspace() {
    let fixture = Fixture::new("pipeline-library-owner", false);
    let library = PipelineLibrary::open(&fixture.root.join("data")).expect("opens");
    let project = fixture.project(&fixture.root.join("project"), TrustState::Trusted);
    let other = fixture.project(&fixture.root.join("other"), TrustState::Trusted);
    let chat = fixture.chat(&project);

    let bound = dispatch(
        &fixture.state,
        &library,
        PipelineLibraryCommandV1::SetChatPipeline {
            session_id: chat.clone(),
            workspace_id: project.clone(),
            launch_command_id: Some("launch".into()),
        },
    )
    .expect("binds its own chat");
    let PipelineLibraryResultV1::Chat {
        chat: Some(binding),
        ..
    } = bound
    else {
        panic!("expected a chat binding");
    };
    assert_eq!(binding.workspace_id, project);

    let mismatch = dispatch(
        &fixture.state,
        &library,
        PipelineLibraryCommandV1::RecordChatRun {
            session_id: chat.clone(),
            workspace_id: other,
            run_id: "run".into(),
        },
    )
    .expect_err("another project's chat is refused");
    assert_eq!(mismatch.code, "NOT_FOUND");
    let missing = dispatch(
        &fixture.state,
        &library,
        PipelineLibraryCommandV1::RecordChatRun {
            session_id: Uuid::new_v4().to_string(),
            workspace_id: project.clone(),
            run_id: "run".into(),
        },
    )
    .expect_err("an unknown chat is refused");
    assert_eq!(missing.code, "NOT_FOUND");
    let invalid = dispatch(
        &fixture.state,
        &library,
        PipelineLibraryCommandV1::SetChatPipeline {
            session_id: String::new(),
            workspace_id: project,
            launch_command_id: None,
        },
    )
    .expect_err("an empty id is refused");
    assert_eq!(invalid.code, "INVALID_ARGUMENT");
}
