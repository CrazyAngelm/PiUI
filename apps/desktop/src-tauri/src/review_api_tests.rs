//! Review v1 against real git on temporary repositories.

use super::{
    ReviewArea, ReviewChange, ReviewContentV1, ReviewRepositoryV1, ReviewRequestV1, ReviewResultV1,
    dispatch_review,
};
use crate::session_tools_test_support::{
    Fixture, ORIGINAL, block_on, git, git_output, init_repository, lines, outside_any_repository,
};
use piui_index::TrustState;

fn status(fixture: &Fixture, session_id: &str) -> ReviewResultV1 {
    block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Status {
            session_id: session_id.into(),
        },
    ))
    .expect("status")
}

struct Reviewed {
    fingerprint: String,
    content: ReviewContentV1,
    actions: super::ReviewActionsV1,
}

fn diff(fixture: &Fixture, session_id: &str, path: &str, area: ReviewArea) -> Reviewed {
    match block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Diff {
            session_id: session_id.into(),
            path: path.into(),
            area,
        },
    ))
    .expect("diff")
    {
        ReviewResultV1::Diff {
            fingerprint,
            content,
            actions,
            ..
        } => Reviewed {
            fingerprint,
            content,
            actions,
        },
        ReviewResultV1::Status { .. } => panic!("expected a diff"),
    }
}

fn setup(label: &str) -> (Fixture, std::path::PathBuf, String) {
    let fixture = Fixture::new(label, false);
    let repo = fixture.root.join("repo");
    init_repository(&repo);
    let project = fixture.project(&repo, TrustState::Trusted);
    let session = fixture.chat(&project);
    (fixture, repo, session)
}

#[test]
fn status_lists_every_area_with_line_counts() {
    let (fixture, repo, session) = setup("review-status");
    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits");
    std::fs::write(repo.join("staged.txt"), "one\ntwo\n").expect("new file");
    git(&repo, &["add", "staged.txt"]);
    std::fs::write(repo.join("notes.md"), "draft\n").expect("untracked");
    std::fs::remove_file(repo.join("gone.txt")).expect("deletes");
    let ReviewResultV1::Status {
        repository,
        files,
        truncated,
        read_only,
        ..
    } = status(&fixture, &session)
    else {
        panic!("expected status");
    };
    assert!(!truncated);
    assert!(!read_only);
    match repository {
        ReviewRepositoryV1::Ready {
            branch,
            head,
            worktree,
            folder,
        } => {
            assert_eq!(branch.as_deref(), Some("main"));
            assert_eq!(head.map(|head| head.len()), Some(12));
            assert!(!worktree);
            assert_eq!(folder, "repo");
        }
        ReviewRepositoryV1::NotRepository {} => panic!("expected a repository"),
    }
    let find = |path: &str, area: ReviewArea| {
        files
            .iter()
            .find(|file| file.path == path && file.area == area)
            .unwrap_or_else(|| panic!("{path} in {area:?}"))
            .clone()
    };
    let edited = find("src/f.txt", ReviewArea::Unstaged);
    assert_eq!(
        (edited.change, edited.added, edited.removed),
        (ReviewChange::Modified, Some(1), Some(1))
    );
    assert_eq!(
        find("staged.txt", ReviewArea::Staged).change,
        ReviewChange::Added
    );
    assert_eq!(find("staged.txt", ReviewArea::Staged).added, Some(2));
    assert_eq!(
        find("notes.md", ReviewArea::Untracked).change,
        ReviewChange::Added
    );
    assert_eq!(
        find("gone.txt", ReviewArea::Unstaged).change,
        ReviewChange::Deleted
    );
}

