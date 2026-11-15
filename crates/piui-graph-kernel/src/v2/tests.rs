use std::io::Cursor;

use piui_orchestration::{self as core, Coordinator};
use serde_json::{Value, json};

use super::handle_frame;

const V1: &str = include_str!("../../../../contracts/fixtures/nano-graph-kernel-v1.json");
const LOCAL: &str =
    include_str!("../../../../contracts/fixtures/unified-shell/graph/kernel-v2/create-local.json");
const CLOUD: &str =
    include_str!("../../../../contracts/fixtures/unified-shell/graph/kernel-v2/create-cloud.json");
const REFUSAL: &str =
    include_str!("../../../../contracts/fixtures/unified-shell/graph/kernel-v2/refusal-cloud.json");
const VECTORS: &str =
    include_str!("../../../../contracts/fixtures/unified-shell/graph/compile-vectors-v1.json");

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn invoke(command: Value) -> Value {
    let bytes =
        serde_json::to_vec(&json!({"protocol":2,"requestId":"request","command":command})).unwrap();
    serde_json::to_value(handle_frame(&bytes)).unwrap()
}

fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "ok", "{value}");
    assert_eq!(value["protocol"], 2);
    value
}

/// Refused with `code`, and nothing returned for the host to persist.
fn refused(value: &Value, code: &str) {
    assert_eq!(value["status"], "error", "{value}");
    assert_eq!(value["error"]["code"], code, "{value}");
    assert!(value.get("state").is_none() && value.get("child").is_none());
}

fn binding(response: &Value) -> Value {
    serde_json::from_str(response["state"]["binding"].as_str().unwrap()).unwrap()
}

fn snapshot(response: &Value) -> Value {
    serde_json::from_str(response["state"]["snapshot"].as_str().unwrap()).unwrap()
}

/// The stored pair, with the owner the host authenticated for this command.
fn state(response: &Value) -> Value {
    json!({"snapshot":response["state"]["snapshot"],"binding":response["state"]["binding"],
        "expectedRunRevision":response["run"]["revision"],"owner":binding(response)["owner"]})
}

fn task(response: &Value, step_id: &str) -> Value {
    snapshot(response)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["stepId"] == step_id)
        .cloned()
        .unwrap()
}

fn local() -> Value {
    json!({"location":{"kind":"local"},"scopeId":"project"})
}

fn cloud() -> Value {
    fixture(CLOUD)["command"]["binding"]["owner"].clone()
}

fn every_executor() -> Value {
    json!({"agent":true,"llm":true,"script":true,"plugin":true,"pipeline":true})
}

fn capabilities(mode: &str, operations: bool) -> Value {
    json!({"permissionModes":[mode],"nativeEnforcedTools":[],"coordinatorEnforcedTools":[],
        "agentOperations":{"roster":operations,"send":operations,"observe":operations,"spawn":operations}})
}

fn profile(id: &str, harness: &str, mode: &str, spawns: &[&str]) -> Value {
    json!({"id":id,"name":id,"harness":harness,"model":"native","permissionMode":mode,
        "instructions":"","toolPolicy":{"rules":[]},"allowedSpawnProfileIds":spawns})
}

fn create_command() -> Value {
    fixture(LOCAL)["command"].clone()
}

/// A local run of `definition` with every executor and these capabilities.
fn create_with(definition: Value, profile_capabilities: Value) -> Value {
    json!({"type":"create","runId":"run","definition":definition,
        "binding":{"owner":local(),"executors":every_executor(),"profileCapabilities":profile_capabilities},
        "inputs":{},"usePinnedData":false})
}

fn create() -> Value {
    ok(invoke(create_command()))
}

fn lease(run: &Value, lease_id: &str) -> Value {
    ok(invoke(
        json!({"type":"lease","state":state(run),"leaseId":lease_id}),
    ))
}

fn dispatch(leased: &Value, session: &str) -> Value {
    let lease = &leased["effect"]["lease"];
    ok(invoke(
        json!({"type":"dispatch","state":state(leased),"stepId":lease["stepId"],
        "expectedTaskRevision":lease["taskRevision"],"leaseId":lease["leaseId"],"execution":{"id":session}}),
    ))
}

fn reference(session: &str) -> Value {
    json!({"sessionId":session,"blockId":"block","contentHash":"ab".repeat(32)})
}

fn complete(running: &Value, text: &str) -> Value {
    let launch = &running["effect"]["launch"];
    let session = launch["execution"]["id"].as_str().unwrap();
    ok(invoke(
        json!({"type":"completeChecked","state":state(running),"stepId":launch["stepId"],
        "expectedTaskRevision":launch["taskRevision"],"executionId":session,
        "outcome":{"status":"succeeded","resultReference":reference(session)},"text":text}),
    ))
}

/// Leases, dispatches under `session` and completes the next native step.
fn finish(run: &Value, session: &str, text: &str) -> Value {
    complete(
        &dispatch(&lease(run, &format!("{session}-lease")), session),
        text,
    )
}

#[test]
fn protocol_one_frames_replay_byte_for_byte_through_the_dispatcher() {
    let both = |frame: &[u8]| {
        let old = serde_json::to_vec(&crate::handle_frame(frame)).unwrap();
        let new = serde_json::to_vec(&crate::handle_any_frame(frame)).unwrap();
        assert_eq!(old, new, "{}", String::from_utf8_lossy(frame));
        serde_json::from_slice::<Value>(&new).unwrap()
    };
    let v1 = |command: Value| {
        serde_json::to_vec(&json!({"protocol":1,"requestId":"replay","command":command})).unwrap()
    };
    let state = |run: &Value| json!({"snapshot":run["snapshot"],"expectedRunRevision":run["run"]["revision"]});
    let created = both(V1.as_bytes());
    assert_eq!(
        (created["status"].as_str(), created["protocol"].as_u64()),
        (Some("ok"), Some(1))
    );
    let leased = both(&v1(
        json!({"type":"lease","state":state(&created),"leaseId":"lease"}),
    ));
    let lease = &leased["effect"]["lease"];
    let running = both(&v1(
        json!({"type":"dispatch","state":state(&leased),"stepId":lease["stepId"],
        "expectedTaskRevision":lease["taskRevision"],"leaseId":"lease","execution":{"id":"session-a"}}),
    ));
    let done = both(&v1(
        json!({"type":"completeChecked","state":state(&running),"stepId":"a",
        "expectedTaskRevision":running["effect"]["launch"]["taskRevision"],"executionId":"session-a",
        "outcome":{"status":"succeeded","resultReference":reference("session-a")},"text":"{\"approved\":true}"}),
    ));
    assert_eq!(done["run"]["readyTaskIds"], json!(["b"]));
    both(&v1(
        json!({"type":"cancellationRequests","state":state(&running)}),
    ));
    both(&v1(json!({"type":"restore","state":state(&leased)})));
    both(&v1(json!({"type":"cancel","state":state(&done)})));
    // Every frame that is not one object with `protocol: 2` stays protocol 1.
    for frame in [
        &b"not JSON"[..],
        br#"{"protocol":3,"requestId":"three","command":{"type":"inspect","state":{"snapshot":"{}","expectedRunRevision":0}}}"#,
        br#"{"protocol":"2","requestId":"text","command":{}}"#,
        br#"{"protocol":2.0,"requestId":"float","command":{}}"#,
        br#"{"protocol":1,"protocol":2,"requestId":"repeated","command":{}}"#,
        br#"[2,"array",{"type":"inspect","state":{"snapshot":"{}","expectedRunRevision":0}}]"#,
        br#"{"requestId":"none","command":{}}"#,
        br#"{"protocol":2} trailing"#,
    ] {
        let response = both(frame);
        assert_eq!((response["status"].as_str(), response["protocol"].as_u64()), (Some("error"), Some(1)));
    }
    // The protocol 1 handler itself still refuses protocol 2; the dispatcher
    // hands it to protocol 2 instead.
    let frame = serde_json::to_vec(&json!({"protocol":2,"requestId":"v2",
        "command":{"type":"inspect","state":{"snapshot":"{}","expectedRunRevision":0}}}))
    .unwrap();
    let old = serde_json::to_value(crate::handle_frame(&frame)).unwrap();
    assert_eq!(old["error"]["code"], "unsupportedProtocol");
    let new = serde_json::to_value(crate::handle_any_frame(&frame)).unwrap();
    assert_eq!(
        (new["protocol"].as_u64(), new["error"]["code"].as_str()),
        (Some(2), Some("invalidRequest"))
    );
}

/// The responses of one served input, one JSON value per LF.
fn served(with_protocol_2: bool, input: &str) -> Vec<Value> {
    let mut output = Vec::new();
    let mut input = Cursor::new(input.as_bytes());
    if with_protocol_2 {
        crate::serve_with_protocol_2(&mut input, &mut output).unwrap();
    } else {
        crate::serve(&mut input, &mut output).unwrap();
    }
    output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect()
}

fn summary(responses: &[Value]) -> Vec<(u64, &str, &str)> {
    responses
        .iter()
        .map(|response| {
            (
                response["protocol"].as_u64().unwrap(),
                response["status"].as_str().unwrap(),
                response["error"]["code"].as_str().unwrap_or(""),
            )
        })
        .collect()
}

