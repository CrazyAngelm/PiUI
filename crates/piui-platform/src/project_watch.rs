//! Recursive project-folder watcher for host-side automations.
//!
//! The watcher reports project-relative, `/`-separated paths of created,
//! changed, renamed or removed entries in coalesced batches. It never reads
//! file contents. Version control, dependency, build output and agent/PiUI
//! data folders are ignored, so an agent writing its own history or a build
//! writing `target/` cannot look like a user edit. Events are hints: a lost
//! or overflowing batch is reported as such and never guessed at.

use notify::event::{EventKind, ModifyKind};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

/// Folder names never reported at any depth.
pub const IGNORED_DIRECTORY_NAMES: &[&str] =
    &[".git", "node_modules", "target", "dist", ".pi", ".piui"];
/// Most distinct paths kept in one batch; more set `overflow`.
pub const MAX_BATCH_PATHS: usize = 256;
/// Longest time one batch may keep growing while changes continue.
const MAX_BATCH_WINDOW_FACTOR: u32 = 8;

/// One coalesced set of changes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChangeBatch {
    /// Sorted, distinct project-relative paths (`/`-separated).
    pub paths: Vec<String>,
    /// More paths changed than were kept, or the OS reported lost events.
    pub overflow: bool,
}

#[derive(Debug)]
pub enum ProjectWatchError {
    /// The root is not a real directory (missing, a file or a link).
    NotDirectory,
    /// The OS watcher could not be created or attached.
    Unavailable(String),
    /// The coalescing thread could not be started.
    Thread(std::io::Error),
}

impl std::fmt::Display for ProjectWatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotDirectory => formatter.write_str("project folder is not a directory"),
            Self::Unavailable(_) => formatter.write_str("file watching is unavailable"),
            Self::Thread(_) => formatter.write_str("could not start the watcher thread"),
        }
    }
}

impl std::error::Error for ProjectWatchError {}

/// Keeps the OS watch alive. Dropping it stops watching; its thread ends
/// after the current batch.
pub struct ProjectWatch {
    _watcher: RecommendedWatcher,
}

/// Whether a project-relative path lies in an ignored folder.
pub fn is_ignored_path(relative: &str) -> bool {
    relative
        .split('/')
        .any(|part| IGNORED_DIRECTORY_NAMES.contains(&part))
}

/// The project-relative form of `path`, or `None` when it is outside `root`,
/// inside an ignored folder, or not representable as UTF-8.
pub fn relative_change_path(root: &Path, extra_ignored: &[PathBuf], path: &Path) -> Option<String> {
    if extra_ignored
        .iter()
        .any(|ignored| path.starts_with(ignored))
    {
        return None;
    }
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?),
            // `..`, a prefix or a root inside a relative path is not a child.
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    let joined = parts.join("/");
    (!is_ignored_path(&joined)).then_some(joined)
}

fn counts(kind: &EventKind) -> bool {
    !matches!(
        kind,
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))
    )
}

/// Starts watching `root` recursively. `sink` receives one batch after
/// `coalesce` passes without a new change (or after a bounded window while
/// changes continue). It runs on the watcher's own thread and must not block.
pub fn watch_project<F>(
    root: &Path,
    extra_ignored: Vec<PathBuf>,
    coalesce: Duration,
    sink: F,
) -> Result<ProjectWatch, ProjectWatchError>
where
    F: Fn(ChangeBatch) + Send + 'static,
{
    let metadata = std::fs::symlink_metadata(root).map_err(|_| ProjectWatchError::NotDirectory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ProjectWatchError::NotDirectory);
    }
    let (sender, receiver) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(
        move |event| {
            // A closed receiver means the watch is being dropped.
            let _ = sender.send(event);
        },
        Config::default(),
    )
    .map_err(|error| ProjectWatchError::Unavailable(error.to_string()))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|error| ProjectWatchError::Unavailable(error.to_string()))?;
    let root = root.to_path_buf();
    thread::Builder::new()
        .name("piui-project-watch".to_owned())
        .spawn(move || coalesce_events(&root, &extra_ignored, coalesce, &receiver, &sink))
        .map_err(ProjectWatchError::Thread)?;
    Ok(ProjectWatch { _watcher: watcher })
}

fn coalesce_events<F: Fn(ChangeBatch)>(
    root: &Path,
    extra_ignored: &[PathBuf],
    coalesce: Duration,
    receiver: &Receiver<notify::Result<Event>>,
    sink: &F,
) {
    let window = coalesce.saturating_mul(MAX_BATCH_WINDOW_FACTOR);
    loop {
        // Wait for the first relevant change of the next batch.
        let mut paths = BTreeSet::new();
        let mut overflow = false;
        loop {
            match receiver.recv() {
                Ok(event) => {
                    if collect(root, extra_ignored, event, &mut paths, &mut overflow) {
                        break;
                    }
                }
                Err(_) => return,
            }
        }
        let started = Instant::now();
        loop {
            let remaining = window.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            match receiver.recv_timeout(coalesce.min(remaining)) {
                Ok(event) => {
                    collect(root, extra_ignored, event, &mut paths, &mut overflow);
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    sink(batch(paths, overflow));
                    return;
                }
            }
        }
        sink(batch(paths, overflow));
    }
}

