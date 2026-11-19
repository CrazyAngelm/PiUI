//! Placement v1: worktree chats, removal, trust and handoff links, with real
//! git and the production bridge runner around a test adapter. Every test
//! runs on one tokio runtime: live runtimes belong to the runtime that
//! started them.

use super::{
    ChatBranchV1, PlacementCommandV1, PlacementResultV1, WorktreeRequestV1, WorktreeState,
    dispatch_placement,
};
use crate::session_links::model::{BranchMode, BranchOrigin};
use crate::session_tools_test_support::{
    Fixture, git, git_output, init_repository, outside_any_repository,
};
use crate::workspace_api::{
    HarnessKind, PermissionMode, WorkspaceCommand, WorkspaceError, WorkspaceEventPublisher,
    WorkspaceModel, WorkspaceResult, dispatch_workspace_command,
};
use piui_index::TrustState;
use piui_runtime::workspace_runtime::{NativeRuntime, NativeRuntimeConfig, NativeRuntimeError};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

type HookFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Default)]
struct BranchHooks {
    origins: Mutex<HashMap<String, BranchOrigin>>,
    adopted: Mutex<Vec<(String, String)>>,
    refuse_record: AtomicBool,
}

impl crate::workspace_api::SessionLinksHooks for BranchHooks {
    fn enabled(&self) -> bool {
        false
    }
    fn handle(
        &self,
        _: String,
        _: serde_json::Map<String, serde_json::Value>,
    ) -> HookFuture<serde_json::Value> {
        Box::pin(async { serde_json::json!({"ok":false}) })
    }
    fn person_message(&self, _: String) -> HookFuture<()> {
        Box::pin(async {})
    }
    fn session_deleted(&self, _: String) -> HookFuture<()> {
        Box::pin(async {})
    }
    fn record_branch(&self, child: &str, origin: BranchOrigin) -> bool {
        if self.refuse_record.load(Ordering::Relaxed) {
            return false;
        }
        self.origins
            .lock()
            .expect("origins")
            .insert(child.into(), origin);
        true
    }
    fn forget_branch(&self, child: &str) {
        self.origins.lock().expect("origins").remove(child);
    }
    fn branch_origin(&self, child: &str) -> Option<BranchOrigin> {
        self.origins.lock().expect("origins").get(child).cloned()
    }
    fn adopt_branch(&self, parent: String, child: String) -> HookFuture<()> {
        self.adopted.lock().expect("adopted").push((parent, child));
        Box::pin(async {})
    }
}

fn branch_hooks(fixture: &Fixture) -> Arc<BranchHooks> {
    let hooks = Arc::new(BranchHooks::default());
    fixture
        .state
        .workspace
        .set_session_links_hooks(hooks.clone());
    hooks
}

fn branch_command(
    project: &str,
    source: &str,
    harness: HarnessKind,
    branch: ChatBranchV1,
) -> PlacementCommandV1 {
    PlacementCommandV1::CreateChat {
        workspace_id: project.into(),
        harness,
        permission_mode: PermissionMode::Native,
        title: Some("Branch".into()),
        model: None,
        worktree: None,
        continued_from: Some(source.into()),
        branch: Some(branch),
    }
}

fn native_source(fixture: &Fixture, project: &str) -> String {
    let source = fixture.chat(project);
    fixture
        .state
        .workspace
        .configure_branch_source_for_test(
            &source,
            HarnessKind::Codex,
            Some(uuid::Uuid::new_v4().to_string()),
            None,
            false,
        )
        .expect("native source metadata");
    source
}

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

fn record_branch_launches(fixture: &Fixture) -> Arc<Mutex<Vec<NativeRuntimeConfig>>> {
    let starts = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&starts);
    fixture
        .state
        .workspace
        .replace_native_spawner(move |config: NativeRuntimeConfig| {
            captured.lock().expect("launches").push(config.clone());
            NativeRuntime::spawn_test_adapter(config, ADAPTER)
        });
    starts
}

