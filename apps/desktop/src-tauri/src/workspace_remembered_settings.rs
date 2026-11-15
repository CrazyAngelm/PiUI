//! Host-private remembered chat settings (session settings v1).
//!
//! The model, reasoning level and speed a person last confirmed for a chat
//! through PiUI. One JSON file per session next to, not inside, the v11
//! session registry, whose format is unchanged. This is UI metadata, not
//! history: a missing or unreadable file only means the chat reopens with the
//! harness's own settings.

use super::WorkspaceModel;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const SETTINGS_DIRECTORY: &str = "workspace-session-settings-v1";
const SETTINGS_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RememberedSettings {
    pub version: u32,
    pub session_id: String,
    pub model: WorkspaceModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
}

pub(super) struct RememberedSettingsStore {
    directory: PathBuf,
    records: Mutex<HashMap<String, RememberedSettings>>,
}

impl RememberedSettingsStore {
    /// Reads every readable settings file. A file that does not parse, carries
    /// another version or names another session is skipped, never deleted.
    pub(super) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let directory = app_data_dir.join(SETTINGS_DIRECTORY);
        fs::create_dir_all(&directory)?;
        let mut records = HashMap::new();
        for entry in fs::read_dir(&directory)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let Some(session_id) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".json"))
                .filter(|id| Uuid::parse_str(id).is_ok())
                .map(str::to_owned)
            else {
                continue;
            };
            if let Some(record) = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<RememberedSettings>(&bytes).ok())
                .filter(|record| {
                    record.version == SETTINGS_VERSION && record.session_id == session_id
                })
            {
                records.insert(session_id, record);
            }
        }
        Ok(Self {
            directory,
            records: Mutex::new(records),
        })
    }

    /// The settings remembered for a chat, if any.
    pub(super) fn get(&self, session_id: &str) -> Option<RememberedSettings> {
        self.records.lock().ok()?.get(session_id).cloned()
    }

    /// Writes a complete file next to the target, then renames it into place.
    /// The in-memory copy changes only after the rename succeeded.
    pub(super) fn save(
        &self,
        session_id: &str,
        model: &WorkspaceModel,
        thinking_level: Option<&str>,
        service_tier: Option<&str>,
    ) -> io::Result<()> {
        Uuid::parse_str(session_id).map_err(io::Error::other)?;
        let mut stored_model = model.clone();
        // Catalog metadata is observed, not a choice: it is not remembered.
        stored_model.thinking_levels = None;
        let record = RememberedSettings {
            version: SETTINGS_VERSION,
            session_id: session_id.to_owned(),
            model: stored_model,
            thinking_level: thinking_level.map(str::to_owned),
            service_tier: service_tier.map(str::to_owned),
        };
        let bytes = serde_json::to_vec_pretty(&record).map_err(io::Error::other)?;
        let mut records = self
            .records
            .lock()
            .map_err(|_| io::Error::other("remembered settings are unavailable"))?;
        let target = self.directory.join(format!("{session_id}.json"));
        let staging = self
            .directory
            .join(format!(".{session_id}.{}.tmp", Uuid::new_v4()));
        let written = (|| -> io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&staging, &target)
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
        records.insert(session_id.to_owned(), record);
        Ok(())
    }

    /// Forgets the settings of a deleted chat or of one that never started.
    pub(super) fn discard(&self, session_id: &str) {
        if let Ok(mut records) = self.records.lock() {
            records.remove(session_id);
        }
        if Uuid::parse_str(session_id).is_ok() {
            let _ = fs::remove_file(self.directory.join(format!("{session_id}.json")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("piui-remembered-settings-{}", Uuid::new_v4()))
    }

    fn model() -> WorkspaceModel {
        WorkspaceModel {
            id: "chosen".into(),
            provider: Some("lab".into()),
            name: "Chosen".into(),
            thinking_levels: Some(vec!["low".into(), "high".into()]),
        }
    }

    #[test]
    fn remembered_settings_survive_a_restart() {
        let root = temp_root();
        let id = Uuid::new_v4().to_string();
        let store = RememberedSettingsStore::open(&root).expect("open");
        assert!(store.get(&id).is_none());
        store
            .save(&id, &model(), Some("high"), Some("fast"))
            .expect("save");
        drop(store);

        let reopened = RememberedSettingsStore::open(&root).expect("reopen");
        let remembered = reopened.get(&id).expect("remembered");
        assert_eq!(remembered.session_id, id);
        assert_eq!(remembered.model.id, "chosen");
        assert_eq!(remembered.model.provider.as_deref(), Some("lab"));
        assert_eq!(
            remembered.model.thinking_levels, None,
            "catalog metadata is not remembered"
        );
        assert_eq!(remembered.thinking_level.as_deref(), Some("high"));
        assert_eq!(remembered.service_tier.as_deref(), Some("fast"));

        // A later choice replaces the earlier one, including a cleared level.
        reopened.save(&id, &model(), None, None).expect("replace");
        let replaced = reopened.get(&id).expect("replaced");
        assert_eq!(replaced.thinking_level, None);
        assert_eq!(replaced.service_tier, None);
        assert!(
            reopened
                .save("not-a-session", &model(), None, None)
                .is_err(),
            "only a session uuid names a file"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unreadable_file_is_ignored_and_replaced_by_the_next_save() {
        let root = temp_root();
        let directory = root.join(SETTINGS_DIRECTORY);
        fs::create_dir_all(&directory).expect("directory");
        let partial = Uuid::new_v4().to_string();
        fs::write(directory.join(format!("{partial}.json")), b"partial").expect("partial");
        let unknown = Uuid::new_v4().to_string();
        fs::write(
            directory.join(format!("{unknown}.json")),
            format!(
                r#"{{"version":1,"sessionId":"{unknown}","model":{{"id":"m","name":"M"}},"extra":true}}"#
            ),
        )
        .expect("unknown field");
        let future = Uuid::new_v4().to_string();
        fs::write(
            directory.join(format!("{future}.json")),
            format!(r#"{{"version":2,"sessionId":"{future}","model":{{"id":"m","name":"M"}}}}"#),
        )
        .expect("future version");
        let renamed = Uuid::new_v4().to_string();
        let other = Uuid::new_v4().to_string();
        fs::write(
            directory.join(format!("{renamed}.json")),
            format!(r#"{{"version":1,"sessionId":"{other}","model":{{"id":"m","name":"M"}}}}"#),
        )
        .expect("copied file");

        let store = RememberedSettingsStore::open(&root).expect("open ignores bad files");
        assert!(store.get(&partial).is_none());
        assert!(store.get(&unknown).is_none());
        assert!(store.get(&future).is_none());
        assert!(store.get(&renamed).is_none());
        assert!(store.get(&other).is_none());
        assert!(
            directory.join(format!("{partial}.json")).exists(),
            "an unreadable file is skipped, not deleted"
        );

        store
            .save(&partial, &model(), Some("low"), None)
            .expect("save replaces it");
        let remembered = store.get(&partial).expect("remembered");
        assert_eq!(remembered.thinking_level.as_deref(), Some("low"));
        drop(store);
        let reopened = RememberedSettingsStore::open(&root).expect("reopen");
        assert!(reopened.get(&partial).is_some());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn discard_forgets_the_chat() {
        let root = temp_root();
        let id = Uuid::new_v4().to_string();
        let store = RememberedSettingsStore::open(&root).expect("open");
        store.save(&id, &model(), Some("high"), None).expect("save");
        let file = root.join(SETTINGS_DIRECTORY).join(format!("{id}.json"));
        assert!(file.exists());

        store.discard(&id);
        assert!(store.get(&id).is_none());
        assert!(!file.exists());
        store.discard(&id);
        store.discard("not-a-session");
        let reopened = RememberedSettingsStore::open(&root).expect("reopen");
        assert!(reopened.get(&id).is_none());
        let _ = fs::remove_dir_all(&root);
    }
}
