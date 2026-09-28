//! Board run engine rules: capacity, queue order, cooldown, chain-depth
//! stop, run-end mapping and idempotent run-end recording.

use super::{capacity_available, needs_run_end};
use crate::board::BoardService;
use crate::board::model::{
    BoardActor, BoardError, CardChange, CardDraft, CardPriority, CardStartMode, CardStatus,
    RunOutcome,
};
use crate::board::ops::{
    AssignOutcome, Availability, BoardRunRequest, BoardRunStarter, MAX_RUN_RESULT_BYTES,
    QueuedStart, RunEnd, TeammateRef, own_run_card, queue_order, run_end_comment, run_end_status,
};
use crate::board::store::{BoardStore, MemoryBoardStore};
use chrono::{DateTime, Duration, Utc};
use piui_orchestration::{BoardRunCause, MAX_TRIGGER_CHAIN_DEPTH, TeammateStartRule};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

const PROJECT: &str = "project";

#[derive(Default)]
struct LimitedStarter {
    full: AtomicBool,
    fail: AtomicBool,
    requests: Mutex<Vec<BoardRunRequest>>,
}

impl BoardRunStarter for LimitedStarter {
    fn available(&self) -> bool {
        true
    }
    fn has_capacity(&self, _workspace_id: &str, _teammate_id: &str, _board_limit: u8) -> bool {
        !self.full.load(Ordering::SeqCst)
    }
    fn start(&self, request: &BoardRunRequest) -> Result<(), BoardError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(BoardError::Invalid("The run could not be created."));
        }
        self.requests.lock().expect("lock").push(request.clone());
        Ok(())
    }
}

fn base_time() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-09-28T10:00:00Z")
        .expect("time")
        .with_timezone(&Utc)
}

/// A service with a settable clock (seconds after `base_time`) and starter.
fn service() -> (BoardService, Arc<LimitedStarter>, Arc<AtomicI64>) {
    let offset = Arc::new(AtomicI64::new(0));
    let clock = Arc::clone(&offset);
    let service = BoardService::new(Box::new(MemoryBoardStore::default()), false)
        .with_clock(move || base_time() + Duration::seconds(clock.load(Ordering::SeqCst)));
    let starter = Arc::new(LimitedStarter::default());
    service.set_run_starter(Arc::clone(&starter) as Arc<dyn BoardRunStarter>);
    service.set_enabled(PROJECT, true).expect("enables");
    (service, starter, offset)
}

fn teammate(id: &str, rule: TeammateStartRule) -> TeammateRef {
    TeammateRef {
        id: id.to_owned(),
        handle: id.to_owned(),
        name: id.to_owned(),
        role: "Builds".to_owned(),
        kind: "simple",
        on_assign: rule,
        on_mention: true,
        enabled: true,
        not_assignable_reason: None,
        availability: Availability::Idle,
    }
}

fn draft(title: &str, priority: Option<CardPriority>) -> CardDraft {
    CardDraft {
        title: title.to_owned(),
        description: None,
        priority,
        labels: None,
        blocked_by: None,
        parent_id: None,
    }
}

fn card_id(service: &BoardService, title: &str, priority: Option<CardPriority>) -> String {
    service
        .create_card(
            PROJECT,
            &BoardActor::Person,
            draft(title, priority),
            None,
            None,
        )
        .expect("creates")
        .0
        .id
}

fn queued(priority: CardPriority, seq: u64) -> QueuedStart {
    QueuedStart {
        workspace_id: PROJECT.to_owned(),
        card_id: format!("card-{seq}"),
        teammate_id: "builder".to_owned(),
        cause: BoardRunCause::Assigned,
        chain_depth: 0,
        actor: BoardActor::Person,
        priority,
        seq,
    }
}

#[test]
fn capacity_counts_the_teammate_and_the_board() {
    assert!(capacity_available(&[], "a", 1, 1));
    assert!(!capacity_available(&["a"], "a", 1, 4), "teammate limit");
    assert!(capacity_available(&["a"], "b", 1, 4));
    assert!(!capacity_available(&["a", "b"], "c", 2, 2), "board limit");
    assert!(capacity_available(&["a"], "a", 2, 4));
}

#[test]
fn queue_orders_by_priority_then_age() {
    let mut starts = [
        queued(CardPriority::Low, 1),
        queued(CardPriority::Normal, 3),
        queued(CardPriority::Urgent, 5),
        queued(CardPriority::Normal, 2),
        queued(CardPriority::High, 4),
    ];
    starts.sort_by(queue_order);
    let order: Vec<u64> = starts.iter().map(|start| start.seq).collect();
    assert_eq!(order, [5, 4, 2, 3, 1]);
}

