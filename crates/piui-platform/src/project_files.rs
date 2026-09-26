//! Project-relative file names for composer `@` mentions.
//!
//! Only names are listed: no file is opened and no content is read. The walk
//! stays inside the given root (links are neither followed nor listed), skips
//! hidden entries, dependency/build folders and everything `.gitignore`,
//! `.ignore` or git's exclude files ignore, and is bounded by entry count,
//! result count, depth and time.

use crate::project_watch::IGNORED_DIRECTORY_NAMES;
use ignore::WalkBuilder;
use std::fmt;
use std::path::Path;
use std::time::{Duration, Instant};

/// Most paths returned by one listing.
pub const MAX_PROJECT_FILES: usize = 2_000;
/// Most directory entries one listing visits before it stops.
pub const MAX_VISITED_ENTRIES: usize = 100_000;
/// Longest accepted query, in characters.
pub const MAX_FILE_QUERY_CHARS: usize = 256;
/// Deepest directory level walked below the root.
const MAX_DEPTH: usize = 32;
/// Longest project-relative path listed, in bytes.
const MAX_RELATIVE_PATH_BYTES: usize = 1_024;
/// Wall-clock bound of one walk.
const MAX_WALK_TIME: Duration = Duration::from_secs(3);

/// Paths found by [`list_project_files`].
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProjectFileListing {
    /// `/`-separated project-relative paths, shallow paths first.
    pub files: Vec<String>,
    /// More paths matched, or the walk stopped at one of its bounds.
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectFilesError {
    /// The query is too long or contains control characters.
    InvalidQuery,
    /// The root is not a readable directory.
    Unreadable,
}

impl fmt::Display for ProjectFilesError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidQuery => "the file query is invalid",
            Self::Unreadable => "the project folder could not be listed",
        })
    }
}

impl std::error::Error for ProjectFilesError {}

/// Normalized query characters, or an error for an unacceptable query.
fn needle(query: &str) -> Result<Vec<char>, ProjectFilesError> {
    if query.chars().count() > MAX_FILE_QUERY_CHARS || query.chars().any(char::is_control) {
        return Err(ProjectFilesError::InvalidQuery);
    }
    Ok(query
        .trim()
        .trim_start_matches('@')
        .chars()
        .filter(|character| !character.is_whitespace())
        .map(|character| if character == '\\' { '/' } else { character })
        .flat_map(char::to_lowercase)
        .collect())
}

/// Whether every needle character appears in `path` in order (case-insensitive).
fn matches(needle: &[char], path: &str) -> bool {
    let mut remaining = needle.iter().peekable();
    for character in path.chars().flat_map(char::to_lowercase) {
        if remaining.peek() == Some(&&character) {
            remaining.next();
        }
        if remaining.peek().is_none() {
            return true;
        }
    }
    remaining.peek().is_none()
}

