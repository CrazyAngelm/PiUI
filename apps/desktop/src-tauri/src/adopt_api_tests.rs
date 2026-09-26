//! Adoption v1: an indexed terminal Pi session becomes a workspace chat
//! without PiUI writing its session file.

use super::{WorkspaceAdoptRequestV1, adopt_at, recently_written};
use crate::session_tools_test_support::{Fixture, block_on};
use crate::workspace_api::{WorkspaceCommand, WorkspaceEventPublisher, dispatch_workspace_command};
use piui_index::{AgentKind, TrustState};
use piui_platform::ProjectDirectory;
use piui_runtime::workspace_runtime::{NativeRuntime, NativeRuntimeConfig};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

const ADAPTER: &str = r#"
    const native = {supported:true,enforcement:'native'};
    const unsupported = {supported:false,enforcement:'unsupported'};
    return {
      snapshot() {
        return {nativeId:'terminal-session',nativePath:config.nativePath,materialized:true,title:config.title ?? 'Pi session',status:'idle',blocks:[],approvals:[],
          capabilities:{prompt:native,resume:native,models:native,approvals:native,instructions:unsupported,toolPolicy:native,nativeSubagents:unsupported},models:[]};
      },
      prompt() { return {accepted:true}; },
      interrupt() { return null; },
      dispose() { return null; },
    };
"#;

/// Working folder, title and session file of every native start.
type Starts = Arc<Mutex<Vec<(PathBuf, Option<String>, Option<PathBuf>)>>>;

struct Terminal {
    fixture: Fixture,
    project: String,
    project_path: PathBuf,
    file: PathBuf,
    index_session: String,
}

fn session_text(project: &Path) -> String {
    format!(
        "{{\"type\":\"session\",\"id\":\"terminal-session\",\"cwd\":{}}}\n{{\"type\":\"message\",\"id\":\"entry\",\"message\":{{\"role\":\"user\",\"content\":\"Fix the flaky scheduler test\"}}}}\n",
        serde_json::to_string(&project.to_string_lossy().to_string()).expect("encodes cwd")
    )
}

fn terminal_session(label: &str, kind: AgentKind) -> Terminal {
    let mut fixture = Fixture::new(label, false);
    let project_path = fixture.root.join("project");
    let sessions = fixture.root.join("sessions");
    std::fs::create_dir_all(&project_path).expect("creates project");
    std::fs::create_dir_all(&sessions).expect("creates session root");
    let file = sessions.join("terminal.jsonl");
    std::fs::write(&file, session_text(&project_path)).expect("writes session");
    fixture.state.session_roots = vec![sessions];
    let directory = ProjectDirectory::resolve(&project_path).expect("resolves project");
    let project = fixture
        .state
        .index
        .lock()
        .expect("locks index")
        .register_project_directory_with_kind(&directory, None, TrustState::Trusted, kind)
        .expect("registers project")
        .id;
    let index_session = if kind == AgentKind::Pi {
        crate::api::refresh_project_sessions_for_tests(&fixture.state, &project).expect("indexes");
        fixture
            .state
            .index
            .lock()
            .expect("locks index")
            .list_sessions(Some(&project))
            .expect("lists")
            .into_iter()
            .next()
            .expect("indexed session")
            .id
    } else {
        "unindexed".into()
    };
    Terminal {
        fixture,
        project,
        project_path,
        file,
        index_session,
    }
}

fn later(file: &Path) -> SystemTime {
    std::fs::metadata(file)
        .and_then(|metadata| metadata.modified())
        .expect("modified")
        + Duration::from_secs(60)
}

fn request(terminal: &Terminal) -> WorkspaceAdoptRequestV1 {
    WorkspaceAdoptRequestV1 {
        project_id: Some(terminal.project.clone()),
        session_id: terminal.index_session.clone(),
    }
}

#[test]
fn adopts_once_resumes_the_same_file_and_never_writes_it() {
    let terminal = terminal_session("adopt", AgentKind::Pi);
    // One runtime for every step: live runtimes belong to the runtime that
    // started them.
    block_on(adopts_once_resumes_the_same_file(&terminal));
}