#[test]
fn hunks_are_staged_unstaged_and_reverted_with_the_reviewed_fingerprint() {
    let (fixture, repo, session) = setup("review-hunks");
    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    changed[12] = "M";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits two regions");
    let reviewed = diff(&fixture, &session, "src/f.txt", ReviewArea::Unstaged);
    let ReviewContentV1::Text {
        hunks,
        hunk_actions,
        text,
    } = &reviewed.content
    else {
        panic!("expected text");
    };
    assert_eq!(*hunks, 2);
    assert!(*hunk_actions);
    assert!(text.contains("+M") && !text.contains("index "));
    assert!(reviewed.actions.stage && reviewed.actions.revert && !reviewed.actions.unstage);

    block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Stage {
            session_id: session.clone(),
            path: "src/f.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: reviewed.fingerprint.clone(),
            hunk: Some(1),
            part: None,
        },
    ))
    .expect("stages the second hunk");
    assert_eq!(
        git_output(&repo, &["diff", "--cached", "--numstat"]),
        "1\t1\tsrc/f.txt"
    );

    // The fingerprint belongs to the reviewed state; replaying it is stale.
    let replay = block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Stage {
            session_id: session.clone(),
            path: "src/f.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: reviewed.fingerprint.clone(),
            hunk: Some(0),
            part: None,
        },
    ))
    .expect_err("stale fingerprint");
    assert_eq!(replay.code, "STALE");

    let staged = diff(&fixture, &session, "src/f.txt", ReviewArea::Staged);
    assert!(staged.actions.unstage && !staged.actions.revert);
    block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Unstage {
            session_id: session.clone(),
            path: "src/f.txt".into(),
            fingerprint: staged.fingerprint,
            hunk: Some(0),
            part: None,
        },
    ))
    .expect("unstages");
    assert_eq!(git_output(&repo, &["diff", "--cached", "--numstat"]), "");

    let current = diff(&fixture, &session, "src/f.txt", ReviewArea::Unstaged);
    block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Revert {
            session_id: session.clone(),
            path: "src/f.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: current.fingerprint,
            hunk: Some(0),
            part: None,
        },
    ))
    .expect("reverts the first hunk");
    let mut expected = ORIGINAL.to_vec();
    expected[12] = "M";
    assert_eq!(
        std::fs::read_to_string(repo.join("src/f.txt")).expect("reads"),
        lines(&expected)
    );
}

#[test]
fn a_file_changed_after_review_is_refused_and_left_alone() {
    let (fixture, repo, session) = setup("review-stale");
    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits");
    let reviewed = diff(&fixture, &session, "src/f.txt", ReviewArea::Unstaged);
    changed[5] = "F";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("agent edits again");
    for request in [
        ReviewRequestV1::Revert {
            session_id: session.clone(),
            path: "src/f.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: reviewed.fingerprint.clone(),
            hunk: None,
            part: None,
        },
        ReviewRequestV1::Stage {
            session_id: session.clone(),
            path: "src/f.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: reviewed.fingerprint.clone(),
            hunk: Some(0),
            part: None,
        },
    ] {
        let error = block_on(dispatch_review(&fixture.state, request)).expect_err("stale");
        assert_eq!(error.code, "STALE");
    }
    assert_eq!(
        std::fs::read_to_string(repo.join("src/f.txt")).expect("reads"),
        lines(&changed)
    );
    assert_eq!(git_output(&repo, &["diff", "--cached", "--numstat"]), "");
}

#[test]
fn untracked_files_go_to_the_trash_only_as_reviewed() {
    let (fixture, repo, session) = setup("review-untracked");
    std::fs::write(repo.join("scratch.txt"), "one\ntwo").expect("untracked");
    let reviewed = diff(&fixture, &session, "scratch.txt", ReviewArea::Untracked);
    let ReviewContentV1::Text {
        text, hunk_actions, ..
    } = &reviewed.content
    else {
        panic!("expected text");
    };
    assert!(text.contains("+two\n\\ No newline at end of file"));
    assert!(!hunk_actions);
    assert!(reviewed.actions.stage && reviewed.actions.revert);

    std::fs::write(repo.join("scratch.txt"), "one\ntwo\nthree").expect("changes");
    let stale = block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Revert {
            session_id: session.clone(),
            path: "scratch.txt".into(),
            area: ReviewArea::Untracked,
            fingerprint: reviewed.fingerprint,
            hunk: None,
            part: None,
        },
    ))
    .expect_err("stale");
    assert_eq!(stale.code, "STALE");
    assert!(repo.join("scratch.txt").exists());

    let current = diff(&fixture, &session, "scratch.txt", ReviewArea::Untracked);
    block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Revert {
            session_id: session.clone(),
            path: "scratch.txt".into(),
            area: ReviewArea::Untracked,
            fingerprint: current.fingerprint,
            hunk: None,
            part: None,
        },
    ))
    .expect("moves to the trash");
    assert!(!repo.join("scratch.txt").exists());
    let trash = std::env::temp_dir().join(format!("piui-review-test-trash-{}", std::process::id()));
    let kept = std::fs::read_dir(&trash)
        .expect("test trash")
        .flatten()
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with("-scratch.txt")
                && std::fs::read_to_string(entry.path()).ok().as_deref() == Some("one\ntwo\nthree")
        });
    assert!(kept, "the file is in the trash, not deleted");
}

