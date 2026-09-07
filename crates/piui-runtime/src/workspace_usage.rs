//! Native usage receipts. Replace a receipt by identity; never add a repeated event.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeUsage {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}
pub fn merge_usage(receipts: &mut Vec<NativeUsage>, incoming: NativeUsage) {
    if incoming.id.is_empty() {
        return;
    }
    if let Some(previous) = receipts.iter_mut().find(|item| item.id == incoming.id) {
        *previous = incoming;
    } else {
        receipts.push(incoming);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_receipts_replace_and_unknown_stays_unknown() {
        let mut receipts = vec![];
        let receipt: NativeUsage =
            serde_json::from_str(r#"{"id":"session","inputTokens":12}"#).unwrap();
        merge_usage(&mut receipts, receipt.clone());
        merge_usage(&mut receipts, receipt);
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].output_tokens, None);
        assert!(serde_json::from_str::<NativeUsage>(r#"{"id":"bad","inputTokens":-1}"#).is_err());
    }
}