#[test]
fn run_end_moves_only_a_card_the_run_still_held() {
    use CardStatus::*;
    assert_eq!(
        run_end_status(RunOutcome::Succeeded, true, InProgress),
        Some(InReview)
    );
    assert_eq!(
        run_end_status(RunOutcome::Failed, true, InProgress),
        Some(Blocked)
    );
    assert_eq!(
        run_end_status(RunOutcome::Cancelled, true, InProgress),
        None
    );
    assert_eq!(
        run_end_status(RunOutcome::Succeeded, false, InProgress),
        None
    );
    assert_eq!(run_end_status(RunOutcome::Succeeded, true, Done), None);
    assert_eq!(run_end_status(RunOutcome::Succeeded, true, InReview), None);
}

#[test]
fn run_end_comment_truncates_the_result() {
    let long = "x".repeat(MAX_RUN_RESULT_BYTES * 2);
    let comment = run_end_comment(&RunEnd::Succeeded { result: Some(long) }, Some("builder"))
        .expect("comment");
    assert!(comment.starts_with("@builder finished."));
    assert!(comment.contains("Result truncated"));
    assert!(comment.len() < MAX_RUN_RESULT_BYTES + 200);
    assert_eq!(
        run_end_comment(&RunEnd::Succeeded { result: None }, None).as_deref(),
        Some("The run finished without a text result.")
    );
    assert!(run_end_comment(&RunEnd::Cancelled, None).is_none());
    assert!(
        run_end_comment(
            &RunEnd::Failed {
                reason: "boom".into()
            },
            Some("b")
        )
        .expect("failure")
        .contains("failed: boom")
    );
}

#[test]
fn a_full_slot_queues_the_start_and_a_freed_slot_starts_it() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let low = card_id(&service, "Low", Some(CardPriority::Low));
    let urgent = card_id(&service, "Urgent", Some(CardPriority::Urgent));
    starter.full.store(true, Ordering::SeqCst);
    for card in [&low, &urgent] {
        let (_, _, outcome) = service
            .assign(
                PROJECT,
                &BoardActor::Person,
                card,
                Some("builder"),
                CardStartMode::Now,
                0,
                true,
                &teammates,
            )
            .expect("assigns");
        assert_eq!(outcome, AssignOutcome::Queued);
    }
    assert_eq!(service.queued_count(PROJECT, "builder"), 2);
    let board = service.get(PROJECT).unwrap();
    assert_eq!(board.queued_starts.len(), 2, "the queue is in the document");
    assert!(
        board
            .cards
            .iter()
            .all(|card| card.activity.iter().any(|activity| matches!(
                &activity.change,
                CardChange::Queued { teammate_id } if teammate_id == "builder"
            )))
    );
    assert!(
        board
            .cards
            .iter()
            .all(|card| card.status == CardStatus::Todo && card.claim.is_none())
    );

    starter.full.store(false, Ordering::SeqCst);
    assert_eq!(service.drain_queue(PROJECT, &teammates), 2);
    let requests = starter.requests.lock().unwrap();
    assert_eq!(requests[0].card_id, urgent, "urgent starts first");
    assert_eq!(requests[1].card_id, low);
    assert_eq!(service.queued_count(PROJECT, "builder"), 0);
    assert!(service.get(PROJECT).unwrap().queued_starts.is_empty());
}

fn assign_now(service: &BoardService, card: &str, teammates: &[TeammateRef]) -> AssignOutcome {
    service
        .assign(
            PROJECT,
            &BoardActor::Person,
            card,
            Some("builder"),
            CardStartMode::Now,
            0,
            true,
            teammates,
        )
        .expect("assigns")
        .2
}

#[test]
fn a_queued_start_survives_a_restart() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let card = card_id(&service, "Card", None);
    starter.full.store(true, Ordering::SeqCst);
    assert_eq!(
        assign_now(&service, &card, &teammates),
        AssignOutcome::Queued
    );
    assert_eq!(
        assign_now(&service, &card, &teammates),
        AssignOutcome::Queued,
        "a card waits once"
    );
    let saved = service.get(PROJECT).unwrap();
    assert_eq!(saved.queued_starts.len(), 1);
    let queued_activities = saved
        .card(&card)
        .unwrap()
        .activity
        .iter()
        .filter(|activity| matches!(activity.change, CardChange::Queued { .. }))
        .count();
    assert_eq!(queued_activities, 1);

    // A new host process over the same stored document.
    let store = MemoryBoardStore::default();
    store.save(&saved).unwrap();
    let restarted =
        BoardService::new(Box::new(store), false).with_clock(|| base_time() + Duration::seconds(5));
    let fresh = Arc::new(LimitedStarter::default());
    restarted.set_run_starter(Arc::clone(&fresh) as Arc<dyn BoardRunStarter>);
    assert_eq!(restarted.queued_count(PROJECT, "builder"), 1);
    assert!(restarted.queued_workspaces().contains(PROJECT));
    assert_eq!(restarted.drain_queue(PROJECT, &teammates), 1);
    assert_eq!(fresh.requests.lock().unwrap()[0].card_id, card);
    assert!(restarted.get(PROJECT).unwrap().queued_starts.is_empty());
}