fn branch_model(provider: &str, id: &str) -> WorkspaceModel {
    WorkspaceModel {
        id: id.into(),
        provider: Some(provider.into()),
        name: id.into(),
        thinking_levels: None,
    }
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
        branch: None,
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
            Err(NativeRuntimeError::Spawn)
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
            branch: None,
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
            branch: None,
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
            branch: None,
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

#[test]
fn branch_contract_shapes_are_strict_and_match_the_placement_contract() {
    let contract = include_str!("../../../../contracts/workspace-placement-v1.ts");
    for shape in [
        "{ mode: 'native'; at: 'end' }",
        "{ mode: 'native'; at: 'before'; blockId: string }",
        "{ mode: 'linked' }",
    ] {
        assert!(contract.contains(shape), "contract shape {shape}");
    }
    for (value, expected) in [
        (
            serde_json::json!({"mode":"native","at":"end"}),
            ChatBranchV1::Native {
                before_block_id: None,
            },
        ),
        (
            serde_json::json!({"mode":"native","at":"before","blockId":"prompt"}),
            ChatBranchV1::Native {
                before_block_id: Some("prompt".into()),
            },
        ),
        (serde_json::json!({"mode":"linked"}), ChatBranchV1::Linked),
    ] {
        assert_eq!(
            serde_json::from_value::<ChatBranchV1>(value.clone()).expect("branch"),
            expected
        );
        let command = serde_json::json!({"type":"createChat","workspaceId":"w","harness":"codex","permissionMode":"native","continuedFrom":"source","branch":value});
        assert!(serde_json::from_value::<PlacementCommandV1>(command).is_ok());
    }
    for value in [
        serde_json::json!({"mode":"other"}),
        serde_json::json!({"mode":"native"}),
        serde_json::json!({"mode":"native","at":"other"}),
        serde_json::json!({"mode":"native","at":"end","blockId":"prompt"}),
        serde_json::json!({"mode":"native","at":"before"}),
        serde_json::json!({"mode":"linked","at":"end"}),
        serde_json::json!({"mode":"linked","blockId":"prompt"}),
        serde_json::json!({"mode":"linked","extra":true}),
        serde_json::json!({"mode":"linked","at":null}),
    ] {
        assert!(serde_json::from_value::<ChatBranchV1>(value).is_err());
    }
    let placement = super::ChatPlacementV1 {
        session_id: "child".into(),
        worktree: None,
        continued_from: Some("source".into()),
        branch: Some(BranchMode::Native),
        adopted: false,
    };
    let wire: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&placement).expect("placement wire"))
            .expect("parses placement");
    assert_eq!(
        wire,
        serde_json::json!({"sessionId":"child","continuedFrom":"source","branch":"native"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_native_validation_refuses_before_any_start_or_origin_is_created() {
    let (fixture, _, project) = setup("branch-refusals");
    let source = native_source(&fixture, &project);
    let starts = record_starts(&fixture);
    let hooks = branch_hooks(&fixture);
    let valid_id = uuid::Uuid::new_v4().to_string();
    for (source_harness, requested, native_id, run_id, nano_connector) in [
        (
            HarnessKind::Codex,
            HarnessKind::ClaudeCode,
            Some(valid_id.clone()),
            None,
            false,
        ),
        (
            HarnessKind::PrimeAgent,
            HarnessKind::PrimeAgent,
            Some(valid_id.clone()),
            None,
            false,
        ),
        (
            HarnessKind::Codex,
            HarnessKind::Codex,
            Some(valid_id.clone()),
            Some("run".into()),
            false,
        ),
        (HarnessKind::Codex, HarnessKind::Codex, None, None, false),
        (
            HarnessKind::Codex,
            HarnessKind::Codex,
            Some(valid_id.clone()),
            None,
            true,
        ),
    ] {
        fixture
            .state
            .workspace
            .configure_branch_source_for_test(
                &source,
                source_harness,
                native_id,
                run_id,
                nano_connector,
            )
            .expect("source case");
        let error = run(
            &fixture,
            branch_command(
                &project,
                &source,
                requested,
                ChatBranchV1::Native {
                    before_block_id: None,
                },
            ),
        )
        .await
        .expect_err("native branch refused");
        assert_eq!(error.code, "BRANCH_UNSUPPORTED");
        assert_eq!(error.message, "This chat cannot be branched natively.");
    }
    fixture
        .state
        .workspace
        .configure_branch_source_for_test(&source, HarnessKind::Codex, Some(valid_id), None, false)
        .expect("restore source");
    for cut in ["".to_owned(), "x".repeat(257), "prompt\n".into()] {
        let error = run(
            &fixture,
            branch_command(
                &project,
                &source,
                HarnessKind::Codex,
                ChatBranchV1::Native {
                    before_block_id: Some(cut),
                },
            ),
        )
        .await
        .expect_err("invalid cut");
        assert_eq!(error.code, "INVALID_ARGUMENT");
    }
    let mut missing = branch_command(&project, &source, HarnessKind::Codex, ChatBranchV1::Linked);
    if let PlacementCommandV1::CreateChat {
        continued_from,
        worktree,
        ..
    } = &mut missing
    {
        *continued_from = None;
        *worktree = Some(WorktreeRequestV1::Shared {
            session_id: source.clone(),
        });
    }
    assert_eq!(
        run(&fixture, missing)
            .await
            .expect_err("branch needs a source")
            .code,
        "INVALID_ARGUMENT"
    );
    let mut placed = branch_command(
        &project,
        &source,
        HarnessKind::Codex,
        ChatBranchV1::Native {
            before_block_id: None,
        },
    );
    if let PlacementCommandV1::CreateChat { worktree, .. } = &mut placed {
        *worktree = Some(WorktreeRequestV1::Shared {
            session_id: source.clone(),
        });
    }
    assert_eq!(
        run(&fixture, placed)
            .await
            .expect_err("native placement is inherited")
            .code,
        "INVALID_ARGUMENT"
    );
    hooks.refuse_record.store(true, Ordering::Relaxed);
    assert_eq!(
        run(
            &fixture,
            branch_command(
                &project,
                &source,
                HarnessKind::Codex,
                ChatBranchV1::Native {
                    before_block_id: None
                }
            )
        )
        .await
        .expect_err("origin save failed")
        .code,
        "BRANCH_UNSUPPORTED"
    );
    assert!(starts.lock().expect("starts").is_empty());
    assert!(hooks.origins.lock().expect("origins").is_empty());
    assert!(
        fixture
            .state
            .workspace
            .tools()
            .placements()
            .expect("placements")
            .iter()
            .all(|placement| placement.session_id == source)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_native_on_pi_needs_the_session_file_of_its_source() {
    let (fixture, _, project) = setup("branch-pi");
    let starts = record_starts(&fixture);
    let source = fixture.chat(&project);
    fixture
        .state
        .workspace
        .configure_branch_source_for_test(
            &source,
            HarnessKind::Pi,
            Some(uuid::Uuid::new_v4().to_string()),
            None,
            false,
        )
        .expect("pi source");
    let hooks = branch_hooks(&fixture);
    let native = |before_block_id: Option<String>| ChatBranchV1::Native { before_block_id };
    // Pi names its session by file: without one there is nothing to copy, and
    // the interface falls back to a linked branch.
    let error = run(
        &fixture,
        branch_command(&project, &source, HarnessKind::Pi, native(None)),
    )
    .await
    .expect_err("no session file");
    assert_eq!(error.code, "BRANCH_UNSUPPORTED");
    assert!(starts.lock().expect("starts").is_empty());
    assert!(hooks.origins.lock().expect("origins").is_empty());
    fixture
        .state
        .workspace
        .configure_native_path_for_test(&source, &std::env::temp_dir().join("piui-pi-source.jsonl"))
        .expect("session file");
    for before in [None, Some("pi-entry-cut".to_owned())] {
        let PlacementResultV1::Created {
            snapshot,
            placement,
            ..
        } = run(
            &fixture,
            branch_command(&project, &source, HarnessKind::Pi, native(before)),
        )
        .await
        .expect("a Pi branch with its source file")
        else {
            panic!("created");
        };
        assert_eq!(placement.branch, Some(BranchMode::Native));
        assert_eq!(
            hooks.origins.lock().expect("origins")[&snapshot.session.id].mode,
            BranchMode::Native
        );
    }
    // A Pi source cannot seed another agent's native fork, and Nano keeps linked branches.
    for requested in [HarnessKind::Codex, HarnessKind::Nano] {
        let error = run(
            &fixture,
            branch_command(&project, &source, requested, native(None)),
        )
        .await
        .expect_err("a native branch stays on its own agent");
        assert_eq!(error.code, "BRANCH_UNSUPPORTED");
    }
    fixture.state.workspace.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_creation_records_and_lists_both_modes_even_with_the_tool_preference_off() {
    let (fixture, _, project) = setup("branch-create");
    record_starts(&fixture);
    let source = native_source(&fixture, &project);
    let hooks = branch_hooks(&fixture);
    let mut children = Vec::new();
    for (harness, branch, mode) in [
        (
            HarnessKind::Codex,
            ChatBranchV1::Native {
                before_block_id: None,
            },
            BranchMode::Native,
        ),
        (
            HarnessKind::Codex,
            ChatBranchV1::Native {
                before_block_id: Some("prompt".into()),
            },
            BranchMode::Native,
        ),
        (HarnessKind::Pi, ChatBranchV1::Linked, BranchMode::Linked),
    ] {
        let PlacementResultV1::Created {
            snapshot,
            placement,
            ..
        } = run(&fixture, branch_command(&project, &source, harness, branch))
            .await
            .expect("creates branch")
        else {
            panic!("created");
        };
        assert_eq!(placement.branch, Some(mode));
        assert_eq!(placement.continued_from.as_deref(), Some(source.as_str()));
        assert_eq!(
            hooks.origins.lock().expect("origins")[&snapshot.session.id].mode,
            mode
        );
        children.push(snapshot.session.id.clone());
    }
    let PlacementResultV1::Placements { placements, .. } =
        run(&fixture, PlacementCommandV1::List {})
            .await
            .expect("list")
    else {
        panic!("list");
    };
    assert!(
        placements
            .iter()
            .filter(|placement| children.contains(&placement.session_id))
            .all(|placement| placement.branch.is_some())
    );
    assert!(
        placements
            .iter()
            .find(|placement| placement.session_id == source)
            .expect("ordinary placement")
            .branch
            .is_none()
    );
    assert_eq!(hooks.adopted.lock().expect("adopted").len(), 3);
    fixture.state.workspace.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_missing_hooks_only_refuse_native_and_safe_mode_refuses_both() {
    let (fixture, _, project) = setup("branch-no-hooks");
    record_starts(&fixture);
    let source = native_source(&fixture, &project);
    assert_eq!(
        run(
            &fixture,
            branch_command(
                &project,
                &source,
                HarnessKind::Codex,
                ChatBranchV1::Native {
                    before_block_id: None
                }
            )
        )
        .await
        .expect_err("native needs durable origin")
        .code,
        "BRANCH_UNSUPPORTED"
    );
    let PlacementResultV1::Created { placement, .. } = run(
        &fixture,
        branch_command(&project, &source, HarnessKind::Pi, ChatBranchV1::Linked),
    )
    .await
    .expect("linked is best effort") else {
        panic!("created");
    };
    assert!(placement.branch.is_none());
    fixture.state.workspace.shutdown_all().await;
    let safe = Fixture::new("branch-safe", true);
    for branch in [
        ChatBranchV1::Linked,
        ChatBranchV1::Native {
            before_block_id: None,
        },
    ] {
        assert_eq!(
            run(
                &safe,
                branch_command("project", "source", HarnessKind::Codex, branch)
            )
            .await
            .expect_err("safe mode")
            .code,
            "SAFE_MODE"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_bridge_refusal_removes_the_new_record_placement_origin_and_empty_runtime_folder() {
    use piui_runtime::workspace_runtime::BridgeFailureCode;
    let (fixture, _, project) = setup("branch-failed");
    let source = native_source(&fixture, &project);
    let hooks = branch_hooks(&fixture);
    let child = Arc::new(Mutex::new(None));
    for (failure, expected) in [
        (BridgeFailureCode::BranchUnsupported, "BRANCH_UNSUPPORTED"),
        (
            BridgeFailureCode::BranchPointNotFound,
            "BRANCH_POINT_NOT_FOUND",
        ),
    ] {
        let capture = child.clone();
        fixture
            .state
            .workspace
            .replace_native_spawner(move |config: NativeRuntimeConfig| {
                *capture.lock().expect("child") = config
                    .session_dir
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned());
                async move { Err(NativeRuntimeError::Bridge(failure)) }
            });
        assert_eq!(
            run(
                &fixture,
                branch_command(
                    &project,
                    &source,
                    HarnessKind::Codex,
                    ChatBranchV1::Native {
                        before_block_id: Some("prompt".into())
                    }
                )
            )
            .await
            .expect_err("native refused")
            .code,
            expected
        );
        let id = child
            .lock()
            .expect("child")
            .clone()
            .expect("attempted child");
        assert!(!fixture.state.workspace.session_exists(&id));
        assert!(
            fixture
                .state
                .workspace
                .tools()
                .placement(&id)
                .expect("placement")
                .is_none()
        );
        assert!(!hooks.origins.lock().expect("origins").contains_key(&id));
        assert!(
            !fixture
                .root
                .join("data/workspace-native-v11")
                .join(&id)
                .exists()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_native_inherits_the_sources_verified_worktree() {
    let (fixture, _, project) = setup("branch-worktree");
    let starts = record_starts(&fixture);
    let planned = preview(&fixture, &project, Some("piui/source")).await;
    let (source, root) = create_in_worktree(&fixture, &project, &planned).await;
    fixture
        .state
        .workspace
        .configure_branch_source_for_test(
            &source,
            HarnessKind::Codex,
            Some(uuid::Uuid::new_v4().to_string()),
            None,
            false,
        )
        .expect("source harness");
    branch_hooks(&fixture);
    let PlacementResultV1::Created {
        snapshot,
        placement,
        ..
    } = run(
        &fixture,
        branch_command(
            &project,
            &source,
            HarnessKind::Codex,
            ChatBranchV1::Native {
                before_block_id: None,
            },
        ),
    )
    .await
    .expect("branch in worktree")
    else {
        panic!("created");
    };
    assert_eq!(placement.branch, Some(BranchMode::Native));
    assert_eq!(
        fixture
            .state
            .workspace
            .worktree_binding(&snapshot.session.id)
            .expect("binding")
            .expect("worktree")
            .root,
        root
    );
    assert_eq!(
        std::fs::canonicalize(&starts.lock().expect("starts")[1].0).expect("cwd"),
        root
    );
    fixture.state.workspace.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_native_inherits_source_permission_model_and_thinking_before_validation() {
    let (fixture, _, project) = setup("branch-native-settings");
    let source = native_source(&fixture, &project);
    let source_model = branch_model("openai", "source-model");
    fixture
        .state
        .workspace
        .configure_branch_settings_for_test(
            &source,
            PermissionMode::FullAccess,
            Some(source_model.clone()),
            Some("high".into()),
        )
        .expect("source settings");
    branch_hooks(&fixture);
    let starts = record_branch_launches(&fixture);
    let mut request = branch_command(
        &project,
        &source,
        HarnessKind::Codex,
        ChatBranchV1::Native {
            before_block_id: None,
        },
    );
    if let PlacementCommandV1::CreateChat {
        permission_mode,
        model,
        ..
    } = &mut request
    {
        *permission_mode = PermissionMode::ReadOnly;
        // This would select a different model source if it reached validation.
        *model = Some(branch_model("nano", "auto"));
    }
    run(&fixture, request)
        .await
        .expect("source settings are inherited");
    {
        let launches = starts.lock().expect("launches");
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].permission_mode, PermissionMode::FullAccess);
        assert_eq!(
            serde_json::to_value(&launches[0].model).expect("model"),
            serde_json::to_value(Some(source_model)).expect("source model")
        );
        assert_eq!(launches[0].thinking_level.as_deref(), Some("high"));
    }
    fixture.state.workspace.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_linked_same_harness_inherits_permission_and_uses_requested_or_source_model() {
    let (fixture, _, project) = setup("branch-linked-settings");
    let source = native_source(&fixture, &project);
    let source_model = branch_model("openai", "source-model");
    fixture
        .state
        .workspace
        .configure_branch_settings_for_test(
            &source,
            PermissionMode::FullAccess,
            Some(source_model.clone()),
            Some("high".into()),
        )
        .expect("source settings");
    branch_hooks(&fixture);
    let starts = record_branch_launches(&fixture);
    let requested_model = branch_model("openai", "requested-model");
    for model in [Some(requested_model.clone()), None] {
        let mut request =
            branch_command(&project, &source, HarnessKind::Codex, ChatBranchV1::Linked);
        if let PlacementCommandV1::CreateChat {
            permission_mode,
            model: requested,
            ..
        } = &mut request
        {
            *permission_mode = PermissionMode::ReadOnly;
            *requested = model;
        }
        run(&fixture, request).await.expect("linked branch");
    }
    {
        let launches = starts.lock().expect("launches");
        assert_eq!(launches.len(), 2);
        for (launch, expected) in launches.iter().zip([requested_model, source_model]) {
            assert_eq!(launch.permission_mode, PermissionMode::FullAccess);
            assert_eq!(
                serde_json::to_value(&launch.model).expect("model"),
                serde_json::to_value(Some(expected)).expect("expected model")
            );
            assert!(launch.thinking_level.is_none());
        }
    }
    fixture.state.workspace.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_linked_different_harness_keeps_requested_permission_and_model() {
    let (fixture, _, project) = setup("branch-other-harness-settings");
    let source = native_source(&fixture, &project);
    fixture
        .state
        .workspace
        .configure_branch_settings_for_test(
            &source,
            PermissionMode::FullAccess,
            Some(branch_model("openai", "source-model")),
            Some("high".into()),
        )
        .expect("source settings");
    branch_hooks(&fixture);
    let starts = record_branch_launches(&fixture);
    let requested_model = branch_model("openai", "requested-model");
    let mut request = branch_command(&project, &source, HarnessKind::Pi, ChatBranchV1::Linked);
    if let PlacementCommandV1::CreateChat {
        permission_mode,
        model,
        ..
    } = &mut request
    {
        *permission_mode = PermissionMode::ReadOnly;
        *model = Some(requested_model.clone());
    }
    run(&fixture, request)
        .await
        .expect("linked branch on another harness");
    {
        let launches = starts.lock().expect("launches");
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].harness, HarnessKind::Pi);
        assert_eq!(launches[0].permission_mode, PermissionMode::ReadOnly);
        assert_eq!(
            serde_json::to_value(&launches[0].model).expect("model"),
            serde_json::to_value(Some(requested_model)).expect("request model")
        );
        assert!(launches[0].thinking_level.is_none());
    }
    fixture.state.workspace.shutdown_all().await;
}
