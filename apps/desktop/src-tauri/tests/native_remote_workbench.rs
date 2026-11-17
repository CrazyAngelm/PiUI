//! Runs an isolated native host and the repository's synthetic OAuth issuer and relay.
#[cfg(all(windows, debug_assertions))]
#[test]
#[ignore = "requires Windows and Node 22"]
fn remote_native_relay_checks_workbench_authority() {
    // Wry owns process-lifetime native references. Cleaning the temporary
    // SQLite directory after process exit releases its Windows sharing locks.
    const CHILD_ROOT: &str = "PIUI_NATIVE_REMOTE_TEST_CHILD_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        piui_desktop_lib::run_native_remote_workbench_proof(std::path::Path::new(&root));
        return;
    }
    let root = std::env::temp_dir().join(format!("piui-native-relay-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "remote_native_relay_checks_workbench_authority",
            "--ignored",
            "--nocapture",
        ])
        .env(CHILD_ROOT, &root)
        .status();
    std::fs::remove_dir_all(root).unwrap();
    assert!(result.unwrap().success());
}
