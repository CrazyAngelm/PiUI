//! Host tests for composer inputs v1 and composer v19 image delivery.

use super::super::composer::{ComposerCommand, Delivery, run_composer};
use super::super::native_host_tests::{install_test_spawner, test_root};
use super::*;
use piui_index::TrustState;
use piui_runtime::workspace_runtime::NativeRuntimeConfig;
use std::time::Duration;

const PNG: &[u8] =
    b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

/// Reports image support unless the session title says `text-only`, and
/// records every prompt's images as `mime:bytes` in a user block.
const IMAGE_ADAPTER: &str = r#"
    let status = 'idle';
    const native = {supported:true,enforcement:'native'};
    const unsupported = {supported:false,enforcement:'unsupported'};
    const blocks = [];
    const images = !String(config.title ?? '').includes('text-only');
    const setStatus = (next) => { status = next; emit({type:'status',status:next}); };
    return {
      snapshot() {
        return {nativeId:'native-images',materialized:false,title:config.title ?? 'Images',status,blocks,approvals:[],
          capabilities:{prompt:native,resume:native,models:native,approvals:native,instructions:unsupported,toolPolicy:native,nativeSubagents:unsupported},models:[]};
      },
      composerCapabilities() { return {steer:false,compact:false,images}; },
      composerCatalog() {
        return {commands:[{name:'review',description:'Review the diff',hint:'<ref>',source:'command'},{name:'bad name',source:'command'}],
          skills:[{name:'tests',description:'Runs tests',mention:'$tests'}]};
      },
      prompt({ text, images: attached }) {
        if (attached?.length && !images) throw Object.assign(new Error('no images'), {bridgeCode:'unsupported-input',safeMessage:'No images.'});
        setStatus('running');
        const summary = (attached ?? []).map((image) => `${image.mimeType}:${Buffer.from(image.data, 'base64').length}`).join(',');
        const block = {id:`user-${blocks.length}`,kind:'user',label:'You',status:'complete',text:`${text}|${summary}`};
        blocks.push(block);
        emit({type:'block',block});
        emit({type:'turnCompleted',outcome:'succeeded'});
        setStatus('idle');
        return {accepted:true};
      },
      interrupt() { return null; },
      dispose() { return null; },
    };
"#;

fn no_pick() -> PickFiles {
    Box::new(|_| panic!("the native dialog is not opened by this command"))
}