#[test]
fn binary_and_deleted_files_are_whole_file_changes() {
    let (fixture, repo, session) = setup("review-binary");
    std::fs::write(repo.join("image.bin"), b"bin\0ary-edited").expect("edits binary");
    std::fs::remove_file(repo.join("gone.txt")).expect("deletes");
    let binary = diff(&fixture, &session, "image.bin", ReviewArea::Unstaged);
    assert_eq!(binary.content, ReviewContentV1::Binary { size: Some(14) });
    let hunk = block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Stage {
            session_id: session.clone(),
            path: "image.bin".into(),
            area: ReviewArea::Unstaged,
            fingerprint: binary.fingerprint.clone(),
            hunk: Some(0),
            part: None,
        },
    ))
    .expect_err("no hunks in binary files");
    assert_eq!(hunk.code, "NOT_SUPPORTED");
    block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Revert {
            session_id: session.clone(),
            path: "image.bin".into(),
            area: ReviewArea::Unstaged,
            fingerprint: binary.fingerprint,
            hunk: None,
            part: None,
        },
    ))
    .expect("reverts the binary file");
    assert_eq!(
        std::fs::read(repo.join("image.bin")).expect("reads"),
        b"bin\0ary"
    );

    let deleted = diff(&fixture, &session, "gone.txt", ReviewArea::Unstaged);
    block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Revert {
            session_id: session.clone(),
            path: "gone.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: deleted.fingerprint,
            hunk: None,
            part: None,
        },
    ))
    .expect("restores the deleted file");
    assert_eq!(
        std::fs::read_to_string(repo.join("gone.txt")).expect("restored"),
        "delete me\n"
    );
}

#[test]
fn paths_must_be_in_the_current_status_of_the_chat_folder() {
    let (fixture, repo, session) = setup("review-paths");
    let project_sub = repo.join("src");
    let sub_project = fixture.project(&project_sub, TrustState::Trusted);
    let sub_session = fixture.chat(&sub_project);
    std::fs::write(repo.join("root.txt"), "outside the project\n").expect("outside");
    std::fs::write(repo.join("src/inside.txt"), "inside\n").expect("inside");
    let ReviewResultV1::Status { files, .. } = status(&fixture, &sub_session) else {
        panic!("expected status");
    };
    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["src/inside.txt"],
        "a project in a subfolder reviews only its subfolder"
    );
    for (path, code) in [
        ("../outside.txt", "INVALID_ARGUMENT"),
        ("root.txt", "STALE"),
        ("src/f.txt", "STALE"),
        ("", "INVALID_ARGUMENT"),
    ] {
        let error = block_on(dispatch_review(
            &fixture.state,
            ReviewRequestV1::Diff {
                session_id: sub_session.clone(),
                path: path.into(),
                area: ReviewArea::Untracked,
            },
        ))
        .expect_err("refused");
        assert_eq!(error.code, code, "{path}");
    }
    let bad_fingerprint = block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Stage {
            session_id: session,
            path: "root.txt".into(),
            area: ReviewArea::Untracked,
            fingerprint: "not-a-fingerprint".into(),
            hunk: None,
            part: None,
        },
    ))
    .expect_err("invalid");
    assert_eq!(bad_fingerprint.code, "INVALID_ARGUMENT");
}

#[test]
fn safe_mode_reads_and_refuses_every_change() {
    let (fixture, repo, session) = setup("review-safe");
    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits");
    let reviewed = diff(&fixture, &session, "src/f.txt", ReviewArea::Unstaged);
    let data = fixture.root.join("data");
    let safe = crate::state::HostState::open(&data, true).expect("reopens in safe mode");
    let read = block_on(dispatch_review(
        &safe,
        ReviewRequestV1::Status {
            session_id: session.clone(),
        },
    ))
    .expect("reads in safe mode");
    assert!(matches!(
        read,
        ReviewResultV1::Status {
            read_only: true,
            ..
        }
    ));
    let refused = block_on(dispatch_review(
        &safe,
        ReviewRequestV1::Revert {
            session_id: session,
            path: "src/f.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: reviewed.fingerprint,
            hunk: None,
            part: None,
        },
    ))
    .expect_err("refused in safe mode");
    assert_eq!(refused.code, "SAFE_MODE");
    assert_eq!(
        std::fs::read_to_string(repo.join("src/f.txt")).expect("reads"),
        lines(&changed)
    );
}

