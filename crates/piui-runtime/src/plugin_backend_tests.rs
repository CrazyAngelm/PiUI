//! Plugin backend tests with a fake plugin run by the real Node.js: framing,
//! errors, timeouts, crashes, protocol violations, cancellation, the
//! environment allowlist and process-tree containment. No model or harness
//! is started.

use super::*;
use std::sync::atomic::AtomicU64;

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A fake backend: answers `initialize`, echoes, fails, hangs, crashes,
/// breaks the protocol, reports its environment and starts a grandchild.
const FAKE_PLUGIN: &str = r#"
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let settings = null;
let buffer = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const { id, method, params } = message;
    if (id === undefined) { if (method === 'settings/changed') settings = params.settings; continue; }
    switch (method) {
      case 'initialize': send({ jsonrpc: '2.0', id, result: { protocol: 1, echo: params } }); break;
      case 'echo': send({ jsonrpc: '2.0', id, result: { params, settings } }); break;
      case 'fail': send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'the plugin failed on purpose' } }); break;
      case 'hang': break;
      case 'crash': process.exit(3);
      case 'garbage': process.stdout.write('this is not json\n'); break;
      case 'huge': process.stdout.write('"' + 'x'.repeat(1536 * 1024) + '"\n'); break;
      case 'unknown-id': send({ jsonrpc: '2.0', id: id + 1000, result: {} }); break;
      case 'env': send({ jsonrpc: '2.0', id, result: Object.keys(process.env) }); break;
      case 'grandchild': {
        const child = spawn(process.execPath, ['-e', `setInterval(() => require('fs').appendFileSync(${JSON.stringify(params.file)}, 'x'), 50)`], { stdio: 'ignore' });
        send({ jsonrpc: '2.0', id, result: { pid: child.pid } });
        break;
      }
      case 'shutdown': send({ jsonrpc: '2.0', id, result: {} }); setTimeout(() => process.exit(0), 10); break;
      default: send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } });
    }
  }
});
"#;

