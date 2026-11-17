//! Real Tauri state/event plumbing, native OAuth, authenticated desktop socket,
//! local approval, a signed viewer and a durable write. The Node peer implements
//! the browser side with the repository's loopback issuer. No OS credential
//! store, WebView profile or provider is used.
use super::{NanoHost, remote};
use crate::{orchestration_api::OrchestrationApiState, state::HostState};
use piui_nano::{NanoAccount, NanoConfig};
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub fn run_native_remote_workbench_proof(root: &std::path::Path) {
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let host = HostState::open(&root.join("app"), false).unwrap();
    let workspace = host
        .index
        .lock()
        .unwrap()
        .register_project_directory(
            &piui_platform::ProjectDirectory::resolve(&project).unwrap(),
            Some("Remote fixture"),
            piui_index::TrustState::Trusted,
        )
        .unwrap()
        .id;
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .any_thread()
        .manage(crate::board::BoardService::open(root, false).unwrap())
        .manage(crate::pipeline_library::PipelineLibrary::open(root).unwrap())
        .manage(crate::orchestration_scheduler::OrchestrationScheduler::default())
        .manage(host)
        .manage(OrchestrationApiState::open(root).unwrap())
        .build(context)
        .expect("isolated windowless native application");

    tauri::async_runtime::block_on(async {
        tokio::time::timeout(
            Duration::from_secs(piui_nano::remote::frames::PAIRING_SECONDS),
            async {
                let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../tools/nano-dev-server/native-remote-peer.mjs");
                let mut peer = tokio::process::Command::new("node")
                    .arg(script)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap();
                let mut lines = BufReader::new(peer.stdout.take().unwrap()).lines();
                let mut input = peer.stdin.take().unwrap();
                let origin = lines.next_line().await.unwrap().expect("issuer origin");
                let config =
                    NanoConfig::from_parts(Some(&origin), env!("CARGO_PKG_VERSION")).unwrap();
                let account = NanoAccount::with_store(config, None, None).unwrap();
                let mut changes = account.subscribe();
                let (send_url, auth_url) = tokio::sync::oneshot::channel();
                account
                    .begin_sign_in(Box::new(move |url| {
                        send_url.send(url.clone()).map_err(|_| ())
                    }))
                    .await
                    .unwrap();
                input
                    .write_all(format!("{}\n", auth_url.await.unwrap()).as_bytes())
                    .await
                    .unwrap();
                let signed_in = changes
                    .wait_for(|s| {
                        matches!(s.state, piui_nano::status::NanoAccountStateV1::SignedIn)
                            || s.last_error.is_some()
                    })
                    .await
                    .expect("account status")
                    .clone();
                assert_eq!(
                    signed_in.state,
                    piui_nano::status::NanoAccountStateV1::SignedIn,
                    "{:?}",
                    signed_in.last_error
                );
                let device = signed_in.device.expect("registered device").id;
                let nano = Arc::new(NanoHost {
                    account: Ok(account),
                    ..NanoHost::open(
                        root,
                        root.join("profile"),
                        false,
                        true,
                        env!("CARGO_PKG_VERSION"),
                        false,
                    )
                });
                app.manage(Arc::clone(&nano));
                let actor = remote::install(app.handle().clone(), root, nano, false);
                let remote_host = app.state::<Arc<remote::RemoteHost>>();
                remote::nano_remote_set_enabled_v1(
                    remote_host.clone(),
                    remote::NanoRemoteSetEnabledRequestV1 { enabled: true },
                )
                .await
                .unwrap();
                let mut status = remote_host.subscribe_for_tests();
                status
                    .wait_for(|s| s.link == super::remote_core::LinkStateV1::Online)
                    .await
                    .unwrap();
                input
                    .write_all(
                        format!(
                            "{}\n",
                            serde_json::json!({"device":device,"workspaceId":workspace})
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                loop {
                    let code = lines
                        .next_line()
                        .await
                        .unwrap()
                        .expect("signed viewer or completion");
                    if code == "verified" || code == "failed" {
                        break;
                    }
                    let pending = status
                        .wait_for(|s| s.pending.is_some())
                        .await
                        .unwrap()
                        .pending
                        .clone()
                        .unwrap();
                    assert_eq!(pending.code, code);
                    remote::nano_remote_decide_v1(
                        remote_host.clone(),
                        remote::NanoRemoteDecideRequestV1 {
                            request_id: pending.request_id,
                            decision: super::remote_core::Decision::Once,
                        },
                    )
                    .await
                    .unwrap();
                }
                remote::nano_remote_set_enabled_v1(
                    remote_host,
                    remote::NanoRemoteSetEnabledRequestV1 { enabled: false },
                )
                .await
                .unwrap();
                assert!(peer.wait().await.unwrap().success());
                actor.abort();
                let _ = actor.await;
            },
        )
        .await
        .expect("native relay within pairing deadline");
    });
}
