//! Placement v1: worktree chats, removal, trust and handoff links, with real
//! git and the production bridge runner around a test adapter. Every test
//! runs on one tokio runtime: live runtimes belong to the runtime that
//! started them.

use super::{
    PlacementCommandV1, PlacementResultV1, WorktreeRequestV1, WorktreeState, dispatch_placement,
};
use crate::session_tools_test_support::{
    Fixture, git, git_output, init_repository, outside_any_repository,
};
use crate::workspace_api::{
    HarnessKind, PermissionMode, WorkspaceCommand, WorkspaceError, WorkspaceEventPublisher,
    WorkspaceResult, dispatch_workspace_command,
};
use piui_index::TrustState;
use piui_runtime::workspace_runtime::{NativeRuntime, NativeRuntimeConfig, NativeRuntimeError};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const ADAPTER: &str = r#"
    let status = 'idle';
    const native = {supported:true,enforcement:'native'};
    const unsupported = {supported:false,enforcement:'unsupported'};
    return {
      snapshot() {
        return {nativeId:'native-placement',materialized:false,title:config.title ?? 'Pi session',status,blocks:[],approvals:[],
          capabilities:{prompt:native,resume:native,models:native,approvals:native,instructions:unsupported,toolPolicy:native,nativeSubagents:unsupported},models:[]};
      },
      prompt() { return {accepted:true}; },
      interrupt() { return null; },
      dispose() { return null; },
    };
"#;

type Starts = Arc<Mutex<Vec<(PathBuf, Option<String>)>>>;

fn record_starts(fixture: &Fixture) -> Starts {
    let starts: Starts = Arc::default();
    let captured = Arc::clone(&starts);
    fixture
        .state
        .workspace
        .replace_native_spawner(move |config: NativeRuntimeConfig| {
            if let Ok(mut starts) = captured.lock() {
                starts.push((config.cwd.clone(), config.title.clone()));
            }
            NativeRuntime::spawn_test_adapter(config, ADAPTER)
        });
    starts
}

fn quiet() -> WorkspaceEventPublisher {
    Arc::new(|_| {})
}

async fn run(
    fixture: &Fixture,
    command: PlacementCommandV1,
) -> Result<PlacementResultV1, WorkspaceError> {
    dispatch_placement(&fixture.state, command, quiet()).await
}

async fn workspace(
    fixture: &Fixture,
    command: WorkspaceCommand,
) -> Result<WorkspaceResult, WorkspaceError> {
    dispatch_workspace_command(&fixture.state, command, quiet()).await
}

struct Preview {
    branch: String,
    folder: String,
    commit: String,
}

async fn preview(fixture: &Fixture, project: &str, branch: Option<&str>) -> Preview {
    match run(
        fixture,
        PlacementCommandV1::PreviewWorktree {
            workspace_id: project.into(),
            branch: branch.map(str::to_owned),
        },
    )
    .await
    .expect("preview")
    {
        PlacementResultV1::Preview { preview, .. } => Preview {
            branch: preview.branch,
            folder: preview.folder,
            commit: preview.base.commit,
        },
        other => panic!("unexpected {other:?}"),
    }
}

fn create_command(project: &str, worktree: WorktreeRequestV1) -> PlacementCommandV1 {
    PlacementCommandV1::CreateChat {
        workspace_id: project.into(),
        harness: HarnessKind::Pi,
        permission_mode: PermissionMode::Native,
        title: Some("Worktree chat".into()),
        model: None,
        worktree: Some(worktree),
        continued_from: None,
    }
}

fn new_worktree(planned: &Preview) -> WorktreeRequestV1 {
    WorktreeRequestV1::New {
        branch: planned.branch.clone(),
        folder: planned.folder.clone(),
        expected_base: planned.commit.clone(),
    }
}

async fn create_in_worktree(
    fixture: &Fixture,
    project: &str,
    planned: &Preview,
) -> (String, PathBuf) {
    match run(fixture, create_command(project, new_worktree(planned)))
        .await
        .expect("creates a worktree chat")
    {
        PlacementResultV1::Created {
            snapshot,
            placement,
            ..
        } => {
            let worktree = placement.worktree.expect("worktree view");
            assert_eq!(worktree.state, WorktreeState::Ready);
            assert_eq!(worktree.branch, planned.branch);
            let root = fixture
                .state
                .workspace
                .worktree_binding(&snapshot.session.id)
                .expect("reads")
                .expect("bound")
                .root;
            (snapshot.session.id.clone(), root)
        }
        other => panic!("unexpected {other:?}"),
    }
}