struct Fixture {
    root: PathBuf,
    entry: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piui-plugin-backend-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("backend")).expect("fixture folder");
        let root = std::fs::canonicalize(&root).expect("canonical fixture");
        let entry = root.join("backend").join("main.mjs");
        std::fs::write(&entry, FAKE_PLUGIN).expect("fake plugin");
        Self { root, entry }
    }

    async fn start(&self) -> PluginBackend {
        let node = resolve_plugin_node().expect("Node.js is installed for plugin tests");
        let mut environment = std::env::vars_os().collect::<Vec<_>>();
        environment.push(("ANTHROPIC_API_KEY".into(), "sk-ant-planted-secret".into()));
        environment.push(("NODE_OPTIONS".into(), "--require=./evil.js".into()));
        environment.push((
            "PIUI_AGENT_API_TOKEN".into(),
            "planted-operator-token".into(),
        ));
        PluginBackend::spawn(PluginBackendLaunch {
            node: &node,
            entry: &self.entry,
            working_dir: &self.root,
            host_environment: &environment,
            permissions: None,
        })
        .await
        .expect("backend starts")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

const TIMEOUT: Duration = Duration::from_secs(15);

async fn exit_of(backend: &PluginBackend) -> BackendExit {
    let mut exit = backend.exit();
    let reason = tokio::time::timeout(TIMEOUT, exit.wait_for(Option::is_some))
        .await
        .expect("the backend ends")
        .expect("exit channel");
    reason.unwrap_or(BackendExit::Stopped)
}

#[tokio::test]
async fn requests_notifications_and_errors_round_trip() {
    let fixture = Fixture::new("round-trip");
    let backend = fixture.start().await;
    let initialized = backend
        .request("initialize", json!({ "protocol": 1 }), TIMEOUT, None)
        .await
        .expect("initialize");
    assert_eq!(initialized["protocol"], 1);
    backend
        .notify(
            "settings/changed",
            json!({ "settings": { "greeting": "Hi" } }),
        )
        .await
        .expect("notification");
    let echoed = backend
        .request(
            "echo",
            json!({ "text": "héllo\u{2028}world" }),
            TIMEOUT,
            None,
        )
        .await
        .expect("echo");
    assert_eq!(
        echoed["params"]["text"], "héllo\u{2028}world",
        "only LF delimits frames"
    );
    assert_eq!(echoed["settings"]["greeting"], "Hi");
    let failed = backend.request("fail", json!({}), TIMEOUT, None).await;
    assert_eq!(
        failed,
        Err(PluginBackendError::Remote {
            code: -32000,
            message: "the plugin failed on purpose".into()
        })
    );
    assert!(
        backend.running(),
        "an error answer keeps the backend running"
    );
    backend.shutdown(Duration::from_secs(2)).await;
    assert_eq!(exit_of(&backend).await, BackendExit::Stopped);
    assert_eq!(
        backend.request("echo", json!({}), TIMEOUT, None).await,
        Err(PluginBackendError::Stopped)
    );
}

#[tokio::test]
async fn a_timeout_or_a_cancellation_stops_the_backend() {
    let fixture = Fixture::new("timeout");
    let backend = fixture.start().await;
    let started = std::time::Instant::now();
    assert_eq!(
        backend
            .request("hang", json!({}), Duration::from_millis(300), None)
            .await,
        Err(PluginBackendError::Timeout)
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(exit_of(&backend).await, BackendExit::TimedOut);

    let backend = fixture.start().await;
    let (cancel, receiver) = watch::channel(false);
    let request = backend.request("hang", json!({}), TIMEOUT, Some(receiver));
    let canceller = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.send_replace(true);
    };
    let (result, ()) = tokio::join!(request, canceller);
    assert_eq!(result, Err(PluginBackendError::Cancelled));
    assert_eq!(exit_of(&backend).await, BackendExit::Cancelled);
}

#[tokio::test]
async fn a_crash_fails_pending_requests_with_a_typed_error() {
    let fixture = Fixture::new("crash");
    let backend = fixture.start().await;
    assert_eq!(
        backend.request("crash", json!({}), TIMEOUT, None).await,
        Err(PluginBackendError::Stopped)
    );
    assert_eq!(exit_of(&backend).await, BackendExit::Crashed);
}

#[tokio::test]
async fn protocol_violations_and_oversized_frames_stop_the_backend() {
    let fixture = Fixture::new("protocol");
    for method in ["garbage", "huge", "unknown-id"] {
        let backend = fixture.start().await;
        assert_eq!(
            backend.request(method, json!({}), TIMEOUT, None).await,
            Err(PluginBackendError::Protocol),
            "{method}"
        );
        assert_eq!(exit_of(&backend).await, BackendExit::Protocol, "{method}");
    }
}

#[tokio::test]
async fn the_environment_is_an_allowlist_without_secrets() {
    let fixture = Fixture::new("environment");
    let backend = fixture.start().await;
    let names = backend
        .request("env", json!({}), TIMEOUT, None)
        .await
        .expect("environment");
    let names = names
        .as_array()
        .expect("names")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_ascii_uppercase)
        .collect::<Vec<_>>();
    for denied in ["ANTHROPIC_API_KEY", "NODE_OPTIONS", "PIUI_AGENT_API_TOKEN"] {
        assert!(!names.iter().any(|name| name == denied), "{denied} leaked");
    }
    assert!(
        names.iter().all(|name| {
            PLUGIN_ENVIRONMENT_ALLOWLIST
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(name))
            // Node itself and the OS may define a few process-local values.
            || name.starts_with('=')
            || name == "NODE_UNIQUE_ID"
        }),
        "{names:?}"
    );
    backend.stop().await;
}

