//! Opt-in local operator API. Calls the same typed application commands as the UI.
//! Authentication is connection-scoped; no web/HTTP or arbitrary Tauri invoke surface.
use crate::{api, orchestration_api as orchestration, workspace_api as workspace};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Listener, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    protocol: u8,
    method: String,
    #[serde(default = "empty_object")]
    params: Value,
}
fn empty_object() -> Value {
    json!({})
}
fn encode<T: Serialize, E: Serialize>(protocol: u8, result: Result<T, E>) -> Value {
    match result {
        Ok(value) => json!({"protocol":protocol,"ok":true,"result":value}),
        Err(error) => json!({"protocol":protocol,"ok":false,"error":error}),
    }
}
fn failure(protocol: u8, code: &str) -> Value {
    json!({"protocol":protocol,"ok":false,"error":{"code":code}})
}
fn parse<T: serde::de::DeserializeOwned>(protocol: u8, value: Value) -> Result<T, Value> {
    serde_json::from_value(value).map_err(|_| failure(protocol, "invalid"))
}

async fn dispatch(app: &AppHandle, request: Request) -> Value {
    let protocol = request.protocol;
    if !matches!(protocol, 1 | 2) {
        return failure(protocol, "unsupported-protocol");
    }
    let schedule_method = matches!(
        request.method.as_str(),
        "listSchedules" | "saveSchedule" | "setScheduleEnabled" | "deleteSchedule"
    );
    if schedule_method && protocol < 2 {
        return failure(protocol, "unsupported-protocol");
    }
    // These are typed host functions, NOT arbitrary command names from the client.
    macro_rules! args {
        () => {
            match parse(protocol, request.params) {
                Ok(value) => value,
                Err(error) => return error,
            }
        };
    }
    match request.method.as_str() {
        "ping" => {
            json!({"protocol":protocol,"ok":true,"result":{"api":"piui-agent","version":protocol}})
        }
        "waitRun" => wait_run(app, protocol, args!()).await,
        "workspace" => encode(
            protocol,
            workspace::workspace_command_v15(app.clone(), app.state(), args!()).await,
        ),
        "models" => encode(
            protocol,
            workspace::harness_models_v18(app.state(), args!()).await,
        ),
        "addProject" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Params {
                path: String,
            }
            let params: Params = args!();
            encode(protocol, api::add_project(app.state(), params.path).await)
        }
        "setProjectTrust" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Params {
                project_id: String,
                trust_state: String,
            }
            let params: Params = args!();
            encode(
                protocol,
                api::set_project_trust(app.state(), params.project_id, params.trust_state).await,
            )
        }
        "catalog" => encode(
            protocol,
            orchestration::orchestration_catalog_v6(app.state(), app.state(), args!()),
        ),
        "getProfile" => encode(
            protocol,
            orchestration::orchestration_get_profile_v6(app.state(), app.state(), args!()),
        ),
        "getTeam" => encode(
            protocol,
            orchestration::orchestration_get_team_v6(app.state(), app.state(), args!()),
        ),
        "getPipeline" => encode(
            protocol,
            orchestration::orchestration_get_pipeline_v6(app.state(), app.state(), args!()),
        ),
        "getLaunchCommand" => encode(
            protocol,
            orchestration::orchestration_get_launch_command_v6(app.state(), app.state(), args!()),
        ),
        "listRuns" => encode(
            protocol,
            orchestration::orchestration_list_runs_v6(app.state(), app.state(), args!()),
        ),
        "getRun" => encode(
            protocol,
            orchestration::orchestration_get_run_v6(app.state(), app.state(), args!()),
        ),
        "usage" => encode(
            protocol,
            orchestration::orchestration_run_usage_v6(app.state(), app.state(), args!()),
        ),
        "saveGraph" => encode(
            protocol,
            orchestration::orchestration_save_graph_v6(app.state(), app.state(), args!()).await,
        ),
        "saveProfile" => encode(
            protocol,
            orchestration::orchestration_save_profile_v6(app.state(), app.state(), args!()).await,
        ),
        "saveTeam" => encode(
            protocol,
            orchestration::orchestration_save_team_v6(app.state(), app.state(), args!()).await,
        ),
        "savePipeline" => encode(
            protocol,
            orchestration::orchestration_save_pipeline_v6(app.state(), app.state(), args!()).await,
        ),
        "saveLaunchCommand" => encode(
            protocol,
            orchestration::orchestration_save_launch_command_v6(app.state(), app.state(), args!())
                .await,
        ),
        "deleteProfile" => encode(
            protocol,
            orchestration::orchestration_delete_profile_v6(app.state(), app.state(), args!()).await,
        ),
        "deleteTeam" => encode(
            protocol,
            orchestration::orchestration_delete_team_v6(app.state(), app.state(), args!()).await,
        ),
        "deletePipeline" => encode(
            protocol,
            orchestration::orchestration_delete_pipeline_v6(app.state(), app.state(), args!())
                .await,
        ),
        "deleteLaunchCommand" => encode(
            protocol,
            orchestration::orchestration_delete_launch_command_v6(
                app.state(),
                app.state(),
                args!(),
            )
            .await,
        ),
        "listSchedules" => encode(
            protocol,
            orchestration::orchestration_list_schedules_v7(app.state(), app.state(), args!()),
        ),
        "saveSchedule" => encode(
            protocol,
            orchestration::orchestration_save_schedule_v7(
                app.state(),
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        "setScheduleEnabled" => encode(
            protocol,
            orchestration::orchestration_set_schedule_enabled_v7(
                app.state(),
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        "deleteSchedule" => encode(
            protocol,
            orchestration::orchestration_delete_schedule_v7(
                app.state(),
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        "startRun" => encode(
            protocol,
            orchestration::orchestration_start_run_v6(
                app.state(),
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        "controlFlow" => encode(
            protocol,
            orchestration::orchestration_control_flow_v6(
                app.state(),
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        "reconcileTask" => encode(
            protocol,
            orchestration::orchestration_reconcile_uncertain_task_v6(
                app.state(),
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        "retryTask" => encode(
            protocol,
            orchestration::orchestration_retry_uncertain_task_v6(
                app.state(),
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        "cancelRun" => encode(
            protocol,
            orchestration::orchestration_cancel_run_v6(
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        "cancelTask" => encode(
            protocol,
            orchestration::orchestration_cancel_task_v6(
                app.state(),
                app.state(),
                app.clone(),
                args!(),
            )
            .await,
        ),
        _ => failure(protocol, "unknown-method"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitRun {
    workspace_id: String,
    run_id: String,
    after_revision: u64,
    timeout_ms: u64,
}
async fn wait_run(app: &AppHandle, protocol: u8, request: WaitRun) -> Value {
    let notify = std::sync::Arc::new(tokio::sync::Notify::new());
    let wake = notify.clone();
    let workspace_id = request.workspace_id.clone();
    let run_id = request.run_id.clone();
    // Subscribe before reading: a durable commit between subscribe and snapshot
    // cannot be lost. Only scalar invalidations wake this waiter.
    let listener = app.listen(orchestration::ORCHESTRATION_EVENT_V4, move |event| {
        if let Ok(value) = serde_json::from_str::<Value>(event.payload())
            && value["workspaceId"] == workspace_id
            && value["runId"] == run_id
        {
            wake.notify_one();
        }
    });
    let read = || {
        let params = json!({"workspaceId":request.workspace_id,"runId":request.run_id});
        match parse(protocol, params) {
            Ok(params) => encode(
                protocol,
                orchestration::orchestration_get_run_v6(app.state(), app.state(), params),
            ),
            Err(error) => error,
        }
    };
    let outcome = tokio::time::timeout(
        std::time::Duration::from_millis(request.timeout_ms),
        async {
            loop {
                let current = read();
                if current["ok"] != true
                    || current["result"].is_null()
                    || current["result"]["revision"].as_u64() != Some(request.after_revision)
                {
                    return current;
                }
                notify.notified().await;
            }
        },
    )
    .await;
    app.unlisten(listener);
    outcome.unwrap_or_else(|_| read())
}

async fn authenticate(reader: &mut BufReader<TcpStream>, token: &[u8]) -> std::io::Result<bool> {
    // A 256-bit hex capability plus LF is the entire unauthenticated frame.
    let mut supplied = [0_u8; 65];
    reader.read_exact(&mut supplied).await?;
    let difference = supplied[..64]
        .iter()
        .zip(token)
        .fold(supplied[64] ^ b'\n', |diff, (a, b)| diff | (a ^ b));
    Ok(difference == 0)
}
async fn serve(stream: TcpStream, app: AppHandle, token: &str) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    if !authenticate(&mut reader, token.as_bytes()).await? {
        return Ok(());
    }
    let mut line = String::new();
    // Exactly one LF-framed request per connection. Unicode separators are data.
    if reader.read_line(&mut line).await? == 0 {
        return Ok(());
    }
    let result = match serde_json::from_str::<Request>(&line) {
        Ok(request) => dispatch(&app, request).await,
        Err(_) => failure(1, "invalid"),
    };
    let mut bytes = serde_json::to_vec(&result).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    reader.get_mut().write_all(&bytes).await?;
    reader.get_mut().shutdown().await
}

fn configuration(
    port: Option<String>,
    token: Option<String>,
) -> std::io::Result<Option<(u16, String)>> {
    if port.is_none() && token.is_none() {
        return Ok(None);
    }
    let invalid = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Agent API requires PIUI_AGENT_API_PORT (nonzero port) and PIUI_AGENT_API_TOKEN (64 hex characters)",
        )
    };
    let port = port
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(invalid)?;
    let token = token
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(invalid)?;
    Ok(Some((port, token)))
}

pub struct Server {
    listener: std::net::TcpListener,
    token: String,
}
impl Server {
    /// Bind before opening durable state: invalid/busy configuration must not
    /// trigger recovery of a different, already running host's journal.
    pub fn from_environment() -> std::io::Result<Option<Self>> {
        let Some((port, token)) = configuration(
            std::env::var("PIUI_AGENT_API_PORT").ok(),
            std::env::var("PIUI_AGENT_API_TOKEN").ok(),
        )?
        else {
            return Ok(None);
        };
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))?;
        listener.set_nonblocking(true)?;
        Ok(Some(Self { listener, token }))
    }
    pub fn start(self, app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = TcpListener::from_std(self.listener) else {
                return;
            };
            while let Ok((stream, _)) = listener.accept().await {
                let app = app.clone();
                let token = self.token.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = serve(stream, app, &token).await;
                });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_is_explicit_and_invalid_configuration_fails_closed() {
        assert!(configuration(None, None).unwrap().is_none());
        assert!(configuration(Some("0".into()), Some("a".repeat(64))).is_err());
        assert!(configuration(Some("1234".into()), None).is_err());
        assert!(configuration(None, Some("a".repeat(64))).is_err());
        assert!(configuration(Some("1234".into()), Some("g".repeat(64))).is_err());
        assert!(
            configuration(Some("1234".into()), Some("a".repeat(64)))
                .unwrap()
                .is_some()
        );
        assert!(
            serde_json::from_value::<Request>(
                json!({"protocol":1,"method":"ping","sender":"forged"})
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn socket_authentication_rejects_other_tokens_and_http() {
        for (bytes, expected) in [
            (format!("{}\n", "a".repeat(64)), true),
            (format!("{}\n", "b".repeat(64)), false),
            ("GET / HTTP/1.1".repeat(5), false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let client = tokio::spawn(async move {
                let mut stream = TcpStream::connect(address).await.unwrap();
                stream.write_all(bytes.as_bytes()).await.unwrap();
            });
            let (stream, _) = listener.accept().await.unwrap();
            assert_eq!(
                authenticate(&mut BufReader::new(stream), "a".repeat(64).as_bytes())
                    .await
                    .unwrap(),
                expected
            );
            client.await.unwrap();
        }
    }
}