fn setup(label: &str) -> (Fixture, PathBuf, String) {
    let fixture = Fixture::new(label, false);
    let repo = fixture.root.join("repo");
    init_repository(&repo);
    let project = fixture.project(&repo, TrustState::Trusted);
    (fixture, repo, project)
}

fn worktree_count(repo: &std::path::Path) -> usize {
    git_output(repo, &["worktree", "list", "--porcelain"])
        .lines()
        .filter(|line| line.starts_with("worktree "))
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_preview_names_branch_folder_and_base_and_refuses_bad_requests() {
    let (fixture, repo, project) = setup("placement-preview");
    let planned = preview(&fixture, &project, None).await;
    assert!(planned.branch.starts_with("piui/chat-"));
    assert!(planned.folder.starts_with("piui-chat-"));
    assert_eq!(planned.commit, git_output(&repo, &["rev-parse", "HEAD"]));
    let named = preview(&fixture, &project, Some("feature/login")).await;
    assert_eq!(named.folder, "feature-login");
    for (branch, code) in [
        ("main", "BRANCH_EXISTS"),
        ("bad name", "INVALID_BRANCH"),
        ("@{-1}", "INVALID_BRANCH"),
        ("-x", "INVALID_BRANCH"),
    ] {
        let error = run(
            &fixture,
            PlacementCommandV1::PreviewWorktree {
                workspace_id: project.clone(),
                branch: Some(branch.into()),
            },
        )
        .await
        .expect_err("refused");
        assert_eq!(error.code, code, "{branch}");
    }
    let personal = run(
        &fixture,
        PlacementCommandV1::PreviewWorktree {
            workspace_id: fixture.state.personal_workspace.project_id.clone(),
            branch: None,
        },
    )
    .await
    .expect_err("personal chats have no repository");
    assert_eq!(personal.code, "NOT_SUPPORTED");
    let plain = fixture.root.join("plain");
    let plain_project = fixture.project(&plain, TrustState::Trusted);
    if outside_any_repository(&plain) {
        let error = run(
            &fixture,
            PlacementCommandV1::PreviewWorktree {
                workspace_id: plain_project,
                branch: None,
            },
        )
        .await
        .expect_err("not a repository");
        assert_eq!(error.code, "NOT_A_REPOSITORY");
    }
    let restricted = fixture.project(&fixture.root.join("restricted"), TrustState::Restricted);
    let error = run(
        &fixture,
        PlacementCommandV1::PreviewWorktree {
            workspace_id: restricted,
            branch: None,
        },
    )
    .await
    .expect_err("untrusted");
    assert_eq!(error.code, "NOT_TRUSTED");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worktree_chat_starts_in_its_worktree_on_a_new_branch() {
    let (fixture, repo, project) = setup("placement-create");
    let starts = record_starts(&fixture);
    std::fs::write(repo.join("uncommitted.txt"), "stays in the project\n").expect("dirty project");
    let planned = preview(&fixture, &project, Some("piui/login")).await;
    let (session, root) = create_in_worktree(&fixture, &project, &planned).await;
    let started = starts.lock().expect("starts").clone();
    assert_eq!(started.len(), 1);
    assert_eq!(std::fs::canonicalize(&started[0].0).expect("cwd"), root);
    assert_eq!(started[0].1.as_deref(), Some("Worktree chat"));
    let managed =
        std::fs::canonicalize(fixture.root.join("data").join("worktrees")).expect("managed");
    assert!(root.starts_with(managed));
    assert!(
        !root.join("uncommitted.txt").exists(),
        "nothing is copied from the project"
    );
    assert_eq!(
        git_output(&root, &["branch", "--show-current"]),
        "piui/login"
    );
    assert_eq!(worktree_count(&repo), 2);
    let PlacementResultV1::Placements { placements, .. } =
        run(&fixture, PlacementCommandV1::List {})
            .await
            .expect("lists")
    else {
        panic!("expected placements");
    };
    let listed = placements
        .iter()
        .find(|placement| placement.session_id == session)
        .expect("listed");
    assert_eq!(
        listed.worktree.as_ref().map(|worktree| worktree.state),
        Some(WorktreeState::Ready)
    );

    // The confirmed folder is exact: using it again is stale.
    let again = run(
        &fixture,
        create_command(
            &project,
            WorktreeRequestV1::New {
                branch: "piui/other".into(),
                folder: planned.folder.clone(),
                expected_base: planned.commit.clone(),
            },
        ),
    )
    .await
    .expect_err("folder already used");
    assert_eq!(again.code, "STALE");
    fixture.state.workspace.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_moved_head_is_refused_before_anything_is_created() {
    let (fixture, repo, project) = setup("placement-stale");
    record_starts(&fixture);
    let planned = preview(&fixture, &project, Some("piui/stale")).await;
    std::fs::write(repo.join("more.txt"), "more\n").expect("new file");
    git(&repo, &["add", "more.txt"]);
    git(&repo, &["commit", "-q", "-m", "more"]);
    let error = run(&fixture, create_command(&project, new_worktree(&planned)))
        .await
        .expect_err("stale base");
    assert_eq!(error.code, "STALE");
    assert_eq!(git_output(&repo, &["branch", "--list", "piui/stale"]), "");
    assert_eq!(worktree_count(&repo), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_start_removes_the_fresh_worktree_and_keeps_the_branch() {
    let (fixture, repo, project) = setup("placement-failed-start");
    fixture
        .state
        .workspace
        .replace_native_spawner(|_config: NativeRuntimeConfig| async {
            Err(NativeRuntimeError::HarnessUnavailable)
        });
    let planned = preview(&fixture, &project, Some("piui/failed")).await;
    let error = run(&fixture, create_command(&project, new_worktree(&planned)))
        .await
        .expect_err("start fails");
    assert_eq!(error.code, "RUNTIME_FAILED");
    assert_eq!(worktree_count(&repo), 1);
    assert_eq!(
        git_output(&repo, &["branch", "--list", "piui/failed"]),
        "piui/failed"
    );
    let PlacementResultV1::Placements { placements, .. } =
        run(&fixture, PlacementCommandV1::List {})
            .await
            .expect("lists")
    else {
        panic!("expected placements");
    };
    assert!(placements.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removal_refuses_changes_until_they_are_confirmed_and_keeps_history_and_branch() {
    let (fixture, repo, project) = setup("placement-remove");
    let starts = record_starts(&fixture);
    let planned = preview(&fixture, &project, Some("piui/remove")).await;
    let (session, root) = create_in_worktree(&fixture, &project, &planned).await;
    std::fs::write(root.join("agent-work.txt"), "uncommitted\n").expect("agent writes");
    let remove = |discard: bool, expected: Option<String>| PlacementCommandV1::RemoveWorktree {
        session_id: session.clone(),
        discard_changes: discard,
        expected_changes: expected,
    };
    let PlacementResultV1::Dirty {
        changes,
        fingerprint,
        ..
    } = run(&fixture, remove(false, None))
        .await
        .expect("reports changes")
    else {
        panic!("expected dirty");
    };
    assert_eq!(changes, 1);
    assert!(root.join("agent-work.txt").exists());

    std::fs::write(root.join("more-work.txt"), "later\n").expect("more changes");
    let stale = run(&fixture, remove(true, Some(fingerprint)))
        .await
        .expect_err("changes differ from the confirmed ones");
    assert_eq!(stale.code, "STALE");
    assert!(root.join("more-work.txt").exists());

    let PlacementResultV1::Dirty { fingerprint, .. } = run(&fixture, remove(false, None))
        .await
        .expect("reports changes again")
    else {
        panic!("expected dirty");
    };
    let PlacementResultV1::Removed { placement, .. } =
        run(&fixture, remove(true, Some(fingerprint)))
            .await
            .expect("removes after confirmation")
    else {
        panic!("expected removed");
    };
    assert_eq!(
        placement.worktree.map(|worktree| worktree.state),
        Some(WorktreeState::Removed)
    );
    assert!(
        root.is_dir(),
        "an empty folder keeps the chat history readable"
    );
    assert_eq!(std::fs::read_dir(&root).expect("folder").count(), 0);
    assert_eq!(
        git_output(&repo, &["branch", "--list", "piui/remove"]),
        "piui/remove"
    );
    assert_eq!(worktree_count(&repo), 1);

    let reopen = workspace(
        &fixture,
        WorkspaceCommand::OpenSession {
            session_id: session.clone(),
        },
    )
    .await
    .expect_err("a removed worktree does not start");
    assert_eq!(reopen.code, "WORKTREE_REMOVED");
    assert_eq!(starts.lock().expect("starts").len(), 1);
    let again = run(&fixture, remove(false, None))
        .await
        .expect_err("already removed");
    assert_eq!(again.code, "WORKTREE_REMOVED");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trust_follows_the_project_and_a_clean_worktree_is_removed_at_once() {
    let (fixture, _repo, project) = setup("placement-trust");
    let starts = record_starts(&fixture);
    let planned = preview(&fixture, &project, Some("piui/trust")).await;
    let (session, _root) = create_in_worktree(&fixture, &project, &planned).await;
    let open = || WorkspaceCommand::OpenSession {
        session_id: session.clone(),
    };
    workspace(
        &fixture,
        WorkspaceCommand::CloseSession {
            session_id: session.clone(),
        },
    )
    .await
    .expect("closes");
    fixture.set_trust(&project, TrustState::Restricted);
    let refused = workspace(&fixture, open()).await.expect_err("untrusted");
    assert_eq!(refused.code, "NOT_TRUSTED");
    fixture.set_trust(&project, TrustState::Trusted);
    let reopened = workspace(&fixture, open())
        .await
        .expect("reopens in the worktree");
    assert!(matches!(reopened, WorkspaceResult::Session { .. }));
    let started = starts.lock().expect("starts").clone();
    assert_eq!(started.len(), 2);
    assert_eq!(
        started[0].0, started[1].0,
        "the reopen uses the same worktree folder"
    );

    let removed = run(
        &fixture,
        PlacementCommandV1::RemoveWorktree {
            session_id: session,
            discard_changes: false,
            expected_changes: None,
        },
    )
    .await
    .expect("a clean worktree is removed at once, stopping its idle chat");
    assert!(matches!(removed, PlacementResultV1::Removed { .. }));
    fixture.state.workspace.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handoffs_link_back_and_can_share_the_worktree() {
    let (fixture, _repo, project) = setup("placement-handoff");
    let starts = record_starts(&fixture);
    let planned = preview(&fixture, &project, Some("piui/handoff")).await;
    let (source, root) = create_in_worktree(&fixture, &project, &planned).await;
    let mut shared = create_command(
        &project,
        WorktreeRequestV1::Shared {
            session_id: source.clone(),
        },
    );
    if let PlacementCommandV1::CreateChat { continued_from, .. } = &mut shared {
        *continued_from = Some(source.clone());
    }
    let PlacementResultV1::Created {
        snapshot,
        placement,
        ..
    } = run(&fixture, shared)
        .await
        .expect("continues in the same worktree")
    else {
        panic!("expected created");
    };
    assert_eq!(placement.continued_from.as_deref(), Some(source.as_str()));
    let started = starts.lock().expect("starts").clone();
    assert_eq!(std::fs::canonicalize(&started[1].0).expect("cwd"), root);
    assert_ne!(snapshot.session.id, source);

    let other = fixture.project(&fixture.root.join("other"), TrustState::Trusted);
    let wrong = run(
        &fixture,
        PlacementCommandV1::CreateChat {
            workspace_id: other,
            harness: HarnessKind::Pi,
            permission_mode: PermissionMode::Native,
            title: None,
            model: None,
            worktree: None,
            continued_from: Some(source.clone()),
        },
    )
    .await
    .expect_err("the source belongs to another project");
    assert_eq!(wrong.code, "NOT_FOUND");
    let empty = run(
        &fixture,
        PlacementCommandV1::CreateChat {
            workspace_id: project.clone(),
            harness: HarnessKind::Pi,
            permission_mode: PermissionMode::Native,
            title: None,
            model: None,
            worktree: None,
            continued_from: None,
        },
    )
    .await
    .expect_err("nothing to place");
    assert_eq!(empty.code, "INVALID_ARGUMENT");
    let linked = run(
        &fixture,
        PlacementCommandV1::CreateChat {
            workspace_id: project,
            harness: HarnessKind::Pi,
            permission_mode: PermissionMode::Native,
            title: None,
            model: None,
            worktree: None,
            continued_from: Some(source),
        },
    )
    .await
    .expect("a handoff in the project folder");
    let PlacementResultV1::Created { placement, .. } = linked else {
        panic!("expected created");
    };
    assert!(placement.worktree.is_none());
    let started = starts.lock().expect("starts").clone();
    assert_eq!(started.len(), 3);
    assert_ne!(std::fs::canonicalize(&started[2].0).expect("cwd"), root);
    fixture.state.workspace.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn safe_mode_lists_placements_and_refuses_changes() {
    let fixture = Fixture::new("placement-safe", true);
    assert!(matches!(
        run(&fixture, PlacementCommandV1::List {}).await,
        Ok(PlacementResultV1::Placements { .. })
    ));
    let error = run(
        &fixture,
        PlacementCommandV1::PreviewWorktree {
            workspace_id: "any".into(),
            branch: None,
        },
    )
    .await
    .expect_err("safe mode");
    assert_eq!(error.code, "SAFE_MODE");
    let command: PlacementCommandV1 = serde_json::from_value(serde_json::json!({
        "type": "createChat", "workspaceId": "w", "harness": "codex", "permissionMode": "native",
        "worktree": {"type": "new", "branch": "b", "folder": "f", "expectedBase": "c"}
    }))
    .expect("decodes");
    assert!(matches!(command, PlacementCommandV1::CreateChat { .. }));
    assert!(
        serde_json::from_value::<PlacementCommandV1>(
            serde_json::json!({"type": "list", "extra": 1})
        )
        .is_err(),
        "unknown fields are refused"
    );
}

async fn listed(fixture: &Fixture) -> Vec<super::ManagedWorktreeV1> {
    match run(fixture, PlacementCommandV1::Worktrees {})
        .await
        .expect("lists worktrees")
    {
        PlacementResultV1::Worktrees { worktrees, .. } => worktrees,
        other => panic!("unexpected {other:?}"),
    }
}

/// Closes and deletes a chat the way `deleteSession` does; its worktree stays.
async fn delete_chat(fixture: &Fixture, session: &str) {
    workspace(
        fixture,
        WorkspaceCommand::CloseSession {
            session_id: session.into(),
        },
    )
    .await
    .expect("closes");
    fixture
        .state
        .workspace
        .forget_session_for_test(session)
        .expect("deletes the chat");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worktree_left_by_a_deleted_chat_is_listed_and_removed_only_after_confirming_its_changes()
{
    let (fixture, repo, project) = setup("placement-orphan");
    record_starts(&fixture);
    let planned = preview(&fixture, &project, Some("piui/orphan")).await;
    let (session, root) = create_in_worktree(&fixture, &project, &planned).await;

    let worktrees = listed(&fixture).await;
    assert_eq!(worktrees.len(), 1);
    assert_eq!(worktrees[0].sessions, vec![session.clone()]);
    assert_eq!(worktrees[0].branch, "piui/orphan");
    assert_eq!(worktrees[0].state, WorktreeState::Ready);
    let id = worktrees[0].id.clone();
    let remove =
        |discard: bool, expected: Option<String>| PlacementCommandV1::RemoveOrphanWorktree {
            worktree_id: id.clone(),
            discard_changes: discard,
            expected_changes: expected,
        };
    let in_use = run(&fixture, remove(false, None))
        .await
        .expect_err("a chat still works in it");
    assert_eq!(in_use.code, "CONFLICT");

    std::fs::write(root.join("agent-work.txt"), "uncommitted\n").expect("agent writes");
    delete_chat(&fixture, &session).await;
    let orphans = listed(&fixture).await;
    assert_eq!(orphans.len(), 1);
    assert!(orphans[0].sessions.is_empty(), "the chat is gone");

    let PlacementResultV1::WorktreeDirty {
        changes,
        fingerprint,
        files,
        truncated,
        ..
    } = run(&fixture, remove(false, None))
        .await
        .expect("reports the changes")
    else {
        panic!("expected dirty");
    };
    assert_eq!(changes, 1);
    assert!(!truncated);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "agent-work.txt");
    assert_eq!(files[0].area, super::WorktreeChangeArea::Untracked);
    assert!(root.join("agent-work.txt").exists(), "nothing was removed");

    let unconfirmed = run(&fixture, remove(true, None))
        .await
        .expect_err("discarding needs the confirmed changes");
    assert_eq!(unconfirmed.code, "STALE");
    std::fs::write(root.join("later.txt"), "more\n").expect("more changes");
    let stale = run(&fixture, remove(true, Some(fingerprint)))
        .await
        .expect_err("changes differ from the confirmed ones");
    assert_eq!(stale.code, "STALE");
    assert!(root.join("later.txt").exists());

    let PlacementResultV1::WorktreeDirty { fingerprint, .. } = run(&fixture, remove(false, None))
        .await
        .expect("reports the current changes")
    else {
        panic!("expected dirty");
    };
    let removed = run(&fixture, remove(true, Some(fingerprint)))
        .await
        .expect("removes after confirmation");
    assert!(matches!(removed, PlacementResultV1::WorktreeRemoved { .. }));
    assert!(!root.exists(), "an orphan leaves no folder behind");
    assert_eq!(worktree_count(&repo), 1);
    assert_eq!(
        git_output(&repo, &["branch", "--list", "piui/orphan"]),
        "piui/orphan",
        "the branch stays"
    );
    assert!(listed(&fixture).await.is_empty());
    let gone = run(&fixture, remove(false, None))
        .await
        .expect_err("no longer managed");
    assert_eq!(gone.code, "NOT_FOUND");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_clean_or_missing_orphan_is_removed_at_once_and_requests_are_checked() {
    let (fixture, repo, project) = setup("placement-orphan-clean");
    record_starts(&fixture);
    let planned = preview(&fixture, &project, Some("piui/clean")).await;
    let (session, root) = create_in_worktree(&fixture, &project, &planned).await;
    delete_chat(&fixture, &session).await;
    let second = preview(&fixture, &project, Some("piui/missing")).await;
    let (other, other_root) = create_in_worktree(&fixture, &project, &second).await;
    delete_chat(&fixture, &other).await;
    // The folder vanished outside PiUI.
    let other_path = other_root.to_string_lossy().into_owned();
    git(&repo, &["worktree", "remove", "--force", &other_path]);

    let worktrees = listed(&fixture).await;
    assert_eq!(worktrees.len(), 2);
    let missing = worktrees
        .iter()
        .find(|worktree| worktree.branch == "piui/missing")
        .expect("listed");
    assert_eq!(missing.state, WorktreeState::Missing);
    for worktree in &worktrees {
        let result = run(
            &fixture,
            PlacementCommandV1::RemoveOrphanWorktree {
                worktree_id: worktree.id.clone(),
                discard_changes: false,
                expected_changes: None,
            },
        )
        .await
        .expect("removed at once");
        assert!(matches!(result, PlacementResultV1::WorktreeRemoved { .. }));
    }
    assert!(!root.exists());
    assert!(listed(&fixture).await.is_empty());

    let invalid = run(
        &fixture,
        PlacementCommandV1::RemoveOrphanWorktree {
            worktree_id: "../not-an-id".into(),
            discard_changes: false,
            expected_changes: None,
        },
    )
    .await
    .expect_err("invalid id");
    assert_eq!(invalid.code, "INVALID_ARGUMENT");
    assert!(
        serde_json::from_value::<PlacementCommandV1>(serde_json::json!({
            "type": "removeOrphanWorktree", "worktreeId": "a", "discardChanges": false, "path": "x"
        }))
        .is_err(),
        "unknown fields are refused"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn safe_mode_lists_worktrees_but_never_removes_one() {
    let fixture = Fixture::new("placement-orphan-safe", true);
    assert!(listed(&fixture).await.is_empty());
    let error = run(
        &fixture,
        PlacementCommandV1::RemoveOrphanWorktree {
            worktree_id: "0".repeat(32),
            discard_changes: true,
            expected_changes: Some("x".into()),
        },
    )
    .await
    .expect_err("safe mode");
    assert_eq!(error.code, "SAFE_MODE");
}