#[tokio::test]
async fn stopping_ends_the_whole_process_tree() {
    let fixture = Fixture::new("tree");
    let backend = fixture.start().await;
    let heartbeat = fixture.root.join("heartbeat.txt");
    backend
        .request(
            "grandchild",
            json!({ "file": heartbeat.to_string_lossy() }),
            TIMEOUT,
            None,
        )
        .await
        .expect("grandchild started");
    let grew = async {
        loop {
            if std::fs::metadata(&heartbeat).is_ok_and(|metadata| metadata.len() > 2) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    tokio::time::timeout(TIMEOUT, grew)
        .await
        .expect("the grandchild runs");
    backend.stop().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = std::fs::metadata(&heartbeat).map_or(0, |metadata| metadata.len());
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = std::fs::metadata(&heartbeat).map_or(0, |metadata| metadata.len());
    assert_eq!(
        before, after,
        "the grandchild was terminated with the backend"
    );
}

#[tokio::test]
async fn an_entry_outside_the_package_is_refused() {
    let fixture = Fixture::new("outside");
    let node = resolve_plugin_node().expect("Node.js is installed for plugin tests");
    let outside = std::env::temp_dir().join("elsewhere.mjs");
    let result = PluginBackend::spawn(PluginBackendLaunch {
        node: &node,
        entry: &outside,
        working_dir: &fixture.root,
        host_environment: &[],
        permissions: None,
    })
    .await;
    assert!(matches!(result, Err(PluginBackendError::Spawn)));
}

/// A backend that reports what Node's permission model lets it do.
const PROBING_PLUGIN: &str = r#"
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
let buffer = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const attempt = (action) => { try { action(); return 'ok'; } catch (error) { return error.code ?? 'error'; } };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const { id, method, params } = JSON.parse(line);
    if (method !== 'probe') { send({ jsonrpc: '2.0', id, result: {} }); continue; }
    const spawned = attempt(() => { const result = spawnSync(process.execPath, ['-e', '0']); if (result.error) throw result.error; });
    send({ jsonrpc: '2.0', id, result: {
      readOwn: attempt(() => readFileSync(new URL('./data.txt', import.meta.url))),
      readData: attempt(() => readFileSync(params.data + '/seed.txt')),
      writeData: attempt(() => writeFileSync(params.data + '/written.txt', 'x')),
      readProject: attempt(() => readFileSync(params.project + '/secret.txt')),
      writeProject: attempt(() => writeFileSync(params.project + '/changed.txt', 'x')),
      spawn: spawned,
    } });
  }
});
"#;