#[test]
fn without_the_launch_argument_the_kernel_speaks_only_protocol_one() {
    // The existing server probe: the fixture, then the same frame as protocol 2.
    let fixture = fixture(V1);
    let mut unsupported = fixture.clone();
    unsupported["protocol"] = 2.into();
    unsupported["requestId"] = "unsupported".into();
    let probe = format!("{fixture}\n{unsupported}\n");
    let responses = served(false, &probe);
    assert_eq!(
        summary(&responses),
        [(1, "ok", ""), (1, "error", "unsupportedProtocol")]
    );
    let two = json!({"protocol":2,"requestId":"two","command":create_command()}).to_string();
    assert_eq!(
        summary(&served(false, &format!("{two}\n"))),
        [(1, "error", "invalidRequest")]
    );
    // With the argument the same probe frame is a protocol 2 request, and
    // protocol 2 refuses the protocol 1 `profileCapabilities` field.
    let responses = served(true, &probe);
    assert_eq!(
        summary(&responses),
        [(1, "ok", ""), (2, "error", "invalidRequest")]
    );
}

#[test]
fn private_stdio_dispatches_every_lf_frame_by_its_exact_protocol() {
    let one = json!({"protocol":1,"requestId":"one","command":fixture(V1)["command"]}).to_string();
    let two = json!({"protocol":2,"requestId":"two","command":create_command()}).to_string();
    assert!(one.contains('\u{2028}') && two.contains('\u{2028}'));
    let three = one.replacen("\"protocol\":1", "\"protocol\":3", 1);
    let input = format!("{one}\n{two}\nnot JSON\n{three}\n{two}");
    let responses = served(true, &input);
    assert_eq!(
        summary(&responses),
        [
            (1, "ok", ""),
            (2, "ok", ""),
            (1, "error", "invalidRequest"),
            (1, "error", "unsupportedProtocol"),
            // EOF without LF is an invalid frame, whatever it contains.
            (1, "error", "invalidRequest"),
        ]
    );
    assert!(responses[0]["snapshot"].is_string() && responses[0].get("state").is_none());
    assert!(responses[1]["state"]["binding"].is_string() && responses[1].get("snapshot").is_none());
}

#[test]
fn the_committed_fixtures_round_trip_exactly() {
    for (text, owner) in [(LOCAL, local()), (CLOUD, cloud())] {
        let frame = serde_json::to_vec(&fixture(text)).unwrap();
        let created = serde_json::to_value(crate::handle_any_frame(&frame)).unwrap();
        let created = ok(created);
        assert_eq!(created["requestId"], fixture(text)["requestId"]);
        assert_eq!(created["effect"], json!({"type":"created"}));
        assert_eq!(binding(&created)["owner"], owner);
        assert_eq!(lease(&created, "lease")["effect"]["executor"], "agent");
    }
    let refusal = fixture(REFUSAL);
    let frame = serde_json::to_vec(&refusal["request"]).unwrap();
    let response = serde_json::to_value(crate::handle_any_frame(&frame)).unwrap();
    assert_eq!(response, refusal["response"]);
}

