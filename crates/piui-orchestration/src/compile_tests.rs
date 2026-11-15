//! Compile vectors and refusals (ADR-059).
//!
//! `contracts/fixtures/unified-shell/graph/compile-vectors-v1.json` is
//! generated from the editor's import path by
//! `apps/desktop/src/features/orchestration/compileVectors.ts`. Every vector
//! must compile to an equal orchestration v6 definition or be refused with the
//! same code. The server outcomes in the file are predictions read from the
//! server source; the parts that depend only on this crate's types are checked
//! here.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    CompileError, CompileIdentity, CompileRefusal, ExecutionMode, LaunchCommandReference,
    NativeBridgeCapabilities, PipelineName, PipelineStep, ReviewRule, RunDefinitionSnapshot,
    StepExecutor, ToolDecision, compile_system_document, validate_definition,
    validate_profile_capabilities,
};

const VECTORS: &str =
    include_str!("../../../contracts/fixtures/unified-shell/graph/compile-vectors-v1.json");
const CONTRACT: &str = include_str!("../../../contracts/nano-graph-kernel-v2.ts");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorFile {
    format: String,
    version: u32,
    identity: CompileIdentity,
    server: ServerContext,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerContext {
    draft_id: String,
    identity: CompileIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    id: String,
    source_version: u64,
    original: Option<String>,
    document: String,
    pipelines: Vec<PipelineName>,
    typescript: EditorOutcome,
    rust: Expected,
    server: ServerPrediction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Stage {
    Accepted,
    Refused,
}

/// What the editor did: import, then save (graph issues), then the definition.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorOutcome {
    import: Stage,
    save: Option<Stage>,
    definition: Option<RunDefinitionSnapshot>,
    mapping_without_import_checks: Option<RunDefinitionSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
enum Expected {
    Compiled,
    Refused { refusal: CompileRefusal },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerPrediction {
    status: String,
    compile: Option<ServerCompile>,
}

#[derive(Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ServerCompile {
    Refused {},
    Uncertain {},
    Accepted {
        definition: Option<Value>,
        differences_from_rust: Option<Vec<Value>>,
        kernel: KernelPrediction,
    },
}

#[derive(Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
enum KernelPrediction {
    Created,
    Refused { code: String },
}

fn vectors() -> VectorFile {
    let file: VectorFile =
        serde_json::from_str(VECTORS).expect("the vector file decodes into its test types");
    assert_eq!(file.format, "piui-graph-compile-vectors");
    assert_eq!(file.version, 1);
    assert!(!file.vectors.is_empty());
    file
}

/// The definition a compiled vector must equal: the editor's saved
/// definition, or its mapping when only adapter checks refused the import.
fn editor_definition(vector: &Vector) -> &RunDefinitionSnapshot {
    let editor = &vector.typescript;
    match (editor.import, editor.save) {
        (Stage::Accepted, Some(Stage::Accepted)) => editor.definition.as_ref(),
        (Stage::Refused, None) => editor.mapping_without_import_checks.as_ref(),
        _ => None,
    }
    .unwrap_or_else(|| panic!("{}: a compiled vector carries a definition", vector.id))
}

#[test]
fn every_vector_compiles_to_the_editor_definition_or_is_refused_with_its_code() {
    let file = vectors();
    for vector in &file.vectors {
        let result = compile_system_document(&vector.document, &file.identity, &vector.pipelines);
        match (&vector.rust, result) {
            (Expected::Compiled, Ok(definition)) => {
                assert_eq!(&definition, editor_definition(vector), "{}", vector.id);
            }
            (Expected::Refused { refusal }, Err(error)) => {
                assert_eq!(error.refusal(), *refusal, "{}: {error}", vector.id);
            }
            (expected, actual) => panic!("{}: expected {expected:?}, got {actual:?}", vector.id),
        }
    }
}

#[test]
fn versions_one_to_four_are_left_to_the_editor() {
    let file = vectors();
    let mut upgraded = Vec::new();
    for vector in &file.vectors {
        match &vector.original {
            Some(original) => {
                let error = compile_system_document(original, &file.identity, &vector.pipelines)
                    .expect_err("a version 1-4 original is not compiled");
                assert_eq!(
                    error,
                    CompileError::UnsupportedVersion {
                        version: Some(vector.source_version)
                    },
                    "{}",
                    vector.id
                );
                upgraded.push(vector.id.as_str());
            }
            None => assert_eq!(vector.source_version, 5, "{}", vector.id),
        }
    }
    assert!(upgraded.contains(&"example-single"));
}

/// The server compiles with its draft id as team and pipeline id and without
/// a launch command. Nothing else changes, and the recorded differences from
/// the predicted server definition are exactly the typed differences.
#[test]
fn the_server_identity_changes_only_identifiers() {
    let file = vectors();
    assert_eq!(file.server.identity.team_id, file.server.draft_id);
    assert_eq!(file.server.identity.pipeline_id, file.server.draft_id);
    assert_eq!(file.server.identity.launch_command_id, None);
    let mut compared = Vec::new();
    for vector in &file.vectors {
        assert!(vector.server.status == "predicted", "{}", vector.id);
        let Some(ServerCompile::Accepted {
            definition: Some(csharp),
            differences_from_rust: Some(differences),
            ..
        }) = &vector.server.compile
        else {
            continue;
        };
        let mut expected = editor_definition(vector).clone();
        expected.team.id.clone_from(&file.server.draft_id);
        expected.pipeline.id.clone_from(&file.server.draft_id);
        expected.launch_command = None;
        let compiled =
            compile_system_document(&vector.document, &file.server.identity, &vector.pipelines)
                .unwrap_or_else(|error| panic!("{}: {error}", vector.id));
        assert_eq!(compiled, expected, "{}", vector.id);
        let csharp: RunDefinitionSnapshot =
            serde_json::from_value(csharp.clone()).unwrap_or_else(|error| {
                panic!("{}: the server definition decodes: {error}", vector.id)
            });
        assert_eq!(
            csharp == compiled,
            differences.is_empty(),
            "{}: recorded differences {differences:?}",
            vector.id
        );
        compared.push(vector.id.as_str());
    }
    assert!(compared.contains(&"cloud-server-proof"));
    assert!(compared.contains(&"cloud-dependency-order"));
}

/// What kernel protocol 1 `create` does with a decoded definition.
#[derive(Debug, PartialEq, Eq)]
enum KernelCreate {
    Created,
    UnsupportedExecutor,
    UnsupportedCapability,
    InvalidDefinition,
}

/// `create` as `piui-graph-kernel` performs it (`supported_definition`, the
/// profile capabilities, then `Coordinator::new_started_run`, whose
/// definition check is `validate_definition`), with the capabilities that
/// `HermesGraphAdmission.Capabilities` sends for every profile. Run inputs
/// are request data, not document data, and are not checked.
fn kernel_v1_create(definition: &RunDefinitionSnapshot) -> KernelCreate {
    if definition
        .pipeline
        .steps
        .iter()
        .any(PipelineStep::is_host_executed)
    {
        return KernelCreate::UnsupportedExecutor;
    }
    if definition.team.spawned_agents_join_team
        || !definition.team.send_edges.is_empty()
        || !definition.team.observe_edges.is_empty()
        || definition
            .pipeline
            .steps
            .iter()
            .any(|step| step.execution_mode == Some(ExecutionMode::Callable))
        || definition.profiles.iter().any(|profile| {
            !profile.allowed_spawn_profile_ids.is_empty()
                || profile.tool_policy.rules.iter().any(|rule| {
                    rule.decision == ToolDecision::Allow && rule.tool.starts_with("orchestration.")
                })
        })
    {
        return KernelCreate::UnsupportedCapability;
    }
    let capabilities: NativeBridgeCapabilities = serde_json::from_value(json!({
        "permissionModes": ["native"],
        "nativeEnforcedTools": [],
        "coordinatorEnforcedTools": [],
        "agentOperations": {"roster": false, "send": false, "observe": false, "spawn": false}
    }))
    .expect("the server's capabilities decode");
    if definition
        .profiles
        .iter()
        .any(|profile| validate_profile_capabilities(profile, &capabilities).is_err())
    {
        return KernelCreate::UnsupportedCapability;
    }
    match validate_definition(definition) {
        Ok(()) => KernelCreate::Created,
        Err(_) => KernelCreate::InvalidDefinition,
    }
}

/// Each predicted server definition decodes with the kernel's types and
/// meets the outcome predicted for `create`. This includes the graphs the
/// editor refuses (`rule-*`): the kernel's checks do not refuse them.
#[test]
fn predicted_server_definitions_meet_the_predicted_kernel_outcome() {
    let file = vectors();
    let mut created = Vec::new();
    for vector in &file.vectors {
        let Some(ServerCompile::Accepted {
            definition: Some(csharp),
            kernel,
            ..
        }) = &vector.server.compile
        else {
            continue;
        };
        let definition: RunDefinitionSnapshot = serde_json::from_value(csharp.clone())
            .unwrap_or_else(|error| {
                panic!("{}: the server definition decodes: {error}", vector.id)
            });
        let expected = match kernel {
            KernelPrediction::Created => KernelCreate::Created,
            KernelPrediction::Refused { code } if code == "invalidDefinition" => {
                KernelCreate::InvalidDefinition
            }
            // The frame does not decode because of number spelling, which
            // the stored definition (as JSON.parse reads it) cannot show:
            // `a_review_limit_spelled_as_a_float_does_not_decode`.
            KernelPrediction::Refused { code } if code == "kernel_invalid_response" => continue,
            KernelPrediction::Refused { code } => panic!("{}: unchecked code {code}", vector.id),
        };
        assert_eq!(kernel_v1_create(&definition), expected, "{}", vector.id);
        if expected == KernelCreate::Created {
            created.push(vector.id.as_str());
        }
    }
    for editor_refused in [
        "rule-condition-through-route",
        "rule-binding-through-route",
        "rule-review-through-route",
        "rule-output-field-undeclared",
        "rule-predicate-on-added-field",
        "rule-duplicate-declared-field",
        "name-byte-order-mark",
    ] {
        assert!(created.contains(&editor_refused), "{editor_refused}");
    }
}

/// `cloud-integer-spelling`: the server copies `"maxIterations": 3.0`
/// unchanged, and kernel protocol 1 reads review limits with this type.
#[test]
fn a_review_limit_spelled_as_a_float_does_not_decode() {
    let rule = |limit: &str| {
        serde_json::from_str::<ReviewRule>(&format!(
            r#"{{"field":"accepted","retryFromStepId":"research","maxIterations":{limit}}}"#
        ))
    };
    assert!(rule("3").is_ok());
    assert!(rule("3.0").is_err());
}

/// `nesting-beyond-parser-limit`: the kernel reads its frame with the same
/// recursion limit as the compiler.
#[test]
fn a_definition_nested_beyond_the_recursion_limit_does_not_decode() {
    let file = vectors();
    let vector = file
        .vectors
        .iter()
        .find(|vector| vector.id == "cloud-routed-review")
        .expect("cloud-routed-review exists");
    let Some(ServerCompile::Accepted {
        definition: Some(csharp),
        ..
    }) = &vector.server.compile
    else {
        panic!("cloud-routed-review has a server definition");
    };
    let decodes = |depth: usize| {
        let mut predicate = json!({"op": "equals", "field": "status", "value": "ready"});
        for _ in 0..depth {
            predicate = json!({"op": "not", "predicate": predicate});
        }
        let mut definition = csharp.clone();
        definition["pipeline"]["steps"][1]["router"]["branches"][0]["predicate"] = predicate;
        serde_json::from_str::<RunDefinitionSnapshot>(&definition.to_string()).is_ok()
    };
    assert!(decodes(65));
    assert!(!decodes(130));
}

#[test]
fn refusal_codes_are_the_contract_list_in_order() {
    const ALL: [CompileRefusal; 9] = [
        CompileRefusal::InvalidJson,
        CompileRefusal::NotSystemFile,
        CompileRefusal::UnsupportedVersion,
        CompileRefusal::InvalidDocument,
        CompileRefusal::InvalidStructure,
        CompileRefusal::UnresolvedPipeline,
        CompileRefusal::SelfReferencingPipeline,
        CompileRefusal::InvalidDefinition,
        CompileRefusal::DelegationDenied,
    ];
    // A new refusal does not compile here until it is listed above.
    let position = |refusal: CompileRefusal| match refusal {
        CompileRefusal::InvalidJson => 0,
        CompileRefusal::NotSystemFile => 1,
        CompileRefusal::UnsupportedVersion => 2,
        CompileRefusal::InvalidDocument => 3,
        CompileRefusal::InvalidStructure => 4,
        CompileRefusal::UnresolvedPipeline => 5,
        CompileRefusal::SelfReferencingPipeline => 6,
        CompileRefusal::InvalidDefinition => 7,
        CompileRefusal::DelegationDenied => 8,
    };
    for (index, refusal) in ALL.into_iter().enumerate() {
        assert_eq!(position(refusal), index);
    }
    let start = CONTRACT
        .find("GRAPH_COMPILE_REFUSALS_V2 = [")
        .expect("the contract lists the refusals");
    let end = start
        + CONTRACT[start..]
            .find("] as const")
            .expect("the list is closed");
    let listed: Vec<String> = CONTRACT[start..end]
        .lines()
        .filter_map(|line| line.trim().strip_prefix('\'')?.strip_suffix("',"))
        .map(str::to_owned)
        .collect();
    let names: Vec<String> = ALL
        .iter()
        .map(|refusal| {
            serde_json::to_value(refusal)
                .expect("a refusal serializes")
                .as_str()
                .expect("as a string")
                .to_owned()
        })
        .collect();
    assert_eq!(listed, names);
}

fn identity() -> CompileIdentity {
    CompileIdentity {
        team_id: "team".to_owned(),
        pipeline_id: "pipeline".to_owned(),
        launch_command_id: Some("command".to_owned()),
    }
}

fn profile(name: &str) -> Value {
    json!({"name": name, "harness": "codex", "model": "model", "permissionMode": "read-only",
        "instructions": "", "toolPolicy": {"rules": []}})
}

fn agent(id: &str) -> Value {
    json!({"id": id, "task": "Do the work.", "profile": profile(id)})
}

fn document(agents: Value, connections: Value) -> Value {
    json!({"format": "piui-system", "version": 5, "name": "Unit", "agents": agents,
        "connections": connections})
}

fn compile(text: &str) -> Result<RunDefinitionSnapshot, CompileError> {
    compile_system_document(text, &identity(), &[])
}

fn refusal_of(value: &Value) -> Option<CompileRefusal> {
    compile(&value.to_string())
        .err()
        .map(|error| error.refusal())
}

/// Replaces exactly one occurrence, so that a spelling test cannot miss.
fn respell(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "{from}");
    text.replacen(from, to, 1)
}

#[test]
fn the_envelope_is_read_before_the_schema() {
    let refused = |text: &str| compile(text).err().map(|error| error.refusal());
    assert_eq!(refused("{"), Some(CompileRefusal::InvalidJson));
    assert_eq!(refused("[]"), Some(CompileRefusal::NotSystemFile));
    assert_eq!(
        refused(r#"{"format":"other","version":5}"#),
        Some(CompileRefusal::NotSystemFile)
    );
    assert_eq!(
        refused(r#"{"format":"piui-system"}"#),
        Some(CompileRefusal::NotSystemFile)
    );
    assert_eq!(
        refused(r#"{"format":"piui-system","version":"5"}"#),
        Some(CompileRefusal::NotSystemFile)
    );
    assert_eq!(
        compile(r#"{"format":"piui-system","version":4}"#),
        Err(CompileError::UnsupportedVersion { version: Some(4) })
    );
    assert_eq!(
        compile(r#"{"format":"piui-system","version":4.5}"#),
        Err(CompileError::UnsupportedVersion { version: None })
    );
    let text = document(json!([agent("a")]), json!([])).to_string();
    assert!(compile(&respell(&text, r#""version":5"#, r#""version":5.0"#)).is_ok());
}

#[test]
fn unknown_null_missing_and_mistyped_members_are_refused() {
    let invalid = Some(CompileRefusal::InvalidDocument);
    let mut llm = agent("a");
    llm["executor"] = json!({"type": "llm", "model": "other"});
    assert_eq!(refusal_of(&document(json!([llm]), json!([]))), invalid);

    let mut null_orchestrator = document(json!([agent("a")]), json!([]));
    null_orchestrator["orchestrator"] = Value::Null;
    assert_eq!(refusal_of(&null_orchestrator), invalid);

    let mut no_task = agent("a");
    no_task
        .as_object_mut()
        .expect("an agent is an object")
        .remove("task");
    assert_eq!(refusal_of(&document(json!([no_task]), json!([]))), invalid);

    let mut source = agent("a");
    source["resultFields"] = json!([{"name": "done", "kind": "boolean"}]);
    let mut gated = agent("b");
    gated["condition"] = json!({"sourceStepId": "a", "field": "done"});
    let result = json!([{"from": "a", "to": "b", "kind": "result"}]);
    assert_eq!(
        refusal_of(&document(json!([source.clone(), gated]), result.clone())),
        invalid
    );

    let mut reviewed = agent("b");
    reviewed["resultFields"] = json!([{"name": "accepted", "kind": "boolean"}]);
    reviewed["review"] = json!({"field": "accepted", "retryFromStepId": "a", "maxIterations": 1.5});
    assert_eq!(
        refusal_of(&document(
            json!([source.clone(), reviewed.clone()]),
            result.clone()
        )),
        invalid
    );
    reviewed["review"]["maxIterations"] = json!(3);
    assert_eq!(
        refusal_of(&document(json!([source, reviewed]), result)),
        None
    );
}

#[test]
fn a_repeated_member_name_is_refused_in_records_and_maps() {
    let mut plugin = agent("count");
    plugin["executor"] = json!({"type": "plugin", "pluginId": "acme.audit",
        "nodeType": "count-lines", "config": {"label": "first"}});
    let text = document(json!([agent("a"), plugin]), json!([])).to_string();
    assert!(compile(&text).is_ok());
    let repeated = |text: &str| {
        matches!(
            compile(text),
            Err(CompileError::InvalidDocument {
                reason: "a member name is repeated",
                ..
            })
        )
    };
    assert!(repeated(&respell(
        &text,
        r#""label":"first""#,
        r#""label":"first","label":"second""#
    )));
    assert!(repeated(&respell(
        &text,
        r#""name":"Unit""#,
        r#""name":"Unit","name":"Other""#
    )));
}

#[test]
fn numbers_are_read_as_javascript_reads_them() {
    let mut source = agent("a");
    source["resultFields"] = json!([{"name": "count", "kind": "number"}]);
    let mut script = agent("s");
    script["executor"] = json!({"type": "script", "runtime": "node",
        "source": "console.log('{}')", "timeoutSeconds": 30});
    let mut plugin = agent("p");
    plugin["executor"] = json!({"type": "plugin", "pluginId": "acme.audit",
        "nodeType": "count-lines", "config": {"hundred": 100, "large": 1, "half": 0.5,
            "rounded": 1_000_000_000_000_000_128_u64, "negative": -1_000_000_000_000_000_128_i64}});
    let mut gated = agent("b");
    gated["condition"] = json!({"sourceStepId": "a", "field": "count", "equals": 1});
    let text = document(
        json!([source, script, plugin, gated]),
        json!([{"from": "a", "to": "b", "kind": "result"}]),
    )
    .to_string();
    let text = respell(&text, r#""timeoutSeconds":30"#, r#""timeoutSeconds":30.0"#);
    let text = respell(&text, r#""hundred":100"#, r#""hundred":1e2"#);
    let text = respell(&text, r#""large":1"#, r#""large":9007199254740993"#);
    let text = respell(&text, r#""equals":1"#, r#""equals":1.0"#);
    let definition = compile(&text).expect("the document compiles");
    let step = |id: &str| {
        definition
            .pipeline
            .steps
            .iter()
            .find(|step| step.id == id)
            .expect("the step exists")
    };
    assert!(matches!(
        step("s").executor,
        Some(StepExecutor::Script {
            timeout_seconds: 30,
            ..
        })
    ));
    let Some(StepExecutor::Plugin { config, .. }) = &step("p").executor else {
        panic!("p is a plugin node");
    };
    assert_eq!(config["hundred"], json!(100));
    assert_eq!(config["large"], json!(9_007_199_254_740_992_u64));
    assert_eq!(config["rounded"], json!(1_000_000_000_000_000_100_u64));
    assert_eq!(config["negative"], json!(-1_000_000_000_000_000_100_i64));
    assert_eq!(config["half"], json!(0.5));
    let condition = step("b").condition.as_ref().expect("b has a condition");
    assert_eq!(condition.equals, json!(1));
}

#[test]
fn a_sub_pipeline_name_resolves_exactly_first_and_never_to_itself() {
    let mut child = agent("t");
    child["executor"] = json!({"type": "pipeline", "pipeline": "Testing"});
    let text = document(
        json!([agent("a"), child]),
        json!([{"from": "a", "to": "t", "kind": "result"}]),
    )
    .to_string();
    let pipelines = |names: &[(&str, &str)]| -> Vec<PipelineName> {
        names
            .iter()
            .map(|(id, name)| PipelineName {
                id: (*id).to_owned(),
                name: (*name).to_owned(),
            })
            .collect()
    };
    let resolved = |names: &[(&str, &str)]| {
        compile_system_document(&text, &identity(), &pipelines(names)).map(|definition| {
            match &definition.pipeline.steps[1].executor {
                Some(StepExecutor::Pipeline {
                    launch_command_id, ..
                }) => launch_command_id.clone(),
                other => panic!("t runs a sub-pipeline, not {other:?}"),
            }
        })
    };
    assert_eq!(
        resolved(&[
            ("folded", "testing"),
            ("exact", "Testing"),
            ("upper", "TESTING")
        ]),
        Ok("exact".to_owned())
    );
    assert_eq!(resolved(&[("folded", "testing")]), Ok("folded".to_owned()));
    assert_eq!(
        resolved(&[("command", "Testing")]),
        Err(CompileError::SelfReferencingPipeline {
            step_id: "t".to_owned()
        })
    );
}

#[test]
fn the_launch_command_follows_the_identity() {
    let text = document(json!([agent("a")]), json!([])).to_string();
    let with = compile(&text).expect("the document compiles");
    assert_eq!(
        with.launch_command,
        Some(LaunchCommandReference {
            id: "command".to_owned(),
            name: "Unit".to_owned(),
            team_id: "team".to_owned(),
            pipeline_id: "pipeline".to_owned(),
            managed_by_teammate_id: None,
        })
    );
    let draft = CompileIdentity {
        launch_command_id: None,
        ..identity()
    };
    let without = compile_system_document(&text, &draft, &[]).expect("the document compiles");
    assert_eq!(without.launch_command, None);
    assert_eq!(
        (
            without.team.id.as_str(),
            without.pipeline.id.as_str(),
            without.profiles[0].id.as_str(),
            without.team.members[0].profile_id.as_str()
        ),
        ("team", "pipeline", "a", "a")
    );
}

/// `PRESENTATION_ONLY_FIELDS`: canvas positions and the placeholder profile
/// of a step without a team member, except its name, are not mapped.
#[test]
fn presentation_members_do_not_reach_the_definition() {
    let file = vectors();
    let vector = file
        .vectors
        .iter()
        .find(|vector| vector.id == "example-routed-review")
        .expect("example-routed-review exists");
    let mut document: Value = serde_json::from_str(&vector.document).expect("the document is JSON");
    let original = compile(&vector.document).expect("the document compiles");
    for agent in document["agents"]
        .as_array_mut()
        .expect("agents is an array")
    {
        agent["position"] = json!({"x": 40, "y": 1200.5});
    }
    let router = &mut document["agents"][1]["profile"];
    router["model"] = json!("another-placeholder");
    router["instructions"] = json!("Never read.");
    router["permissionMode"] = json!("full-access");
    assert_eq!(compile(&document.to_string()), Ok(original.clone()));
    document["agents"][1]["profile"]["name"] = json!("Renamed router");
    assert_ne!(compile(&document.to_string()), Ok(original));
}
