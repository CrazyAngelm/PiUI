//! The Rust side of `contracts/fixtures/workspace-session-tools-v1.json`:
//! every request decodes into the host DTOs and every result the host builds
//! serializes to exactly the fixture JSON the TypeScript clients decode.

use crate::adopt_api::{WorkspaceAdoptRequestV1, WorkspaceAdoptResultV1};
use crate::placement_api::{
    ChatPlacementV1, ChatWorktreeV1, PlacementCommandV1, PlacementResultV1, WorktreeBaseV1,
    WorktreePreviewV1, WorktreeRequestV1, WorktreeState,
};
use crate::review_api::{
    ReviewActionsV1, ReviewArea, ReviewChange, ReviewContentV1, ReviewFileV1, ReviewRepositoryV1,
    ReviewRequestV1, ReviewResultV1,
};
use serde_json::Value;

const SESSION: &str = "3f1f2d52-8f0b-4c3e-9a51-6d7f0c2b9e10";
const FINGERPRINT: &str = "5e0b7a4c2d1f3e6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a";
const PATH: &str = "~/AppData/Roaming/dev.piui.desktop/worktrees/piui-1a2b3c4d/piui-login";

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/workspace-session-tools-v1.json"
    ))
    .expect("fixture")
}

fn file(path: &str, area: ReviewArea, counts: Option<(u64, u64)>, binary: bool) -> ReviewFileV1 {
    ReviewFileV1 {
        path: path.into(),
        area,
        change: if area == ReviewArea::Untracked {
            ReviewChange::Added
        } else {
            ReviewChange::Modified
        },
        added: counts.map(|counts| counts.0),
        removed: counts.map(|counts| counts.1),
        binary,
    }
}

