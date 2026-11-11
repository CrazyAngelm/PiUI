//! Host-only filesystem watcher for Pi session roots.
//!
//! Watcher events are deliberately treated as lossy scheduling hints: they
//! contain no path/content data on the WebView boundary and never mutate the
//! catalog directly. The authoritative reconciliation path always reopens and
//! verifies Pi JSONL through `piui-index`.

use notify::event::{EventKind, ModifyKind};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const SESSION_ROOT_HINT_EVENT: &str = "piui://session-root-hint";
const WATCHER_PROTOCOL: u8 = 7;
const EVENT_COALESCE_WINDOW: Duration = Duration::from_millis(200);
/// Longest a batch may keep growing: continuous writes still emit a hint at
/// least this often (a multiple of `EVENT_COALESCE_WINDOW`).
const MAX_BATCH_WINDOW_FACTOR: u32 = 15;

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
            // An event that cannot change the catalog starts no batch.
            WatchInput::Event(first) if !event_may_change_catalog(&first) => {}
            WatchInput::Event(first) => {
                let mut overflow = first.is_err();
                // A watcher can emit many changes for one Pi append. Coalesce
                // them into one opaque reconciliation hint while still accepting
                // newly registered roots promptly. The batch ends after a quiet
                // window, or at the maximum window while changes continue;
                // irrelevant events do not extend it.
                let started = Instant::now();
                let mut last_relevant = started;
                let max_window = EVENT_COALESCE_WINDOW.saturating_mul(MAX_BATCH_WINDOW_FACTOR);
                loop {
                    let quiet = EVENT_COALESCE_WINDOW.saturating_sub(last_relevant.elapsed());
                    let remaining = max_window.saturating_sub(started.elapsed());
                    let wait = quiet.min(remaining);
                    if wait.is_zero() {
                        break;
                    }
                    match receiver.recv_timeout(wait) {
                        Ok(WatchInput::AddRoot(root)) => {
                            add_root(&mut watcher, &mut watched_roots, root)
                        }
                        Ok(WatchInput::Event(result)) => {
                            if event_may_change_catalog(&result) {
                                overflow |= result.is_err();
                                last_relevant = Instant::now();
                            }
                        }
                        Err(_) => break,
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

/// Whether a watcher result can change the session catalog. Conservative: an
/// error, a creation, removal or rename (which can add or drop a whole folder
/// of sessions), an event without a path and an unknown kind all count. Access
/// events never do, and a content or metadata change counts only on a `.jsonl`
/// file, the only kind the scanner reads.
fn event_may_change_catalog(result: &Result<Event, notify::Error>) -> bool {
    let Ok(event) = result else {
        return true;
    };
    match &event.kind {
        EventKind::Access(_) => false,
        EventKind::Modify(kind) if !matches!(kind, ModifyKind::Name(_)) => {
            event.paths.is_empty() || event.paths.iter().any(|path| is_jsonl_path(path))
        }
        _ => true,
    }
}

fn is_jsonl_path(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
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
    use super::{event_may_change_catalog, watchable_root};
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, MetadataKind, ModifyKind, RemoveKind,
        RenameMode,
    };
    use notify::{Event, EventKind};
    use std::fs;
    use std::path::PathBuf;

    fn event(kind: EventKind, paths: &[&str]) -> Result<Event, notify::Error> {
        let mut event = Event::new(kind);
        for path in paths {
            event = event.add_path(PathBuf::from(path));
        }
        Ok(event)
    }

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

    #[test]
    fn access_events_never_change_the_catalog() {
        for kind in [
            AccessKind::Read,
            AccessKind::Open(AccessMode::Any),
            AccessKind::Close(AccessMode::Write),
        ] {
            assert!(!event_may_change_catalog(&event(
                EventKind::Access(kind),
                &["/sessions/a.jsonl"]
            )));
        }
    }

    #[test]
    fn content_changes_count_only_on_jsonl_files() {
        let data = EventKind::Modify(ModifyKind::Data(DataChange::Any));
        assert!(event_may_change_catalog(&event(
            data,
            &["/sessions/proj/a.jsonl"]
        )));
        assert!(event_may_change_catalog(&event(
            data,
            &["/sessions/proj/A.JSONL"]
        )));
        assert!(!event_may_change_catalog(&event(
            data,
            &["/sessions/proj/a.json", "/sessions/proj/a.jsonl.tmp"]
        )));
        assert!(!event_may_change_catalog(&event(
            EventKind::Modify(ModifyKind::Any),
            &["/sessions/proj"]
        )));
        assert!(!event_may_change_catalog(&event(
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
            &["/sessions/proj/notes.txt"]
        )));
        assert!(event_may_change_catalog(&event(
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
            &["/sessions/proj/a.jsonl"]
        )));
    }

    #[test]
    fn structure_changes_and_unknown_events_are_kept() {
        // Folders can hold sessions, so creating, removing or renaming any
        // entry counts, as does an event that carries no path.
        for kind in [
            EventKind::Create(CreateKind::Folder),
            EventKind::Create(CreateKind::Any),
            EventKind::Remove(RemoveKind::Folder),
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            EventKind::Any,
            EventKind::Other,
        ] {
            assert!(event_may_change_catalog(&event(
                kind,
                &["/sessions/my.project"]
            )));
        }
        assert!(event_may_change_catalog(&event(
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            &[]
        )));
        assert!(event_may_change_catalog(&Err(notify::Error::generic(
            "lost events"
        ))));
    }
}
