//! Serde mirror of `contracts/nano-account-v1.ts` (WebView <-> host).
//!
//! The account-owned documents are closed: unknown fields and values are
//! rejected. Nested server documents (`entitlements`, `usage`,
//! `capabilities`) keep the tolerance of [`crate::wire`].

use serde::{Deserialize, Serialize};

use crate::error::NanoError;
use crate::wire::{
    NanoCapabilitiesV1, NanoEntitlementsV1, NanoModeIdV1, NanoUsageV1, NanoWorkspaceRoleV1,
};

/// `NANO_ACCOUNT_PROTOCOL`.
pub const NANO_ACCOUNT_PROTOCOL: u8 = 1;
/// `NANO_ACCOUNT_EVENT_V1`: the event that carries every published status.
pub const NANO_ACCOUNT_EVENT_V1: &str = "piui://nano-account-v1";
/// `NANO_HARNESS`.
pub const NANO_HARNESS: &str = "nano";
/// `NANO_MODEL_PROVIDER`.
pub const NANO_MODEL_PROVIDER: &str = "nano";

/// The literal `protocol: 1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct NanoAccountProtocolV1;

impl TryFrom<u8> for NanoAccountProtocolV1 {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        if value == NANO_ACCOUNT_PROTOCOL {
            Ok(Self)
        } else {
            Err(format!("unsupported Nano account protocol {value}"))
        }
    }
}

impl From<NanoAccountProtocolV1> for u8 {
    fn from(_: NanoAccountProtocolV1) -> Self {
        NANO_ACCOUNT_PROTOCOL
    }
}

/// `NanoAccountStateV1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoAccountStateV1 {
    SignedOut,
    SigningIn,
    SignedIn,
    Expired,
    Unsupported,
    Offline,
}

/// `NanoCredentialStoreV1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoCredentialStoreV1 {
    Os,
    Memory,
}

/// `NanoLinkV1`: pages of the Nano site opened in the system browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NanoLinkV1 {
    Billing,
    Devices,
    Signup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoServerInfoV1 {
    pub origin: String,
    pub development: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoAccountUserV1 {
    pub display_name: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoAccountDeviceV1 {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoAccountWorkspaceV1 {
    pub id: String,
    pub name: String,
    pub role: NanoWorkspaceRoleV1,
}

/// `NanoAccountStatusV1`: everything the WebView may know about the account.
/// It never contains a token, code, verifier or relay key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoAccountStatusV1 {
    pub protocol: NanoAccountProtocolV1,
    /// Increases with every change the host publishes.
    pub revision: u64,
    pub state: NanoAccountStateV1,
    pub server: NanoServerInfoV1,
    pub user: Option<NanoAccountUserV1>,
    pub device: Option<NanoAccountDeviceV1>,
    pub workspaces: Vec<NanoAccountWorkspaceV1>,
    pub selected_workspace_id: Option<String>,
    pub entitlements: Option<NanoEntitlementsV1>,
    pub usage: Option<NanoUsageV1>,
    pub capabilities: Option<NanoCapabilitiesV1>,
    pub credential_store: Option<NanoCredentialStoreV1>,
    pub busy: bool,
    pub last_error: Option<NanoError>,
}

impl NanoAccountStatusV1 {
    /// `nanoModeAvailable`: whether a mode can start a turn now.
    pub fn mode_available(&self, mode: NanoModeIdV1) -> bool {
        self.state == NanoAccountStateV1::SignedIn
            && self
                .entitlements
                .as_ref()
                .is_some_and(|e| e.mode_available(mode))
    }
}

/// `NanoAccountEventV1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum NanoAccountEventV1 {
    Status { status: NanoAccountStatusV1 },
}

/// `NanoSelectWorkspaceRequestV1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoSelectWorkspaceRequestV1 {
    pub workspace_id: String,
}

