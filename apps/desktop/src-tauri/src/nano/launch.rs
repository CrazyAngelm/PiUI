//! Launch data of one Nano session (ADR-048): the private Pi agent
//! directory, the approval guard and a per-session relay key.
//!
//! **Shared agent directory.** All Nano sessions of this app share one agent
//! directory, `<app data>/nano/pi-agent`, whose `models.json` points at the
//! shared relay URL (`http://127.0.0.1:<port>/v1`). A per-session directory
//! would add nothing: the relay accepts a session key on `/v1` exactly as on
//! its per-session path, the key reaches Pi only through the child
//! environment, and the directory holds configuration only (no credential).
//! One directory means no per-session creation or cleanup, and the files are
//! rewritten only when their content changes (a different relay port after a
//! restart, other entitled modes, a new guard), so a running Pi never has its
//! `models.json` replaced under it for no reason.
//!
//! **Relay session lifetime.** The relay is started lazily by the first Nano
//! launch. Each launch registers one [`RelaySession`], wrapped in a
//! [`NanoLease`]. `spawn_native` attaches the lease to the started
//! `NativeRuntime`, which drops it with the runtime (after the process tree
//! was terminated); a start that fails, times out or is cancelled drops the
//! lease with the future. Every stop, close and retire path therefore releases
//! the key without tracking it.
//!
//! **Account generation.** A launch captures the account generation together
//! with the status it is gated on and registers its relay session for that
//! generation only (an atomic check under the relay's key lock). A sign-out,
//! expiry or new sign-in while the launch was preparing the relay or the
//! agent directory therefore fails it with `NanoNotReady` (sign-in required)
//! instead of registering a key for an account that is gone; a session
//! registered just before such a change is retired by the relay itself.

use piui_nano::NanoError;
use piui_nano::agent_dir::{GUARD_DIR, GUARD_FILE};
use piui_nano::status::{NanoAccountStateV1, NanoAccountStatusV1};
use piui_nano::wire::{NanoEntitlementsV1, NanoModeV1};
use piui_nano::{Relay, RelaySession, prepare_pi_agent_dir};
use piui_runtime::nano::{NANO_GUARD_EXTENSION_SOURCE, NanoRelayKey, NanoRuntimeLaunch};
use piui_runtime::workspace_runtime::{NativeRuntimeError, PermissionMode};
use sha2::{Digest, Sha256};

use super::NanoHost;

/// Keeps a relay session registered. Dropping it retires the session key.
pub(crate) struct NanoLease {
    _session: RelaySession,
}

impl std::fmt::Debug for NanoLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NanoLease")
    }
}

/// The entitlements of an account that may start a Nano session now: signed
/// in, a selected workspace, the gateway offered by the server, the local
/// agent in the plan and at least one available mode.
pub(crate) fn launch_gate(status: &NanoAccountStatusV1) -> Option<&NanoEntitlementsV1> {
    if status.state != NanoAccountStateV1::SignedIn
        || status.selected_workspace_id.is_none()
        || !status
            .capabilities
            .is_some_and(|capabilities| capabilities.gateway)
    {
        return None;
    }
    let entitlements = status.entitlements.as_ref()?;
    (entitlements.features.local_agent && entitlements.modes.iter().any(|mode| mode.available))
        .then_some(entitlements)
}

/// A hash of everything the agent directory's files are written from.
fn fingerprint(relay_base_url: &str, modes: &[NanoModeV1]) -> String {
    let available: Vec<&NanoModeV1> = modes.iter().filter(|mode| mode.available).collect();
    let mut hasher = Sha256::new();
    hasher.update(relay_base_url.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(&available).unwrap_or_default());
    hasher.update([0]);
    hasher.update(NANO_GUARD_EXTENSION_SOURCE.as_bytes());
    format!("{:x}", hasher.finalize())
}

impl NanoHost {
    /// Builds the launch data of one Nano session.
    ///
    /// # Errors
    /// [`NativeRuntimeError::NanoNotReady`] when safe mode is on, the
    /// account cannot start a Nano session, or its generation ended while
    /// the launch was being prepared (nothing was registered);
    /// [`NativeRuntimeError::Spawn`] when the relay or the agent directory
    /// cannot be set up.
    pub(crate) async fn launch(
        &self,
        permission_mode: PermissionMode,
    ) -> Result<(NanoRuntimeLaunch, NanoLease), NativeRuntimeError> {
        if self.safe_mode {
            return Err(NativeRuntimeError::NanoNotReady);
        }
        let account = self
            .account
            .as_ref()
            .map_err(|_| NativeRuntimeError::NanoNotReady)?;
        let (generation, status) = account.status_with_generation();
        let modes = launch_gate(&status)
            .ok_or(NativeRuntimeError::NanoNotReady)?
            .modes
            .clone();
        let relay = self
            .relay
            .get_or_try_init(|| Relay::start(account.clone()))
            .await
            .map_err(|_| NativeRuntimeError::Spawn)?;
        let base_url = relay.base_url();
        self.write_agent_dir(&base_url, modes).await?;
        let session = relay
            .register_session(generation)
            .map_err(|error| match error {
                NanoError::SignInRequired => NativeRuntimeError::NanoNotReady,
                _ => NativeRuntimeError::Spawn,
            })?;
        let relay_key = NanoRelayKey::new(session.key().expose());
        let guard_extension = (permission_mode != PermissionMode::FullAccess)
            .then(|| self.agent_dir.join(GUARD_DIR).join(GUARD_FILE));
        Ok((
            NanoRuntimeLaunch {
                agent_dir: self.agent_dir.clone(),
                guard_extension,
                relay_key,
            },
            NanoLease { _session: session },
        ))
    }