#[test]
fn the_probe_output_names_what_node_can_limit() {
    let modern = NodePermissionSupport::from_probe(
        r#"{"version":"v25.1.0","flags":["--permission","--allow-fs-read","--allow-fs-write","--allow-net"]}"#,
    )
    .expect("probe output");
    assert!(modern.permission && modern.network);
    let current = NodePermissionSupport::from_probe(
        r#"{"version":"v24.13.0","flags":["--permission","--allow-fs-read","--allow-fs-write"]}"#,
    )
    .expect("probe output");
    assert!(current.permission && !current.network);
    let old = NodePermissionSupport::from_probe(r#"{"version":"v20.11.0","flags":[]}"#)
        .expect("probe output");
    assert!(!old.permission && !old.network);
    assert_eq!(NodePermissionSupport::from_probe("not json"), None);
    assert_eq!(
        NodePermissionSupport::from_probe(r#"{"version":"24","flags":[]}"#),
        None
    );
}

#[test]
fn permission_flags_follow_the_grants_and_never_allow_processes() {
    let support = NodePermissionSupport {
        version: "v25.1.0".into(),
        permission: true,
        network: true,
    };
    let root = std::env::temp_dir();
    let package = root.join("package");
    let data = root.join("data");
    let grants = BackendGrants {
        read: vec![package.clone(), data.clone(), data.clone()],
        write: vec![data.clone()],
        network: false,
    };
    let arguments = permission_arguments(&support, &grants).expect("flags");
    let text = arguments
        .as_slice()
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let value = |path: &Path| process_directory(path).to_string_lossy().into_owned();
    assert_eq!(
        text,
        vec![
            "--permission".to_owned(),
            format!("--allow-fs-read={}", value(&package)),
            format!("--allow-fs-read={}", value(&data)),
            format!("--allow-fs-write={}", value(&data)),
        ]
    );
    assert!(!text.iter().any(|flag| flag.contains("child-process")
        || flag.contains("worker")
        || flag.contains("addons")
        || flag.contains("wasi")));
    let networked = permission_arguments(
        &support,
        &BackendGrants {
            network: true,
            ..grants.clone()
        },
    )
    .expect("flags");
    assert_eq!(
        networked
            .as_slice()
            .last()
            .map(|flag| flag.to_string_lossy().into_owned()),
        Some("--allow-net".to_owned())
    );
    let without_net = NodePermissionSupport {
        network: false,
        ..support.clone()
    };
    let unrestricted = permission_arguments(
        &without_net,
        &BackendGrants {
            network: true,
            ..grants.clone()
        },
    )
    .expect("flags");
    assert!(
        !unrestricted
            .as_slice()
            .iter()
            .any(|flag| flag.to_string_lossy() == "--allow-net")
    );
    assert_eq!(
        permission_arguments(
            &NodePermissionSupport {
                permission: false,
                ..support.clone()
            },
            &grants
        ),
        Err(PermissionPlanError::Unsupported)
    );
    assert_eq!(
        permission_arguments(
            &support,
            &BackendGrants {
                read: vec![PathBuf::from("relative")],
                ..BackendGrants::default()
            }
        ),
        Err(PermissionPlanError::Path)
    );
    assert_eq!(
        permission_arguments(
            &support,
            &BackendGrants {
                read: vec![root.join("*")],
                ..BackendGrants::default()
            }
        ),
        Err(PermissionPlanError::Path)
    );
}

#[tokio::test]
async fn node_denies_what_the_grants_leave_out() {
    let node = resolve_plugin_node().expect("Node.js is installed for plugin tests");
    let support = probe_node_permissions(&node).expect("the probe runs");
    assert_eq!(cached_node_permissions(&node), Some(support.clone()));
    if !support.permission {
        eprintln!(
            "skipped: Node.js {} has no permission model",
            support.version
        );
        return;
    }
    let fixture = Fixture::new("permissions");
    std::fs::write(&fixture.entry, PROBING_PLUGIN).expect("probing plugin");
    std::fs::write(fixture.root.join("backend").join("data.txt"), "own").expect("own file");
    let outside = std::fs::canonicalize(std::env::temp_dir())
        .expect("temp")
        .join(format!(
            "piui-plugin-permissions-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    let data = outside.join("data");
    let project = outside.join("project");
    std::fs::create_dir_all(&data).expect("data folder");
    std::fs::create_dir_all(&project).expect("project folder");
    std::fs::write(data.join("seed.txt"), "seed").expect("seed");
    std::fs::write(project.join("secret.txt"), "secret").expect("secret");
    let params = json!({
        "data": process_directory(&data).to_string_lossy(),
        "project": process_directory(&project).to_string_lossy(),
    });
    let run = |grants: BackendGrants| {
        let node = node.clone();
        let support = support.clone();
        let fixture_root = fixture.root.clone();
        let entry = fixture.entry.clone();
        let params = params.clone();
        async move {
            let arguments = permission_arguments(&support, &grants).expect("flags");
            let backend = PluginBackend::spawn(PluginBackendLaunch {
                node: &node,
                entry: &entry,
                working_dir: &fixture_root,
                host_environment: &std::env::vars_os().collect::<Vec<_>>(),
                permissions: Some(&arguments),
            })
            .await
            .expect("backend starts");
            let answer = backend
                .request("probe", params, TIMEOUT, None)
                .await
                .expect("probe answer");
            backend.stop().await;
            answer
        }
    };
    let base = BackendGrants {
        read: vec![fixture.root.clone(), data.clone()],
        write: vec![data.clone()],
        network: false,
    };
    let denied = run(base.clone()).await;
    assert_eq!(denied["readOwn"], "ok");
    assert_eq!(denied["readData"], "ok");
    assert_eq!(denied["writeData"], "ok");
    assert_eq!(denied["readProject"], "ERR_ACCESS_DENIED");
    assert_eq!(denied["writeProject"], "ERR_ACCESS_DENIED");
    assert_eq!(denied["spawn"], "ERR_ACCESS_DENIED");
    assert!(!project.join("changed.txt").exists());

    let reader = run(BackendGrants {
        read: [base.read.clone(), vec![project.clone()]].concat(),
        ..base.clone()
    })
    .await;
    assert_eq!(reader["readProject"], "ok");
    assert_eq!(reader["writeProject"], "ERR_ACCESS_DENIED");
    assert_eq!(reader["spawn"], "ERR_ACCESS_DENIED");

    let writer = run(BackendGrants {
        read: [base.read.clone(), vec![project.clone()]].concat(),
        write: [base.write.clone(), vec![project.clone()]].concat(),
        ..base
    })
    .await;
    assert_eq!(writer["writeProject"], "ok");
    assert_eq!(writer["spawn"], "ERR_ACCESS_DENIED");
    let _ = std::fs::remove_dir_all(&outside);
}