#[test]
fn review_v1_matches_the_public_fixture() {
    let fixture = fixture();
    let review = &fixture["review"];
    for name in [
        "statusRequest",
        "diffRequest",
        "stageHunkRequest",
        "unstageRequest",
        "trashRequest",
    ] {
        serde_json::from_value::<ReviewRequestV1>(review[name].clone())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
    assert!(matches!(
        serde_json::from_value::<ReviewRequestV1>(review["stageHunkRequest"].clone()),
        Ok(ReviewRequestV1::Stage {
            hunk: Some(1),
            area: ReviewArea::Unstaged,
            ..
        })
    ));
    let status = ReviewResultV1::Status {
        protocol: 1,
        session_id: SESSION.into(),
        repository: ReviewRepositoryV1::Ready {
            branch: Some("main".into()),
            head: Some("0123456789ab".into()),
            worktree: false,
            folder: "repo".into(),
        },
        files: vec![
            file("src/f.txt", ReviewArea::Staged, Some((1, 1)), false),
            file("src/f.txt", ReviewArea::Unstaged, Some((1, 1)), false),
            file("image.bin", ReviewArea::Unstaged, None, true),
            file("notes.md", ReviewArea::Untracked, None, false),
        ],
        truncated: false,
        hidden: 0,
        read_only: false,
    };
    assert_eq!(
        serde_json::to_value(status).expect("status"),
        review["status"]
    );
    let not_repository = ReviewResultV1::Status {
        protocol: 1,
        session_id: SESSION.into(),
        repository: ReviewRepositoryV1::NotRepository {},
        files: Vec::new(),
        truncated: false,
        hidden: 0,
        read_only: true,
    };
    assert_eq!(
        serde_json::to_value(not_repository).expect("not a repository"),
        review["notRepository"]
    );
    let diff = ReviewResultV1::Diff {
        protocol: 1,
        session_id: SESSION.into(),
        path: "src/f.txt".into(),
        area: ReviewArea::Unstaged,
        fingerprint: FINGERPRINT.into(),
        content: ReviewContentV1::Text {
            text: "diff --git a/src/f.txt b/src/f.txt\n--- a/src/f.txt\n+++ b/src/f.txt\n@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n".into(),
            hunks: 1,
            hunk_actions: true,
        },
        actions: ReviewActionsV1 {
            stage: true,
            unstage: false,
            revert: true,
        },
    };
    assert_eq!(serde_json::to_value(diff).expect("diff"), review["diff"]);
    let binary = ReviewResultV1::Diff {
        protocol: 1,
        session_id: SESSION.into(),
        path: "image.bin".into(),
        area: ReviewArea::Unstaged,
        fingerprint: FINGERPRINT.into(),
        content: ReviewContentV1::Binary { size: Some(14) },
        actions: ReviewActionsV1 {
            stage: true,
            unstage: false,
            revert: true,
        },
    };
    assert_eq!(
        serde_json::to_value(binary).expect("binary"),
        review["binaryDiff"]
    );
    assert_eq!(
        serde_json::to_value(crate::session_placement::stale_error()).expect("error"),
        review["error"]
    );
}

fn worktree(state: WorktreeState) -> ChatWorktreeV1 {
    ChatWorktreeV1 {
        branch: "piui/login".into(),
        path: PATH.into(),
        state,
        base: "0123456789ab".into(),
    }
}

#[test]
fn placement_v1_matches_the_public_fixture() {
    let fixture = fixture();
    let placement = &fixture["placement"];
    for name in [
        "listRequest",
        "previewRequest",
        "createRequest",
        "sharedRequest",
        "removeRequest",
    ] {
        serde_json::from_value::<PlacementCommandV1>(placement[name].clone())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
    assert!(matches!(
        serde_json::from_value::<PlacementCommandV1>(placement["sharedRequest"].clone()),
        Ok(PlacementCommandV1::CreateChat {
            worktree: Some(WorktreeRequestV1::Shared { .. }),
            continued_from: Some(_),
            ..
        })
    ));
    let listed = PlacementResultV1::Placements {
        protocol: 1,
        placements: vec![
            ChatPlacementV1 {
                session_id: SESSION.into(),
                worktree: Some(worktree(WorktreeState::Ready)),
                continued_from: None,
                adopted: false,
            },
            ChatPlacementV1 {
                session_id: "8c7b0d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e".into(),
                worktree: None,
                continued_from: Some(SESSION.into()),
                adopted: false,
            },
            ChatPlacementV1 {
                session_id: "0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a".into(),
                worktree: None,
                continued_from: None,
                adopted: true,
            },
        ],
    };
    assert_eq!(
        serde_json::to_value(listed).expect("list"),
        placement["placements"]
    );
    let preview = PlacementResultV1::Preview {
        protocol: 1,
        preview: WorktreePreviewV1 {
            workspace_id: "project-1".into(),
            branch: "piui/login".into(),
            folder: "piui-login".into(),
            path: PATH.into(),
            base: WorktreeBaseV1 {
                commit: "0123456789abcdef0123456789abcdef01234567".into(),
                short: "0123456789ab".into(),
                branch: Some("main".into()),
            },
            project_changes: true,
        },
    };
    assert_eq!(
        serde_json::to_value(preview).expect("preview"),
        placement["preview"]
    );
    let dirty = PlacementResultV1::Dirty {
        protocol: 1,
        session_id: SESSION.into(),
        changes: 2,
        fingerprint: FINGERPRINT.into(),
    };
    assert_eq!(
        serde_json::to_value(dirty).expect("dirty"),
        placement["dirty"]
    );
    let removed = PlacementResultV1::Removed {
        protocol: 1,
        session_id: SESSION.into(),
        placement: ChatPlacementV1 {
            session_id: SESSION.into(),
            worktree: Some(worktree(WorktreeState::Removed)),
            continued_from: None,
            adopted: false,
        },
    };
    assert_eq!(
        serde_json::to_value(removed).expect("removed"),
        placement["removed"]
    );
}

#[test]
fn adopt_v1_matches_the_public_fixture() {
    let fixture = fixture();
    let adopt = &fixture["adopt"];
    let request: WorkspaceAdoptRequestV1 =
        serde_json::from_value(adopt["request"].clone()).expect("request");
    assert_eq!(request.project_id.as_deref(), Some("project-1"));
    let personal: WorkspaceAdoptRequestV1 =
        serde_json::from_value(adopt["personalRequest"].clone()).expect("personal request");
    assert_eq!(personal.project_id, None);
    let result = WorkspaceAdoptResultV1 {
        protocol: 1,
        session_id: "0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a".into(),
        created: true,
    };
    assert_eq!(
        serde_json::to_value(result).expect("result"),
        adopt["result"]
    );
}