    /// Writes `models.json`, `settings.json` and the guard when their content
    /// changed or a file is missing. Serialized, so two launches never write
    /// the same files at once.
    async fn write_agent_dir(
        &self,
        relay_base_url: &str,
        modes: Vec<NanoModeV1>,
    ) -> Result<(), NativeRuntimeError> {
        let wanted = fingerprint(relay_base_url, &modes);
        let mut written = self.prepared.lock().await;
        let present = self.agent_dir.join("models.json").is_file()
            && self.agent_dir.join(GUARD_DIR).join(GUARD_FILE).is_file();
        if present && written.as_deref() == Some(wanted.as_str()) {
            return Ok(());
        }
        let directory = self.agent_dir.clone();
        let url = relay_base_url.to_owned();
        tokio::task::spawn_blocking(move || {
            prepare_pi_agent_dir(&directory, &url, &modes, NANO_GUARD_EXTENSION_SOURCE)
        })
        .await
        .map_err(|_| NativeRuntimeError::Spawn)?
        .map_err(|_| NativeRuntimeError::Spawn)?;
        *written = Some(wanted);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nano::tests::fixture_status;

    #[test]
    fn the_gate_needs_every_condition() {
        let signed_in = fixture_status("signedIn");
        assert!(launch_gate(&signed_in).is_some());

        assert!(launch_gate(&fixture_status("signedOut")).is_none());
        assert!(launch_gate(&fixture_status("signingIn")).is_none());
        assert!(launch_gate(&fixture_status("expired")).is_none());

        let mut no_workspace = signed_in.clone();
        no_workspace.selected_workspace_id = None;
        assert!(launch_gate(&no_workspace).is_none());

        let mut no_gateway = signed_in.clone();
        if let Some(capabilities) = no_gateway.capabilities.as_mut() {
            capabilities.gateway = false;
        }
        assert!(launch_gate(&no_gateway).is_none());

        let mut no_capabilities = signed_in.clone();
        no_capabilities.capabilities = None;
        assert!(launch_gate(&no_capabilities).is_none());

        let mut no_local_agent = signed_in.clone();
        if let Some(entitlements) = no_local_agent.entitlements.as_mut() {
            entitlements.features.local_agent = false;
        }
        assert!(launch_gate(&no_local_agent).is_none());

        let mut no_mode = signed_in.clone();
        if let Some(entitlements) = no_mode.entitlements.as_mut() {
            for mode in &mut entitlements.modes {
                mode.available = false;
            }
        }
        assert!(launch_gate(&no_mode).is_none());

        let mut loading = signed_in;
        loading.entitlements = None;
        assert!(launch_gate(&loading).is_none());
    }

    #[test]
    fn the_fingerprint_follows_the_written_content_only() {
        let status = fixture_status("signedIn");
        let modes = status.entitlements.expect("entitlements").modes;
        let base = fingerprint("http://127.0.0.1:4000/v1", &modes);
        assert_eq!(base, fingerprint("http://127.0.0.1:4000/v1", &modes));
        assert_ne!(base, fingerprint("http://127.0.0.1:4001/v1", &modes));

        // A locked mode is not written, so its hint changing is no change.
        let mut other_hint = modes.clone();
        for mode in &mut other_hint {
            if !mode.available {
                mode.cost_hint = Some("changed".to_owned());
            }
        }
        assert_eq!(base, fingerprint("http://127.0.0.1:4000/v1", &other_hint));

        let mut fewer = modes;
        fewer[0].available = false;
        assert_ne!(base, fingerprint("http://127.0.0.1:4000/v1", &fewer));
    }

    /// Records when it is dropped; stands in for a [`NanoLease`].
    struct Probe(std::sync::Arc<std::sync::atomic::AtomicBool>);

    impl Drop for Probe {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    const IDLE_ADAPTER: &str = r#"
        const native = {supported:true,enforcement:'native'};
        const unsupported = {supported:false,enforcement:'unsupported'};
        return {
          snapshot() {
            return {nativeId:'native-lease',materialized:false,title:'Pi session',status:'idle',blocks:[],approvals:[],
              capabilities:{prompt:native,resume:native,models:native,approvals:native,instructions:unsupported,toolPolicy:native,nativeSubagents:unsupported},models:[]};
          },
          prompt() { return {accepted:true}; },
          interrupt() { return null; },
          dispose() { return null; },
        };
    "#;

    fn runtime_config(
        directory: &std::path::Path,
    ) -> piui_runtime::workspace_runtime::NativeRuntimeConfig {
        use piui_runtime::workspace_runtime::{HarnessKind, NativeRuntimeConfig};
        let cwd = directory.join("cwd");
        let session_dir = directory.join("sessions");
        std::fs::create_dir_all(&cwd).expect("cwd");
        std::fs::create_dir_all(&session_dir).expect("session dir");
        NativeRuntimeConfig {
            harness: HarnessKind::Pi,
            cwd,
            session_dir,
            native_id: None,
            native_path: None,
            title: None,
            model: None,
            thinking_level: None,
            instructions: None,
            base_instructions: None,
            service_tier: None,
            resource_rules: None,
            permission_mode: PermissionMode::Native,
            network_access: false,
            allowed_tools: None,
            native_subagents: None,
            daemon_socket: None,
            package_root: None,
            agent_dir: None,
            kernel_python: None,
            coordination: false,
            plugin_mcp_servers: Vec::new(),
            host_tools: Vec::new(),
            nano: None,
        }
    }

    #[tokio::test]
    async fn a_lease_lives_exactly_as_long_as_its_runtime() {
        use piui_runtime::workspace_runtime::NativeRuntime;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let directory = crate::nano::tests::test_dir("lease");
        let (runtime, events) =
            NativeRuntime::spawn_test_adapter(runtime_config(&directory), IDLE_ADAPTER)
                .await
                .expect("test runtime");
        let released = Arc::new(AtomicBool::new(false));
        runtime.attach_lease(Box::new(Probe(released.clone())));
        // A second lease is dropped at once; the first one is kept.
        let ignored = Arc::new(AtomicBool::new(false));
        runtime.attach_lease(Box::new(Probe(ignored.clone())));
        assert!(ignored.load(Ordering::SeqCst));
        assert!(!released.load(Ordering::SeqCst));

        // Sharing the runtime (as the live session map does) keeps it.
        let runtime = Arc::new(runtime);
        let shared = Arc::clone(&runtime);
        drop(runtime);
        assert!(!released.load(Ordering::SeqCst));

        // Closing disposes the process, then the last owner drops the lease.
        shared.begin_retirement();
        drop(events);
        let _ = shared.dispose().await;
        assert!(
            !released.load(Ordering::SeqCst),
            "a disposed runtime that is still owned keeps its lease"
        );
        drop(shared);
        assert!(released.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(directory);
    }

    /// Reports a failed runtime (as the Pi bridge does once its child exited)
    /// shortly after start.
    const FAILING_ADAPTER: &str = r#"
        const native = {supported:true,enforcement:'native'};
        const unsupported = {supported:false,enforcement:'unsupported'};
        setTimeout(() => emit({type:'status',status:'failed'}), 200);
        return {
          snapshot() {
            return {nativeId:'native-failing',materialized:false,title:'Pi session',status:'idle',blocks:[],approvals:[],
              capabilities:{prompt:native,resume:native,models:native,approvals:native,instructions:unsupported,toolPolicy:native,nativeSubagents:unsupported},models:[]};
          },
          prompt() { return {accepted:true}; },
          interrupt() { return null; },
          dispose() { return null; },
        };
    "#;

    #[tokio::test]
    async fn a_terminally_failed_runtime_releases_its_lease_while_still_owned() {
        use piui_runtime::workspace_runtime::{NativeEvent, NativeRuntime, SessionStatus};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let directory = crate::nano::tests::test_dir("lease-failed");
        let (runtime, mut events) =
            NativeRuntime::spawn_test_adapter(runtime_config(&directory), FAILING_ADAPTER)
                .await
                .expect("test runtime");
        let released = Arc::new(AtomicBool::new(false));
        runtime.attach_lease(Box::new(Probe(released.clone())));
        let failed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(event) = events.recv().await {
                if matches!(
                    event,
                    NativeEvent::Status {
                        status: SessionStatus::Failed
                    }
                ) {
                    return true;
                }
            }
            false
        })
        .await
        .expect("the failed status arrives");
        assert!(failed);
        assert!(
            released.load(Ordering::SeqCst),
            "a failed runtime releases its lease before the host drops it"
        );
        // A lease attached after the end is dropped at once.
        let late = Arc::new(AtomicBool::new(false));
        runtime.attach_lease(Box::new(Probe(late.clone())));
        assert!(late.load(Ordering::SeqCst));
        drop(runtime);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn safe_mode_and_a_signed_out_account_refuse_before_any_setup() {
        let directory = crate::nano::tests::test_dir("launch-refused");
        for safe_mode in [true, false] {
            let host = NanoHost::for_tests(&directory, safe_mode);
            let refused = host.launch(PermissionMode::Native).await;
            assert!(matches!(refused, Err(NativeRuntimeError::NanoNotReady)));
            assert!(host.relay.get().is_none(), "no relay was started");
            assert!(!directory.join("nano").exists(), "no agent directory");
        }
        let _ = std::fs::remove_dir_all(&directory);
    }
}