#[test]
fn untrusted_folders_and_plain_folders() {
    let fixture = Fixture::new("review-trust", false);
    let repo = fixture.root.join("repo");
    init_repository(&repo);
    let project = fixture.project(&repo, TrustState::Trusted);
    let session = fixture.chat(&project);
    fixture.set_trust(&project, TrustState::Restricted);
    let refused = block_on(dispatch_review(
        &fixture.state,
        ReviewRequestV1::Status {
            session_id: session,
        },
    ))
    .expect_err("restricted");
    assert_eq!(refused.code, "NOT_TRUSTED");

    let plain = fixture.root.join("plain");
    let plain_project = fixture.project(&plain, TrustState::Trusted);
    let plain_session = fixture.chat(&plain_project);
    if outside_any_repository(&plain) {
        let result = status(&fixture, &plain_session);
        assert!(matches!(
            result,
            ReviewResultV1::Status {
                repository: ReviewRepositoryV1::NotRepository {},
                ..
            }
        ));
        let error = block_on(dispatch_review(
            &fixture.state,
            ReviewRequestV1::Diff {
                session_id: plain_session,
                path: "a.txt".into(),
                area: ReviewArea::Untracked,
            },
        ))
        .expect_err("no repository");
        assert_eq!(error.code, "NOT_A_REPOSITORY");
    }
}

#[test]
fn the_result_shape_matches_the_contract_fixture() {
    let (fixture, repo, session) = setup("review-shape");
    let mut changed = ORIGINAL.to_vec();
    changed[0] = "A";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits");
    let value = serde_json::to_value(status(&fixture, &session)).expect("serializes");
    assert_eq!(value["type"], "status");
    assert_eq!(value["protocol"], 1);
    assert_eq!(value["repository"]["state"], "ready");
    assert_eq!(value["files"][0]["area"], "unstaged");
    assert_eq!(value["files"][0]["change"], "modified");
    assert!(value["files"][0].get("binary").is_none());
    let diff = serde_json::to_value(
        block_on(dispatch_review(
            &fixture.state,
            ReviewRequestV1::Diff {
                session_id: session,
                path: "src/f.txt".into(),
                area: ReviewArea::Unstaged,
            },
        ))
        .expect("diff"),
    )
    .expect("serializes");
    assert_eq!(diff["type"], "diff");
    assert_eq!(diff["content"]["kind"], "text");
    assert_eq!(diff["content"]["hunkActions"], true);
    assert_eq!(
        diff["actions"],
        serde_json::json!({"stage": true, "unstage": false, "revert": true})
    );
    let request: ReviewRequestV1 = serde_json::from_value(serde_json::json!({
        "type": "stage", "sessionId": "s", "path": "p", "area": "unstaged", "fingerprint": "f", "hunk": 2
    }))
    .expect("decodes");
    assert!(matches!(
        request,
        ReviewRequestV1::Stage { hunk: Some(2), .. }
    ));
    assert!(
        serde_json::from_value::<ReviewRequestV1>(serde_json::json!({
            "type": "status", "sessionId": "s", "extra": true
        }))
        .is_err(),
        "unknown fields are refused"
    );
}

fn act(fixture: &Fixture, request: ReviewRequestV1) -> Result<ReviewResultV1, String> {
    block_on(dispatch_review(&fixture.state, request)).map_err(|error| error.code.to_owned())
}