#[test]
fn unassigning_closing_or_disabling_drops_queued_starts() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let unassigned = card_id(&service, "Unassigned", None);
    let closed = card_id(&service, "Closed", None);
    let disabled = card_id(&service, "Disabled", None);
    starter.full.store(true, Ordering::SeqCst);
    for card in [&unassigned, &closed, &disabled] {
        assert_eq!(
            assign_now(&service, card, &teammates),
            AssignOutcome::Queued
        );
    }
    assert_eq!(service.queued_count(PROJECT, "builder"), 3);
    service
        .assign(
            PROJECT,
            &BoardActor::Person,
            &unassigned,
            None,
            CardStartMode::Later,
            0,
            true,
            &teammates,
        )
        .unwrap();
    assert_eq!(service.queued_count(PROJECT, "builder"), 2);
    service
        .move_card(
            PROJECT,
            &BoardActor::Person,
            &closed,
            CardStatus::Done,
            None,
            None,
            true,
            &teammates,
        )
        .unwrap();
    assert_eq!(service.queued_count(PROJECT, "builder"), 1);
    service.forget_queued_starts(PROJECT, "builder").unwrap();
    assert_eq!(service.queued_count(PROJECT, "builder"), 0);
    assert!(service.get(PROJECT).unwrap().queued_starts.is_empty());
    starter.full.store(false, Ordering::SeqCst);
    assert_eq!(service.drain_queue(PROJECT, &teammates), 0);
    assert!(starter.requests.lock().unwrap().is_empty());
}

#[test]
fn a_rolled_back_start_does_not_count_toward_the_cooldown() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let card = card_id(&service, "Card", None);
    service
        .assign(
            PROJECT,
            &BoardActor::Person,
            &card,
            Some("builder"),
            CardStartMode::Later,
            0,
            true,
            &teammates,
        )
        .unwrap();
    starter.fail.store(true, Ordering::SeqCst);
    assert!(service.start_run(PROJECT, &card, &teammates).is_err());
    starter.fail.store(false, Ordering::SeqCst);
    let rolled_back = service.get(PROJECT).unwrap();
    let stored = rolled_back.card(&card).unwrap();
    assert_eq!(stored.status, CardStatus::Todo, "status restored");
    assert!(stored.claim.is_none());
    for to in [CardStatus::Backlog, CardStatus::Todo] {
        service
            .move_card(
                PROJECT,
                &BoardActor::Person,
                &card,
                to,
                None,
                None,
                true,
                &teammates,
            )
            .unwrap();
    }
    let board = service.get(PROJECT).unwrap();
    assert!(
        board.pending_starts.is_empty(),
        "no cooldown after a failed start"
    );
    assert_eq!(starter.requests.lock().unwrap().len(), 1);
}

#[test]
fn a_queued_start_that_no_longer_applies_leaves_the_queue() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let card = card_id(&service, "Card", None);
    starter.full.store(true, Ordering::SeqCst);
    service
        .assign(
            PROJECT,
            &BoardActor::Person,
            &card,
            Some("builder"),
            CardStartMode::Now,
            0,
            true,
            &teammates,
        )
        .unwrap();
    service
        .move_card(
            PROJECT,
            &BoardActor::Person,
            &card,
            CardStatus::Backlog,
            None,
            None,
            true,
            &teammates,
        )
        .unwrap();
    starter.full.store(false, Ordering::SeqCst);
    assert_eq!(service.drain_queue(PROJECT, &teammates), 0);
    assert!(starter.requests.lock().unwrap().is_empty());
    assert_eq!(service.queued_count(PROJECT, "builder"), 0);
}

#[test]
fn run_end_is_recorded_once_and_maps_to_statuses() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    for (end, expected) in [
        (
            RunEnd::Succeeded {
                result: Some("All done".into()),
            },
            CardStatus::InReview,
        ),
        (
            RunEnd::Failed {
                reason: "boom".into(),
            },
            CardStatus::Blocked,
        ),
        (RunEnd::Cancelled, CardStatus::InProgress),
    ] {
        let card = card_id(&service, "Work", None);
        service
            .assign(
                PROJECT,
                &BoardActor::Person,
                &card,
                Some("builder"),
                CardStartMode::Now,
                0,
                true,
                &teammates,
            )
            .unwrap();
        let run_id = starter
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .run_id
            .clone();
        let before = service.get(PROJECT).unwrap();
        assert!(needs_run_end(before.card(&card).unwrap(), &run_id));
        assert!(
            service
                .finish_run(PROJECT, &card, &run_id, Some("builder"), &end)
                .unwrap()
        );
        let board = service.get(PROJECT).unwrap();
        let stored = board.card(&card).unwrap();
        assert_eq!(stored.status, expected);
        assert!(stored.claim.is_none(), "the run's claim is released");
        assert!(stored.activity.iter().any(|activity| matches!(
            &activity.change,
            CardChange::RunFinished { run_id: finished, outcome } if *finished == run_id && *outcome == end.outcome()
        )));
        assert!(!needs_run_end(stored, &run_id));
        assert!(
            !service
                .finish_run(PROJECT, &card, &run_id, Some("builder"), &end)
                .unwrap(),
            "a repeated observation (restart) changes nothing"
        );
    }
}

