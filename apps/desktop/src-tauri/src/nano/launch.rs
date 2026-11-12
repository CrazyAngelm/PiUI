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
use piui_nano::agent_dir::prepare_external_pi_agent_dir;
use piui_nano::agent_dir::{GUARD_DIR, GUARD_FILE, prepare_pi_bundled_assets};
use piui_nano::external_providers::connection_id;
use piui_nano::relay::ExternalProviderLease;
use piui_nano::relay::{ConnectorDialect, ConnectorHarness, ConnectorLease, ConnectorLeaseError};
use piui_nano::status::{NanoAccountStateV1, NanoAccountStatusV1};
use piui_nano::wire::{NanoEntitlementsV1, NanoModeIdV1, NanoModeV1};
use piui_nano::{Relay, RelaySession, prepare_pi_agent_dir};
use piui_runtime::acp_nano::{AcpNanoMode, AcpNanoSource};
use piui_runtime::codex_nano::CodexNanoSource;
use piui_runtime::nano::{
    NANO_BUNDLED_ASSETS, NANO_GUARD_EXTENSION_SOURCE, NanoRelayKey, NanoRuntimeLaunch,
};
use piui_runtime::prime_nano::{PrimeNanoMode, PrimeNanoSource};
use piui_runtime::workspace_runtime::{NativeRuntimeError, PermissionMode, WorkspaceModel};
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

/// Keeps a connector lease (ADR-050) registered for one harness session.
/// Dropping it retires the lease key and cuts its open requests and streams.
pub(crate) struct NanoConnectorLease {
    _lease: ConnectorLease,
}