/// `NanoOpenLinkRequestV1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NanoOpenLinkRequestV1 {
    pub link: NanoLinkV1,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::wire::tests::ts_union;
    use serde_json::Value;

    const ACCOUNT_FIXTURES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/fixtures/nano-account-v1.json"
    ));
    const ACCOUNT_CONTRACT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/nano-account-v1.ts"
    ));

    fn fixtures() -> serde_json::Map<String, Value> {
        let all: Value = serde_json::from_str(ACCOUNT_FIXTURES).expect("fixture json");
        let mut map = all.as_object().cloned().expect("object");
        map.remove("$comment");
        map
    }

    #[test]
    fn every_status_fixture_round_trips() {
        let all = fixtures();
        assert_eq!(all.len(), 5);
        for (key, value) in all {
            let status: NanoAccountStatusV1 = serde_json::from_value(value.clone()).expect(&key);
            assert_eq!(
                serde_json::to_value(&status).expect("serialize"),
                value,
                "{key}"
            );
        }
    }

    #[test]
    fn closed_values_are_rejected() {
        let base = fixtures()["signedOut"].clone();

        let mut bad = base.clone();
        bad["protocol"] = Value::from(2);
        assert!(serde_json::from_value::<NanoAccountStatusV1>(bad).is_err());

        let mut bad = base.clone();
        bad["state"] = Value::from("paused");
        assert!(serde_json::from_value::<NanoAccountStatusV1>(bad).is_err());

        let mut bad = base.clone();
        bad["lastError"] = Value::from("teapot");
        assert!(serde_json::from_value::<NanoAccountStatusV1>(bad).is_err());

        let mut bad = base.clone();
        bad["credentialStore"] = Value::from("file");
        assert!(serde_json::from_value::<NanoAccountStatusV1>(bad).is_err());

        let mut bad = base;
        bad["accessToken"] = Value::from("x");
        assert!(serde_json::from_value::<NanoAccountStatusV1>(bad).is_err());
    }

    #[test]
    fn requests_reject_unknown_fields() {
        let ok: NanoSelectWorkspaceRequestV1 =
            serde_json::from_value(serde_json::json!({ "workspaceId": "ws" })).expect("ok");
        assert_eq!(ok.workspace_id, "ws");
        assert!(
            serde_json::from_value::<NanoSelectWorkspaceRequestV1>(
                serde_json::json!({ "workspaceId": "ws", "extra": 1 })
            )
            .is_err()
        );
        let link: NanoOpenLinkRequestV1 =
            serde_json::from_value(serde_json::json!({ "link": "billing" })).expect("link");
        assert_eq!(link.link, NanoLinkV1::Billing);
        assert!(
            serde_json::from_value::<NanoOpenLinkRequestV1>(serde_json::json!({ "link": "cloud" }))
                .is_err()
        );
    }

    #[test]
    fn event_is_tagged_status() {
        let status: NanoAccountStatusV1 =
            serde_json::from_value(fixtures()["signedIn"].clone()).expect("status");
        let event = serde_json::to_value(NanoAccountEventV1::Status {
            status: status.clone(),
        })
        .expect("event");
        assert_eq!(event["type"], "status");
        assert!(status.mode_available(NanoModeIdV1::Fast));
        assert!(!status.mode_available(NanoModeIdV1::Smart));
    }

    #[test]
    fn closed_unions_match_the_typescript_contract() {
        let states: Vec<String> = [
            NanoAccountStateV1::SignedOut,
            NanoAccountStateV1::SigningIn,
            NanoAccountStateV1::SignedIn,
            NanoAccountStateV1::Expired,
            NanoAccountStateV1::Unsupported,
            NanoAccountStateV1::Offline,
        ]
        .iter()
        .map(|state| {
            serde_json::to_value(state)
                .expect("state")
                .as_str()
                .expect("str")
                .to_owned()
        })
        .collect();
        assert_eq!(states, ts_union(ACCOUNT_CONTRACT, "NanoAccountStateV1"));

        let links: Vec<String> = [NanoLinkV1::Billing, NanoLinkV1::Devices, NanoLinkV1::Signup]
            .iter()
            .map(|link| {
                serde_json::to_value(link)
                    .expect("link")
                    .as_str()
                    .expect("str")
                    .to_owned()
            })
            .collect();
        assert_eq!(links, ts_union(ACCOUNT_CONTRACT, "NanoLinkV1"));
    }
}
