//! Host-only filesystem watcher for Pi session roots.
//!
//! Watcher events are deliberately treated as lossy scheduling hints: they
//! contain no path/content data on the WebView boundary and never mutate the
//! catalog directly. The authoritative reconciliation path always reopens and
//! verifies Pi JSONL through `piui-index`.

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const SESSION_ROOT_HINT_EVENT: &str = "piui://session-root-hint";
const WATCHER_PROTOCOL: u8 = 7;
const EVENT_COALESCE_WINDOW: Duration = Duration::from_millis(200);

/// The only watcher data allowed across the WebView boundary. A sequence lets
/// the frontend collapse duplicate hints; paths, event names, and errors stay
/// host-private.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRootHint {
    pub protocol: u8,
    pub sequence: u64,
    pub kind: &'static str,
}

enum WatchInput {
    AddRoot(PathBuf),
    Event(Result<Event, notify::Error>),
}

/// A small command handle retained by [`crate::state::HostState`]. It never
/// exposes a filesystem API to Tauri/WebView callers.
#[derive(Clone)]
pub struct CatalogWatcher {
    sender: Sender<WatchInput>,
}

impl CatalogWatcher {
    pub fn add_root(&self, root: PathBuf) {
        // A closed watcher is equivalent to an unavailable watcher; polling or
        // an explicit refresh remains safe recovery, so the send is best-effort.
        let _ = self.sender.send(WatchInput::AddRoot(root));
    }
}

/// Starts a process-lifetime watcher thread. Failure is deliberately
/// non-fatal: the catalog remains available from SQLite and callers can use
/// explicit/background reconciliation as the safe polling fallback.
pub fn start_catalog_watcher(app: AppHandle, initial_roots: Vec<PathBuf>) -> CatalogWatcher {
    let (sender, receiver) = mpsc::channel::<WatchInput>();
    let handle = CatalogWatcher {
        sender: sender.clone(),
    };
    let thread_sender = sender.clone();
    let _ = thread::Builder::new()
        .name("piui-session-root-watch".to_owned())
        .spawn(move || run_watcher(app, initial_roots, receiver, thread_sender));
    handle
}

fn run_watcher(
    app: AppHandle,
    initial_roots: Vec<PathBuf>,
    receiver: Receiver<WatchInput>,
    sender: Sender<WatchInput>,
) {
    let callback_sender = sender.clone();
    let mut watcher = match RecommendedWatcher::new(
        move |event| {
            let _ = callback_sender.send(WatchInput::Event(event));
        },
        Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(_) => {
            emit_hint(&app, 1, "unavailable");
            return;
        }
    };

    let mut watched_roots = HashSet::new();
    for root in initial_roots {
        add_root(&mut watcher, &mut watched_roots, root);
    }

    let mut sequence = 0_u64;
    while let Ok(input) = receiver.recv() {
        match input {
            WatchInput::AddRoot(root) => add_root(&mut watcher, &mut watched_roots, root),
            WatchInput::Event(first) => {
                let mut overflow = first.is_err();
                // A watcher can emit many changes for one Pi append. Coalesce
                // them into one opaque reconciliation hint while still accepting
                // newly registered roots promptly.
                while let Ok(next) = receiver.recv_timeout(EVENT_COALESCE_WINDOW) {
                    match next {
                        WatchInput::AddRoot(root) => {
                            add_root(&mut watcher, &mut watched_roots, root)
                        }
                        WatchInput::Event(result) => overflow |= result.is_err(),
                    }
                }
                sequence = sequence.wrapping_add(1).max(1);
                emit_hint(
                    &app,
                    sequence,
                    if overflow { "overflow" } else { "changed" },
                );
            }
        }
    }
}

fn add_root(watcher: &mut RecommendedWatcher, watched_roots: &mut HashSet<PathBuf>, root: PathBuf) {
    if !watchable_root(&root) || !watched_roots.insert(root.clone()) {
        return;
    }
    // Failure to watch a root does not invalidate cached state. Remove it from
    // the dedupe set so a later reconciliation can retry registration.
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        watched_roots.remove(&root);
    }
}

fn watchable_root(root: &Path) -> bool {
    fs::symlink_metadata(root)
        .is_ok_and(|metadata| !metadata.file_type().is_symlink() && metadata.is_dir())
}

fn emit_hint(app: &AppHandle, sequence: u64, kind: &'static str) {
    let _ = app.emit(
        SESSION_ROOT_HINT_EVENT,
        SessionRootHint {
            protocol: WATCHER_PROTOCOL,
            sequence,
            kind,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::watchable_root;
    use std::fs;

    #[test]
    fn only_real_directories_are_watchable_roots() {
        let root = std::env::temp_dir().join(format!("piui-catalog-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("creates fixture root");
        assert!(watchable_root(&root));
        let file = root.join("not-a-directory");
        fs::write(&file, "fixture").expect("writes fixture file");
        assert!(!watchable_root(&file));
        let _ = fs::remove_dir_all(root);
    }
}
