//! The Nano model catalog, served by the host from the account's entitlements
//! (no Pi process is started to discover models).
//!
//! A Nano "model" is one of the server's modes (`auto`, `free`, `fast`,
//! `smart`). Only modes the entitlements mark `available` are offered; the
//! provider model behind a mode is never named. Signed out, the catalog is
//! empty and no native process is spawned.

use piui_nano::status::{NANO_MODEL_PROVIDER, NanoAccountStateV1, NanoAccountStatusV1};
use piui_runtime::workspace_runtime::{NativeCatalogModel, WorkspaceModel};

/// The catalog rows of `status`: one per available mode, in server order.
pub(crate) fn catalog_models(status: &NanoAccountStatusV1) -> Vec<NativeCatalogModel> {
    if status.state != NanoAccountStateV1::SignedIn {
        return Vec::new();
    }
    let Some(entitlements) = &status.entitlements else {
        return Vec::new();
    };
    entitlements
        .modes
        .iter()
        .filter(|mode| mode.available)
        .map(|mode| NativeCatalogModel {
            id: mode.id.as_str().to_owned(),
            provider: Some(NANO_MODEL_PROVIDER.to_owned()),
            name: if mode.name.trim().is_empty() {
                mode.id.as_str().to_owned()
            } else {
                mode.name.clone()
            },
            // Nano has no thinking levels or fast tier in v1.
            thinking_levels: None,
            supports_fast: false,
        })
        .collect()
}

/// Keeps only the rows of a live Nano session's model list that the account
/// may use now: provider `nano` and a mode of [`catalog_models`]. Pi lists
/// what its `models.json` held when it started; a plan change, an expired or
/// signed-out account must not leave a locked mode selectable.
pub(crate) fn retain_entitled(
    models: &mut Vec<WorkspaceModel>,
    status: &NanoAccountStatusV1,
    provider: &str,
) {
    let entitled = catalog_models(status);
    models.retain(|model| {
        model.provider.as_deref() == Some(provider) && entitled.iter().any(|row| row.id == model.id)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nano::tests::fixture_status;

    fn live(provider: Option<&str>, id: &str) -> WorkspaceModel {
        WorkspaceModel {
            id: id.to_owned(),
            provider: provider.map(str::to_owned),
            name: id.to_owned(),
            thinking_levels: None,
        }
    }

    #[test]
    fn a_live_list_keeps_only_entitled_nano_modes() {
        let status = fixture_status("signedIn");
        let modes = &status.entitlements.as_ref().expect("entitlements").modes;
        let available = modes
            .iter()
            .find(|mode| mode.available)
            .expect("an available mode")
            .id
            .as_str()
            .to_owned();
        let locked = modes
            .iter()
            .find(|mode| !mode.available)
            .expect("a locked mode")
            .id
            .as_str()
            .to_owned();
        let all = vec![
            live(Some("nano"), &available),
            live(Some("nano"), &locked),
            live(Some("openai"), &available),
            live(None, &available),
            live(Some("nano"), "unknown-mode"),
        ];
        let mut models = all.clone();
        retain_entitled(&mut models, &status, NANO_MODEL_PROVIDER);
        assert_eq!(
            models
                .iter()
                .map(|model| (model.provider.as_deref(), model.id.as_str()))
                .collect::<Vec<_>>(),
            [(Some("nano"), available.as_str())]
        );
        for key in ["signedOut", "expired", "signingIn"] {
            let mut models = all.clone();
            retain_entitled(&mut models, &fixture_status(key), NANO_MODEL_PROVIDER);
            assert!(models.is_empty(), "{key}");
        }
    }

    #[test]
    fn signed_in_status_offers_only_available_modes() {
        let status = fixture_status("signedIn");
        let models = catalog_models(&status);
        let expected: Vec<&str> = status
            .entitlements
            .as_ref()
            .expect("entitlements")
            .modes
            .iter()
            .filter(|mode| mode.available)
            .map(|mode| mode.id.as_str())
            .collect();
        assert!(!expected.is_empty());
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            expected
        );
        for model in &models {
            assert_eq!(model.provider.as_deref(), Some("nano"));
            assert_eq!(model.thinking_levels, None);
            assert!(!model.supports_fast);
            assert!(!model.name.is_empty());
        }
        // The fixture's `smart` mode is locked (no credits): never offered.
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["auto", "free", "fast"]
        );
    }

    #[test]
    fn signed_out_or_loading_entitlements_offer_nothing() {
        assert!(catalog_models(&fixture_status("signedOut")).is_empty());
        let mut loading = fixture_status("signedIn");
        loading.entitlements = None;
        assert!(catalog_models(&loading).is_empty());
        let mut expired = fixture_status("signedIn");
        expired.state = NanoAccountStateV1::Expired;
        assert!(catalog_models(&expired).is_empty());
    }
}
