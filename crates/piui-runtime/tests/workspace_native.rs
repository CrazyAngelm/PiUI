//! Opt-in live verification of the host-private native workspace supervisor.
//!
//! These tests use the user's native harness authentication and selected
//! default model. They never read, copy, print, or replace native credentials
//! or settings. Run one ignored test by exact name only after explicit consent.

use piui_runtime::workspace_runtime::{
    BlockKind, HarnessKind, NativeBlock, NativeEvent, NativeRuntime, NativeRuntimeConfig,
    NativeRuntimeError, PermissionMode, PromptMode, SessionStatus, TurnOutcome,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
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
        // Codex 0.147.0 does not expose a restrictive built-in tool allowlist.
        // The prompt asks for no tools and the proof rejects any observed use.
        HarnessKind::Codex => (None, None),
    };
    NativeRuntimeConfig {
        harness: kind,
        cwd,
        session_dir,
        native_id: None,
        native_path: None,
        title: Some("PiUI integration verification".into()),
        model: None,
        thinking_level: None,
        instructions: None,
        permission_mode: PermissionMode::Native,
        allowed_tools,
        native_subagents,
        daemon_socket,
        package_root: None,
        agent_dir: None,
        kernel_python: None,
        coordination: false,
    }
}

async fn wait_for_live_turn(events: &mut mpsc::Receiver<NativeEvent>) -> LiveTurn {
    let deadline = Instant::now() + LIVE_OPERATION_TIMEOUT;
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
    let turn = wait_for_live_turn(&mut events).await;
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