fn pick(paths: Vec<PathBuf>) -> PickFiles {
    Box::new(move |_| Some(paths))
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn trusted_project(host: &HostState, root: &Path) -> (String, PathBuf) {
    let path = root.join("project");
    fs::create_dir_all(path.join("src")).expect("creates project");
    fs::write(path.join(".gitignore"), "*.log\n").expect("ignore file");
    fs::write(path.join("src").join("main.rs"), "fn main() {}").expect("source");
    fs::write(path.join("debug.log"), "ignored").expect("log");
    fs::write(path.join("README.md"), "readme").expect("readme");
    let directory = ProjectDirectory::resolve(&path).expect("resolves project");
    let id = host
        .index
        .lock()
        .expect("index")
        .register_project_directory(&directory, Some("Project"), TrustState::Trusted)
        .expect("registers a trusted project")
        .id;
    (id, directory.canonical_path().to_path_buf())
}

async fn inputs(
    host: &HostState,
    drops: &ComposerDrops,
    command: ComposerInputsCommand,
) -> Result<ComposerInputsResult, WorkspaceError> {
    run_composer_inputs(host, drops, command, no_pick()).await
}

type Attached = (Vec<StoredImage>, Vec<FileReference>, Vec<Rejection>);

fn attachments(result: ComposerInputsResult) -> Attached {
    match result {
        ComposerInputsResult::Attachments {
            images,
            files,
            rejected,
            ..
        } => (images, files, rejected),
        other => panic!("expected attachments, got {other:?}"),
    }
}

async fn start_chat(host: &HostState, title: &str) -> String {
    let result = dispatch_workspace_command(
        host,
        WorkspaceCommand::CreateSession {
            workspace_id: host.personal_workspace.project_id.clone(),
            harness: HarnessKind::Pi,
            title: Some(title.into()),
            model: None,
            permission_mode: PermissionMode::Native,
        },
        Arc::new(|_| {}),
    )
    .await;
    match result {
        Ok(WorkspaceResult::Session { snapshot }) => snapshot.session.id,
        other => panic!("expected a session, got {other:?}"),
    }
}

fn image_host(purpose: &str) -> (Arc<HostState>, PathBuf) {
    let root = test_root(purpose);
    let host = Arc::new(HostState::open(&root, false).expect("host state"));
    install_test_spawner(&host.workspace, |config: NativeRuntimeConfig| {
        NativeRuntime::spawn_test_adapter(config, IMAGE_ADAPTER)
    });
    (host, root)
}

async fn session_blocks(host: &HostState, session_id: &str) -> Vec<NativeBlock> {
    match dispatch_workspace_command(
        host,
        WorkspaceCommand::Snapshot {
            session_id: session_id.into(),
        },
        Arc::new(|_| {}),
    )
    .await
    {
        Ok(WorkspaceResult::Session { snapshot }) => snapshot.blocks,
        other => panic!("expected a session snapshot, got {other:?}"),
    }
}

#[test]
fn the_golden_fixture_matches_the_rust_contract() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/workspace-composer-inputs-v1.json"
    ))
    .expect("fixture");
    for command in fixture["commands"].as_array().expect("commands") {
        assert!(
            serde_json::from_value::<ComposerInputsCommand>(command.clone()).is_ok(),
            "{command}"
        );
    }
    for command in fixture["invalidCommands"].as_array().expect("invalid") {
        assert!(
            serde_json::from_value::<ComposerInputsCommand>(command.clone()).is_err(),
            "{command}"
        );
    }
    let image = StoredImage {
        id: "0f8e5a4c-1b2d-4e6f-8a9b-7c6d5e4f3a2b".into(),
        name: "screen.png".into(),
        mime_type: ImageType::Png,
        size: 1024,
    };
    let results = &fixture["results"];
    let attached = ComposerInputsResult::Attachments {
        protocol: 1,
        images: vec![image.clone()],
        files: vec![
            FileReference {
                name: "spec sheet.pdf".into(),
                reference: "@\"docs/spec sheet.pdf\"".into(),
                in_project: true,
            },
            FileReference {
                name: "notes.txt".into(),
                reference: r"D:\notes.txt".into(),
                in_project: false,
            },
        ],
        rejected: vec![
            Rejection {
                name: "src".into(),
                reason: RejectionReason::NotAFile,
            },
            Rejection {
                name: "huge.png".into(),
                reason: RejectionReason::TooLarge,
            },
        ],
    };
    assert_eq!(
        serde_json::to_value(&attached).expect("json"),
        results["attachments"]
    );
    let preview = ComposerInputsResult::Preview {
        protocol: 1,
        attachment_id: image.id.clone(),
        mime_type: ImageType::Png,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".into(),
    };
    assert_eq!(
        serde_json::to_value(&preview).expect("json"),
        results["preview"]
    );
    assert_eq!(
        serde_json::to_value(ComposerInputsResult::Discarded { protocol: 1 }).expect("json"),
        results["discarded"]
    );
    let files = ComposerInputsResult::Files {
        protocol: 1,
        workspace_id: "workspace-1".into(),
        query: "src/app".into(),
        files: vec![
            "src/app/App.svelte".into(),
            "src/app/shell/AppShell.svelte".into(),
        ],
        truncated: false,
    };
    assert_eq!(
        serde_json::to_value(&files).expect("json"),
        results["files"]
    );
    let catalog: ComposerCatalog = serde_json::from_value(serde_json::json!({
        "commands": results["catalog"]["commands"],
        "skills": results["catalog"]["skills"],
    }))
    .expect("bridge catalog shape");
    let catalog = catalog.sanitized();
    let catalog = ComposerInputsResult::Catalog {
        protocol: 1,
        session_id: "8d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d".into(),
        commands: catalog.commands,
        skills: catalog.skills,
    };
    assert_eq!(
        serde_json::to_value(&catalog).expect("json"),
        results["catalog"]
    );
    let drops = ComposerDrops::default();
    let paths = vec![PathBuf::from("a.png"), PathBuf::from("b.txt")];
    let position = tauri::PhysicalPosition::new(0.0, 0.0);
    let enter = drop_event(
        &drops,
        false,
        &tauri::DragDropEvent::Enter {
            paths: paths.clone(),
            position,
        },
    )
    .expect("enter");
    assert_eq!(
        serde_json::to_value(&enter).expect("json"),
        fixture["dropEvents"][0]
    );
    let dropped = drop_event(
        &drops,
        false,
        &tauri::DragDropEvent::Drop { paths, position },
    )
    .expect("drop");
    let mut expected = fixture["dropEvents"][1].clone();
    expected["dropId"] = dropped.drop_id.clone().expect("drop id").into();
    assert_eq!(serde_json::to_value(&dropped).expect("json"), expected);
    let leave = drop_event(&drops, false, &tauri::DragDropEvent::Leave).expect("leave");
    assert_eq!(
        serde_json::to_value(&leave).expect("json"),
        fixture["dropEvents"][2]
    );
    assert!(serde_json::from_value::<ComposerCommand>(fixture["composer"]["send"].clone()).is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn safe_mode_refuses_every_composer_input() {
    let root = test_root("inputs-safe");
    let host = HostState::open(&root, true).expect("host state");
    let drops = ComposerDrops::default();
    let workspace_id = host.personal_workspace.project_id.clone();
    let id = Uuid::new_v4().to_string();
    for command in [
        ComposerInputsCommand::Pick {
            workspace_id: workspace_id.clone(),
        },
        ComposerInputsCommand::Paste {
            workspace_id: workspace_id.clone(),
            name: "x.png".into(),
            data: base64(PNG),
        },
        ComposerInputsCommand::Drop {
            workspace_id: workspace_id.clone(),
            drop_id: id.clone(),
        },
        ComposerInputsCommand::Preview {
            attachment_id: id.clone(),
        },
        ComposerInputsCommand::Discard {
            attachment_ids: vec![id.clone()],
        },
        ComposerInputsCommand::Files {
            workspace_id: workspace_id.clone(),
            query: String::new(),
        },
        ComposerInputsCommand::Catalog {
            session_id: id.clone(),
        },
    ] {
        let error = run_composer_inputs(&host, &drops, command, no_pick())
            .await
            .expect_err("refused in safe mode");
        assert_eq!(error.code, "SAFE_MODE");
    }
    let position = tauri::PhysicalPosition::new(0.0, 0.0);
    assert!(
        drop_event(
            &drops,
            true,
            &tauri::DragDropEvent::Drop {
                paths: vec![root.join("x.png")],
                position
            }
        )
        .is_none(),
        "safe mode never accepts a drop"
    );
    drop(host);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_are_names_of_a_trusted_project_only() {
    let root = test_root("inputs-files");
    let host = HostState::open(&root.join("app-data"), false).expect("host state");
    let drops = ComposerDrops::default();
    let (workspace_id, _) = trusted_project(&host, &root);
    let listing = |query: &str| ComposerInputsCommand::Files {
        workspace_id: workspace_id.clone(),
        query: query.into(),
    };
    let ComposerInputsResult::Files {
        files, truncated, ..
    } = inputs(&host, &drops, listing("")).await.expect("lists")
    else {
        panic!("a file listing");
    };
    assert_eq!(files, ["README.md", "src/main.rs"]);
    assert!(!truncated);
    // A query only filters names below the project: it cannot name a folder.
    let ComposerInputsResult::Files { files, .. } =
        inputs(&host, &drops, listing("../../app-data"))
            .await
            .expect("lists")
    else {
        panic!("a file listing");
    };
    assert!(files.is_empty());
    let error = inputs(&host, &drops, listing(&"x".repeat(300)))
        .await
        .expect_err("a long query is invalid");
    assert_eq!(error.code, "INVALID_ARGUMENT");
    for (unknown, code) in [
        ("missing-project", "NOT_FOUND"),
        ("../..", "NOT_FOUND"),
        ("", "INVALID_ARGUMENT"),
    ] {
        let error = inputs(
            &host,
            &drops,
            ComposerInputsCommand::Files {
                workspace_id: unknown.into(),
                query: String::new(),
            },
        )
        .await
        .expect_err("an unknown project is refused");
        assert_eq!(error.code, code, "{unknown}");
    }
    host.index
        .lock()
        .expect("index")
        .update_project_trust(&workspace_id, TrustState::Restricted)
        .expect("restricts")
        .expect("project exists");
    let error = inputs(&host, &drops, listing(""))
        .await
        .expect_err("an untrusted project is never listed");
    assert_eq!(error.code, "NOT_TRUSTED");
    drop(host);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pasted_bytes_must_be_a_bounded_image() {
    let root = test_root("inputs-paste");
    let host = HostState::open(&root.join("app-data"), false).expect("host state");
    let drops = ComposerDrops::default();
    let (workspace_id, project) = trusted_project(&host, &root);
    let paste = |name: &str, data: String| ComposerInputsCommand::Paste {
        workspace_id: workspace_id.clone(),
        name: name.into(),
        data,
    };
    let (images, _, rejected) = attachments(
        inputs(&host, &drops, paste(r"C:\clip\image.png", base64(PNG)))
            .await
            .expect("pastes"),
    );
    assert!(rejected.is_empty());
    assert_eq!(images[0].name, "image.png");
    assert_eq!(images[0].mime_type, ImageType::Png);
    let ComposerInputsResult::Preview { data, .. } = inputs(
        &host,
        &drops,
        ComposerInputsCommand::Preview {
            attachment_id: images[0].id.clone(),
        },
    )
    .await
    .expect("previews") else {
        panic!("a preview");
    };
    assert_eq!(data, base64(PNG));
    let (_, _, rejected) = attachments(
        inputs(&host, &drops, paste("notes.txt", base64(b"plain text")))
            .await
            .expect("answers"),
    );
    assert_eq!(rejected[0].reason, RejectionReason::NotAnImage);
    let (_, _, rejected) = attachments(
        inputs(
            &host,
            &drops,
            paste("big.png", "A".repeat(MAX_PASTE_BASE64 + 4)),
        )
        .await
        .expect("answers"),
    );
    assert_eq!(rejected[0].reason, RejectionReason::TooLarge);
    let error = inputs(&host, &drops, paste("bad.png", "not base64!".into()))
        .await
        .expect_err("malformed data");
    assert_eq!(error.code, "INVALID_ARGUMENT");
    inputs(
        &host,
        &drops,
        ComposerInputsCommand::Discard {
            attachment_ids: vec![images[0].id.clone()],
        },
    )
    .await
    .expect("discards");
    let error = inputs(
        &host,
        &drops,
        ComposerInputsCommand::Preview {
            attachment_id: images[0].id.clone(),
        },
    )
    .await
    .expect_err("a discarded image is gone");
    assert_eq!(error.code, "ATTACHMENT_UNAVAILABLE");
    // Nothing reached the project folder.
    assert!(!project.join("image.png").exists());
    drop(host);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn picked_and_dropped_files_are_classified_without_touching_the_project() {
    let root = test_root("inputs-pick");
    let host = HostState::open(&root.join("app-data"), false).expect("host state");
    let drops = ComposerDrops::default();
    let (workspace_id, project) = trusted_project(&host, &root);
    let outside = root.join("outside");
    fs::create_dir_all(&outside).expect("outside folder");
    fs::write(outside.join("shot.png"), PNG).expect("image");
    fs::write(outside.join("report.pdf"), b"%PDF").expect("pdf");
    let chosen = vec![
        outside.join("shot.png"),
        outside.join("report.pdf"),
        project.join("src").join("main.rs"),
        project.join("src"),
    ];
    let pick_command = || ComposerInputsCommand::Pick {
        workspace_id: workspace_id.clone(),
    };
    let (images, files, rejected) = attachments(
        run_composer_inputs(&host, &drops, pick_command(), pick(chosen))
            .await
            .expect("picks"),
    );
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].name, "shot.png");
    assert_eq!(files.len(), 2);
    assert!(!files[0].in_project);
    assert!(files[0].reference.ends_with("report.pdf"));
    assert_eq!(files[1].reference, "@src/main.rs");
    assert_eq!(
        rejected,
        [Rejection {
            name: "src".into(),
            reason: RejectionReason::NotAFile
        }]
    );
    let cancelled = attachments(
        run_composer_inputs(&host, &drops, pick_command(), Box::new(|_| None))
            .await
            .expect("a cancelled dialog"),
    );
    assert_eq!(cancelled, (Vec::new(), Vec::new(), Vec::new()));

    // A drop is redeemed once, by id; the WebView never sends a path.
    let too_many: Vec<PathBuf> = (0..12).map(|_| outside.join("report.pdf")).collect();
    let position = tauri::PhysicalPosition::new(0.0, 0.0);
    let event = drop_event(
        &drops,
        false,
        &tauri::DragDropEvent::Drop {
            paths: too_many,
            position,
        },
    )
    .expect("drop event");
    let serialized = serde_json::to_string(&event).expect("json");
    assert!(!serialized.contains("report"), "{serialized}");
    let drop_id = event.drop_id.expect("drop id");
    let redeem = || ComposerInputsCommand::Drop {
        workspace_id: workspace_id.clone(),
        drop_id: drop_id.clone(),
    };
    let (_, files, rejected) = attachments(
        inputs(&host, &drops, redeem())
            .await
            .expect("redeems the drop"),
    );
    assert_eq!(files.len(), MAX_FILES_PER_BATCH);
    assert_eq!(rejected.len(), 2);
    assert!(
        rejected
            .iter()
            .all(|item| item.reason == RejectionReason::Limit)
    );
    let error = inputs(&host, &drops, redeem())
        .await
        .expect_err("a drop is single use");
    assert_eq!(error.code, "DROP_EXPIRED");
    let mut names: Vec<_> = fs::read_dir(&project)
        .expect("project")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    assert_eq!(names, [".gitignore", "README.md", "debug.log", "src"]);
    drop(host);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_image_reaches_the_harness_once_and_its_bytes_are_released() {
    let (host, root) = image_host("inputs-send");
    let drops = ComposerDrops::default();
    let session_id = start_chat(&host, "Images").await;
    let workspace_id = host.personal_workspace.project_id.clone();
    let (images, _, _) = attachments(
        inputs(
            &host,
            &drops,
            ComposerInputsCommand::Paste {
                workspace_id,
                name: "shot.png".into(),
                data: base64(PNG),
            },
        )
        .await
        .expect("pastes"),
    );
    let image = images[0].clone();
    let request_id = Uuid::new_v4().to_string();
    let send = || ComposerCommand::Send {
        session_id: session_id.clone(),
        request_id: request_id.clone(),
        text: "What is on this screen?".into(),
        mode: PromptMode::Prompt,
        attachments: vec![image.id.clone()],
    };
    let snapshot = serde_json::to_value(run_composer(&host, send(), |_| {}).await.expect("queues"))
        .expect("json");
    assert_eq!(snapshot["capabilities"]["images"], true);
    let delivered = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let queue = host.workspace.record(&session_id).expect("record").composer;
            if queue
                .items
                .iter()
                .any(|item| item.id == request_id && item.status == Delivery::Sent)
            {
                return queue;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the message is delivered");
    assert!(delivered.referenced_images().next().is_none());
    assert_eq!(
        host.workspace.inner.attachments.read(&image),
        Err(super::super::attachments::AttachmentError::NotFound),
        "delivered image bytes are removed from app data"
    );
    let expected = format!("What is on this screen?|image/png:{}", PNG.len());
    let delivered_blocks = |blocks: Vec<NativeBlock>| {
        blocks
            .iter()
            .filter(|block| block.text.as_deref() == Some(expected.as_str()))
            .count()
    };
    assert_eq!(
        delivered_blocks(session_blocks(&host, &session_id).await),
        1
    );
    // A retried request id after a lost reply is never sent twice.
    run_composer(&host, send(), |_| {})
        .await
        .expect("a retry is accepted");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        delivered_blocks(session_blocks(&host, &session_id).await),
        1
    );

    let ComposerInputsResult::Catalog {
        commands, skills, ..
    } = inputs(
        &host,
        &drops,
        ComposerInputsCommand::Catalog {
            session_id: session_id.clone(),
        },
    )
    .await
    .expect("catalog")
    else {
        panic!("a catalog");
    };
    assert_eq!(commands.len(), 1, "malformed native entries are dropped");
    assert_eq!(commands[0].name, "review");
    assert_eq!(skills[0].mention, "$tests");
    host.workspace.shutdown_all().await;
    drop(host);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn images_a_session_cannot_take_are_refused_before_anything_is_queued() {
    let (host, root) = image_host("inputs-refused");
    let drops = ComposerDrops::default();
    let session_id = start_chat(&host, "text-only chat").await;
    let workspace_id = host.personal_workspace.project_id.clone();
    let (images, _, _) = attachments(
        inputs(
            &host,
            &drops,
            ComposerInputsCommand::Paste {
                workspace_id,
                name: "shot.png".into(),
                data: base64(PNG),
            },
        )
        .await
        .expect("pastes"),
    );
    let send = |attachments: Vec<String>| ComposerCommand::Send {
        session_id: session_id.clone(),
        request_id: Uuid::new_v4().to_string(),
        text: "look".into(),
        mode: PromptMode::Prompt,
        attachments,
    };
    let error = run_composer(&host, send(vec![images[0].id.clone()]), |_| {})
        .await
        .expect_err("a text-only session refuses images");
    assert_eq!(error.code, "IMAGES_UNSUPPORTED");
    assert!(
        host.workspace
            .record(&session_id)
            .expect("record")
            .composer
            .items
            .is_empty()
    );
    // The refused image is still the user's pending attachment.
    assert!(
        host.workspace
            .inner
            .attachments
            .preview(&images[0].id)
            .is_ok()
    );
    host.workspace.shutdown_all().await;
    drop(host);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_image_id_queues_nothing() {
    let (host, root) = image_host("inputs-unknown");
    let session_id = start_chat(&host, "Images").await;
    let error = run_composer(
        &host,
        ComposerCommand::Send {
            session_id: session_id.clone(),
            request_id: Uuid::new_v4().to_string(),
            text: "look".into(),
            mode: PromptMode::Prompt,
            attachments: vec![Uuid::new_v4().to_string()],
        },
        |_| {},
    )
    .await
    .expect_err("an image that was never attached");
    assert_eq!(error.code, "ATTACHMENT_UNAVAILABLE");
    assert!(
        host.workspace
            .record(&session_id)
            .expect("record")
            .composer
            .items
            .is_empty()
    );
    host.workspace.shutdown_all().await;
    drop(host);
    let _ = fs::remove_dir_all(root);
}