async fn adopts_once_resumes_the_same_file(terminal: &Terminal) {
    let before = std::fs::read(&terminal.file).expect("reads session");
    let first = adopt_at(
        &terminal.fixture.state,
        request(terminal),
        later(&terminal.file),
    )
    .await
    .expect("adopts");
    assert!(first.created);
    assert_eq!(first.protocol, 1);
    let second = adopt_at(
        &terminal.fixture.state,
        request(terminal),
        later(&terminal.file),
    )
    .await
    .expect("adopts again");
    assert_eq!(second.session_id, first.session_id);
    assert!(!second.created, "one chat per session file");
    assert_eq!(
        std::fs::read(&terminal.file).expect("reads session"),
        before
    );
    let placement = terminal
        .fixture
        .state
        .workspace
        .tools()
        .placement(&first.session_id)
        .expect("reads")
        .expect("placement");
    assert!(placement.adopted);

    let starts: Starts = Arc::default();
    let captured = Arc::clone(&starts);
    terminal
        .fixture
        .state
        .workspace
        .replace_native_spawner(move |config: NativeRuntimeConfig| {
            if let Ok(mut starts) = captured.lock() {
                starts.push((
                    config.cwd.clone(),
                    config.title.clone(),
                    config.native_path.clone(),
                ));
            }
            NativeRuntime::spawn_test_adapter(config, ADAPTER)
        });
    let publisher: WorkspaceEventPublisher = Arc::new(|_| {});
    dispatch_workspace_command(
        &terminal.fixture.state,
        WorkspaceCommand::OpenSession {
            session_id: first.session_id.clone(),
        },
        publisher,
    )
    .await
    .expect("resumes through the ordinary open");
    let started = starts.lock().expect("starts").clone();
    assert_eq!(started.len(), 1);
    let (cwd, title, native_path) = &started[0];
    assert_eq!(
        std::fs::canonicalize(cwd).expect("cwd"),
        std::fs::canonicalize(&terminal.project_path).expect("project")
    );
    assert_eq!(title, &None, "no title that Pi would write into the file");
    assert_eq!(
        native_path
            .as_deref()
            .map(|path| std::fs::canonicalize(path).expect("path")),
        Some(std::fs::canonicalize(&terminal.file).expect("file"))
    );
    let catalog = terminal
        .fixture
        .state
        .workspace
        .session_workspace_id(&first.session_id)
        .expect("registered");
    assert_eq!(catalog, terminal.project);
    assert_eq!(
        std::fs::read(&terminal.file).expect("reads session"),
        before
    );
    terminal.fixture.state.workspace.shutdown_all().await;
}

#[test]
fn a_session_written_moments_ago_is_refused() {
    let terminal = terminal_session("adopt-recent", AgentKind::Pi);
    let modified = std::fs::metadata(&terminal.file)
        .and_then(|metadata| metadata.modified())
        .expect("modified");
    let error = block_on(adopt_at(
        &terminal.fixture.state,
        request(&terminal),
        modified + Duration::from_secs(2),
    ))
    .expect_err("may still be open in the terminal");
    assert_eq!(error.code, "SESSION_ALREADY_ACTIVE");
    assert!(
        terminal
            .fixture
            .state
            .workspace
            .tools()
            .placements()
            .expect("reads")
            .is_empty()
    );
    assert!(recently_written(
        Some(modified),
        modified + Duration::from_secs(9)
    ));
    assert!(!recently_written(
        Some(modified),
        modified + Duration::from_secs(11)
    ));
    assert!(
        recently_written(Some(modified + Duration::from_secs(5)), modified),
        "a future time counts as recent"
    );
}

#[test]
fn refuses_safe_mode_untrusted_prime_and_unknown_sessions() {
    let terminal = terminal_session("adopt-refusals", AgentKind::Pi);
    let now = later(&terminal.file);
    let unknown = block_on(adopt_at(
        &terminal.fixture.state,
        WorkspaceAdoptRequestV1 {
            project_id: Some(terminal.project.clone()),
            session_id: "no-such-session".into(),
        },
        now,
    ))
    .expect_err("unknown");
    assert_eq!(unknown.code, "NOT_FOUND");
    let personal = block_on(adopt_at(
        &terminal.fixture.state,
        WorkspaceAdoptRequestV1 {
            project_id: Some(terminal.fixture.state.personal_workspace.project_id.clone()),
            session_id: terminal.index_session.clone(),
        },
        now,
    ))
    .expect_err("personal chats are addressed without a project id");
    assert_eq!(personal.code, "INVALID_ARGUMENT");
    terminal
        .fixture
        .set_trust(&terminal.project, TrustState::Restricted);
    let untrusted = block_on(adopt_at(&terminal.fixture.state, request(&terminal), now))
        .expect_err("untrusted");
    assert_eq!(untrusted.code, "NOT_TRUSTED");

    let prime = terminal_session("adopt-prime", AgentKind::PrimeAgent);
    let refused = block_on(adopt_at(
        &prime.fixture.state,
        request(&prime),
        later(&prime.file),
    ))
    .expect_err("Prime Agent folders are refused");
    assert_eq!(refused.code, "NOT_SUPPORTED");

    let data = terminal.fixture.root.join("data");
    let safe = crate::state::HostState::open(&data, true).expect("safe mode");
    let refused = block_on(adopt_at(&safe, request(&terminal), now)).expect_err("safe mode");
    assert_eq!(refused.code, "SAFE_MODE");
    let decoded: Result<WorkspaceAdoptRequestV1, _> =
        serde_json::from_value(serde_json::json!({"sessionId": "s", "extra": true}));
    assert!(decoded.is_err(), "unknown fields are refused");
}
