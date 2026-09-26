//! Opt-in live verification of the host-private native workspace supervisor.
//!
//! These tests use the user's native harness authentication and selected
//! default model. They never read, copy, print, or replace native credentials
//! or settings. Run one ignored test by exact name only after explicit consent.

use piui_runtime::workspace_runtime::{
    BlockKind, HarnessKind, NativeBlock, NativeEvent, NativeEventReceiver, NativeRuntime,
    NativeRuntimeConfig, NativeRuntimeError, PermissionMode, PromptMode, SessionStatus,
    TurnOutcome, WorkspaceModel,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::{Instant, timeout_at};

// Reuses the established live Prime proof watchdog from real_rpc. This bounds
// a real provider turn without introducing a product quota.
const LIVE_OPERATION_TIMEOUT: Duration = Duration::from_secs(33);
const MARKER: &str = "PIUI_NATIVE_RUNTIME_OK";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct LiveTurn {
    outcome: TurnOutcome,
    blocks: HashMap<String, NativeBlock>,
    used_tool: bool,
    safe_errors: Vec<String>,
}

fn fresh_native_root(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock supports a unique test root")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "piui-workspace-native-integration-{label}-{}-{stamp}-{}",
        std::process::id(),
        NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn native_config(kind: HarnessKind, label: &str) -> NativeRuntimeConfig {
    let root = fresh_native_root(label);
    let cwd = root.join("cwd");
    let session_dir = root.join("sessions");
    std::fs::create_dir_all(&cwd).expect("creates an isolated trusted test cwd");
    std::fs::create_dir_all(&session_dir).expect("creates isolated native session storage");
    let daemon_socket = if kind == HarnessKind::PrimeAgent {
        #[cfg(windows)]
        {
            Some(format!(
                r"\\.\pipe\piui-workspace-native-{}-{}",
                std::process::id(),
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
            ))
        }
        #[cfg(not(windows))]
        {
            Some(
                root.join(format!(
                    "piui-workspace-native-{}-{}.sock",
                    std::process::id(),
                    NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
                ))
                .to_string_lossy()
                .into_owned(),
            )
        }
    } else {
        None
    };
    let (allowed_tools, native_subagents) = match kind {
        HarnessKind::Pi => (Some(Vec::new()), Some(false)),
        HarnessKind::PrimeAgent => (Some(Vec::new()), Some(false)),
        // `--tools ""` disables every built-in tool; subagents stay off.
        HarnessKind::ClaudeCode => (Some(Vec::new()), Some(false)),
        // Codex 0.147.0 does not expose a restrictive built-in tool allowlist.
        // The prompt asks for no tools and the proof rejects any observed use.
        HarnessKind::Codex | HarnessKind::Hermes => (None, None),
    };
    NativeRuntimeConfig {
        harness: kind,
        cwd,
        session_dir,
        native_id: None,
        native_path: None,
        title: Some("PiUI integration verification".into()),
        model: if kind == HarnessKind::Hermes {
            std::env::var("PIUI_TEST_HERMES_MODEL")
                .ok()
                .map(|id| WorkspaceModel {
                    name: id.clone(),
                    id,
                    provider: None,
                    thinking_levels: None,
                })
        } else {
            None
        },
        thinking_level: None,
        base_instructions: None,
        service_tier: None,
        resource_rules: None,
        instructions: None,
        permission_mode: PermissionMode::Native,
        network_access: false,
        allowed_tools,
        native_subagents,
        daemon_socket,
        package_root: None,
        agent_dir: None,
        kernel_python: None,
        coordination: false,
    }
}

async fn wait_for_live_turn(events: &mut NativeEventReceiver, kind: HarnessKind) -> LiveTurn {
    // Hermes 0.21 run_agent._resolved_api_call_timeout defaults to 1800s.
    // Its provider request must not be cut off by the older Prime-only watchdog.
    let operation_timeout = if kind == HarnessKind::Hermes {
        Duration::from_secs(1800)
    } else {
        LIVE_OPERATION_TIMEOUT
    };
    let deadline = Instant::now() + operation_timeout;
    let mut blocks = HashMap::new();
    let mut outcome = None;
    let mut idle_after_terminal = false;
    let mut used_tool = false;
    let mut safe_errors = Vec::new();
    while !idle_after_terminal {
        let event = timeout_at(deadline, events.recv())
            .await
            .expect("native turn reached the established live-operation watchdog")
            .expect("native event channel remains open through terminal idle");
        match event {
            NativeEvent::Block { block } => {
                used_tool |= block.kind == BlockKind::Tool;
                blocks.insert(block.id.clone(), block);
            }
            NativeEvent::TextDelta { block_id, text } => {
                if let Some(block) = blocks.get_mut(&block_id) {
                    block.text.get_or_insert_with(String::new).push_str(&text);
                }
            }
            NativeEvent::TurnCompleted { outcome: terminal } => {
                assert!(
                    outcome.is_none(),
                    "one admitted turn emits one terminal outcome"
                );
                outcome = Some(terminal);
            }
            NativeEvent::Status {
                status: SessionStatus::Idle,
            } if outcome.is_some() => idle_after_terminal = true,
            NativeEvent::Error { message } => safe_errors.push(message),
            _ => {}
        }
    }
    LiveTurn {
        outcome: outcome.expect("explicit terminal outcome precedes idle"),
        blocks,
        used_tool,
        safe_errors,
    }
}

fn assert_final_assistant(blocks: impl IntoIterator<Item = NativeBlock>) {
    let assistants = blocks
        .into_iter()
        .filter(|block| block.kind == BlockKind::Assistant)
        .collect::<Vec<_>>();
    assert!(
        !assistants.is_empty(),
        "native history contains a final assistant block"
    );
    assert!(
        assistants.iter().any(|block| block
            .text
            .as_deref()
            .is_some_and(|text| text.contains(MARKER))),
        "final assistant block contains the requested marker"
    );
}

async fn verify_live_harness(kind: HarnessKind, label: &str, resume_supported: bool) {
    let config = native_config(kind, label);
    let resume_base = config.clone();
    let (runtime, mut events) = NativeRuntime::spawn(config)
        .await
        .expect("native harness starts through the contained supervisor");
    let initial = runtime
        .snapshot()
        .await
        .expect("native snapshot is available without exposing it");
    assert!(initial.model.is_some(), "native default model is selected");
    assert!(
        !runtime
            .models()
            .await
            .expect("native model catalog is available")
            .is_empty(),
        "native model catalog is nonempty"
    );

    runtime
        .prompt(
            format!("Reply with exactly {MARKER} and do not use tools."),
            PromptMode::Prompt,
        )
        .await
        .expect("native runtime admits the verification turn");
    let turn = wait_for_live_turn(&mut events, kind).await;
    let completed = runtime
        .snapshot()
        .await
        .expect("completed native snapshot is available");
    let native_id = completed.native_id.clone();
    let native_path = completed.native_path.clone();
    runtime
        .dispose()
        .await
        .expect("contained native runtime disposes");
    assert_eq!(
        runtime.snapshot().await,
        Err(NativeRuntimeError::NotRunning),
        "disposed supervisor closes command admission"
    );

    assert_eq!(
        turn.outcome,
        TurnOutcome::Succeeded,
        "native turn did not succeed: {}",
        if turn.safe_errors.is_empty() {
            "no safe runtime error was emitted".into()
        } else {
            turn.safe_errors.join(" | ")
        }
    );
    assert!(!turn.used_tool, "verification turn does not invoke tools");
    assert_final_assistant(
        completed
            .blocks
            .into_iter()
            .chain(turn.blocks.into_values()),
    );

    if resume_supported {
        let mut resume = resume_base;
        resume.native_id = Some(native_id.clone());
        resume.native_path = native_path.map(PathBuf::from);
        let (resumed, _events) = NativeRuntime::spawn(resume)
            .await
            .expect("ordinary native session resumes through a new contained supervisor");
        let reopened = resumed
            .snapshot()
            .await
            .expect("resumed snapshot is available");
        assert_eq!(
            reopened.native_id, native_id,
            "resume keeps native session identity"
        );
        assert_final_assistant(reopened.blocks);
        resumed
            .dispose()
            .await
            .expect("resumed native runtime disposes");
        assert_eq!(
            resumed.snapshot().await,
            Err(NativeRuntimeError::NotRunning),
            "resumed supervisor closes command admission"
        );
    }
}

#[tokio::test]
#[ignore = "run this exact ignored test only; uses native Pi auth/default model"]
async fn live_pi_native_runtime() {
    verify_live_harness(HarnessKind::Pi, "pi", true).await;
}

#[tokio::test]
#[ignore = "run this exact ignored test only; uses native Prime auth/default model"]
async fn live_prime_native_runtime() {
    // Prime's adapter uses the in-process SDK. The unique daemon socket is an
    // inert fail-closed guard and never selects or contacts the shared daemon.
    verify_live_harness(HarnessKind::PrimeAgent, "prime", true).await;
}

#[tokio::test]
#[ignore = "run this exact ignored test only; uses native Codex auth/default model"]
async fn live_codex_native_runtime() {
    // Codex 0.147.0 supports ordinary thread resume. Managed dynamic-tool
    // resume is a separate rejected capability and is not enabled here.
    verify_live_harness(HarnessKind::Codex, "codex", true).await;
}

#[tokio::test]
#[ignore = "explicit live verification; uses native Hermes auth/default model"]
async fn live_hermes_native_runtime() {
    verify_live_harness(HarnessKind::Hermes, "hermes", true).await;
}

#[tokio::test]
#[ignore = "explicit Hermes native MCP verification; uses selected native provider"]
async fn live_hermes_workspace_coordinator() {
    use piui_runtime::workspace_runtime::{CoordinatorOperation, CoordinatorResponse};
    let mut config = native_config(HarnessKind::Hermes, "hermes-managed");
    config.coordination = true;
    let (runtime, mut events) = NativeRuntime::spawn(config)
        .await
        .expect("contained managed Hermes");
    runtime.prompt(format!("Call the piui workspace tool with type roster once, then reply exactly {MARKER}. Do not call other tools."), PromptMode::Prompt).await.expect("prompt accepted");
    let deadline = Instant::now() + Duration::from_secs(1800); // Native Hermes request default.
    let mut called = false;
    let mut blocks = HashMap::new();
    loop {
        let event = timeout_at(deadline, events.recv())
            .await
            .expect("native request deadline")
            .expect("live events");
        match event {
            NativeEvent::CoordinatorRequest {
                request_id,
                operation,
            } => {
                assert_eq!(operation, CoordinatorOperation::Roster);
                called = true;
                runtime
                    .coordinator_response(
                        request_id,
                        CoordinatorResponse::Success(serde_json::json!({"members":[]})),
                    )
                    .await
                    .expect("host coordinator reply");
            }
            NativeEvent::Block { block } => {
                blocks.insert(block.id.clone(), block);
            }
            NativeEvent::TurnCompleted { outcome } => {
                assert_eq!(outcome, TurnOutcome::Succeeded);
                break;
            }
            _ => {}
        }
    }
    runtime.dispose().await.expect("managed process cleanup");
    assert!(called, "real Hermes native MCP invoked host coordinator");
    assert_final_assistant(blocks.into_values());
}

/// Real Claude Code evidence without inference: resolves the installed CLI,
/// verifies `claude --version`, performs only the `initialize` control request
/// (no prompt, no model turn, no transcript) and proves the subscription gate.
/// A signed-out or non-subscription CLI must fail with the typed sign-in
/// status; a Claude subscription login must list native models.
#[tokio::test]
#[ignore = "Runs the installed Claude Code initialize handshake only; no prompt or model turn"]
async fn installed_claude_code_initialize_is_subscription_gated() {
    use piui_runtime::workspace_runtime::{
        BridgeFailureCode, CLAUDE_SIGN_IN_MESSAGE, HarnessAvailability, claude_sign_in_required,
        probe_native_harnesses,
    };
    let summary = probe_native_harnesses()
        .into_iter()
        .find(|summary| summary.kind == HarnessKind::ClaudeCode)
        .expect("Claude Code is part of discovery");
    eprintln!(
        "claude discovery status={:?} version={:?}",
        summary.status, summary.version
    );
    assert_eq!(summary.status, HarnessAvailability::Available);
    let mut config = native_config(HarnessKind::ClaudeCode, "claude-catalog");
    config.allowed_tools = None;
    config.native_subagents = None;
    let started = Instant::now();
    match NativeRuntime::spawn_catalog(config).await {
        Ok((runtime, mut events)) => {
            let drain = tokio::spawn(async move { while events.recv().await.is_some() {} });
            let models = runtime.catalog_models().await.expect("native catalog");
            eprintln!(
                "claude initialize subscription=verified models={} elapsed_ms={}",
                models.len(),
                started.elapsed().as_millis()
            );
            assert!(!models.is_empty());
            assert!(models.iter().all(|model| !model.supports_fast));
            assert!(!claude_sign_in_required());
            runtime.terminate().await.expect("catalog process retired");
            drain.abort();
        }
        Err(error) => {
            eprintln!(
                "claude initialize error={error:?} elapsed_ms={}",
                started.elapsed().as_millis()
            );
            assert_eq!(
                error,
                NativeRuntimeError::Bridge(BridgeFailureCode::SubscriptionRequired)
            );
            assert!(claude_sign_in_required());
            let summary = probe_native_harnesses()
                .into_iter()
                .find(|summary| summary.kind == HarnessKind::ClaudeCode)
                .expect("Claude Code summary");
            assert_eq!(summary.reason.as_deref(), Some(CLAUDE_SIGN_IN_MESSAGE));
        }
    }
}

#[tokio::test]
#[ignore = "Reads installed native catalogs with isolated session storage; no inference"]
async fn installed_four_harness_catalogs() {
    let mut failures = Vec::new();
    for kind in [
        HarnessKind::Pi,
        HarnessKind::Codex,
        HarnessKind::PrimeAgent,
        HarnessKind::Hermes,
    ] {
        let mut config = native_config(kind, "catalog");
        if let Some(cwd) = std::env::var_os("PIUI_TEST_CATALOG_CWD") {
            config.cwd = PathBuf::from(cwd);
        }
        config.allowed_tools = None;
        config.native_subagents = None;
        let started = Instant::now();
        match NativeRuntime::spawn_catalog(config).await {
            Ok((runtime, mut events)) => {
                let drain = tokio::spawn(async move { while events.recv().await.is_some() {} });
                let models = runtime.catalog_models().await;
                let resources = runtime.resources().await;
                eprintln!(
                    "catalog harness={kind:?} models={:?} resources={:?} elapsed_ms={}",
                    models.as_ref().map(Vec::len),
                    resources.as_ref().map(|catalog| catalog.items.len()),
                    started.elapsed().as_millis()
                );
                if !models.as_ref().is_ok_and(|models| !models.is_empty()) || resources.is_err() {
                    failures.push(kind);
                }
                runtime
                    .terminate()
                    .await
                    .expect("catalog process tree retired");
                drain.abort();
            }
            Err(error) => {
                eprintln!(
                    "catalog harness={kind:?} error={error:?} elapsed_ms={}",
                    started.elapsed().as_millis()
                );
                failures.push(kind);
            }
        }
    }
    assert!(failures.is_empty(), "Failed native catalogs: {failures:?}");
}
