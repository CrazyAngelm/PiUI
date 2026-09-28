use super::agent::{AgentContext, BoardToolOperation, BoardToolResult};
use super::model::{
    Board, BoardActor, BoardAgentMode, BoardError, BoardSettings, CardChange, CardDraft, CardPatch,
    CardStartMode, CardStatus, CommentMention,
};
use super::ops::{
    AssignOutcome, Availability, BoardRunRequest, BoardRunStarter, BoardService, SessionRef,
    TeammateRef,
};
use super::similarity;
use super::store::{
    BoardStore, DIRECTORY, FileBoardStore, MemoryBoardStore, generation_path,
    workspace_directory_name,
};
use piui_orchestration::{BoardPermissions, TeammateStartRule};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

const PROJECT: &str = "project";

fn root() -> PathBuf {
    std::env::temp_dir().join(format!("piui-board-{}", uuid::Uuid::new_v4()))
}

struct SharedStore(Arc<MemoryBoardStore>);

impl BoardStore for SharedStore {
    fn load(&self, workspace_id: &str) -> Result<Option<Board>, BoardError> {
        self.0.load(workspace_id)
    }
    fn save(&self, board: &Board) -> Result<(), BoardError> {
        self.0.save(board)
    }
}

fn service() -> BoardService {
    BoardService::new(Box::new(MemoryBoardStore::default()), false)
}

fn enabled_service() -> BoardService {
    let service = service();
    service.set_enabled(PROJECT, true).expect("enables");
    service
}

fn draft(title: &str) -> CardDraft {
    CardDraft {
        title: title.to_owned(),
        description: None,
        priority: None,
        labels: None,
        blocked_by: None,
        parent_id: None,
    }
}

fn person() -> BoardActor {
    BoardActor::Person
}

fn chat(session: &str) -> BoardActor {
    BoardActor::ChatAgent {
        session_id: session.to_owned(),
        harness: "codex".to_owned(),
    }
}

const ALL: BoardPermissions = BoardPermissions {
    read: true,
    comment: true,
    create: true,
    move_cards: true,
    claim: true,
    assign: true,
};

fn context<'a>(
    session: &str,
    permissions: BoardPermissions,
    teammates: &'a [TeammateRef],
) -> AgentContext<'a> {
    AgentContext {
        workspace_id: PROJECT,
        actor: chat(session),
        permissions,
        session: Some(SessionRef {
            session_id: session.to_owned(),
            harness: "codex".to_owned(),
        }),
        turn_key: "turn-1",
        causing_depth: 0,
        teammates,
    }
}

fn teammate(id: &str, handle: &str, rule: TeammateStartRule) -> TeammateRef {
    TeammateRef {
        id: id.to_owned(),
        handle: handle.to_owned(),
        name: handle.to_owned(),
        role: "Reviews".to_owned(),
        kind: "simple",
        on_assign: rule,
        on_mention: true,
        enabled: true,
        not_assignable_reason: None,
        availability: Availability::Idle,
    }
}

fn json_of(result: &BoardToolResult) -> Value {
    serde_json::to_value(result).expect("serializes")
}

#[derive(Default)]
struct FakeStarter {
    fail: bool,
    requests: Mutex<Vec<BoardRunRequest>>,
}

