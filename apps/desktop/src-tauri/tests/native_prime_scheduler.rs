//! Opt-in managed-native Prime scheduler integration.
//!
//! Tauri MockRuntime supplies only state/event plumbing. The workspace host,
//! scheduler, Prime Agent runtime, provider, containment, and transcripts are real.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires installed prime-agent 0.9.2 and a configured default provider"]
async fn native_prime_scheduler_runs_two_step_dependency_dag() {
    piui_desktop_lib::run_native_prime_scheduler_two_step_dependency_dag().await;
}
