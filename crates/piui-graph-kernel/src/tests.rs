use std::io::Cursor;

use serde_json::{Value, json};

use super::{handle_frame, serve};

fn create_command() -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../contracts/fixtures/nano-graph-kernel-v1.json"
    ))
    .unwrap();
    fixture["command"].clone()
}

fn invoke(command: Value) -> Value {
    let bytes =
        serde_json::to_vec(&json!({"protocol":1,"requestId":"request","command":command})).unwrap();
    serde_json::to_value(handle_frame(&bytes)).unwrap()
}

fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "ok", "{value}");
    value
}

fn state(value: &Value) -> Value {
    json!({"snapshot":value["snapshot"],"expectedRunRevision":value["run"]["revision"]})
}

fn create() -> Value {
    ok(invoke(create_command()))
}

#[test]
fn native_result_projection_uses_core_without_mutating_snapshot() {
    let run = create();
    let projected = ok(invoke(json!({"type":"projectResult","state":state(&run),
        "text":"{\"approved\":true,\"private\":\"not selected\"}",
        "fields":[{"field":"approved","name":"verdict"}]})));
    assert_eq!(projected["snapshot"], run["snapshot"]);
    assert_eq!(projected["effect"]["text"], "{\"verdict\":true}");
    let invalid = invoke(json!({"type":"projectResult","state":state(&run),
        "text":"{}","fields":[{"field":"missing","name":"verdict"}]}));
    assert_eq!(invalid["error"]["code"], "invalidRequest");
}

fn lease(run: &Value) -> Value {
    ok(invoke(
        json!({"type":"lease","state":state(run),"leaseId":"lease-a"}),
    ))
}

fn dispatch(leased: &Value) -> Value {
    let lease = &leased["effect"]["lease"];
    ok(invoke(
        json!({"type":"dispatch","state":state(leased),"stepId":lease["stepId"],
        "expectedTaskRevision":lease["taskRevision"],"leaseId":lease["leaseId"],
        "execution":{"id":format!("session-{}", lease["stepId"].as_str().unwrap())}}),
    ))
}

fn complete(running: &Value, text: &str) -> Value {
    let launch = &running["effect"]["launch"];
    ok(invoke(
        json!({"type":"completeChecked","state":state(running),"stepId":launch["stepId"],
        "expectedTaskRevision":launch["taskRevision"],"executionId":launch["execution"]["id"],
        "outcome":{"status":"succeeded","resultReference":{"sessionId":launch["execution"]["id"],"blockId":"block-a","contentHash":"ab".repeat(32)}},
        "text":text}),
    ))
}