/// Adds an event's relevant paths; true when it contributed anything.
fn collect(
    root: &Path,
    extra_ignored: &[PathBuf],
    event: notify::Result<Event>,
    paths: &mut BTreeSet<String>,
    overflow: &mut bool,
) -> bool {
    let event = match event {
        Ok(event) => event,
        Err(_) => {
            *overflow = true;
            return true;
        }
    };
    if event.need_rescan() {
        *overflow = true;
        return true;
    }
    if !counts(&event.kind) {
        return false;
    }
    let mut added = false;
    for path in &event.paths {
        if let Some(relative) = relative_change_path(root, extra_ignored, path) {
            added = true;
            if paths.len() < MAX_BATCH_PATHS {
                paths.insert(relative);
            } else if !paths.contains(&relative) {
                *overflow = true;
            }
        }
    }
    added
}

fn batch(paths: BTreeSet<String>, overflow: bool) -> ChangeBatch {
    ChangeBatch {
        paths: paths.into_iter().collect(),
        overflow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "piui-project-watch-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("creates watch fixture");
        // Canonical like the host's verified project directory.
        std::fs::canonicalize(&root).expect("canonical fixture")
    }

    #[test]
    fn ignored_folders_and_foreign_paths_are_never_reported() {
        let root = Path::new("/project");
        let extra = vec![PathBuf::from("/project/app-data")];
        let relative = |path: &str| relative_change_path(root, &extra, Path::new(path));
        assert_eq!(
            relative("/project/src/main.ts").as_deref(),
            Some("src/main.ts")
        );
        assert_eq!(relative("/project/README.md").as_deref(), Some("README.md"));
        for ignored in [
            "/project/.git/index",
            "/project/node_modules/pkg/index.js",
            "/project/crates/app/target/debug/app",
            "/project/web/dist/bundle.js",
            "/project/.pi/agent-sessions/a.jsonl",
            "/project/.piui/state.json",
            "/project/app-data/orchestration/generation.json",
            "/elsewhere/file.txt",
            "/project",
        ] {
            assert_eq!(relative(ignored), None, "{ignored}");
        }
        assert!(is_ignored_path("a/node_modules/b"));
        assert!(!is_ignored_path("a/node_modules_backup/b"));
    }

    #[test]
    fn a_burst_of_changes_arrives_as_one_filtered_batch() {
        let root = fixture("burst");
        let batches = Arc::new(Mutex::new(Vec::<ChangeBatch>::new()));
        let sink = Arc::clone(&batches);
        let watch = watch_project(
            &root,
            Vec::new(),
            Duration::from_millis(300),
            move |batch| {
                sink.lock().expect("batch lock").push(batch);
            },
        )
        .expect("watches the fixture");
        std::fs::create_dir_all(root.join("src")).expect("creates src");
        std::fs::create_dir_all(root.join("node_modules/pkg")).expect("creates ignored folder");
        for index in 0..5 {
            std::fs::write(root.join("src").join(format!("file{index}.ts")), "x").expect("writes");
            std::fs::write(root.join("node_modules/pkg/index.js"), "x").expect("writes ignored");
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let collected = loop {
            thread::sleep(Duration::from_millis(100));
            let current = batches.lock().expect("batch lock").clone();
            let seen: BTreeSet<String> = current
                .iter()
                .flat_map(|batch| batch.paths.clone())
                .collect();
            if (0..5).all(|index| seen.contains(&format!("src/file{index}.ts")))
                || Instant::now() > deadline
            {
                break current;
            }
        };
        drop(watch);
        let seen: BTreeSet<String> = collected
            .iter()
            .flat_map(|batch| batch.paths.clone())
            .collect();
        for index in 0..5 {
            assert!(seen.contains(&format!("src/file{index}.ts")), "{seen:?}");
        }
        assert!(
            seen.iter().all(|path| !path.starts_with("node_modules")),
            "{seen:?}"
        );
        // Five quick writes coalesce into very few batches, not one per event.
        assert!(collected.len() <= 3, "{collected:?}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_real_directories_can_be_watched() {
        let root = fixture("not-dir");
        let file = root.join("file.txt");
        std::fs::write(&file, "x").expect("writes file");
        assert!(matches!(
            watch_project(&file, Vec::new(), Duration::from_millis(50), |_| {}),
            Err(ProjectWatchError::NotDirectory)
        ));
        assert!(matches!(
            watch_project(
                &root.join("missing"),
                Vec::new(),
                Duration::from_millis(50),
                |_| {}
            ),
            Err(ProjectWatchError::NotDirectory)
        ));
        let _ = std::fs::remove_dir_all(root);
    }
}