impl std::fmt::Debug for NanoConnectorLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NanoConnectorLease")
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
    /// Starts an external provider lease without Nano account sign-in. The
    /// external credential stays in the host, and Pi receives its loopback key.
    pub(crate) async fn launch_external(
        &self,
        model: &WorkspaceModel,
        session_dir: &std::path::Path,
        permission_mode: PermissionMode,
    ) -> Result<(NanoRuntimeLaunch, ExternalProviderLease), NativeRuntimeError> {
        if self.safe_mode {
            return Err(NativeRuntimeError::InvalidConfiguration);
        }
        let id = model
            .provider
            .as_deref()
            .and_then(connection_id)
            .ok_or(NativeRuntimeError::InvalidConfiguration)?
            .to_owned();
        let registry = self.external_providers.clone();
        let grant = if id == piui_nano::openai_subscription::CHATGPT_CONNECTION_ID {
            registry.grant_chatgpt(&model.id).await
        } else {
            tokio::task::spawn_blocking(move || registry.grant(&id))
                .await
                .map_err(|_| NativeRuntimeError::Spawn)?
        }
        .map_err(|_| NativeRuntimeError::InvalidConfiguration)?;
        let provider = grant.metadata().clone();
        if provider.spec.model_id != model.id {
            return Err(NativeRuntimeError::InvalidConfiguration);
        }
        let account = self.account().map_err(|_| NativeRuntimeError::Spawn)?;
        let relay = self
            .relay
            .get_or_try_init(|| Relay::start(account.clone()))
            .await
            .map_err(|_| NativeRuntimeError::Spawn)?;
        let lease = relay
            .register_external_provider(grant)
            .map_err(|_| NativeRuntimeError::Spawn)?;
        let agent_dir = session_dir.join("provider-agent");
        let directory = agent_dir.clone();
        let relay_url = lease.base_url();
        tokio::task::spawn_blocking(move || {
            prepare_external_pi_agent_dir(
                &directory,
                &relay_url,
                &provider,
                NANO_GUARD_EXTENSION_SOURCE,
            )?;
            prepare_pi_bundled_assets(&directory, NANO_BUNDLED_ASSETS)
                .map_err(piui_nano::AgentDirError::from)
        })
        .await
        .map_err(|_| NativeRuntimeError::Spawn)?
        .map_err(|_| NativeRuntimeError::Spawn)?;
        let guard_extension = (permission_mode != PermissionMode::FullAccess)
            .then(|| agent_dir.join(GUARD_DIR).join(GUARD_FILE));
        let relay_key = NanoRelayKey::new(lease.key().expose());
        Ok((
            NanoRuntimeLaunch {
                agent_dir,
                bundle_cache_dir: self.connector_home("runtime"),
                guard_extension,
                relay_key,
            },
            lease,
        ))
    }

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
                bundle_cache_dir: self.connector_home("runtime"),
                guard_extension,
                relay_key,
            },
            NanoLease { _session: session },
        ))
    }

    /// Builds the Nano model source of one OpenCode ACP session (ADR-050): a
    /// connector lease of the relay for `session_id`, bound to the account
    /// generation this launch is gated on, and an [`AcpNanoSource`] with the
    /// modes the account may use now. The lease lives exactly as long as the
    /// returned [`NanoConnectorLease`] (the host attaches it to the runtime).
    ///
    /// # Errors
    /// [`NativeRuntimeError::NanoNotReady`] when safe mode is on, the account
    /// cannot start a Nano session, or its generation ended while the launch
    /// was prepared (nothing was registered);
    /// [`NativeRuntimeError::Spawn`] when the relay, the lease or the private
    /// folders cannot be set up.
    pub(crate) async fn launch_acp_source(
        &self,
        session_id: &str,
    ) -> Result<(AcpNanoSource, NanoConnectorLease), NativeRuntimeError> {
        let (lease, modes) = self
            .connector_lease(ConnectorHarness::OpenCodeAcp, session_id, None)
            .await?;
        let modes = modes
            .into_iter()
            .map(|mode| AcpNanoMode {
                id: mode.id.as_str().to_owned(),
                name: mode.name,
            })
            .collect();
        let source = AcpNanoSource::opencode(
            &lease.base_url(),
            lease.key().expose(),
            modes,
            self.connector_home("opencode"),
        )
        .map_err(|_| NativeRuntimeError::Spawn)?;
        let directories = source.directories();
        let home = source.home().to_path_buf();
        tokio::task::spawn_blocking(move || {
            directories.iter().try_for_each(std::fs::create_dir_all)?;
            prepare_pi_bundled_assets(
                &home,
                &[(
                    piui_runtime::acp_nano::OPENCODE_SHELL_PLUGIN,
                    piui_runtime::acp_nano::OPENCODE_SHELL_PLUGIN_SOURCE,
                )],
            )
        })
        .await
        .map_err(|_| NativeRuntimeError::Spawn)?
        .map_err(|_| NativeRuntimeError::Spawn)?;
        Ok((source, NanoConnectorLease { _lease: lease }))
    }

    pub(crate) async fn launch_goose_source(
        &self,
        session_id: &str,
        model: &WorkspaceModel,
    ) -> Result<(AcpNanoSource, NanoConnectorLease), NativeRuntimeError> {
        let selected =
            NanoModeIdV1::parse(&model.id).ok_or(NativeRuntimeError::InvalidConfiguration)?;
        let (lease, modes) = self
            .connector_lease(ConnectorHarness::GooseAcp, session_id, Some(selected))
            .await?;
        let mode = modes
            .into_iter()
            .find(|mode| mode.id == selected)
            .ok_or(NativeRuntimeError::NanoNotReady)?;
        let shell_helper = std::env::current_exe().map_err(|_| NativeRuntimeError::Spawn)?;
        let source = AcpNanoSource::goose(
            &lease.base_url(),
            lease.key().expose(),
            AcpNanoMode {
                id: mode.id.as_str().to_owned(),
                name: mode.name,
            },
            mode.context_window,
            self.connector_home("goose"),
            shell_helper,
        )
        .map_err(|_| NativeRuntimeError::Spawn)?;
        let directories = source.directories();
        tokio::task::spawn_blocking(move || {
            directories.iter().try_for_each(std::fs::create_dir_all)
        })
        .await
        .map_err(|_| NativeRuntimeError::Spawn)?
        .map_err(|_| NativeRuntimeError::Spawn)?;
        Ok((source, NanoConnectorLease { _lease: lease }))
    }

    /// Builds a Prime SDK source with no dependency on the user's Prime home.
    pub(crate) async fn launch_prime_source(
        &self,
        session_id: &str,
    ) -> Result<(PrimeNanoSource, NanoConnectorLease), NativeRuntimeError> {
        let (lease, modes) = self
            .connector_lease(ConnectorHarness::PrimeAgent, session_id, None)
            .await?;
        let modes = modes
            .into_iter()
            .map(|mode| PrimeNanoMode {
                id: mode.id.as_str().to_owned(),
                name: mode.name,
                context_window: mode.context_window,
                max_output_tokens: mode.max_output_tokens,
            })
            .collect();
        let source = PrimeNanoSource::new(
            &lease.base_url(),
            lease.key().expose(),
            modes,
            self.connector_home("prime"),
        )
        .map_err(|_| NativeRuntimeError::Spawn)?;
        Ok((source, NanoConnectorLease { _lease: lease }))
    }

    pub(crate) async fn codex_catalog(
        &self,
    ) -> Vec<piui_runtime::workspace_runtime::NativeCatalogModel> {
        let Ok(account) = self.account.as_ref() else {
            return Vec::new();
        };
        let (generation, status) = account.status_with_generation();
        if self.safe_mode || launch_gate(&status).is_none() {
            return Vec::new();
        }
        let Some(workspace) = status.selected_workspace_id.as_deref() else {
            return Vec::new();
        };
        let modes = account.responses_modes(generation, workspace).await;
        self.catalog_models()
            .into_iter()
            .filter_map(|mut row| {
                let id = piui_nano::NanoModeIdV1::parse(&row.id)?;
                if !modes.contains(&id) {
                    return None;
                }
                row.provider = Some(piui_runtime::codex_nano::PROVIDER.to_owned());
                Some(row)
            })
            .collect()
    }

    pub(crate) async fn launch_codex_source(
        &self,
        session_id: &str,
    ) -> Result<(CodexNanoSource, NanoConnectorLease), NativeRuntimeError> {
        let (lease, modes) = self
            .connector_lease(ConnectorHarness::Codex, session_id, None)
            .await?;
        let modes = modes
            .into_iter()
            .map(|mode| AcpNanoMode {
                id: mode.id.as_str().to_owned(),
                name: mode.name,
            })
            .collect();
        let source = CodexNanoSource::new(
            &lease.base_url(),
            lease.key().expose(),
            modes,
            self.connector_home("codex"),
        )
        .ok_or(NativeRuntimeError::InvalidConfiguration)?;
        Ok((source, NanoConnectorLease { _lease: lease }))
    }

    async fn connector_lease(
        &self,
        harness: ConnectorHarness,
        session_id: &str,
        selected_mode: Option<NanoModeIdV1>,
    ) -> Result<(ConnectorLease, Vec<NanoModeV1>), NativeRuntimeError> {
        if self.safe_mode {
            return Err(NativeRuntimeError::NanoNotReady);
        }
        let account = self
            .account
            .as_ref()
            .map_err(|_| NativeRuntimeError::NanoNotReady)?;
        let (generation, status) = account.status_with_generation();
        let mut modes: Vec<_> = launch_gate(&status)
            .ok_or(NativeRuntimeError::NanoNotReady)?
            .modes
            .iter()
            .filter(|mode| mode.available)
            .cloned()
            .collect();
        let response_modes = if harness == ConnectorHarness::Codex {
            let workspace = status
                .selected_workspace_id
                .as_deref()
                .ok_or(NativeRuntimeError::NanoNotReady)?;
            let available = account.responses_modes(generation, workspace).await;
            modes.retain(|mode| available.contains(&mode.id));
            if modes.is_empty() {
                return Err(NativeRuntimeError::NanoNotReady);
            }
            Some((workspace, modes.iter().map(|mode| mode.id).collect()))
        } else {
            None
        };
        if let Some(selected) = selected_mode {
            modes.retain(|mode| mode.id == selected);
            if modes.is_empty() {
                return Err(NativeRuntimeError::NanoNotReady);
            }
        }
        let relay = self
            .relay
            .get_or_try_init(|| Relay::start(account.clone()))
            .await
            .map_err(|_| NativeRuntimeError::Spawn)?;
        let lease = match (harness, response_modes, selected_mode) {
            (ConnectorHarness::Codex, Some((workspace, allowed)), None) => {
                relay.register_codex_connector(session_id, generation, workspace, allowed)
            }
            (ConnectorHarness::GooseAcp, None, Some(selected)) => {
                relay.register_goose_connector(session_id, generation, selected)
            }
            (_, None, None) => relay.register_connector(
                harness,
                session_id,
                ConnectorDialect::ChatCompletions,
                generation,
            ),
            _ => return Err(NativeRuntimeError::InvalidConfiguration),
        }
        .map_err(|error| match error {
            ConnectorLeaseError::SignInRequired => NativeRuntimeError::NanoNotReady,
            _ => NativeRuntimeError::Spawn,
        })?;
        Ok((lease, modes))
    }

    fn connector_home(&self, harness: &str) -> std::path::PathBuf {
        self.agent_dir
            .parent()
            .unwrap_or(&self.agent_dir)
            .join(harness)
    }

    /// Refreshes the model configuration and restores the bundled resources
    /// before Pi starts. Serialized so launches cannot write them concurrently.
    async fn write_agent_dir(
        &self,
        relay_base_url: &str,
        modes: Vec<NanoModeV1>,
    ) -> Result<(), NativeRuntimeError> {
        let wanted = fingerprint(relay_base_url, &modes);
        let mut written = self.prepared.lock().await;
        let present = self.agent_dir.join("models.json").is_file()
            && self.agent_dir.join("settings.json").is_file()
            && self.agent_dir.join(GUARD_DIR).join(GUARD_FILE).is_file();
        let refresh = !present || written.as_deref() != Some(wanted.as_str());
        let directory = self.agent_dir.clone();
        let url = relay_base_url.to_owned();
        tokio::task::spawn_blocking(move || {
            if refresh {
                prepare_pi_agent_dir(&directory, &url, &modes, NANO_GUARD_EXTENSION_SOURCE)?;
            }
            prepare_pi_bundled_assets(&directory, NANO_BUNDLED_ASSETS)
                .map_err(piui_nano::AgentDirError::from)
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

    #[tokio::test]
    async fn connector_sources_refuse_before_any_relay_lease_or_private_folder() {
        let directory = crate::nano::tests::test_dir("acp-source-refused");
        for safe_mode in [true, false] {
            let host = NanoHost::for_tests(&directory, safe_mode);
            let refused = host.launch_acp_source("session-1").await;
            assert!(matches!(refused, Err(NativeRuntimeError::NanoNotReady)));
            let refused = host.launch_prime_source("session-2").await;
            assert!(matches!(refused, Err(NativeRuntimeError::NanoNotReady)));
            assert!(host.relay.get().is_none(), "no relay was started");
            assert!(!directory.join("nano").exists(), "no private folder");
        }
        // The private folder is the host's own, next to (never inside) the Pi
        // agent directory and never the user's OpenCode folders.
        let host = NanoHost::for_tests(&directory, false);
        assert_eq!(
            host.connector_home("opencode"),
            directory.join("nano").join("opencode")
        );
        assert_eq!(
            host.connector_home("prime"),
            directory.join("nano").join("prime")
        );
        let _ = std::fs::remove_dir_all(&directory);
    }
}
