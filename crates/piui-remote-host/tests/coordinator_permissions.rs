//! Compare the remote ceiling with the real coordinator's file/network
//! admission, not a second expected implementation. Tool/resource/delegation
//! lists are empty here; those are independently enforced by the native host.
use piui_orchestration::{AgentProfile, spawn_permissions_subset};
use piui_remote_host::policy::{HarnessId, Permissions, within_ceiling};
use serde_json::{Value, json};

fn profile(harness: &str, permissions: &Value) -> AgentProfile {
    serde_json::from_value(json!({
        "id":"synthetic-profile", "name":"Synthetic profile", "harness":harness,
        "modelProvider":null, "model":"synthetic-model", "instructions":"",
        "permissionMode":permissions["permissionMode"], "networkAccess":permissions["networkAccess"],
        "toolPolicy":{"rules":[]}, "allowedSpawnProfileIds":[]
    })).expect("valid fixture profile")
}

#[test]
fn remote_ceilings_match_coordinator_file_and_network_permissions() {
    let value: Value = serde_json::from_str(include_str!(
        "../../../contracts/fixtures/unified-shell/nano-host-v1.json"
    ))
    .expect("fixture");
    let rows = value["ceilings"].as_array().expect("ceiling rows");
    assert!(!rows.is_empty());
    for row in rows {
        let ceiling_harness = row["ceilingHarness"].as_str().expect("ceiling harness");
        let harness = row["harness"].as_str().expect("harness");
        let parent = profile(ceiling_harness, &row["ceiling"]);
        let child = profile(harness, &row["requested"]);
        let ceiling: Permissions = serde_json::from_value(row["ceiling"].clone()).expect("ceiling");
        let requested: Permissions =
            serde_json::from_value(row["requested"].clone()).expect("requested");
        let actual = within_ceiling(
            &HarnessId::new(ceiling_harness).unwrap(),
            ceiling,
            &HarnessId::new(harness).unwrap(),
            requested,
        )
        .is_ok();
        assert_eq!(actual, spawn_permissions_subset(&parent, &child), "{row}");
    }
}