#[test]
fn leases_then_binds_a_native_attempt_and_keeps_dependency_references() {
    let created = create();
    assert_eq!(created["run"]["readyTaskIds"], json!(["a"]));
    let leased = lease(&created);
    let before_dispatch: Value =
        serde_json::from_str(leased["snapshot"].as_str().unwrap()).unwrap();
    assert!(before_dispatch["tasks"][0].get("execution").is_none());
    assert_eq!(leased["effect"]["lease"]["leaseId"], "lease-a");
    let running = dispatch(&leased);
    let done = complete(&running, r#"{"approved":true}"#);
    let next = lease(&done);
    assert_eq!(next["effect"]["lease"]["stepId"], "b");
    let reference = &next["effect"]["lease"]["dependencyResultReferences"][0];
    assert_eq!(reference["sessionId"], "session-a");
    assert_eq!(
        reference["fields"],
        json!([{"field":"approved","name":"verdict"}])
    );
}

#[test]
fn checked_completion_rejects_invalid_structured_native_output() {
    let running = dispatch(&lease(&create()));
    let done = complete(&running, "not the required JSON object");
    assert_eq!(done["run"]["status"], "failed");
    assert_eq!(done["run"]["readyTaskIds"], json!([]));
    let snapshot: Value = serde_json::from_str(done["snapshot"].as_str().unwrap()).unwrap();
    assert_eq!(
        snapshot["tasks"][0]["failure"]["code"],
        "result-invalid-json"
    );
}

#[test]
fn human_approval_uses_core_flow_semantics() {
    let mut command = create_command();
    command["definition"]["pipeline"]["steps"][0]["requireApproval"] = true.into();
    let running = dispatch(&lease(&ok(invoke(command))));
    let awaiting = complete(&running, r#"{"approved":true}"#);
    assert_eq!(awaiting["run"]["readyTaskIds"], json!([]));
    let snapshot: Value = serde_json::from_str(awaiting["snapshot"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["tasks"][0]["status"], "awaitingApproval");
    let decided = ok(invoke(
        json!({"type":"controlFlow","state":state(&awaiting),
        "action":{"type":"decide","stepId":"a","taskRevision":snapshot["tasks"][0]["revision"],"approved":true}}),
    ));
    assert_eq!(decided["run"]["readyTaskIds"], json!(["b"]));
}

#[test]
fn a_failed_review_creates_an_explicit_recorded_attempt_without_bypassing_checks() {
    let mut command = create_command();
    command["definition"]["pipeline"]["steps"][1]["resultFields"] =
        json!([{"name":"approved","kind":"boolean"}]);
    command["definition"]["pipeline"]["steps"][1]["review"] =
        json!({"field":"approved","retryFromStepId":"a"});
    let first = dispatch(&lease(&ok(invoke(command))));
    let done = complete(&first, r#"{"approved":true}"#);
    let reviewer = dispatch(&lease(&done));
    let rejected = complete(&reviewer, r#"{"approved":false}"#);
    assert_eq!(rejected["run"]["readyTaskIds"], json!(["a"]));
    let snapshot: Value = serde_json::from_str(rejected["snapshot"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["attempts"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["tasks"][0]["status"], "ready");
    assert!(snapshot["tasks"][0].get("execution").is_none());
}

#[test]
fn program_router_preserves_selected_and_skipped_branches() {
    for approved in [true, false] {
        let mut command = create_command();
        let steps = command["definition"]["pipeline"]["steps"]
            .as_array_mut()
            .unwrap();
        steps[1]["dependencyStepIds"] = json!(["a", "router"]);
        steps[1]["routeGates"] = json!([{"routerStepId":"router","branchId":"yes"}]);
        steps.push(json!({"id":"router","name":"Router","assignedMemberId":"member","instructions":"Route fixture result", "dependencyStepIds":["a"],
            "router":{"mode":"program","inputStepId":"a","branches":[{"id":"yes","label":"Yes","predicate":{"op":"equals","field":"approved","value":true}}]}}));
        let running = dispatch(&lease(&ok(invoke(command))));
        let completed = complete(&running, &json!({"approved":approved}).to_string());
        let advanced = ok(invoke(json!({"type":"advance","state":state(&completed)})));
        assert_eq!(
            advanced["run"]["readyTaskIds"],
            if approved { json!(["b"]) } else { json!([]) }
        );
        if !approved {
            assert_eq!(advanced["run"]["status"], "succeeded");
        }
    }
}

#[test]
fn repeated_input_is_deterministic_but_stale_revision_cannot_commit_again() {
    let created = create();
    let command = json!({"type":"lease","state":state(&created),"leaseId":"once"});
    let first = ok(invoke(command.clone()));
    assert_eq!(first, ok(invoke(command)));
    let mut stale = state(&first);
    stale["expectedRunRevision"] = 0.into();
    let refused = invoke(json!({"type":"lease","state":stale,"leaseId":"second"}));
    assert_eq!(refused["error"]["code"], "revisionConflict");
    assert!(refused.get("snapshot").is_none());
}

#[test]
fn stale_native_execution_and_wrong_lease_cannot_change_the_run() {
    let leased = lease(&create());
    let refused = invoke(
        json!({"type":"dispatch","state":state(&leased),"stepId":"a", "expectedTaskRevision":1,
        "leaseId":"wrong","execution":{"id":"other"}}),
    );
    assert_eq!(refused["error"]["code"], "leaseConflict");
    let running = dispatch(&leased);
    let refused = invoke(
        json!({"type":"completeChecked","state":state(&running),"stepId":"a", "expectedTaskRevision":2,
        "executionId":"old-attempt","outcome":{"status":"failed","failure":{"code":"fixture"}}}),
    );
    assert_eq!(refused["error"]["code"], "staleExecution");
    assert!(refused.get("snapshot").is_none());
}

#[test]
fn restart_preserves_unknown_outcome_until_explicit_replay() {
    for interrupted in [lease(&create()), dispatch(&lease(&create()))] {
        let restored = ok(invoke(
            json!({"type":"restore","state":state(&interrupted)}),
        ));
        assert_eq!(restored["run"]["status"], "uncertain");
        assert_eq!(restored["run"]["readyTaskIds"], json!([]));
        let refused =
            invoke(json!({"type":"lease","state":state(&restored),"leaseId":"never-replay"}));
        assert_eq!(refused["status"], "error");
        let snapshot: Value = serde_json::from_str(restored["snapshot"].as_str().unwrap()).unwrap();
        let retry = ok(invoke(
            json!({"type":"retryUncertain","state":state(&restored),"stepId":"a",
            "expectedTaskRevision":snapshot["tasks"][0]["revision"]}),
        ));
        assert_eq!(retry["run"]["readyTaskIds"], json!(["a"]));
    }
}

#[test]
fn cancellation_returns_exact_native_stop_reference_without_dispatch() {
    let running = dispatch(&lease(&create()));
    let planned = ok(invoke(
        json!({"type":"cancellationRequests","state":state(&running)}),
    ));
    assert_eq!(planned["snapshot"], running["snapshot"]);
    assert_eq!(
        planned["effect"]["requests"],
        json!([{"runId":"run","stepId":"a","execution":{"id":"session-a"}}])
    );
    let cancelled = ok(invoke(json!({"type":"cancel","state":state(&running)})));
    assert_eq!(cancelled["run"]["status"], "cancelled");
    assert_eq!(cancelled["run"]["readyTaskIds"], json!([]));
}

#[test]
fn unsupported_graph_requirements_are_refused_before_any_lease() {
    let mut command = create_command();
    command["definition"]["pipeline"]["steps"][0]["executor"] =
        json!({"type":"script","runtime":"node","source":"1","timeoutSeconds":1});
    assert_eq!(invoke(command)["error"]["code"], "unsupportedExecutor");
    let mut command = create_command();
    command["definition"]["profiles"][0]["allowedSpawnProfileIds"] = json!(["worker"]);
    assert_eq!(invoke(command)["error"]["code"], "unsupportedCapability");
    let mut command = create_command();
    command["definition"]["pipeline"]["steps"][1]["executionMode"] = "callable".into();
    assert_eq!(invoke(command)["error"]["code"], "unsupportedCapability");
    let mut command = create_command();
    command["profileCapabilities"]["worker"]["permissionModes"] = json!([]);
    assert_eq!(invoke(command)["error"]["code"], "unsupportedCapability");
    let mut command = create_command();
    command["profileCapabilities"] = json!({});
    assert_eq!(invoke(command)["error"]["code"], "missingCapabilities");
}

#[test]
fn unsupported_or_unknown_wire_data_is_not_reencoded_or_echoed() {
    let unknown = handle_frame(br#"{"protocol":2,"requestId":"v2","command":{"type":"inspect","state":{"snapshot":"{}","expectedRunRevision":0}}}"#);
    assert_eq!(
        serde_json::to_value(unknown).unwrap()["error"]["code"],
        "unsupportedProtocol"
    );
    let created = create();
    let mut snapshot: Value = serde_json::from_str(created["snapshot"].as_str().unwrap()).unwrap();
    snapshot["schemaVersion"] = 7.into();
    let refused = invoke(
        json!({"type":"inspect","state":{"snapshot":snapshot.to_string(),"expectedRunRevision":0}}),
    );
    assert_eq!(refused["error"]["code"], "unsupportedSnapshotVersion");
    snapshot["schemaVersion"] = 6.into();
    snapshot["unsupportedSecret"] = "do-not-echo".into();
    let refused = invoke(
        json!({"type":"inspect","state":{"snapshot":snapshot.to_string(),"expectedRunRevision":0}}),
    );
    assert_eq!(refused["error"]["code"], "invalidSnapshot");
    assert!(!refused.to_string().contains("do-not-echo"));
    let refused = invoke(
        json!({"type":"controlFlow","state":state(&created),"action":{"type":"pause","unsupported":"do-not-echo"}}),
    );
    assert_eq!(refused["error"]["code"], "invalidRequest");
}

#[test]
fn private_stdio_is_lf_framed_and_recovers_after_an_invalid_frame() {
    let create = json!({"protocol":1,"requestId":"unicode","command":create_command()}).to_string();
    assert!(create.contains('\u{2028}'));
    let input = format!("not JSON\n{create}\n");
    let mut output = Vec::new();
    serve(&mut Cursor::new(input.as_bytes()), &mut output).unwrap();
    let responses: Vec<Value> = output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["error"]["code"], "invalidRequest");
    assert_eq!(responses[1]["status"], "ok");
    let mut output = Vec::new();
    serve(&mut Cursor::new(create.as_bytes()), &mut output).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&output).unwrap()["error"]["code"],
        "invalidRequest"
    );
}