impl BoardRunStarter for FakeStarter {
    fn available(&self) -> bool {
        true
    }
    fn start(&self, request: &BoardRunRequest) -> Result<(), BoardError> {
        self.requests.lock().expect("lock").push(request.clone());
        if self.fail {
            Err(BoardError::Invalid("orchestration refused"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn file_store_keeps_three_generations_and_skips_damaged_or_foreign_ones() {
    let root = root();
    let store = FileBoardStore::open(&root).expect("opens");
    let mut board = Board::empty(PROJECT, "2026-09-28T10:00:00.000Z");
    for revision in 1..=5 {
        board.revision = revision;
        store.save(&board).expect("saves");
    }
    let directory = root.join(DIRECTORY).join(PROJECT);
    assert_eq!(fs::read_dir(&directory).expect("lists").count(), 3);
    assert_eq!(store.load(PROJECT).unwrap().unwrap().revision, 5);

    fs::write(generation_path(&directory, 6), b"{damaged").expect("damages");
    assert_eq!(store.load(PROJECT).unwrap().unwrap().revision, 5);

    let mut foreign = Board::empty("other", "2026-09-28T10:00:00.000Z");
    foreign.revision = 99;
    let document = json!({"version": 1, "generation": 7, "board": foreign});
    fs::write(
        generation_path(&directory, 7),
        serde_json::to_vec(&document).unwrap(),
    )
    .expect("writes foreign");
    assert_eq!(store.load(PROJECT).unwrap().unwrap().revision, 5);

    board.revision = 6;
    store.save(&board).expect("saves after damaged generations");
    assert_eq!(store.load(PROJECT).unwrap().unwrap().revision, 6);
    assert!(generation_path(&directory, 8).exists());
    assert!(store.load("never-saved").unwrap().is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn workspace_ids_never_escape_the_store_directory() {
    assert_eq!(workspace_directory_name("abc-1_2").unwrap(), "abc-1_2");
    for hostile in ["../evil", "..", "a/b", "a\\b", "x-abc", "C:"] {
        let name = workspace_directory_name(hostile).unwrap();
        assert!(name.starts_with("x-"), "{hostile} -> {name}");
        assert!(
            name.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        );
    }
    assert!(workspace_directory_name("").is_err());
    assert!(workspace_directory_name(&"a".repeat(129)).is_err());
}

#[test]
fn board_survives_reopen_and_a_failed_write_keeps_the_previous_board() {
    let root = root();
    let service = BoardService::open(&root, false).expect("opens");
    service.set_enabled(PROJECT, true).unwrap();
    let (card, revision) = service
        .create_card(PROJECT, &person(), draft("Fix login"), None, None)
        .unwrap();
    assert_eq!(card.number, 1);
    assert_eq!(card.status, CardStatus::Todo);
    drop(service);
    let reopened = BoardService::open(&root, false).expect("reopens");
    let board = reopened.get(PROJECT).unwrap();
    assert_eq!(board.revision, revision);
    assert_eq!(board.cards.len(), 1);
    let _ = fs::remove_dir_all(root);

    let memory = Arc::new(MemoryBoardStore::default());
    let service = BoardService::new(Box::new(SharedStore(Arc::clone(&memory))), false);
    service.set_enabled(PROJECT, true).unwrap();
    memory.fail_writes.store(true, Ordering::SeqCst);
    assert_eq!(
        service
            .create_card(PROJECT, &person(), draft("Lost"), None, None)
            .unwrap_err(),
        BoardError::Io
    );
    assert!(service.get(PROJECT).unwrap().cards.is_empty());
}

#[test]
fn never_saved_board_reads_disabled_and_safe_mode_refuses_changes() {
    let service = BoardService::new(Box::new(MemoryBoardStore::default()), true);
    let board = service.get(PROJECT).expect("reads in safe mode");
    assert!(!board.enabled);
    assert_eq!(board.settings, BoardSettings::default());
    assert_eq!(
        service.set_enabled(PROJECT, true).unwrap_err(),
        BoardError::SafeMode
    );
    let disabled = self::service();
    assert_eq!(
        disabled
            .create_card(PROJECT, &person(), draft("x"), None, None)
            .unwrap_err(),
        BoardError::Disabled
    );
    let teammates: [TeammateRef; 0] = [];
    let result = disabled.apply_agent_operation(
        &context("chat-1", ALL, &teammates),
        BoardToolOperation::List { status: None },
    );
    assert_eq!(json_of(&result)["code"], "DISABLED");
}

#[test]
fn stale_revisions_are_refused() {
    let service = enabled_service();
    let board = service.get(PROJECT).unwrap();
    let settings = BoardSettings {
        agent_mode: BoardAgentMode::Proposal,
        ..BoardSettings::default()
    };
    assert_eq!(
        service
            .update_settings(PROJECT, board.revision + 1, settings.clone())
            .unwrap_err(),
        BoardError::RevisionConflict
    );
    service
        .update_settings(PROJECT, board.revision, settings)
        .expect("current revision");
    let invalid = BoardSettings {
        max_concurrent_runs: 0,
        ..BoardSettings::default()
    };
    assert!(matches!(
        service.update_settings(PROJECT, 0, invalid),
        Err(BoardError::Invalid(_))
    ));
    let (card, _) = service
        .create_card(PROJECT, &person(), draft("Edit me"), None, None)
        .unwrap();
    let patch = CardPatch {
        title: Some("Edited".into()),
        ..CardPatch::default()
    };
    let (edited, _) = service
        .update_card(
            PROJECT,
            &person(),
            &card.id,
            Some(card.revision),
            patch.clone(),
            false,
        )
        .unwrap();
    assert_eq!(edited.title, "Edited");
    assert_eq!(
        service
            .update_card(
                PROJECT,
                &person(),
                &card.id,
                Some(card.revision),
                patch,
                false
            )
            .unwrap_err(),
        BoardError::RevisionConflict
    );
}

#[test]
fn agent_move_is_undoable_once() {
    let service = enabled_service();
    let (card, _) = service
        .create_card(PROJECT, &person(), draft("Fix login"), None, None)
        .unwrap();
    let teammates: [TeammateRef; 0] = [];
    let result = service.apply_agent_operation(
        &context("chat-1", ALL, &teammates),
        BoardToolOperation::Move {
            card: card.number,
            to: CardStatus::InReview,
            reason: Some("Ready".into()),
        },
    );
    let value = json_of(&result);
    assert_eq!(value["ok"], true);
    assert_eq!(value["state"], "applied");
    assert_eq!(value["card"]["status"], "inReview");
    let moved = service.get(PROJECT).unwrap().cards[0].clone();
    let activity = moved.activity.last().unwrap().clone();
    assert!(activity.undoable);
    assert!(matches!(activity.change, CardChange::Moved { .. }));

    let (undone, _) = service.undo(PROJECT, &card.id, &activity.id).unwrap();
    assert_eq!(undone.status, CardStatus::Todo);
    assert!(matches!(
        &undone.activity.last().unwrap().change,
        CardChange::Reverted { activity_id } if *activity_id == activity.id
    ));
    assert!(service.undo(PROJECT, &card.id, &activity.id).is_err());
}

#[test]
fn a_second_agent_cannot_claim_a_claimed_card() {
    let service = enabled_service();
    let (card, _) = service
        .create_card(PROJECT, &person(), draft("Claim me"), None, None)
        .unwrap();
    let teammates: [TeammateRef; 0] = [];
    let first = service.apply_agent_operation(
        &context("chat-1", ALL, &teammates),
        BoardToolOperation::Claim { card: card.number },
    );
    assert_eq!(json_of(&first)["state"], "applied");
    let again = service.apply_agent_operation(
        &context("chat-1", ALL, &teammates),
        BoardToolOperation::Claim { card: card.number },
    );
    assert_eq!(json_of(&again)["ok"], true, "the holder renews its claim");
    let second = service.apply_agent_operation(
        &context("chat-2", ALL, &teammates),
        BoardToolOperation::Claim { card: card.number },
    );
    assert_eq!(json_of(&second)["code"], "ALREADY_CLAIMED");
    let release = service.apply_agent_operation(
        &context("chat-2", ALL, &teammates),
        BoardToolOperation::Release { card: card.number },
    );
    assert_eq!(json_of(&release)["code"], "FORBIDDEN");
}

#[test]
fn closing_by_an_agent_is_always_a_proposal() {
    let service = enabled_service();
    let (card, _) = service
        .create_card(PROJECT, &person(), draft("Ship it"), None, None)
        .unwrap();
    let teammates: [TeammateRef; 0] = [];
    let result = service.apply_agent_operation(
        &context("chat-1", ALL, &teammates),
        BoardToolOperation::Move {
            card: card.number,
            to: CardStatus::Done,
            reason: None,
        },
    );
    assert_eq!(json_of(&result)["state"], "proposed");
    let board = service.get(PROJECT).unwrap();
    assert_eq!(board.cards[0].status, CardStatus::Todo);
    assert_eq!(board.proposals.len(), 1);
    let board = service
        .resolve_proposal(PROJECT, &board.proposals[0].id, true, &teammates)
        .expect("accepts");
    assert_eq!(board.cards[0].status, CardStatus::Done);
    assert!(board.cards[0].closed_at.is_some());
    assert!(
        service
            .resolve_proposal(PROJECT, &board.proposals[0].id, true, &teammates)
            .is_err()
    );
}

#[test]
fn proposal_mode_turns_agent_writes_into_proposals() {
    let service = enabled_service();
    let board = service.get(PROJECT).unwrap();
    let settings = BoardSettings {
        agent_mode: BoardAgentMode::Proposal,
        ..BoardSettings::default()
    };
    service
        .update_settings(PROJECT, board.revision, settings)
        .unwrap();
    let (card, _) = service
        .create_card(PROJECT, &person(), draft("Discuss"), None, None)
        .unwrap();
    let teammates: [TeammateRef; 0] = [];
    let result = service.apply_agent_operation(
        &context("chat-1", ALL, &teammates),
        BoardToolOperation::Comment {
            card: card.number,
            body: "Looks fine".into(),
        },
    );
    assert_eq!(json_of(&result)["state"], "proposed");
    let board = service.get(PROJECT).unwrap();
    assert!(board.cards[0].comments.is_empty());
    let board = service
        .resolve_proposal(PROJECT, &board.proposals[0].id, false, &teammates)
        .unwrap();
    assert!(board.cards[0].comments.is_empty());
}

#[test]
fn create_without_confirmation_reports_similar_open_cards() {
    let service = enabled_service();
    service
        .create_card(
            PROJECT,
            &person(),
            draft("Fix login redirect bug"),
            None,
            None,
        )
        .unwrap();
    let teammates: [TeammateRef; 0] = [];
    let create = |confirm_new: Option<bool>| BoardToolOperation::Create {
        title: "Fix the login redirect bug".into(),
        description: None,
        priority: None,
        labels: None,
        status: None,
        confirm_new,
    };
    let duplicate =
        service.apply_agent_operation(&context("chat-1", ALL, &teammates), create(None));
    let value = json_of(&duplicate);
    assert_eq!(value["op"], "possibleDuplicates");
    assert_eq!(value["candidates"][0]["number"], 1);
    assert_eq!(service.get(PROJECT).unwrap().cards.len(), 1);

    let created =
        service.apply_agent_operation(&context("chat-1", ALL, &teammates), create(Some(true)));
    let value = json_of(&created);
    assert_eq!(value["op"], "create");
    assert_eq!(value["card"]["number"], 2);
    let cards = service.session_cards(PROJECT, "chat-1").unwrap();
    assert_eq!(
        cards[0].number, 2,
        "created from a chat, it is the active card"
    );

    let context_result = service.apply_agent_operation(
        &context("chat-1", ALL, &teammates),
        BoardToolOperation::Context {
            query: Some("login redirect".into()),
        },
    );
    let value = json_of(&context_result);
    assert_eq!(value["activeCard"]["number"], 2);
    assert_eq!(value["similar"][0]["number"], 1);
}

#[test]
fn writes_per_turn_are_rate_limited() {
    let service = enabled_service();
    let (card, _) = service
        .create_card(PROJECT, &person(), draft("Chatty"), None, None)
        .unwrap();
    let teammates: [TeammateRef; 0] = [];
    let ctx = context("chat-1", ALL, &teammates);
    service.begin_turn(ctx.turn_key);
    for index in 0..8 {
        let result = service.apply_agent_operation(
            &ctx,
            BoardToolOperation::Comment {
                card: card.number,
                body: format!("note {index}"),
            },
        );
        assert_eq!(json_of(&result)["ok"], true);
    }
    let limited = service.apply_agent_operation(
        &ctx,
        BoardToolOperation::Comment {
            card: card.number,
            body: "one more".into(),
        },
    );
    assert_eq!(json_of(&limited)["code"], "RATE_LIMITED");
    let read = service.apply_agent_operation(&ctx, BoardToolOperation::List { status: None });
    assert_eq!(json_of(&read)["ok"], true, "reads are not limited");
    service.begin_turn(ctx.turn_key);
    let next = service.apply_agent_operation(
        &ctx,
        BoardToolOperation::Comment {
            card: card.number,
            body: "next turn".into(),
        },
    );
    assert_eq!(json_of(&next)["ok"], true);
}

#[test]
fn permissions_are_checked_before_any_change() {
    let service = enabled_service();
    let (card, _) = service
        .create_card(PROJECT, &person(), draft("Guarded"), None, None)
        .unwrap();
    let teammates = [teammate("t-1", "reviewer", TeammateStartRule::Never)];
    let chat_defaults = BoardSettings::default().chat_agent_permissions;
    let claim = service.apply_agent_operation(
        &context("chat-1", chat_defaults, &teammates),
        BoardToolOperation::Claim { card: card.number },
    );
    assert_eq!(json_of(&claim)["code"], "FORBIDDEN");
    let read_only = BoardPermissions::READ_COMMENT;
    let assign = service.apply_agent_operation(
        &context("chat-1", read_only, &teammates),
        BoardToolOperation::Assign {
            card: card.number,
            handle: "reviewer".into(),
        },
    );
    assert_eq!(json_of(&assign)["code"], "FORBIDDEN");
    let person_actor = AgentContext {
        actor: BoardActor::Person,
        ..context("chat-1", ALL, &teammates)
    };
    let forged = service.apply_agent_operation(&person_actor, BoardToolOperation::Roster {});
    assert_eq!(json_of(&forged)["code"], "FORBIDDEN");
    let board = service.get(PROJECT).unwrap();
    assert!(board.cards[0].claim.is_none());
    assert!(board.cards[0].assignee.is_none());
}

#[test]
fn start_rules_create_pending_starts_until_runs_exist() {
    let service = enabled_service();
    let teammates = [
        teammate("t-ask", "asker", TeammateStartRule::Ask),
        teammate("t-always", "doer", TeammateStartRule::Always),
    ];
    let (todo, _) = service
        .create_card(PROJECT, &person(), draft("Todo card"), None, None)
        .unwrap();
    let (_, _, outcome) = service
        .assign(
            PROJECT,
            &person(),
            &todo.id,
            Some("t-ask"),
            CardStartMode::Ask,
            0,
            true,
            &teammates,
        )
        .unwrap();
    assert_eq!(outcome, AssignOutcome::PendingStart);
    let (backlog, _) = service
        .create_card(
            PROJECT,
            &person(),
            draft("Backlog card"),
            Some(CardStatus::Backlog),
            None,
        )
        .unwrap();
    let (_, _, outcome) = service
        .assign(
            PROJECT,
            &person(),
            &backlog.id,
            Some("t-always"),
            CardStartMode::Ask,
            0,
            true,
            &teammates,
        )
        .unwrap();
    assert_eq!(outcome, AssignOutcome::Assigned, "backlog never starts");
    let (_, _, outcome) = service
        .assign(
            PROJECT,
            &person(),
            &todo.id,
            Some("t-always"),
            CardStartMode::Ask,
            0,
            true,
            &teammates,
        )
        .unwrap();
    assert_eq!(
        outcome,
        AssignOutcome::PendingStart,
        "without a run engine a start waits for the person"
    );
    let board = service.get(PROJECT).unwrap();
    assert_eq!(
        board.pending_starts.len(),
        1,
        "reassigning drops the old start"
    );
    assert_eq!(board.pending_starts[0].teammate_id, "t-always");
    assert_eq!(service.queued_count(PROJECT, "t-always"), 1);
    assert_eq!(
        service
            .start_run(PROJECT, &todo.id, &teammates)
            .unwrap_err()
            .code(),
        "INVALID_ARGUMENT"
    );
    let board = service
        .resolve_pending_start(PROJECT, &board.pending_starts[0].id, false, &teammates)
        .unwrap();
    assert!(board.pending_starts.is_empty());
    assert!(matches!(
        service.assign(
            PROJECT,
            &person(),
            &todo.id,
            Some("missing"),
            CardStartMode::Later,
            0,
            true,
            &teammates
        ),
        Err(BoardError::NotFound(_))
    ));
}

#[test]
fn a_started_run_claims_the_card_and_a_failed_start_rolls_back() {
    let service = enabled_service();
    let starter = Arc::new(FakeStarter::default());
    service.set_run_starter(starter.clone());
    let teammates = [teammate("t-1", "doer", TeammateStartRule::Always)];
    let (card, _) = service
        .create_card(PROJECT, &person(), draft("Run me"), None, None)
        .unwrap();
    let (started, _, outcome) = service
        .assign(
            PROJECT,
            &person(),
            &card.id,
            Some("t-1"),
            CardStartMode::Ask,
            0,
            true,
            &teammates,
        )
        .unwrap();
    assert_eq!(outcome, AssignOutcome::Started);
    assert_eq!(started.status, CardStatus::InProgress);
    let claim = started.claim.clone().expect("run holds the claim");
    let requests = starter.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(claim.run_id.as_deref(), Some(requests[0].run_id.as_str()));
    assert!(requests[0].card_text.contains("#1"));
    assert!(requests[0].card_text.contains("untrusted"));
    assert_eq!(
        service
            .start_run(PROJECT, &card.id, &teammates)
            .unwrap_err(),
        BoardError::AlreadyClaimed
    );

    let failing = enabled_service();
    failing.set_run_starter(Arc::new(FakeStarter {
        fail: true,
        requests: Mutex::new(Vec::new()),
    }));
    let (card, _) = failing
        .create_card(PROJECT, &person(), draft("Refused"), None, None)
        .unwrap();
    failing
        .assign(
            PROJECT,
            &person(),
            &card.id,
            Some("t-1"),
            CardStartMode::Later,
            0,
            true,
            &teammates,
        )
        .unwrap();
    assert!(failing.start_run(PROJECT, &card.id, &teammates).is_err());
    let card = failing.get(PROJECT).unwrap().cards[0].clone();
    assert_eq!(card.status, CardStatus::Todo);
    assert!(card.claim.is_none());
    assert_eq!(card.links.len(), 0);
    assert!(
        card.comments
            .last()
            .unwrap()
            .body
            .contains("Could not start")
    );
}

#[test]
fn closing_the_last_blocker_unblocks_and_mentions_wake_teammates() {
    let service = enabled_service();
    let teammates = [teammate("t-1", "reviewer", TeammateStartRule::Ask)];
    let (blocker, _) = service
        .create_card(PROJECT, &person(), draft("Blocker"), None, None)
        .unwrap();
    let mut blocked_draft = draft("Blocked");
    blocked_draft.blocked_by = Some(vec![blocker.id.clone()]);
    let (blocked, _) = service
        .create_card(
            PROJECT,
            &person(),
            blocked_draft,
            Some(CardStatus::Blocked),
            None,
        )
        .unwrap();
    service
        .move_card(
            PROJECT,
            &person(),
            &blocker.id,
            CardStatus::Done,
            None,
            None,
            true,
            &teammates,
        )
        .unwrap();
    let board = service.get(PROJECT).unwrap();
    let unblocked = board.card(&blocked.id).unwrap();
    assert_eq!(unblocked.status, CardStatus::Todo);
    assert!(matches!(
        unblocked.activity.last().unwrap().change,
        CardChange::Unblocked
    ));

    let body = "@reviewer please check".to_owned();
    service
        .comment(
            PROJECT,
            &person(),
            &blocked.id,
            body,
            vec![CommentMention {
                teammate_id: "t-1".into(),
                start: 0,
                length: 9,
            }],
            None,
            &teammates,
        )
        .unwrap();
    assert_eq!(service.get(PROJECT).unwrap().pending_starts.len(), 1);
    assert!(
        service
            .comment(
                PROJECT,
                &person(),
                &blocked.id,
                "short".into(),
                vec![CommentMention {
                    teammate_id: "t-1".into(),
                    start: 3,
                    length: 9,
                }],
                None,
                &teammates,
            )
            .is_err()
    );

    let deleted = service
        .get(PROJECT)
        .unwrap()
        .card(&blocker.id)
        .unwrap()
        .clone();
    let revision = service
        .delete_card(PROJECT, &blocker.id, deleted.revision)
        .unwrap();
    let board = service.get(PROJECT).unwrap();
    assert_eq!(board.revision, revision);
    assert!(board.card(&blocked.id).unwrap().blocked_by.is_empty());
}

#[test]
fn similarity_scores_near_duplicates_above_the_threshold() {
    let service = enabled_service();
    for title in ["Fix login redirect", "Write release notes"] {
        service
            .create_card(PROJECT, &person(), draft(title), None, None)
            .unwrap();
    }
    let board = service.get(PROJECT).unwrap();
    let near = similarity::similar_open_cards(
        &board.cards,
        "fix the login redirect",
        &[],
        similarity::DUPLICATE_THRESHOLD,
        similarity::MAX_SIMILAR,
    );
    assert_eq!(near.len(), 1);
    assert_eq!(near[0].title, "Fix login redirect");
    assert!(similarity::score("Fix login redirect", &[], &board.cards[0]) > 0.99);
    assert!(similarity::score("Update the invoice template", &[], &board.cards[0]) < 0.2);
    let found = similarity::search(&board.cards, "release", false, 10);
    assert_eq!(found.len(), 1);
}

#[test]
fn board_fixture_round_trips() {
    let source: Value = serde_json::from_str(include_str!(
        "../../../../../contracts/fixtures/board-v1/board.json"
    ))
    .expect("fixture is JSON");
    let board: Board = serde_json::from_value(source.clone()).expect("decodes BoardV1");
    assert_eq!(board.cards.len(), 2);
    assert_eq!(serde_json::to_value(&board).unwrap(), source);
}

#[test]
fn tool_operation_fixture_rejects_unknown_keys() {
    let source: Value = serde_json::from_str(include_str!(
        "../../../../../contracts/fixtures/board-v1/tool-operations.json"
    ))
    .expect("fixture is JSON");
    for valid in source["valid"].as_array().unwrap() {
        let operation: BoardToolOperation = serde_json::from_value(valid.clone())
            .unwrap_or_else(|error| panic!("{valid}: {error}"));
        assert_eq!(&serde_json::to_value(&operation).unwrap(), valid);
    }
    for invalid in source["invalid"].as_array().unwrap() {
        assert!(
            serde_json::from_value::<BoardToolOperation>(invalid.clone()).is_err(),
            "{invalid}"
        );
    }
}
