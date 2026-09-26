//! Real git on temporary repositories. Each test creates its own repository
//! under the system temp folder and removes it afterwards.

use super::{
    ApplyTarget, GitError, GitRunner, StatusCode, StatusEntry, add_path, apply, branch_exists,
    check_branch_name, diff, head_commit, locate, numstat, plain_branch_name, status, worktree_add,
    worktree_remove,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch {
    root: PathBuf,
    runner: GitRunner,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piui-git-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("hooks-off")).expect("creates scratch");
        let runner =
            GitRunner::resolve(root.join("hooks-off")).expect("git is installed for these tests");
        Self { root, runner }
    }

    fn repo(&self) -> PathBuf {
        self.root.join("repo")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Plain git for fixture setup only (never through PiUI's runner options).
fn git(cwd: &Path, arguments: &[&str]) {
    let status = std::process::Command::new(if cfg!(windows) { "git.exe" } else { "git" })
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("runs fixture git");
    assert!(status.success(), "fixture git {arguments:?} failed");
}

fn lines(values: &[&str]) -> String {
    values.iter().map(|line| format!("{line}\n")).collect()
}

const ORIGINAL: [&str; 13] = [
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
];

fn init_repository(scratch: &Scratch) -> PathBuf {
    let repo = scratch.repo();
    std::fs::create_dir_all(repo.join("src")).expect("creates repo");
    git(&repo, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.email", "piui@example.com"),
        ("user.name", "PiUI tests"),
        ("core.autocrlf", "false"),
        ("commit.gpgsign", "false"),
    ] {
        git(&repo, &["config", key, value]);
    }
    std::fs::write(repo.join("src/f.txt"), lines(&ORIGINAL)).expect("writes text");
    std::fs::write(repo.join("gone.txt"), "delete me\n").expect("writes doomed file");
    std::fs::write(repo.join("image.bin"), b"bin\0ary").expect("writes binary");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    repo
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

#[test]
fn locates_the_work_tree_prefix_and_common_directory() {
    let scratch = Scratch::new("locate");
    let repo = init_repository(&scratch);
    block_on(async {
        let location = locate(&scratch.runner, &repo.join("src"))
            .await
            .expect("locates");
        assert_eq!(location.top, std::fs::canonicalize(&repo).expect("top"));
        assert_eq!(location.prefix, "src/");
        assert_eq!(
            location.common_dir,
            std::fs::canonicalize(repo.join(".git")).expect("common dir")
        );
        let outside = scratch.root.join("plain");
        std::fs::create_dir_all(&outside).expect("plain folder");
        // The scratch root may itself sit inside a repository on a developer
        // machine; only assert when git sees no work tree there.
        if let Err(error) = locate(&scratch.runner, &outside).await {
            assert_eq!(error, GitError::NotRepository);
        }
    });
}

#[test]
fn status_and_line_counts_cover_every_area() {
    let scratch = Scratch::new("status");
    let repo = init_repository(&scratch);
    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits");
    std::fs::remove_file(repo.join("gone.txt")).expect("deletes");
    std::fs::write(repo.join("image.bin"), b"bin\0ary2").expect("edits binary");
    std::fs::write(repo.join("src/new file.md"), "hello\n").expect("untracked");
    std::fs::write(repo.join("staged.txt"), "staged\n").expect("staged");
    git(&repo, &["add", "staged.txt"]);
    block_on(async {
        let top = std::fs::canonicalize(&repo).expect("top");
        let report = status(&scratch.runner, &top, "").await.expect("status");
        assert_eq!(report.branch.as_deref(), Some("main"));
        assert!(report.head.is_some());
        let find = |path: &str| {
            report
                .entries
                .iter()
                .find(|entry| entry.path() == path)
                .cloned()
                .unwrap_or_else(|| panic!("missing {path}"))
        };
        assert!(matches!(
            find("src/f.txt"),
            StatusEntry::Changed {
                worktree: StatusCode::Modified,
                index: StatusCode::Unmodified,
                ..
            }
        ));
        assert!(matches!(
            find("gone.txt"),
            StatusEntry::Changed {
                worktree: StatusCode::Deleted,
                ..
            }
        ));
        assert!(matches!(
            find("staged.txt"),
            StatusEntry::Changed {
                index: StatusCode::Added,
                ..
            }
        ));
        assert_eq!(
            find("src/new file.md"),
            StatusEntry::Untracked {
                path: "src/new file.md".into()
            }
        );
        let limited = status(&scratch.runner, &top, "src/")
            .await
            .expect("status of src");
        assert!(
            limited
                .entries
                .iter()
                .all(|entry| entry.path().starts_with("src/"))
        );

        let unstaged = numstat(&scratch.runner, &top, "", false)
            .await
            .expect("numstat");
        assert_eq!(
            unstaged.get("src/f.txt").and_then(|counts| counts.added),
            Some(1)
        );
        assert_eq!(
            unstaged.get("image.bin").and_then(|counts| counts.added),
            None
        );
        let staged = numstat(&scratch.runner, &top, "", true)
            .await
            .expect("cached numstat");
        assert_eq!(
            staged.get("staged.txt").and_then(|counts| counts.added),
            Some(1)
        );
    });
}

#[test]
fn a_single_hunk_is_staged_unstaged_and_reverted_exactly() {
    let scratch = Scratch::new("hunks");
    let repo = init_repository(&scratch);
    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    changed[12] = "M";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits two regions");
    block_on(async {
        let top = std::fs::canonicalize(&repo).expect("top");
        let runner = &scratch.runner;
        let unstaged = diff(runner, &top, "src/f.txt", false).await.expect("diff");
        assert_eq!(unstaged.hunk_count(), 2);
        let second = unstaged.hunk_patch(1).expect("second hunk");
        apply(runner, &top, &second, ApplyTarget::Index, false)
            .await
            .expect("stages the second hunk");
        let staged = diff(runner, &top, "src/f.txt", true)
            .await
            .expect("cached diff");
        assert_eq!(staged.hunk_count(), 1);
        assert_eq!(staged.line_counts(), (1, 1));
        let remaining = diff(runner, &top, "src/f.txt", false).await.expect("diff");
        assert_eq!(remaining.hunk_count(), 1);
        assert!(
            remaining
                .display_text(1 << 20)
                .expect("text")
                .contains("+A")
        );

        // Replaying the same patch again no longer applies.
        assert_eq!(
            apply(runner, &top, &second, ApplyTarget::Index, false).await,
            Err(GitError::DoesNotApply)
        );

        let staged_hunk = staged.hunk_patch(0).expect("staged hunk");
        apply(runner, &top, &staged_hunk, ApplyTarget::Index, true)
            .await
            .expect("unstages it");
        assert!(
            diff(runner, &top, "src/f.txt", true)
                .await
                .expect("cached")
                .is_empty()
        );

        let current = diff(runner, &top, "src/f.txt", false).await.expect("diff");
        let first = current.hunk_patch(0).expect("first hunk");
        apply(runner, &top, &first, ApplyTarget::WorkTree, true)
            .await
            .expect("reverts the first hunk");
        let mut expected = ORIGINAL.to_vec();
        expected[12] = "M";
        assert_eq!(
            std::fs::read_to_string(repo.join("src/f.txt")).expect("reads"),
            lines(&expected)
        );

        // A hunk from before an edit is refused: its context changed.
        let before_edit = diff(runner, &top, "src/f.txt", false).await.expect("diff");
        let stale = before_edit.hunk_patch(0).expect("hunk");
        let mut edited = expected.clone();
        edited[11] = "L";
        std::fs::write(repo.join("src/f.txt"), lines(&edited)).expect("edits again");
        assert_eq!(
            apply(runner, &top, &stale, ApplyTarget::WorkTree, true).await,
            Err(GitError::DoesNotApply)
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("src/f.txt")).expect("reads"),
            lines(&edited),
            "a refused patch leaves the file untouched"
        );
    });
}

#[test]
fn whole_file_patches_cover_binary_deleted_and_untracked_files() {
    let scratch = Scratch::new("whole");
    let repo = init_repository(&scratch);
    std::fs::write(repo.join("image.bin"), b"bin\0ary-changed").expect("edits binary");
    std::fs::remove_file(repo.join("gone.txt")).expect("deletes");
    std::fs::write(repo.join("fresh.txt"), "fresh\n").expect("untracked");
    block_on(async {
        let top = std::fs::canonicalize(&repo).expect("top");
        let runner = &scratch.runner;
        let binary = diff(runner, &top, "image.bin", false)
            .await
            .expect("binary diff");
        assert!(binary.binary());
        assert!(!binary.hunks_selectable());
        apply(runner, &top, binary.bytes(), ApplyTarget::Index, false)
            .await
            .expect("stages the binary file");
        let staged = diff(runner, &top, "image.bin", true).await.expect("cached");
        assert!(staged.binary());
        apply(runner, &top, staged.bytes(), ApplyTarget::Index, true)
            .await
            .expect("unstages it");
        let unstaged = diff(runner, &top, "image.bin", false).await.expect("diff");
        apply(runner, &top, unstaged.bytes(), ApplyTarget::WorkTree, true)
            .await
            .expect("reverts the binary file");
        assert_eq!(
            std::fs::read(repo.join("image.bin")).expect("reads"),
            b"bin\0ary"
        );

        let deleted = diff(runner, &top, "gone.txt", false)
            .await
            .expect("deletion");
        assert!(deleted.sections()[0].deleted_file);
        apply(runner, &top, deleted.bytes(), ApplyTarget::WorkTree, true)
            .await
            .expect("restores the deleted file");
        assert_eq!(
            std::fs::read_to_string(repo.join("gone.txt")).expect("restored"),
            "delete me\n"
        );

        add_path(runner, &top, "fresh.txt")
            .await
            .expect("stages the untracked file");
        let report = status(runner, &top, "").await.expect("status");
        assert!(report.entries.iter().any(|entry| matches!(
            entry,
            StatusEntry::Changed { path, index: StatusCode::Added, .. } if path == "fresh.txt"
        )));
    });
}

#[test]
fn a_hunk_revert_keeps_crlf_work_trees_under_autocrlf() {
    let scratch = Scratch::new("crlf");
    let repo = init_repository(&scratch);
    git(&repo, &["config", "core.autocrlf", "true"]);
    let crlf =
        |values: &[&str]| -> String { values.iter().map(|line| format!("{line}\r\n")).collect() };
    std::fs::write(repo.join("win.txt"), crlf(&ORIGINAL)).expect("writes CRLF file");
    git(&repo, &["add", "win.txt"]);
    git(&repo, &["commit", "-q", "-m", "crlf"]);
    // A fresh checkout writes CRLF like a Windows clone does.
    std::fs::remove_file(repo.join("win.txt")).expect("removes");
    git(&repo, &["checkout", "--", "win.txt"]);
    let checked_out = std::fs::read(repo.join("win.txt")).expect("reads checkout");
    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    changed[12] = "M";
    std::fs::write(repo.join("win.txt"), crlf(&changed)).expect("agent edits");
    block_on(async {
        let top = std::fs::canonicalize(&repo).expect("top");
        let patch = diff(&scratch.runner, &top, "win.txt", false)
            .await
            .expect("diff");
        assert_eq!(patch.hunk_count(), 2, "line endings are not a change");
        let first = patch.hunk_patch(0).expect("hunk");
        apply(&scratch.runner, &top, &first, ApplyTarget::WorkTree, true)
            .await
            .expect("reverts the first hunk");
        let second = diff(&scratch.runner, &top, "win.txt", false)
            .await
            .expect("diff");
        let hunk = second.hunk_patch(0).expect("hunk");
        apply(&scratch.runner, &top, &hunk, ApplyTarget::WorkTree, true)
            .await
            .expect("reverts the second hunk");
    });
    assert_eq!(
        std::fs::read(repo.join("win.txt")).expect("reads"),
        checked_out,
        "the work tree is back to its CRLF checkout, byte for byte"
    );
}

#[test]
fn literal_pathspecs_never_expand_patterns() {
    let scratch = Scratch::new("literal");
    let repo = init_repository(&scratch);
    std::fs::write(repo.join("[ab].txt"), "bracket\n").expect("bracket name");
    std::fs::write(repo.join("a.txt"), "plain\n").expect("plain name");
    block_on(async {
        let top = std::fs::canonicalize(&repo).expect("top");
        add_path(&scratch.runner, &top, "[ab].txt")
            .await
            .expect("adds literally");
        let report = status(&scratch.runner, &top, "").await.expect("status");
        assert!(report.entries.contains(&StatusEntry::Untracked {
            path: "a.txt".into()
        }));
    });
}

#[test]
fn branch_names_are_checked_before_and_by_git() {
    for good in ["piui/feature-x", "fix_1.2", "a"] {
        assert!(plain_branch_name(good), "{good}");
    }
    for bad in [
        "",
        "-x",
        "a..b",
        "a//b",
        "@{-1}",
        "a b",
        "x.lock",
        "a/.hidden",
        "end/",
        "end.",
        ".start",
        "a\\b",
    ] {
        assert!(!plain_branch_name(bad), "{bad}");
    }
    let scratch = Scratch::new("branches");
    let repo = init_repository(&scratch);
    block_on(async {
        let top = std::fs::canonicalize(&repo).expect("top");
        check_branch_name(&scratch.runner, &top, "piui/new")
            .await
            .expect("valid");
        assert!(
            check_branch_name(&scratch.runner, &top, "-bad")
                .await
                .is_err()
        );
        assert!(
            branch_exists(&scratch.runner, &top, "main")
                .await
                .expect("checks")
        );
        assert!(
            !branch_exists(&scratch.runner, &top, "piui/new")
                .await
                .expect("checks")
        );
        assert_eq!(
            head_commit(&scratch.runner, &top)
                .await
                .expect("head")
                .len(),
            40
        );
    });
}

#[test]
fn worktrees_share_the_common_directory_and_removal_refuses_changes() {
    let scratch = Scratch::new("worktree");
    let repo = init_repository(&scratch);
    block_on(async {
        let runner = &scratch.runner;
        let top = std::fs::canonicalize(&repo).expect("top");
        let commit = head_commit(runner, &top).await.expect("head");
        let path = scratch.root.join("managed").join("feature");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("parent folder");
        worktree_add(runner, &top, &path, "piui/feature", &commit)
            .await
            .expect("adds a worktree");
        let main = locate(runner, &top).await.expect("main");
        let added = locate(runner, &path).await.expect("worktree");
        assert_eq!(added.common_dir, main.common_dir);
        assert_eq!(
            added.top,
            std::fs::canonicalize(&path).expect("worktree top")
        );
        assert!(
            branch_exists(runner, &top, "piui/feature")
                .await
                .expect("branch")
        );

        std::fs::write(path.join("work.txt"), "uncommitted\n").expect("dirty");
        assert!(worktree_remove(runner, &top, &path, false).await.is_err());
        assert!(
            path.join("work.txt").exists(),
            "a refused removal keeps the files"
        );
        worktree_remove(runner, &top, &path, true)
            .await
            .expect("forced removal");
        assert!(!path.exists());
        assert!(
            branch_exists(runner, &top, "piui/feature")
                .await
                .expect("branch"),
            "removing a worktree keeps its branch"
        );
    });
}

#[test]
fn repository_hooks_never_run() {
    let scratch = Scratch::new("hooks");
    let repo = init_repository(&scratch);
    let marker = scratch.root.join("hook-ran");
    let hooks = repo.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).expect("hooks folder");
    let marker_text = marker.to_string_lossy().replace('\\', "/");
    for name in [
        "post-checkout",
        "post-index-change",
        "reference-transaction",
    ] {
        let hook = hooks.join(name);
        std::fs::write(&hook, format!("#!/bin/sh\necho ran >> \"{marker_text}\"\n")).expect("hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("mode");
        }
    }
    // Control: plain git runs the hooks (a global core.hooksPath is overridden).
    let hooks_setting = format!(
        "core.hooksPath={}",
        hooks.to_string_lossy().replace('\\', "/")
    );
    git(&repo, &["-c", &hooks_setting, "branch", "control"]);
    assert!(marker.exists(), "fixture hooks run under plain git");
    std::fs::remove_file(&marker).expect("resets marker");

    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits");
    block_on(async {
        let runner = &scratch.runner;
        let top = std::fs::canonicalize(&repo).expect("top");
        let patch = diff(runner, &top, "src/f.txt", false).await.expect("diff");
        apply(runner, &top, patch.bytes(), ApplyTarget::Index, false)
            .await
            .expect("stages");
        let commit = head_commit(runner, &top).await.expect("head");
        let path = scratch.root.join("wt");
        worktree_add(runner, &top, &path, "piui/hooks", &commit)
            .await
            .expect("adds");
        status(runner, &top, "").await.expect("status");
    });
    assert!(
        !marker.exists(),
        "no repository hook ran for PiUI's git commands"
    );
}