#[test]
fn automatic_starts_of_one_card_cool_down() {
    let (service, starter, clock) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let card = card_id(&service, "Work", None);
    service
        .assign(
            PROJECT,
            &BoardActor::Person,
            &card,
            Some("builder"),
            CardStartMode::Now,
            0,
            true,
            &teammates,
        )
        .unwrap();
    let run_id = starter.requests.lock().unwrap()[0].run_id.clone();
    clock.store(10, Ordering::SeqCst);
    service
        .finish_run(PROJECT, &card, &run_id, None, &RunEnd::Cancelled)
        .unwrap();
    service
        .move_card(
            PROJECT,
            &BoardActor::Person,
            &card,
            CardStatus::Todo,
            None,
            None,
            true,
            &teammates,
        )
        .unwrap();
    let board = service.get(PROJECT).unwrap();
    assert_eq!(
        starter.requests.lock().unwrap().len(),
        1,
        "no second start within 60 s"
    );
    assert_eq!(board.pending_starts.len(), 1, "the person decides instead");

    clock.store(120, Ordering::SeqCst);
    service
        .move_card(
            PROJECT,
            &BoardActor::Person,
            &card,
            CardStatus::Backlog,
            None,
            None,
            true,
            &teammates,
        )
        .unwrap();
    service
        .move_card(
            PROJECT,
            &BoardActor::Person,
            &card,
            CardStatus::Todo,
            None,
            None,
            true,
            &teammates,
        )
        .unwrap();
    assert_eq!(
        starter.requests.lock().unwrap().len(),
        2,
        "after the cooldown it starts"
    );
}

#[test]
fn a_too_deep_chain_waits_for_the_person() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let card = card_id(&service, "Work", None);
    let agent = BoardActor::ChatAgent {
        session_id: "chat".into(),
        harness: "codex".into(),
    };
    let (_, _, outcome) = service
        .assign(
            PROJECT,
            &agent,
            &card,
            Some("builder"),
            CardStartMode::Ask,
            MAX_TRIGGER_CHAIN_DEPTH + 1,
            true,
            &teammates,
        )
        .unwrap();
    assert_eq!(outcome, AssignOutcome::PendingStart);
    assert!(starter.requests.lock().unwrap().is_empty());
}

#[test]
fn a_runs_own_writes_never_wake_its_card() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let card = card_id(&service, "Work", None);
    service
        .assign(
            PROJECT,
            &BoardActor::Person,
            &card,
            Some("builder"),
            CardStartMode::Now,
            0,
            true,
            &teammates,
        )
        .unwrap();
    let run_id = starter.requests.lock().unwrap()[0].run_id.clone();
    let board = service.get(PROJECT).unwrap();
    let stored = board.card(&card).unwrap();
    let member = BoardActor::RunMember {
        run_id: run_id.clone(),
        member_id: "m".into(),
        profile_id: "p".into(),
        teammate_id: Some("builder".into()),
    };
    assert!(own_run_card(stored, &member));
    let other = BoardActor::RunMember {
        run_id: "other-run".into(),
        member_id: "m".into(),
        profile_id: "p".into(),
        teammate_id: None,
    };
    assert!(!own_run_card(stored, &other));
    assert!(!own_run_card(stored, &BoardActor::Person));
}

#[test]
fn sweep_releases_claims_of_ended_runs() {
    let (service, starter, _) = service();
    let teammates = [teammate("builder", TeammateStartRule::Always)];
    let run_card = card_id(&service, "Run", None);
    service
        .assign(
            PROJECT,
            &BoardActor::Person,
            &run_card,
            Some("builder"),
            CardStartMode::Now,
            0,
            true,
            &teammates,
        )
        .unwrap();
    let run_id = starter.requests.lock().unwrap()[0].run_id.clone();
    assert_eq!(
        service.sweep_claims(PROJECT, &|id| id == run_id).unwrap(),
        0,
        "live run keeps it"
    );
    assert_eq!(
        service.sweep_claims(PROJECT, &|_| false).unwrap(),
        1,
        "ended run releases it"
    );
    let board = service.get(PROJECT).unwrap();
    assert!(board.card(&run_card).unwrap().claim.is_none());
}