#[test]
fn a_split_hunk_stages_and_reverts_one_part_and_refuses_a_stale_or_unknown_part() {
    let (fixture, repo, session) = setup("review-split");
    let mut changed = ORIGINAL.to_vec();
    changed[1] = "B";
    changed[4] = "E";
    changed[8] = "I";
    std::fs::write(repo.join("src/f.txt"), lines(&changed)).expect("edits three places");
    let reviewed = diff(&fixture, &session, "src/f.txt", ReviewArea::Unstaged);
    assert!(matches!(
        reviewed.content,
        ReviewContentV1::Text {
            hunks: 1,
            hunk_actions: true,
            ..
        }
    ));
    let stage =
        |part: Option<usize>, hunk: Option<usize>, fingerprint: &str| ReviewRequestV1::Stage {
            session_id: session.clone(),
            path: "src/f.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: fingerprint.into(),
            hunk,
            part,
        };
    assert_eq!(
        act(&fixture, stage(Some(0), None, &reviewed.fingerprint)).expect_err("part without hunk"),
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        act(&fixture, stage(Some(3), Some(0), &reviewed.fingerprint)).expect_err("no such part"),
        "STALE"
    );
    act(&fixture, stage(Some(1), Some(0), &reviewed.fingerprint)).expect("stages the middle part");
    assert_eq!(
        git_output(&repo, &["diff", "--cached", "--numstat"]),
        "1\t1\tsrc/f.txt"
    );
    assert!(git_output(&repo, &["diff", "--cached"]).contains("+E"));

    // The work tree diff changed: the old fingerprint is stale.
    assert_eq!(
        act(&fixture, stage(Some(0), Some(0), &reviewed.fingerprint)).expect_err("stale"),
        "STALE"
    );
    let current = diff(&fixture, &session, "src/f.txt", ReviewArea::Unstaged);
    act(
        &fixture,
        ReviewRequestV1::Revert {
            session_id: session.clone(),
            path: "src/f.txt".into(),
            area: ReviewArea::Unstaged,
            fingerprint: current.fingerprint,
            hunk: Some(0),
            part: Some(1),
        },
    )
    .expect("reverts the last remaining part");
    let mut expected = changed.clone();
    expected[8] = "i";
    assert_eq!(
        std::fs::read_to_string(repo.join("src/f.txt")).expect("reads"),
        lines(&expected)
    );
}

#[test]
fn a_staged_rename_is_listed_once_with_its_source_and_unstaged_as_a_whole() {
    let (fixture, repo, session) = setup("review-rename");
    git(&repo, &["mv", "src/f.txt", "src/moved.txt"]);
    let ReviewResultV1::Status { files, .. } = status(&fixture, &session) else {
        panic!("expected status");
    };
    let renamed: Vec<_> = files
        .iter()
        .filter(|file| file.area == ReviewArea::Staged)
        .collect();
    assert_eq!(renamed.len(), 1, "{files:?}");
    assert_eq!(renamed[0].path, "src/moved.txt");
    assert_eq!(renamed[0].renamed_from.as_deref(), Some("src/f.txt"));
    assert_eq!((renamed[0].added, renamed[0].removed), (Some(0), Some(0)));
    let json = serde_json::to_value(renamed[0]).expect("json");
    assert_eq!(json["renamedFrom"], "src/f.txt");

    let reviewed = diff(&fixture, &session, "src/moved.txt", ReviewArea::Staged);
    let ReviewContentV1::Text {
        text, hunk_actions, ..
    } = &reviewed.content
    else {
        panic!("expected text");
    };
    assert!(text.contains("rename from src/f.txt"), "{text}");
    assert!(!hunk_actions, "a rename changes as a whole");
    assert!(reviewed.actions.unstage);
    assert_eq!(
        act(
            &fixture,
            ReviewRequestV1::Unstage {
                session_id: session.clone(),
                path: "src/moved.txt".into(),
                fingerprint: reviewed.fingerprint.clone(),
                hunk: Some(0),
                part: None,
            },
        )
        .expect_err("no single hunks of a rename"),
        "NOT_SUPPORTED"
    );
    act(
        &fixture,
        ReviewRequestV1::Unstage {
            session_id: session.clone(),
            path: "src/moved.txt".into(),
            fingerprint: reviewed.fingerprint,
            hunk: None,
            part: None,
        },
    )
    .expect("unstages the rename");
    let ReviewResultV1::Status { files, .. } = status(&fixture, &session) else {
        panic!("expected status");
    };
    assert!(files.iter().all(|file| file.area != ReviewArea::Staged));
    assert!(files.iter().any(|file| file.path == "src/f.txt"
        && file.area == ReviewArea::Unstaged
        && file.change == ReviewChange::Deleted));
    assert!(
        files
            .iter()
            .any(|file| file.path == "src/moved.txt" && file.area == ReviewArea::Untracked)
    );
}