#[test]
fn compile_returns_the_shared_compiler_outcome_for_every_vector() {
    let corpus = fixture(VECTORS);
    let identity: core::CompileIdentity =
        serde_json::from_value(corpus["identity"].clone()).unwrap();
    let vectors = corpus["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 49);
    for vector in vectors {
        let id = &vector["id"];
        let response = ok(invoke(
            json!({"type":"compile","document":vector["document"],"identity":corpus["identity"],
            "pipelines":vector["pipelines"]}),
        ));
        assert!(response.get("state").is_none() && response.get("run").is_none());
        assert_eq!(response["effect"]["type"], "compiled");
        let result = &response["effect"]["result"];
        assert_eq!(result["outcome"], vector["rust"]["outcome"], "{id}");
        let pipelines: Vec<core::PipelineName> =
            serde_json::from_value(vector["pipelines"].clone()).unwrap();
        match core::compile_system_document(
            vector["document"].as_str().unwrap(),
            &identity,
            &pipelines,
        ) {
            Ok(definition) => {
                assert_eq!(
                    result["definition"],
                    serde_json::to_value(definition).unwrap(),
                    "{id}"
                );
            }
            Err(error) => {
                assert_eq!(result["refusal"], vector["rust"]["refusal"], "{id}");
                assert_eq!(
                    result["refusal"],
                    serde_json::to_value(error.refusal()).unwrap()
                );
            }
        }
    }
}

#[test]
fn a_compiled_definition_grants_nothing_until_the_host_binds_it() {
    let corpus = fixture(VECTORS);
    let vector = &corpus["vectors"][0];
    assert_eq!(vector["id"], "example-single");
    let compiled = ok(invoke(
        json!({"type":"compile","document":vector["document"],"identity":corpus["identity"],"pipelines":[]}),
    ));
    let definition = compiled["effect"]["result"]["definition"].clone();
    let profiles = definition["profiles"].as_array().unwrap();
    let mut proved = serde_json::Map::new();
    for profile in profiles {
        proved.insert(
            profile["id"].as_str().unwrap().to_owned(),
            capabilities(profile["permissionMode"].as_str().unwrap(), false),
        );
    }
    let refusal = invoke(create_with(definition.clone(), json!({})));
    refused(&refusal, "admissionRefused");
    assert_eq!(
        refusal["error"]["refusals"][0]["code"],
        "missingCapabilities"
    );
    let created = ok(invoke(create_with(definition, Value::Object(proved))));
    assert_eq!(binding(&created)["ancestry"], json!([]));
}

#[test]
fn the_frozen_binding_is_returned_unchanged_by_every_transition() {
    let created = create();
    let frozen = created["state"]["binding"].clone();
    assert_eq!(
        binding(&created),
        json!({"bindingVersion":1,"runId":"run","owner":local(),"executors":every_executor(),
            "profileCapabilities":create_command()["binding"]["profileCapabilities"],"ancestry":[]})
    );
    let inspected = ok(invoke(json!({"type":"inspect","state":state(&created)})));
    assert_eq!(inspected["state"], created["state"]);
    assert_eq!(inspected["effect"], json!({"type":"observed"}));
    let leased = lease(&created, "lease-a");
    assert_eq!(leased["effect"]["executor"], "agent");
    let running = dispatch(&leased, "session-a");
    let done = complete(&running, r#"{"approved":true}"#);
    let next = lease(&done, "lease-b");
    let restored = ok(invoke(json!({"type":"restore","state":state(&next)})));
    assert_eq!(restored["run"]["status"], "uncertain");
    let retried = ok(invoke(
        json!({"type":"retryUncertain","state":state(&restored),"stepId":"b",
        "expectedTaskRevision":task(&restored, "b")["revision"]}),
    ));
    assert_eq!(retried["run"]["readyTaskIds"], json!(["b"]));
    for response in [
        &inspected, &leased, &running, &done, &next, &restored, &retried,
    ] {
        assert_eq!(response["state"]["binding"], frozen);
    }
    // A reload is the stored pair again: the same command, the same answer.
    let again = json!({"type":"lease","state":state(&retried),"leaseId":"lease-c"});
    assert_eq!(ok(invoke(again.clone())), ok(invoke(again)));
}

#[test]
fn another_owner_or_a_changed_binding_is_refused_before_any_effect() {
    let created = create();
    let lease_with = |state: Value| invoke(json!({"type":"lease","state":state,"leaseId":"lease"}));
    let mut other = state(&created);
    other["owner"]["scopeId"] = "another-project".into();
    refused(&lease_with(other), "ownerMismatch");
    let mut other = state(&created);
    other["owner"] = cloud();
    refused(&lease_with(other), "ownerMismatch");

    let mut foreign = create_command();
    foreign["runId"] = "another-run".into();
    let foreign = ok(invoke(foreign));
    let mut other = state(&created);
    other["binding"] = foreign["state"]["binding"].clone();
    refused(&lease_with(other), "invalidBinding");
    let mut other = state(&foreign);
    other["snapshot"] = created["state"]["snapshot"].clone();
    refused(&lease_with(other), "invalidBinding");

    let edited = |change: &dyn Fn(&mut Value)| {
        let mut value = binding(&created);
        change(&mut value);
        let mut other = state(&created);
        other["binding"] = value.to_string().into();
        lease_with(other)
    };
    refused(
        &edited(&|b| b["bindingVersion"] = 2.into()),
        "unsupportedBindingVersion",
    );
    refused(&edited(&|b| b["unknown"] = true.into()), "invalidBinding");
    refused(
        &edited(&|b| b["owner"]["scopeId"] = " ".into()),
        "invalidBinding",
    );
    refused(
        &edited(&|b| b["profileCapabilities"]["stranger"] = capabilities("native", false)),
        "invalidBinding",
    );
    // Without the adapter's proof or the executor the frozen graph is not
    // admitted again.
    let missing = edited(&|b| b["profileCapabilities"] = json!({}));
    refused(&missing, "admissionRefused");
    assert_eq!(
        missing["error"]["refusals"],
        json!([{"code":"missingCapabilities","subject":{"kind":"profile","id":"worker"}}])
    );
    refused(
        &edited(&|b| b["executors"]["agent"] = false.into()),
        "admissionRefused",
    );
    let mut other = state(&created);
    other["binding"] = "not JSON".into();
    refused(&lease_with(other), "invalidBinding");

    let first = lease(&created, "first");
    let mut stale = state(&first);
    stale["expectedRunRevision"] = created["run"]["revision"].clone();
    refused(&lease_with(stale), "revisionConflict");

    // A host cannot create a binding that names another profile or no owner.
    let mut command = create_command();
    command["binding"]["profileCapabilities"]["stranger"] = capabilities("native", false);
    refused(&invoke(command), "invalidRequest");
    let mut command = fixture(CLOUD)["command"].clone();
    command["binding"]["owner"]["location"]["accountId"] = "".into();
    refused(&invoke(command), "invalidRequest");
    let mut command = create_command();
    command["binding"]["owner"]["location"] = json!({"kind":"device","deviceId":"desk"});
    refused(&invoke(command), "invalidRequest");
}

#[test]
fn a_cloud_binding_admits_only_the_executors_its_host_declared() {
    for (executor, field) in [
        (json!({"type":"llm"}), "llm"),
        (
            json!({"type":"script","runtime":"node","source":"1","timeoutSeconds":1}),
            "script",
        ),
        (
            json!({"type":"plugin","pluginId":"acme.tools","nodeType":"lint","config":{}}),
            "plugin",
        ),
        (
            json!({"type":"pipeline","launchCommandId":"child","inputs":{}}),
            "pipeline",
        ),
    ] {
        let mut command = fixture(CLOUD)["command"].clone();
        command["definition"]["pipeline"]["steps"][1]["executor"] = executor;
        if field != "llm" {
            command["definition"]["pipeline"]["steps"][1]["assignedMemberId"] = "host".into();
        }
        let response = invoke(command.clone());
        refused(&response, "admissionRefused");
        assert_eq!(
            response["error"]["refusals"],
            json!([{"code":"unsupportedExecutor","subject":{"kind":"step","id":"b"}}]),
            "{field}"
        );
        assert_eq!(command["binding"]["executors"][field], false);
    }
}

/// An edit of a create command.
type Change = Box<dyn Fn(&mut Value)>;

#[test]
fn every_protocol_one_refusal_is_a_typed_admission_refusal() {
    let v1 = fixture(V1)["command"].clone();
    let v1_binding = json!({"owner":local(),
        "executors":{"agent":true,"llm":true,"script":false,"plugin":false,"pipeline":false},
        "profileCapabilities":v1["profileCapabilities"]});
    let create = |change: &dyn Fn(&mut Value)| {
        let mut command = v1.clone();
        command["binding"] = v1_binding.clone();
        command
            .as_object_mut()
            .unwrap()
            .remove("profileCapabilities");
        change(&mut command);
        command
    };
    let worker = json!({"kind":"profile","id":"worker"});
    let cases: Vec<(Change, Value)> = vec![
        (
            Box::new(|c: &mut Value| {
                c["definition"]["pipeline"]["steps"][0]["executor"] =
                    json!({"type":"script","runtime":"node","source":"1","timeoutSeconds":1});
                c["definition"]["pipeline"]["steps"][0]["assignedMemberId"] = "host".into();
            }),
            json!([{"code":"unsupportedExecutor","subject":{"kind":"step","id":"a"}}]),
        ),
        (
            Box::new(|c: &mut Value| {
                c["definition"]["profiles"][0]["allowedSpawnProfileIds"] = json!(["worker"]);
            }),
            json!([{"code":"unsupportedCapability","subject":worker}]),
        ),
        (
            Box::new(|c: &mut Value| {
                c["definition"]["pipeline"]["steps"][1]["executionMode"] = "callable".into();
            }),
            json!([{"code":"delegationDenied","subject":{"kind":"step","id":"b"}}]),
        ),
        (
            Box::new(|c: &mut Value| {
                c["binding"]["profileCapabilities"]["worker"]["permissionModes"] = json!([]);
            }),
            json!([{"code":"unsupportedCapability","subject":worker}]),
        ),
        (
            Box::new(|c: &mut Value| c["binding"]["profileCapabilities"] = json!({})),
            json!([{"code":"missingCapabilities","subject":worker}]),
        ),
        (
            Box::new(|c: &mut Value| {
                c["definition"]["team"]["sendEdges"] =
                    json!([{"fromMemberId":"member","toMemberId":"member"}]);
            }),
            json!([{"code":"unsupportedCapability","subject":
                {"kind":"sendEdge","fromMemberId":"member","toMemberId":"member"}}]),
        ),
        (
            Box::new(|c: &mut Value| {
                c["definition"]["team"]["spawnedAgentsJoinTeam"] = true.into()
            }),
            json!([{"code":"unsupportedCapability","subject":{"kind":"team","id":"team"}}]),
        ),
    ];
    for (change, expected) in cases {
        let command = create(&*change);
        let response = invoke(command.clone());
        refused(&response, "admissionRefused");
        assert_eq!(response["error"]["refusals"], expected);
        // A host asks for the same list before a launch.
        assert_eq!(validated(&command), expected);
    }
    ok(invoke(create(&|_| {})));
    assert_eq!(validated(&create(&|_| {})), json!([]));
}

/// The refusals `validate` lists for the definition and binding facts of a
/// create command, with nothing returned for the host to persist.
fn validated(create: &Value) -> Value {
    let response = ok(invoke(
        json!({"type":"validate","definition":create["definition"],"binding":create["binding"]}),
    ));
    assert!(
        ["state", "run", "child"]
            .iter()
            .all(|field| response.get(field).is_none())
    );
    assert_eq!(response["effect"]["type"], "validated");
    response["effect"]["refusals"].clone()
}

#[test]
fn validate_lists_the_refusals_of_create_without_a_run_or_its_inputs() {
    let refusal = fixture(REFUSAL);
    assert_eq!(
        validated(&refusal["request"]["command"]),
        refusal["response"]["error"]["refusals"]
    );
    assert_eq!(validated(&fixture(LOCAL)["command"]), json!([]));
    assert_eq!(validated(&fixture(CLOUD)["command"]), json!([]));

    // Run inputs are the host's at launch: a required one does not block it.
    let mut command = create_command();
    command["definition"]["pipeline"]["inputs"] =
        json!([{"name":"topic","label":"Topic","kind":"text","required":true}]);
    refused(&invoke(command.clone()), "invalidDefinition");
    assert_eq!(validated(&command), json!([]));
    let mut with_inputs = json!({"type":"validate","definition":command["definition"],
        "binding":command["binding"]});
    with_inputs["inputs"] = json!({});
    refused(&invoke(with_inputs), "invalidRequest");

    // The binding facts are checked exactly as `create` checks them.
    let changes: [fn(&mut Value); 2] = [
        |command| command["binding"]["owner"]["scopeId"] = " ".into(),
        |command| {
            command["binding"]["profileCapabilities"]["ghost"] = capabilities("native", false)
        },
    ];
    for change in changes {
        let mut command = create_command();
        change(&mut command);
        refused(&invoke(command.clone()), "invalidRequest");
        let response = invoke(
            json!({"type":"validate","definition":command["definition"],"binding":command["binding"]}),
        );
        refused(&response, "invalidRequest");
    }
}

/// A lead that sends to and observes a peer and may spawn a reviewer role.
fn team_definition() -> Value {
    json!({
        "profiles":[profile("lead","codex","native",&["reviewer"]), profile("reviewer","codex","native",&[])],
        "team":{"id":"team","name":"Team",
            "members":[{"id":"lead","profileId":"lead"},{"id":"peer","profileId":"reviewer"},{"id":"reviewer","profileId":"reviewer"}],
            "sendEdges":[{"fromMemberId":"lead","toMemberId":"peer"}],
            "observeEdges":[{"fromMemberId":"lead","toMemberId":"peer"}],"orchestratorMemberId":"lead"},
        "pipeline":{"id":"pipeline","name":"Pipeline","steps":[
            {"id":"a-work","name":"Work","assignedMemberId":"lead","instructions":"Work","dependencyStepIds":[]},
            {"id":"b-peer","name":"Peer","assignedMemberId":"peer","instructions":"Peer work","dependencyStepIds":[]},
            {"id":"review","name":"Review","assignedMemberId":"reviewer","instructions":"Review",
             "inputInstructions":"Changed paths","executionMode":"callable","dependencyStepIds":[]}
        ]}
    })
}

fn team_run() -> Value {
    let created = ok(invoke(create_with(
        team_definition(),
        json!({"lead":capabilities("native", true),"reviewer":capabilities("native", false)}),
    )));
    dispatch(&lease(&created, "lead-lease"), "lead-session")
}

fn agent(run: &Value, actor: &str, request_id: &str, operation: Value) -> Value {
    invoke(
        json!({"type":"agentRequest","state":state(run),"actorExecutionId":actor,
        "request":{"requestId":request_id,"operation":operation}}),
    )
}

fn agent_refused(response: &Value, disposition: &str, reason: &str) {
    refused(response, "agentRequestRefused");
    assert_eq!(
        response["error"]["agentRequest"],
        json!({"disposition":disposition,"reason":reason})
    );
}

#[test]
fn coordinator_operations_follow_frozen_routes_and_retries_keep_their_identity() {
    let running = team_run();
    let roster = ok(agent(
        &running,
        "lead-session",
        "roster",
        json!({"type":"roster"}),
    ));
    let admission = &roster["effect"]["admission"];
    assert_eq!(admission["type"], "roster");
    assert_eq!(
        admission["members"],
        json!([{"memberId":"peer","profileId":"reviewer","harness":"codex","canSend":true,"canObserve":true}])
    );
    assert_eq!(admission["spawnProfiles"][0]["id"], "reviewer");

    let send = json!({"type":"send","recipientMemberId":"peer","body":"hello"});
    let sent = ok(agent(&roster, "lead-session", "send-1", send.clone()));
    let message = sent["effect"]["admission"].clone();
    assert_eq!(
        (
            message["type"].as_str(),
            message["alreadyDelivered"].as_bool()
        ),
        (Some("send"), Some(false))
    );
    let retried = ok(agent(&sent, "lead-session", "send-1", send.clone()));
    assert_eq!(retried["effect"]["admission"], message);
    let delivered = ok(invoke(
        json!({"type":"markMessageDelivered","state":state(&retried),"messageId":message["messageId"]}),
    ));
    let replay = ok(agent(&delivered, "lead-session", "send-1", send.clone()));
    assert_eq!(
        replay["effect"]["admission"]["messageId"],
        message["messageId"]
    );
    assert_eq!(replay["effect"]["admission"]["alreadyDelivered"], true);
    // Another body under the same request id is a conflict, never a resend.
    agent_refused(
        &agent(
            &delivered,
            "lead-session",
            "send-1",
            json!({"type":"send","recipientMemberId":"peer","body":"changed"}),
        ),
        "conflict",
        "messageConflict",
    );

    let observed = ok(agent(
        &delivered,
        "lead-session",
        "observe",
        json!({"type":"observe","targetMemberId":"peer"}),
    ));
    assert_eq!(
        observed["effect"]["admission"],
        json!({"type":"observe","memberId":"peer","historyReferences":[]})
    );

    // Routes, actors and adapter offers come from the frozen run only.
    agent_refused(
        &agent(
            &delivered,
            "lead-session",
            "route",
            json!({"type":"send","recipientMemberId":"reviewer","body":"hello"}),
        ),
        "denied",
        "routeDenied",
    );
    agent_refused(
        &agent(&delivered, "nobody", "who", json!({"type":"roster"})),
        "denied",
        "unknownActor",
    );
    agent_refused(
        &agent(&delivered, "lead-session", " ", json!({"type":"roster"})),
        "invalid",
        "emptyRequestId",
    );
    let peer = dispatch(&lease(&delivered, "peer-lease"), "peer-session");
    agent_refused(
        &agent(&peer, "peer-session", "peer", json!({"type":"roster"})),
        "denied",
        "operationUnavailable",
    );
}

#[test]
fn a_spawned_role_is_admitted_once_and_its_retry_names_the_same_execution() {
    let running = team_run();
    let spawn = json!({"type":"spawn","stepId":"review"});
    let admitted = ok(agent(&running, "lead-session", "spawn-1", spawn.clone()));
    let lease = &admitted["effect"]["admission"]["lease"];
    assert_eq!(admitted["effect"]["admission"]["type"], "spawn");
    assert_eq!(
        (lease["stepId"].as_str(), lease["profile"]["id"].as_str()),
        (Some("review"), Some("reviewer"))
    );
    let again = ok(agent(&running, "lead-session", "spawn-1", spawn.clone()));
    assert_eq!(
        again, admitted,
        "a retry of the stored state is deterministic"
    );
    let spawned = ok(invoke(
        json!({"type":"dispatch","state":state(&admitted),"stepId":"review",
        "expectedTaskRevision":lease["taskRevision"],"leaseId":lease["leaseId"],"execution":{"id":"review-session"}}),
    ));
    let committed = ok(agent(&spawned, "lead-session", "spawn-1", spawn));
    assert_eq!(
        committed["effect"]["admission"],
        json!({"type":"spawnCommitted","stepId":"review","memberId":"reviewer","execution":{"id":"review-session"}})
    );
    // An undeclared profile is never spawned.
    agent_refused(
        &agent(
            &spawned,
            "lead-session",
            "spawn-lead",
            json!({"type":"spawnAgent","profileId":"lead","name":"Copy","instructions":"Work"}),
        ),
        "denied",
        "spawnAgentRefused",
    );
}

#[test]
fn delegation_never_escalates_and_unlike_native_defaults_are_incomparable() {
    // hermes → codex: native defaults of unlike adapters are never compared.
    let mut definition = team_definition();
    definition["profiles"][0]["harness"] = "hermes".into();
    let response = invoke(create_with(
        definition,
        json!({"lead":capabilities("native", true),"reviewer":capabilities("native", false)}),
    ));
    refused(&response, "admissionRefused");
    assert_eq!(
        response["error"]["refusals"],
        json!([{"code":"delegationDenied","subject":{"kind":"profile","id":"lead"}},
            {"code":"delegationDenied","subject":{"kind":"step","id":"review"}}])
    );
    // workspace-write → full-access is an escalation.
    let mut definition = team_definition();
    definition["profiles"][0]["permissionMode"] = "workspace-write".into();
    definition["profiles"][1]["permissionMode"] = "full-access".into();
    let response = invoke(create_with(
        definition,
        json!({"lead":capabilities("workspace-write", true),"reviewer":capabilities("full-access", false)}),
    ));
    refused(&response, "admissionRefused");
    assert_eq!(response["error"]["refusals"][0]["code"], "delegationDenied");
    // A grant the lead's adapter cannot perform is unsupported, not ignored.
    let response = invoke(create_with(
        team_definition(),
        json!({"lead":capabilities("native", false),"reviewer":capabilities("native", false)}),
    ));
    refused(&response, "admissionRefused");
    let codes: Vec<&str> = response["error"]["refusals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|refusal| refusal["code"].as_str().unwrap())
        .collect();
    assert!(
        codes.iter().all(|code| *code == "unsupportedCapability"),
        "{codes:?}"
    );
}

/// A planner on hermes hands its result to a coder on codex.
fn cross_harness() -> Value {
    json!({
        "profiles":[profile("planner","hermes","native",&[]), profile("coder","codex","native",&[])],
        "team":{"id":"team","name":"Team","members":[{"id":"planner","profileId":"planner"},{"id":"coder","profileId":"coder"}],
            "sendEdges":[],"observeEdges":[],"orchestratorMemberId":"planner"},
        "pipeline":{"id":"pipeline","name":"Pipeline","steps":[
            {"id":"plan","name":"Plan","assignedMemberId":"planner","instructions":"Plan","dependencyStepIds":[]},
            {"id":"code","name":"Code","assignedMemberId":"coder","instructions":"Code","dependencyStepIds":["plan"]}
        ]}
    })
}

#[test]
fn a_cross_harness_result_is_a_reference_and_foreign_references_are_refused() {
    let created = ok(invoke(create_with(
        cross_harness(),
        json!({"planner":capabilities("native", false),"coder":capabilities("native", false)}),
    )));
    let planned = finish(&created, "plan-session", "The plan");
    let leased = lease(&planned, "code-lease");
    let lease = &leased["effect"]["lease"];
    assert_eq!(
        (
            lease["stepId"].as_str(),
            lease["profile"]["harness"].as_str()
        ),
        (Some("code"), Some("codex"))
    );
    assert_eq!(
        lease["dependencyResultReferences"],
        json!([reference("plan-session")])
    );
    let running = dispatch(&leased, "code-session");
    let launch = &running["effect"]["launch"];
    let foreign = invoke(
        json!({"type":"completeChecked","state":state(&running),"stepId":"code",
        "expectedTaskRevision":launch["taskRevision"],"executionId":"code-session",
        "outcome":{"status":"succeeded","resultReference":reference("plan-session")},"text":"Done"}),
    );
    refused(&foreign, "foreignHistoryReference");
    // After a restart the outcome is unknown until the host reconciles it,
    // with a reference of this execution only.
    let restored = ok(invoke(json!({"type":"restore","state":state(&running)})));
    let revision = task(&restored, "code")["revision"].clone();
    let reconcile = |session: &str| {
        invoke(
            json!({"type":"reconcile","state":state(&restored),"stepId":"code",
            "expectedTaskRevision":revision,
            "resolution":{"status":"succeeded","resultReference":reference(session)}}),
        )
    };
    refused(&reconcile("plan-session"), "foreignHistoryReference");
    let reconciled = ok(reconcile("code-session"));
    assert_eq!(reconciled["run"]["status"], "succeeded");
}

#[test]
fn an_unknown_outcome_is_preserved_until_an_explicit_retry() {
    for interrupted in [
        lease(&create(), "lease"),
        dispatch(&lease(&create(), "lease"), "session-a"),
    ] {
        let restored = ok(invoke(
            json!({"type":"restore","state":state(&interrupted)}),
        ));
        assert_eq!(restored["run"]["status"], "uncertain");
        assert_eq!(restored["run"]["readyTaskIds"], json!([]));
        assert_eq!(
            restored["state"]["binding"],
            interrupted["state"]["binding"]
        );
        let refusal = invoke(json!({"type":"lease","state":state(&restored),"leaseId":"never"}));
        refused(&refusal, "invalidTransition");
        let retried = ok(invoke(
            json!({"type":"retryUncertain","state":state(&restored),"stepId":"a",
            "expectedTaskRevision":task(&restored, "a")["revision"]}),
        ));
        assert_eq!(retried["run"]["readyTaskIds"], json!(["a"]));
    }
}

/// `first` (script) → `second` (plugin) → `third` (llm, read-only reader).
fn host_steps() -> Value {
    json!({
        "profiles":[profile("reader","codex","read-only",&[])],
        "team":{"id":"team","name":"Team","members":[{"id":"reader","profileId":"reader"}],
            "sendEdges":[],"observeEdges":[],"orchestratorMemberId":"reader"},
        "pipeline":{"id":"pipeline","name":"Pipeline","steps":[
            {"id":"first","name":"First","assignedMemberId":"host","instructions":"",
             "executor":{"type":"script","runtime":"node","source":"process.stdout.write('{}')","timeoutSeconds":5},
             "dependencyStepIds":[]},
            {"id":"second","name":"Second","assignedMemberId":"host","instructions":"",
             "executor":{"type":"plugin","pluginId":"acme.tools","nodeType":"lint","config":{"strict":true}},
             "dependencyStepIds":["first"]},
            {"id":"third","name":"Third","assignedMemberId":"reader","instructions":"Summarize",
             "executor":{"type":"llm"},"dependencyStepIds":["second"]}
        ]}
    })
}

fn host_dispatch(leased: &Value, execution: &str) -> Value {
    let lease = &leased["effect"]["lease"];
    invoke(
        json!({"type":"dispatchHostStep","state":state(leased),"stepId":lease["stepId"],
        "expectedTaskRevision":lease["taskRevision"],"leaseId":lease["leaseId"],"execution":{"id":execution}}),
    )
}

fn host_complete(running: &Value, step_id: &str, execution: &str, stdout: &str) -> Value {
    ok(invoke(
        json!({"type":"completeHostStep","state":state(running),"stepId":step_id,
        "expectedTaskRevision":task(running, step_id)["revision"],"executionId":execution,
        "completion":{"status":"exited","stdout":stdout,"truncated":false}}),
    ))
}

#[test]
fn host_steps_are_leased_by_executor_and_performed_only_by_the_host() {
    let created = ok(invoke(create_with(
        host_steps(),
        json!({"reader":capabilities("read-only", false)}),
    )));
    let script = lease(&created, "script-lease");
    assert_eq!(script["effect"]["type"], "scriptLeased");
    assert_eq!(script["effect"]["lease"]["runtime"], "node");
    // A native dispatch of host work is refused; the host dispatches it.
    let native = invoke(
        json!({"type":"dispatch","state":state(&script),"stepId":"first",
        "expectedTaskRevision":script["effect"]["lease"]["taskRevision"],"leaseId":"script-lease","execution":{"id":"x"}}),
    );
    refused(&native, "executorMismatch");
    let started = ok(host_dispatch(&script, "process-1"));
    assert_eq!(
        started["effect"],
        json!({"type":"hostDispatched","stepId":"first","executor":"script","execution":{"id":"process-1"}})
    );
    let cancellations = ok(invoke(
        json!({"type":"cancellationRequests","state":state(&started)}),
    ));
    assert_eq!(
        cancellations["effect"]["requests"],
        json!([{"runId":"run","stepId":"first","executor":"script","execution":{"id":"process-1"}}])
    );
    let first = host_complete(&started, "first", "process-1", r#"{"checked":3}"#);
    let plugin = lease(&first, "plugin-lease");
    assert_eq!(plugin["effect"]["type"], "pluginLeased");
    assert_eq!(plugin["effect"]["lease"]["config"], json!({"strict":true}));
    assert_eq!(
        plugin["effect"]["lease"]["dependencies"],
        json!([{"stepId":"first","data":{"checked":3}}])
    );
    let started = ok(host_dispatch(&plugin, "node-1"));
    assert_eq!(started["effect"]["executor"], "plugin");
    let second = host_complete(&started, "second", "node-1", "lint clean");
    let llm = lease(&second, "llm-lease");
    assert_eq!(llm["effect"]["executor"], "llm");
    refused(&host_dispatch(&llm, "process-2"), "executorMismatch");
    // A certain host refusal before anything started fails the step.
    let script = lease(
        &ok(invoke(create_with(
            host_steps(),
            json!({"reader":capabilities("read-only", false)}),
        ))),
        "again",
    );
    let rejected = ok(invoke(
        json!({"type":"rejectLeased","state":state(&script),"stepId":"first",
        "expectedTaskRevision":script["effect"]["lease"]["taskRevision"],"leaseId":"again",
        "failure":{"code":"script-runtime-unavailable"}}),
    ));
    assert_eq!(rejected["run"]["status"], "failed");
    assert_eq!(
        task(&rejected, "first")["failure"]["code"],
        "script-runtime-unavailable"
    );
    // An unsupported capability of the bound adapter refuses the native lease.
    let mut changed = binding(&second);
    changed["profileCapabilities"]["reader"]["permissionModes"] = json!(["native"]);
    let mut stored = state(&second);
    stored["binding"] = changed.to_string().into();
    let refusal = invoke(json!({"type":"lease","state":stored,"leaseId":"llm"}));
    refused(&refusal, "admissionRefused");
    assert_eq!(
        refusal["error"]["refusals"][0]["code"],
        "unsupportedCapability"
    );
}

fn worker() -> Value {
    profile("worker", "codex", "read-only", &[])
}

fn launch(id: &str, pipeline_id: &str) -> Value {
    json!({"id":id,"name":id,"teamId":"team","pipelineId":pipeline_id})
}

/// agent `collect` → sub-pipeline `test` (launch command `testing`).
fn parent() -> Value {
    json!({
        "profiles":[worker()],
        "team":{"id":"team","name":"Team","members":[{"id":"collector","profileId":"worker"}],
            "sendEdges":[],"observeEdges":[],"orchestratorMemberId":"collector"},
        "pipeline":{"id":"development","name":"Development",
            "inputs":[{"name":"branch","label":"Branch","kind":"text"}],
            "steps":[
                {"id":"collect","name":"Collect","assignedMemberId":"collector","instructions":"Collect.","dependencyStepIds":[]},
                {"id":"test","name":"Test","assignedMemberId":"test","instructions":"",
                 "executor":{"type":"pipeline","launchCommandId":"testing","inputs":{
                     "branch":{"kind":"input","name":"branch"},"notes":{"kind":"step","stepId":"collect"}}},
                 "resultFields":[{"name":"passed","kind":"boolean"}],"dependencyStepIds":["collect"]}
            ]},
        "launchCommand":launch("developing", "development")
    })
}

/// The `testing` child: `summary` and `unit`, with two declared outputs.
fn child(steps: Value) -> Value {
    json!({
        "profiles":[worker()],
        "team":{"id":"team","name":"Team","members":[{"id":"tester","profileId":"worker"}],
            "sendEdges":[],"observeEdges":[],"orchestratorMemberId":"tester"},
        "pipeline":{"id":"testing","name":"Testing",
            "inputs":[{"name":"branch","label":"Branch","kind":"text"},{"name":"notes","label":"Notes","kind":"text"}],
            "steps":steps,
            "outputs":[{"name":"passed","kind":"boolean","sourceStepId":"unit","field":"passed"},
                {"name":"report","kind":"text","sourceStepId":"summary"}]},
        "launchCommand":launch("testing", "testing")
    })
}

fn child_steps() -> Value {
    json!([
        {"id":"summary","name":"Summary","assignedMemberId":"tester","instructions":"Sum up.","dependencyStepIds":[]},
        {"id":"unit","name":"Unit","assignedMemberId":"tester","instructions":"Test.",
         "resultFields":[{"name":"passed","kind":"boolean"}],"dependencyStepIds":[]}
    ])
}

fn worker_capabilities() -> Value {
    json!({"worker":capabilities("read-only", false)})
}

fn start(leased: &Value, child_run_id: &str, child: Value, extra: Value) -> Value {
    let lease = &leased["effect"]["lease"];
    let mut command = json!({"type":"startPipelineChild","state":state(leased),"stepId":lease["stepId"],
        "expectedTaskRevision":lease["taskRevision"],"leaseId":lease["leaseId"],"childRunId":child_run_id,
        "child":{"definition":child,"profileCapabilities":worker_capabilities()}});
    for (key, value) in extra.as_object().unwrap() {
        command[key] = value.clone();
    }
    invoke(command)
}

fn child_refused(response: &Value, failure: &str) {
    refused(response, "childRefused");
    assert_eq!(response["error"]["failure"]["code"], failure, "{response}");
}

/// The parent with `collect` done and `test` leased.
fn leased_parent() -> Value {
    let mut command = create_with(parent(), worker_capabilities());
    command["inputs"] = json!({"branch":"main"});
    let created = ok(invoke(command));
    let collected = finish(&created, "collect-session", "Three notes");
    let leased = lease(&collected, "test-lease");
    assert_eq!(leased["effect"]["type"], "pipelineLeased");
    leased
}

#[test]
fn a_sub_pipeline_child_starts_with_the_parent_dispatch_and_frozen_ancestry() {
    let leased = leased_parent();
    let lease = &leased["effect"]["lease"];
    assert_eq!(lease["launchCommandId"], "testing");
    assert_eq!(
        lease["requiredTexts"],
        json!([{"stepId":"collect","reference":reference("collect-session")}])
    );
    let notes = json!({"resolvedTexts":{"collect":"Three notes"}});
    // Native texts are resolved by the host, exactly the listed ones.
    child_refused(
        &start(&leased, "child", child(child_steps()), json!({})),
        core::SUBPIPELINE_INPUT_UNAVAILABLE,
    );
    refused(
        &start(
            &leased,
            "child",
            child(child_steps()),
            json!({"resolvedTexts":{"collect":"x","other":"y"}}),
        ),
        "invalidRequest",
    );
    let mut other = child(child_steps());
    other["launchCommand"] = launch("other", "testing");
    refused(
        &start(&leased, "child", other, notes.clone()),
        "invalidRequest",
    );
    refused(
        &start(&leased, " ", child(child_steps()), notes.clone()),
        "invalidRequest",
    );
    // A child that the frozen binding cannot run is a certain refusal.
    let missing = start(
        &leased,
        "child",
        child(child_steps()),
        json!({"resolvedTexts":{"collect":"Three notes"},
            "child":{"definition":child(child_steps()),"profileCapabilities":{}}}),
    );
    child_refused(&missing, core::SUBPIPELINE_UNAVAILABLE);
    assert_eq!(
        missing["error"]["refusals"][0]["code"],
        "missingCapabilities"
    );
    let mut undeclared = child(child_steps());
    undeclared["pipeline"]["inputs"] = json!([{"name":"branch","label":"Branch","kind":"text"}]);
    child_refused(
        &start(&leased, "child", undeclared, notes.clone()),
        core::SUBPIPELINE_INPUT_INVALID,
    );

    let started = ok(start(&leased, "child", child(child_steps()), notes));
    assert_eq!(
        started["effect"],
        json!({"type":"childStarted","stepId":"test","childRunId":"child"})
    );
    assert_eq!(started["state"]["binding"], leased["state"]["binding"]);
    assert_eq!(task(&started, "test")["execution"], json!({"id":"child"}));
    let child_state = json!({"state":started["child"]["state"],"run":started["child"]["run"]});
    let frozen = binding(&child_state);
    assert_eq!(frozen["owner"], local());
    assert_eq!(frozen["runId"], "child");
    assert_eq!(frozen["ancestry"], json!(["developing"]));
    let child_snapshot = snapshot(&child_state);
    assert_eq!(
        child_snapshot["trigger"],
        json!({"kind":"pipeline","parentRunId":"run","parentStepId":"test","launchCommandId":"testing","depth":1})
    );
    assert_eq!(
        child_snapshot["inputs"],
        json!({"branch":"main","notes":"Three notes"})
    );
    // The parent cancels a running child through its execution reference.
    let cancellations = ok(invoke(
        json!({"type":"cancellationRequests","state":state(&started)}),
    ));
    assert_eq!(
        cancellations["effect"]["requests"],
        json!([{"runId":"run","stepId":"test","executor":"pipeline","execution":{"id":"child"}}])
    );
}

#[test]
fn a_child_ends_its_parent_step_only_with_its_own_checked_outputs() {
    let leased = leased_parent();
    let started = ok(start(
        &leased,
        "child",
        child(child_steps()),
        json!({"resolvedTexts":{"collect":"Three notes"}}),
    ));
    let child_run = json!({"state":started["child"]["state"],"run":started["child"]["run"]});
    let end = |parent: &Value, child: &Value, texts: Value| {
        invoke(
            json!({"type":"completePipelineChild","state":state(parent),"stepId":"test",
            "expectedTaskRevision":task(parent, "test")["revision"],"child":state(child),"nativeTexts":texts}),
        )
    };
    refused(&end(&started, &child_run, json!({})), "childNotEnded");
    let summarized = finish(&child_run, "summary-session", "All green.");
    let tested = finish(&summarized, "unit-session", r#"{"passed":true}"#);
    assert_eq!(tested["run"]["status"], "succeeded");
    let references = ok(invoke(
        json!({"type":"childOutputReferences","child":state(&tested)}),
    ));
    assert_eq!(
        references["effect"]["references"],
        json!([{"stepId":"summary","reference":reference("summary-session")}])
    );
    refused(
        &end(&started, &tested, json!({"unit":"not listed"})),
        "invalidRequest",
    );
    // A run that this step did not start is foreign, even of the same owner.
    let mut stranger = create_with(child(child_steps()), worker_capabilities());
    stranger["runId"] = "child".into();
    let stranger = finish(
        &finish(&ok(invoke(stranger)), "s", "All green."),
        "u",
        r#"{"passed":true}"#,
    );
    refused(
        &end(&started, &stranger, json!({"summary":"All green."})),
        "foreignExecution",
    );
    // An unread native text is unavailable, never guessed.
    let unavailable = ok(end(&started, &tested, json!({})));
    assert_eq!(
        task(&unavailable, "test")["failure"]["code"],
        core::SUBPIPELINE_OUTPUT_UNAVAILABLE
    );
    let ended = ok(end(&started, &tested, json!({"summary":"All green."})));
    assert_eq!(ended["run"]["status"], "succeeded");
    assert_eq!(
        task(&ended, "test")["resultData"],
        json!({"passed":true,"report":"All green."})
    );
}

/// A pipeline with one sub-pipeline step to `next`.
fn relay(own: &str, next: &str) -> Value {
    json!({
        "profiles":[worker()],
        "team":{"id":"team","name":"Team","members":[{"id":"tester","profileId":"worker"}],
            "sendEdges":[],"observeEdges":[],"orchestratorMemberId":"tester"},
        "pipeline":{"id":own,"name":own,"steps":[
            {"id":"next","name":"Next","assignedMemberId":"next","instructions":"",
             "executor":{"type":"pipeline","launchCommandId":next,"inputs":{}},"dependencyStepIds":[]}]},
        "launchCommand":launch(own, own)
    })
}

fn started_child(response: &Value) -> Value {
    json!({"state":response["child"]["state"],"run":response["child"]["run"]})
}

#[test]
fn cycles_and_depth_are_refused_before_a_child_starts() {
    // A child naming itself, or a launch command the host resolved back to
    // an ancestor, is a cycle.
    let leased = leased_parent();
    let notes = json!({"resolvedTexts":{"collect":"Three notes"}});
    let mut itself = child(child_steps());
    itself["pipeline"]["steps"][0] = json!({"id":"summary","name":"Summary","assignedMemberId":"loop","instructions":"",
        "executor":{"type":"pipeline","launchCommandId":"testing","inputs":{}},"dependencyStepIds":[]});
    child_refused(
        &start(&leased, "child", itself, notes.clone()),
        core::SUBPIPELINE_CYCLE,
    );
    let mut back = child(child_steps());
    back["pipeline"]["steps"][0] = json!({"id":"summary","name":"Summary","assignedMemberId":"loop","instructions":"",
        "executor":{"type":"pipeline","launchCommandId":"developing","inputs":{}},"dependencyStepIds":[]});
    let mut resolved = notes.clone();
    resolved["child"] = json!({"definition":back,"profileCapabilities":worker_capabilities(),
        "pipelines":[{"launchCommandId":"developing","pipeline":parent()["pipeline"]}]});
    child_refused(
        &start(&leased, "child", back.clone(), resolved),
        core::SUBPIPELINE_CYCLE,
    );
    // Without the host's resolution the frozen ancestry still refuses the
    // grandchild before it starts.
    let started = ok(start(&leased, "child", back, notes));
    let grandchild = lease(&started_child(&started), "loop-lease");
    let mut developing = parent();
    developing["pipeline"]["steps"] = json!([{"id":"collect","name":"Collect","assignedMemberId":"collector",
        "instructions":"Collect.","dependencyStepIds":[]}]);
    developing["pipeline"]["inputs"] = json!([]);
    child_refused(
        &start(&grandchild, "grandchild", developing, json!({})),
        core::SUBPIPELINE_CYCLE,
    );

    // Nesting: the root and four nested children run; a fifth is refused.
    let mut run = ok(invoke(create_with(
        relay("c0", "c1"),
        worker_capabilities(),
    )));
    for depth in 1..=core::MAX_SUBPIPELINE_DEPTH {
        let leased = lease(&run, "relay");
        let id = format!("c{depth}");
        let next = format!("c{}", depth + 1);
        let started = ok(start(&leased, &id, relay(&id, &next), json!({})));
        run = started_child(&started);
        assert_eq!(snapshot(&run)["trigger"]["depth"], depth);
        assert_eq!(
            binding(&run)["ancestry"].as_array().unwrap().len(),
            usize::from(depth)
        );
    }
    let leased = lease(&run, "relay");
    child_refused(
        &start(&leased, "c5", relay("c5", "c6"), json!({})),
        core::SUBPIPELINE_DEPTH,
    );
}

#[test]
fn a_rebuilt_pipeline_lease_equals_the_coordinator_lease() {
    let mut command = create_with(parent(), worker_capabilities());
    command["inputs"] = json!({"branch":"main"});
    let collected = finish(&ok(invoke(command)), "collect-session", "Three notes");
    let mut run =
        core::deserialize_run(collected["state"]["snapshot"].as_str().unwrap().as_bytes()).unwrap();
    let revision = run.revision();
    let lease = Coordinator::lease_next_pipeline_step(&mut run, revision, "lease".into())
        .unwrap()
        .unwrap();
    let rebuilt = super::leased_pipeline_step(&run, "test", lease.task_revision, "lease").ok();
    assert_eq!(rebuilt, Some(lease.clone()));
    assert!(super::leased_pipeline_step(&run, "test", lease.task_revision, "other").is_err());
    assert!(super::leased_pipeline_step(&run, "collect", lease.task_revision, "lease").is_err());
}

#[test]
fn unknown_or_unsupported_wire_data_is_refused_without_echo() {
    let created = create();
    let mut extra = state(&created);
    extra["secret"] = "do-not-echo".into();
    let refusal = invoke(json!({"type":"inspect","state":extra}));
    refused(&refusal, "invalidRequest");
    assert!(!refusal.to_string().contains("do-not-echo"));
    let refusal = serde_json::to_value(handle_frame(
        br#"{"protocol":2,"requestId":" ","command":{"type":"compile","document":"{}","identity":{"teamId":"t","pipelineId":"p"},"pipelines":[]}}"#,
    ))
    .unwrap();
    assert_eq!(refusal["requestId"], Value::Null);
    assert_eq!(refusal["error"]["code"], "invalidRequest");
    let mut snapshot = snapshot(&created);
    snapshot["schemaVersion"] = 7.into();
    let mut stored = state(&created);
    stored["snapshot"] = snapshot.to_string().into();
    refused(
        &invoke(json!({"type":"inspect","state":stored.clone()})),
        "unsupportedSnapshotVersion",
    );
    snapshot["schemaVersion"] = 6.into();
    snapshot["unsupportedSecret"] = "do-not-echo".into();
    stored["snapshot"] = snapshot.to_string().into();
    let refusal = invoke(json!({"type":"inspect","state":stored}));
    refused(&refusal, "invalidSnapshot");
    assert!(!refusal.to_string().contains("do-not-echo"));
    // Protocol 2 accepts no pipeline trigger from a host's create: a child
    // exists only with its parent's dispatch.
    let mut command = create_command();
    command["trigger"] = json!({"kind":"pipeline","parentRunId":"p","parentStepId":"s","launchCommandId":"c","depth":1});
    refused(&invoke(command), "invalidRequest");
}

/// Independent native steps of one read-only worker.
fn independent(steps: Value) -> Value {
    json!({
        "profiles":[worker()],
        "team":{"id":"team","name":"Team","members":[{"id":"worker","profileId":"worker"}],
            "sendEdges":[],"observeEdges":[],"orchestratorMemberId":"worker"},
        "pipeline":{"id":"pipeline","name":"Pipeline","steps":steps}
    })
}

fn native_step(id: &str) -> Value {
    json!({"id":id,"name":id,"assignedMemberId":"worker","instructions":"Work.","dependencyStepIds":[]})
}

/// Ends the running native `step_id` of the latest `run` with `outcome`.
fn completed(run: &Value, step_id: &str, outcome: Value) -> Value {
    let step = task(run, step_id);
    invoke(
        json!({"type":"completeChecked","state":state(run),"stepId":step_id,
        "expectedTaskRevision":step["revision"],"executionId":step["execution"]["id"],"outcome":outcome}),
    )
}

/// `response` cancelled `step_id` while it held `lease_id`: the returned
/// state no longer holds the reservation, reloads and restores, and the
/// cancelled reservation is never dispatched.
fn released(response: &Value, step_id: &str, lease_id: &str) -> Value {
    let ended = ok(response.clone());
    let cancelled = task(&ended, step_id);
    assert_eq!(cancelled["status"], "cancelled", "{ended}");
    assert!(cancelled.get("leaseId").is_none(), "{cancelled}");
    let inspected = ok(invoke(json!({"type":"inspect","state":state(&ended)})));
    assert_eq!(inspected["state"], ended["state"]);
    ok(invoke(json!({"type":"restore","state":state(&ended)})));
    let late = invoke(
        json!({"type":"dispatch","state":state(&ended),"stepId":step_id,
        "expectedTaskRevision":cancelled["revision"],"leaseId":lease_id,"execution":{"id":"late"}}),
    );
    assert_eq!(late["status"], "error", "{late}");
    assert!(late.get("state").is_none());
    ended
}

#[test]
fn a_lease_identifier_names_one_reservation_of_the_run() {
    let created = ok(invoke(create_with(
        independent(json!([native_step("a"), native_step("b")])),
        worker_capabilities(),
    )));
    let first = lease(&created, "shared");
    assert_eq!(first["effect"]["lease"]["stepId"], "a");
    // Another ready task under the same identifier is refused before any
    // state is returned: the stored run could not be loaded again.
    refused(
        &invoke(json!({"type":"lease","state":state(&first),"leaseId":"shared"})),
        "leaseConflict",
    );
    let second = lease(&first, "other");
    assert_eq!(second["effect"]["lease"]["stepId"], "b");
    ok(invoke(json!({"type":"inspect","state":state(&second)})));

    // A spawn is leased under its request id, which may not name another
    // task's reservation on either spawn path.
    let running = team_run();
    let peer = lease(&running, "peer-lease");
    assert_eq!(peer["effect"]["lease"]["stepId"], "b-peer");
    let spawn = json!({"type":"spawn","stepId":"review"});
    let spawn_agent =
        json!({"type":"spawnAgent","profileId":"reviewer","name":"Second","instructions":"Review"});
    agent_refused(
        &agent(&peer, "lead-session", "peer-lease", spawn.clone()),
        "conflict",
        "spawnLeaseRefused",
    );
    agent_refused(
        &agent(&peer, "lead-session", "peer-lease", spawn_agent.clone()),
        "conflict",
        "spawnAgentLeaseRefused",
    );
    // Nor may an ordinary lease take a spawn's identifier.
    let spawned = ok(agent(&peer, "lead-session", "spawn-1", spawn.clone()));
    assert_eq!(task(&spawned, "review")["leaseId"], "spawn-1");
    refused(
        &invoke(json!({"type":"lease","state":state(&spawned),"leaseId":"spawn-1"})),
        "leaseConflict",
    );
    // An identical retry from the persisted admission names its own target.
    let retried = ok(agent(&spawned, "lead-session", "spawn-1", spawn));
    assert_eq!(retried["effect"], spawned["effect"]);
    ok(invoke(json!({"type":"inspect","state":state(&retried)})));
    let created = ok(agent(
        &retried,
        "lead-session",
        "agent-1",
        spawn_agent.clone(),
    ));
    let replayed = ok(agent(&created, "lead-session", "agent-1", spawn_agent));
    assert_eq!(replayed["effect"], created["effect"]);
    assert_eq!(task(&replayed, "agent-agent-1")["leaseId"], "agent-1");
    ok(invoke(json!({"type":"inspect","state":state(&replayed)})));
}

#[test]
fn a_spawn_is_admitted_with_the_frozen_capabilities_of_its_target() {
    // The lead's adapter runs only full access and the reviewer's only
    // read-only: a legitimate delegation that `validate` admits.
    let mut definition = team_definition();
    definition["profiles"][0]["permissionMode"] = "full-access".into();
    definition["profiles"][1]["permissionMode"] = "read-only".into();
    let command = create_with(
        definition,
        json!({"lead":capabilities("full-access", true),"reviewer":capabilities("read-only", false)}),
    );
    assert_eq!(validated(&command), json!([]));
    let running = dispatch(&lease(&ok(invoke(command)), "lead-lease"), "lead-session");
    let admitted = ok(agent(
        &running,
        "lead-session",
        "spawn-1",
        json!({"type":"spawn","stepId":"review"}),
    ));
    let lease = &admitted["effect"]["admission"]["lease"];
    assert_eq!(admitted["effect"]["admission"]["type"], "spawn");
    assert_eq!(
        (
            lease["stepId"].as_str(),
            lease["profile"]["permissionMode"].as_str()
        ),
        (Some("review"), Some("read-only"))
    );
    ok(invoke(json!({"type":"inspect","state":state(&admitted)})));
    let spawned = ok(invoke(
        json!({"type":"dispatch","state":state(&admitted),"stepId":"review",
        "expectedTaskRevision":lease["taskRevision"],"leaseId":lease["leaseId"],"execution":{"id":"review-session"}}),
    ));
    assert_eq!(task(&spawned, "review")["status"], "running");
    let created = ok(agent(
        &spawned,
        "lead-session",
        "agent-1",
        json!({"type":"spawnAgent","profileId":"reviewer","name":"Second","instructions":"Review"}),
    ));
    assert_eq!(
        created["effect"]["admission"]["lease"]["profile"]["permissionMode"],
        "read-only"
    );
}

#[test]
fn an_agent_request_or_its_record_with_an_unknown_member_is_refused() {
    let running = team_run();
    for operation in [
        json!({"type":"roster","secret":"do-not-echo"}),
        json!({"type":"send","recipientMemberId":"peer","body":"hello","secret":"do-not-echo"}),
        json!({"type":"observe","targetMemberId":"peer","secret":"do-not-echo"}),
        json!({"type":"spawn","stepId":"review","secret":"do-not-echo"}),
        json!({"type":"spawnAgent","profileId":"reviewer","name":"Second","instructions":"Review",
            "secret":"do-not-echo"}),
    ] {
        let refusal = agent(&running, "lead-session", "request", operation);
        refused(&refusal, "invalidRequest");
        assert_eq!(refusal["requestId"], Value::Null);
        assert!(!refusal.to_string().contains("do-not-echo"));
    }
    let mut command = json!({"type":"agentRequest","state":state(&running),"actorExecutionId":"lead-session",
        "request":{"requestId":"roster","operation":{"type":"roster"},"secret":"do-not-echo"}});
    refused(&invoke(command.clone()), "invalidRequest");
    command["request"].as_object_mut().unwrap().remove("secret");
    let roster = ok(invoke(command));
    let stored = snapshot(&roster);
    assert_eq!(
        stored["agentRequests"][0]["operation"],
        json!({"type":"roster"})
    );
    // A stored record reloads only exactly as this kernel returned it.
    let reloaded = |snapshot: &Value| {
        let mut state = state(&roster);
        state["snapshot"] = snapshot.to_string().into();
        invoke(json!({"type":"inspect","state":state}))
    };
    ok(reloaded(&stored));
    let mut changed = stored.clone();
    changed["agentRequests"][0]["operation"]["secret"] = "do-not-echo".into();
    let refusal = reloaded(&changed);
    refused(&refusal, "invalidSnapshot");
    assert!(!refusal.to_string().contains("do-not-echo"));
    let mut changed = stored;
    changed["agentRequests"][0]["secret"] = "do-not-echo".into();
    refused(&reloaded(&changed), "invalidSnapshot");
}

#[test]
fn a_transition_that_cancels_a_reservation_releases_it_before_returning() {
    let created = ok(invoke(create_with(
        independent(json!([native_step("a"), native_step("b")])),
        worker_capabilities(),
    )));
    let a = lease(&created, "a-lease");
    let both = lease(&dispatch(&a, "a-session"), "b-lease");
    assert_eq!(task(&both, "b")["leaseId"], "b-lease");
    // A failed native result fails fast.
    let failed = released(
        &completed(
            &both,
            "a",
            json!({"status":"failed","failure":{"code":"build-failed"}}),
        ),
        "b",
        "b-lease",
    );
    assert_eq!(failed["run"]["status"], "failed");
    // A certain refusal of a leased or of a ready task.
    let leased = lease(&a, "b-lease");
    released(
        &invoke(
            json!({"type":"rejectLeased","state":state(&leased),"stepId":"a",
            "expectedTaskRevision":task(&leased, "a")["revision"],"leaseId":"a-lease",
            "failure":{"code":"profile-unavailable"}}),
        ),
        "b",
        "b-lease",
    );
    let ready = ok(invoke(
        json!({"type":"releaseLease","state":state(&leased),"stepId":"a",
        "expectedTaskRevision":task(&leased, "a")["revision"],"leaseId":"a-lease"}),
    ));
    released(
        &invoke(
            json!({"type":"rejectReady","state":state(&ready),"stepId":"a",
            "expectedTaskRevision":task(&ready, "a")["revision"],"failure":{"code":"profile-unavailable"}}),
        ),
        "b",
        "b-lease",
    );
    // A reconciliation of an uncertain execution or reservation.
    for (run, identity) in [
        (&both, json!({"type":"execution","id":"a-session"})),
        (&leased, json!({"type":"lease","id":"a-lease"})),
    ] {
        for resolution in [
            json!({"status":"failed","failure":{"code":"lost"}}),
            json!({"status":"cancelled"}),
        ] {
            let uncertain = ok(invoke(
                json!({"type":"markUncertain","state":state(run),"stepId":"a",
                "expectedTaskRevision":task(run, "a")["revision"],"identity":identity}),
            ));
            assert_eq!(task(&uncertain, "b")["leaseId"], "b-lease");
            released(
                &invoke(
                    json!({"type":"reconcile","state":state(&uncertain),"stepId":"a",
                    "expectedTaskRevision":task(&uncertain, "a")["revision"],"resolution":resolution}),
                ),
                "b",
                "b-lease",
            );
        }
    }
}

#[test]
fn a_host_or_pinned_failure_releases_the_reservations_it_cancels() {
    // A failed host step.
    let mut definition = independent(json!([native_step("work")]));
    definition["pipeline"]["steps"]
        .as_array_mut()
        .unwrap()
        .insert(0, host_steps()["pipeline"]["steps"][0].clone());
    let created = ok(invoke(create_with(definition, worker_capabilities())));
    let script = lease(&created, "script-lease");
    assert_eq!(script["effect"]["type"], "scriptLeased");
    let both = lease(&ok(host_dispatch(&script, "process-1")), "work-lease");
    assert_eq!(task(&both, "work")["leaseId"], "work-lease");
    released(
        &invoke(
            json!({"type":"completeHostStep","state":state(&both),"stepId":"first",
            "expectedTaskRevision":task(&both, "first")["revision"],"executionId":"process-1",
            "completion":{"status":"failed","failure":{"code":"script-exit-status"}}}),
        ),
        "work",
        "work-lease",
    );

    // A pinned step whose pinned text is not its declared result.
    let mut definition = independent(json!([native_step("a"), native_step("b")]));
    definition["pipeline"]["steps"].as_array_mut().unwrap().push(json!({
        "id":"c","name":"c","assignedMemberId":"worker","instructions":"Work.",
        "resultFields":[{"name":"approved","kind":"boolean"}],
        "pinnedOutput":{"text":"not json","pinnedAt":"2026-11-15T00:00:00Z"},"dependencyStepIds":["a"]}));
    let mut command = create_with(definition, worker_capabilities());
    command["usePinnedData"] = true.into();
    let both = lease(
        &dispatch(&lease(&ok(invoke(command)), "a-lease"), "a-session"),
        "b-lease",
    );
    let done = ok(completed(
        &both,
        "a",
        json!({"status":"succeeded","resultReference":reference("a-session")}),
    ));
    assert_eq!(task(&done, "b")["leaseId"], "b-lease");
    let advanced = released(
        &invoke(json!({"type":"advance","state":state(&done)})),
        "b",
        "b-lease",
    );
    assert_eq!(task(&advanced, "c")["status"], "failed");

    // A sub-pipeline step whose child result is unavailable.
    let mut definition = parent();
    definition["pipeline"]["steps"].as_array_mut().unwrap().push(json!({
        "id":"side","name":"Side","assignedMemberId":"collector","instructions":"Side.","dependencyStepIds":[]}));
    let mut command = create_with(definition, worker_capabilities());
    command["inputs"] = json!({"branch":"main"});
    let collected = finish(&ok(invoke(command)), "collect-session", "Three notes");
    let side = lease(&collected, "side-lease");
    assert_eq!(side["effect"]["lease"]["stepId"], "side");
    let test = lease(&side, "test-lease");
    assert_eq!(test["effect"]["type"], "pipelineLeased");
    let started = ok(start(
        &test,
        "child",
        child(child_steps()),
        json!({"resolvedTexts":{"collect":"Three notes"}}),
    ));
    let tested = finish(
        &finish(&started_child(&started), "summary-session", "All green."),
        "unit-session",
        r#"{"passed":true}"#,
    );
    let ended = released(
        &invoke(
            json!({"type":"completePipelineChild","state":state(&started),"stepId":"test",
            "expectedTaskRevision":task(&started, "test")["revision"],"child":state(&tested),"nativeTexts":{}}),
        ),
        "side",
        "side-lease",
    );
    assert_eq!(
        task(&ended, "test")["failure"]["code"],
        core::SUBPIPELINE_OUTPUT_UNAVAILABLE
    );
}

#[test]
fn a_state_that_could_not_be_loaded_again_is_never_returned() {
    let created = ok(invoke(create_with(
        independent(json!([native_step("a"), native_step("b")])),
        worker_capabilities(),
    )));
    let mut run =
        core::deserialize_run(created["state"]["snapshot"].as_str().unwrap().as_bytes()).unwrap();
    for _ in 0..2 {
        let revision = run.revision();
        Coordinator::lease_next_task(&mut run, revision, "shared".into())
            .unwrap()
            .unwrap();
    }
    assert!(core::deserialize_run(&core::serialize_run(&run).unwrap()).is_err());
    let binding = created["state"]["binding"].as_str().unwrap().to_owned();
    let Err(failure) = super::persisted(super::Stored { run, binding }) else {
        panic!("an unloadable state was returned");
    };
    assert_eq!(failure.code, super::wire::ErrorCode::InvalidTransition);
}