/// Lists regular files below `root` whose relative path matches `query`
/// (a case-insensitive subsequence; empty matches everything).
pub fn list_project_files(
    root: &Path,
    query: &str,
) -> Result<ProjectFileListing, ProjectFilesError> {
    let needle = needle(query)?;
    if !root.is_dir() {
        return Err(ProjectFilesError::Unreadable);
    }
    let started = Instant::now();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // `.gitignore` applies in folders that are not git repositories too.
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(MAX_DEPTH))
        .sort_by_file_name(|left, right| left.cmp(right))
        .filter_entry(|entry| {
            !(entry.file_type().is_some_and(|kind| kind.is_dir())
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| IGNORED_DIRECTORY_NAMES.contains(&name)))
        })
        .build();
    let mut listing = ProjectFileListing::default();
    let mut visited = 0usize;
    for entry in walker {
        visited += 1;
        if visited > MAX_VISITED_ENTRIES || started.elapsed() > MAX_WALK_TIME {
            listing.truncated = true;
            break;
        }
        // Unreadable subfolders are skipped; the rest stays listable.
        let Ok(entry) = entry else { continue };
        // Only regular files: links, folders and devices are never listed.
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let Some(relative) = relative.to_str() else {
            continue;
        };
        let relative = relative.replace('\\', "/");
        if relative.is_empty()
            || relative.len() > MAX_RELATIVE_PATH_BYTES
            || relative
                .split('/')
                .any(|part| part == ".." || part.is_empty())
            || !matches(&needle, &relative)
        {
            continue;
        }
        if listing.files.len() == MAX_PROJECT_FILES {
            listing.truncated = true;
            break;
        }
        listing.files.push(relative);
    }
    listing.files.sort_by(|left, right| {
        left.matches('/')
            .count()
            .cmp(&right.matches('/').count())
            .then_with(|| left.cmp(right))
    });
    Ok(listing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "piui-project-files-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("creates fixture root");
        root
    }

    fn write(root: &Path, relative: &str, text: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("has parent")).expect("creates folders");
        fs::write(path, text).expect("writes file");
    }

    #[test]
    fn lists_names_only_respecting_gitignore_hidden_and_dependency_folders() {
        let root = fixture("ignore");
        write(&root, ".gitignore", "*.log\nbuild/\n!keep.log\n");
        write(&root, "README.md", "readme");
        write(&root, "src/main.rs", "fn main() {}");
        write(&root, "src/app/view.svelte", "<p></p>");
        write(&root, "debug.log", "ignored");
        write(&root, "keep.log", "negated");
        write(&root, "build/out.js", "ignored");
        write(&root, "node_modules/pkg/index.js", "dependency");
        write(&root, "target/debug/app", "build output");
        write(&root, ".hidden/secret.txt", "hidden");
        write(&root, ".env", "hidden");
        write(&root, "nested/.gitignore", "local.txt\n");
        write(&root, "nested/local.txt", "ignored below");
        write(&root, "nested/kept.txt", "kept");

        let listing = list_project_files(&root, "").expect("lists");
        assert!(!listing.truncated);
        assert_eq!(
            listing.files,
            [
                "README.md",
                "keep.log",
                "nested/kept.txt",
                "src/main.rs",
                "src/app/view.svelte",
            ]
        );
        fs::remove_dir_all(root).expect("removes fixture");
    }

    #[test]
    fn a_query_narrows_by_case_insensitive_subsequence() {
        let root = fixture("query");
        write(&root, "src/Main.rs", "");
        write(&root, "src/lib.rs", "");
        write(&root, "docs/manual.md", "");
        let listing = list_project_files(&root, "@SRC\\mn").expect("lists");
        assert_eq!(listing.files, ["src/Main.rs"]);
        let listing = list_project_files(&root, "man").expect("lists");
        assert_eq!(listing.files, ["docs/manual.md", "src/Main.rs"]);
        assert_eq!(
            list_project_files(&root, "zzz").expect("lists").files,
            Vec::<String>::new()
        );
        fs::remove_dir_all(root).expect("removes fixture");
    }

    #[test]
    fn rejects_bad_queries_and_missing_roots() {
        let root = fixture("invalid");
        assert_eq!(
            list_project_files(&root, &"x".repeat(MAX_FILE_QUERY_CHARS + 1)),
            Err(ProjectFilesError::InvalidQuery)
        );
        assert_eq!(
            list_project_files(&root, "a\u{0}b"),
            Err(ProjectFilesError::InvalidQuery)
        );
        assert_eq!(
            list_project_files(&root.join("missing"), ""),
            Err(ProjectFilesError::Unreadable)
        );
        write(&root, "file.txt", "");
        assert_eq!(
            list_project_files(&root.join("file.txt"), ""),
            Err(ProjectFilesError::Unreadable)
        );
        fs::remove_dir_all(root).expect("removes fixture");
    }

    #[test]
    fn the_result_count_is_bounded() {
        let root = fixture("bounded");
        for index in 0..(MAX_PROJECT_FILES + 5) {
            write(&root, &format!("many/file-{index:05}.txt"), "");
        }
        let listing = list_project_files(&root, "").expect("lists");
        assert!(listing.truncated);
        assert_eq!(listing.files.len(), MAX_PROJECT_FILES);
        fs::remove_dir_all(root).expect("removes fixture");
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn links_are_neither_followed_nor_listed() {
        let root = fixture("links");
        let outside = fixture("links-outside");
        write(&outside, "secret.txt", "outside the project");
        write(&root, "inside.txt", "");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, root.join("escape")).is_ok()
            && std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("file-link"))
                .is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, root.join("escape")).is_ok()
            && std::os::windows::fs::symlink_file(
                outside.join("secret.txt"),
                root.join("file-link"),
            )
            .is_ok();
        if !linked {
            // Creating links needs a privilege some Windows machines lack.
            eprintln!("SKIP: could not create links for the project file walk test");
        }
        let listing = list_project_files(&root, "").expect("lists");
        assert_eq!(listing.files, ["inside.txt"]);
        let _ = fs::remove_file(root.join("file-link"));
        let _ = fs::remove_dir(root.join("escape"));
        let _ = fs::remove_file(root.join("escape"));
        fs::remove_dir_all(root).expect("removes fixture");
        fs::remove_dir_all(outside).expect("removes outside fixture");
    }
}
