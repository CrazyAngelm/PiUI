use piui_contracts::{
    HostError, HostErrorCode, ProjectSummary, ProjectTrustState, ReadOnlySessionTree, Revision,
    RevisionError, RuntimeCapabilities, RuntimeEvent, RuntimeSnapshot, RuntimeState,
    SessionParseState, SessionProjection, SessionSummary, SessionTitleSource, TimelineBlock,
    TimelineBlockKind, TimelinePage,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn assert_fixture_round_trip<T>(fixture: &str)
where
    T: DeserializeOwned + Serialize,
{
    let expected: Value = serde_json::from_str(fixture).expect("fixture must contain valid JSON");
    let value: T = serde_json::from_value(expected.clone()).expect("fixture must deserialize");
    let actual = serde_json::to_value(value).expect("DTO must serialize");
    assert_eq!(actual, expected);
}

#[test]
fn project_summary_fixture_round_trips() {
    assert_fixture_round_trip::<ProjectSummary>(include_str!("fixtures/project-summary.json"));
}

#[test]
fn session_summary_fixture_round_trips() {
    assert_fixture_round_trip::<SessionSummary>(include_str!("fixtures/session-summary.json"));
}

#[test]
fn session_projection_fixture_round_trips_without_a_file_location() {
    let fixture = include_str!("fixtures/session-projection.json");
    assert_fixture_round_trip::<SessionProjection>(fixture);

    let projection =
        serde_json::from_str::<SessionProjection>(fixture).expect("projection fixture");
    let serialized = serde_json::to_string(&projection).expect("projection serialization");
    assert!(!serialized.contains("fileUri"));
    assert!(!serialized.contains("path"));
}

#[test]
fn timeline_page_fixture_round_trips() {
    assert_fixture_round_trip::<TimelinePage>(include_str!("fixtures/timeline-page.json"));
}

#[test]
fn read_only_tree_fixture_round_trips() {
    assert_fixture_round_trip::<ReadOnlySessionTree>(include_str!("fixtures/read-only-tree.json"));
}

#[test]
fn runtime_snapshot_fixture_round_trips_known_capabilities_and_ignores_future_ones() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/runtime-snapshot.json"))
        .expect("fixture must contain valid JSON");
    let snapshot: RuntimeSnapshot = serde_json::from_value(fixture).expect("snapshot fixture");

    assert!(snapshot.capabilities.rpc);
    assert!(!snapshot.capabilities.ui_custom_tui.is_supported());

    let serialized = serde_json::to_value(snapshot).expect("snapshot serialization");
    assert_eq!(
        serialized["capabilities"]["ui.customTui"],
        Value::Bool(false)
    );
    assert!(
        serialized["capabilities"]
            .get("future.capability")
            .is_none()
    );
}

#[test]
fn runtime_event_fixture_round_trips() {
    assert_fixture_round_trip::<RuntimeEvent>(include_str!("fixtures/runtime-event.json"));
}

#[test]
fn host_error_fixture_round_trips() {
    assert_fixture_round_trip::<HostError>(include_str!("fixtures/host-error.json"));
}

#[test]
fn safe_defaults_are_conservative_and_complete() {
    assert_eq!(ProjectTrustState::default(), ProjectTrustState::Unknown);
    assert_eq!(SessionTitleSource::default(), SessionTitleSource::DateId);
    assert_eq!(SessionParseState::default(), SessionParseState::Partial);
    assert_eq!(RuntimeState::default(), RuntimeState::Dormant);
    assert_eq!(TimelineBlockKind::default(), TimelineBlockKind::Custom);
    assert_eq!(TimelineBlock::default().content, Value::Null);

    let capabilities = RuntimeCapabilities::default();
    assert!(!capabilities.rpc);
    assert!(!capabilities.images);
    assert!(!capabilities.session_tree_navigate);
    assert!(!capabilities.ui_custom_tui.is_supported());

    let snapshot = RuntimeSnapshot::default();
    assert_eq!(snapshot.revision, Revision::ZERO);
    assert_eq!(snapshot.state, RuntimeState::Dormant);
    assert!(snapshot.available_models.is_empty());
    assert!(snapshot.blocks.is_empty());

    let error = HostError::default();
    assert_eq!(error.code, HostErrorCode::InternalError);
    assert!(!error.recoverable);
}

#[test]
fn host_error_codes_match_the_protocol_spelling() {
    let cases = [
        (HostErrorCode::InvalidArgument, "INVALID_ARGUMENT"),
        (HostErrorCode::NotFound, "NOT_FOUND"),
        (HostErrorCode::NotTrusted, "NOT_TRUSTED"),
        (HostErrorCode::NotSupported, "NOT_SUPPORTED"),
        (HostErrorCode::PermissionDenied, "PERMISSION_DENIED"),
        (HostErrorCode::Conflict, "CONFLICT"),
        (HostErrorCode::RuntimeNotReady, "RUNTIME_NOT_READY"),
        (HostErrorCode::RuntimeFailed, "RUNTIME_FAILED"),
        (HostErrorCode::ProtocolError, "PROTOCOL_ERROR"),
        (HostErrorCode::Timeout, "TIMEOUT"),
        (HostErrorCode::IoError, "IO_ERROR"),
        (HostErrorCode::InternalError, "INTERNAL_ERROR"),
    ];

    for (code, expected) in cases {
        assert_eq!(
            serde_json::to_value(code).expect("code serialization"),
            expected
        );
    }
}

#[test]
fn custom_tui_capability_cannot_be_deserialized_as_supported() {
    let error = serde_json::from_value::<RuntimeCapabilities>(serde_json::json!({
        "ui.customTui": true
    }))
    .expect_err("the foundation contract must never advertise custom TUI support");
    assert!(error.to_string().contains("ui.customTui must be false"));
}

#[test]
fn revision_overflow_is_explicit() {
    assert_eq!(Revision(u64::MAX).next(), Err(RevisionError::Overflow));
}
