//! Event automations (host v7.2) through the real durable journal: which
//! rules fire, how firings are claimed and recorded, file debouncing and
//! every loop-protection layer. Tauri, watchers and harnesses are left out;
//! `TriggerCore` receives snapshots, batches and instants directly.

use super::*;
use crate::orchestration_api::{
    OrchestrationApiState, SaveGraphRequest, SaveScheduleRequest, SetScheduleEnabledRequest,
    StartRunRequest, save_graph, save_schedule, set_schedule_enabled,
};
use crate::orchestration_schedule::{
    IntervalUnit, MissedRunPolicy, OverlapPolicy, ScheduleDefinition, ScheduleOccurrenceOutcome,
    ScheduleSnapshot, ScheduleTrigger,
};
use piui_orchestration::{
    CompletionOutcome, Coordinator, MAX_TRIGGER_CHAIN_DEPTH, NativeExecutionReference, RunTrigger,
    RunTriggerEvent,
};
use serde_json::json;
use std::collections::BTreeMap;

const WORKSPACE: &str = "workspace";

struct Fixture {
    root: PathBuf,
    state: OrchestrationApiState,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("piui-triggers-{}", uuid::Uuid::new_v4()));
        let state = OrchestrationApiState::open(&root).expect("opens journal");
        save_graph(&state, system("build")).expect("saves build");
        save_graph(&state, system("deploy")).expect("saves deploy");
        Self { root, state }
    }

    fn snapshot(&self) -> StoreSnapshot {
        self.state.snapshot().expect("snapshot")
    }

    fn automation(&self, id: &str, target: &str, trigger: ScheduleTrigger) -> ScheduleSnapshot {
        let saved = save_schedule(
            &self.state,
            SaveScheduleRequest {
                workspace_id: WORKSPACE.into(),
                expected_revision: None,
                value: definition(id, target, trigger),
            },
        )
        .expect("saves automation");
        set_schedule_enabled(
            &self.state,
            SetScheduleEnabledRequest {
                workspace_id: WORKSPACE.into(),
                id: id.into(),
                expected_revision: saved.revision,
                enabled: true,
            },
        )
        .expect("enables automation")
    }

    fn start(&self, run_id: &str, command: &str) -> Run {
        self.state
            .create_run(StartRunRequest {
                workspace_id: WORKSPACE.into(),
                run_id: run_id.into(),
                team_id: format!("{command}-team"),
                pipeline_id: format!("{command}-pipeline"),
                launch_command_id: Some(command.into()),
                inputs: BTreeMap::new(),
                use_pinned_data: false,
            })
            .expect("starts run")
    }

    fn succeed(&self, run_id: &str) -> Run {
        let finished = self.state.update_run_for_test(WORKSPACE, run_id, |run| {
            let revision = run.revision();
            let launch = Coordinator::dispatch_next(
                run,
                revision,
                NativeExecutionReference {
                    id: format!("{}-session", run.id()),
                },
            )
            .expect("dispatches")
            .expect("has a ready step");
            Coordinator::complete_task(
                run,
                launch.run_revision,
                &launch.step_id,
                launch.task_revision,
                &launch.execution.id,
                CompletionOutcome::Succeeded {
                    result_reference: None,
                },
            )
            .expect("completes");
        });
        assert_eq!(finished.status(), RunStatus::Succeeded);
        finished
    }

    fn fail(&self, run_id: &str) -> Run {
        let failed = self
            .state
            .reject_ready_task(WORKSPACE, run_id, "node", 0, "native-turn-failed".into())
            .expect("fails the only step");
        assert_eq!(failed.status(), RunStatus::Failed);
        failed
    }

    fn claim(&self, firing: &EventFiring, now: DateTime<Utc>) -> Option<ScheduleSnapshot> {
        self.claim_run(firing, now).map(|(schedule, _)| schedule)
    }

    fn claim_run(
        &self,
        firing: &EventFiring,
        now: DateTime<Utc>,
    ) -> Option<(ScheduleSnapshot, Option<Run>)> {
        self.state
            .claim_event_occurrence(firing, now, None)
            .expect("claims")
            .map(|claim| (claim.schedule, claim.run))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn system(id: &str) -> SaveGraphRequest {
    serde_json::from_value(json!({
        "workspaceId": WORKSPACE,
        "profiles": [{"workspaceId": WORKSPACE, "value": {"id": format!("{id}-agent"), "name": "Agent", "harness": "codex", "model": "model", "permissionMode": "read-only", "instructions": "", "toolPolicy": {"rules": []}, "allowedSpawnProfileIds": []}}],
        "team": {"workspaceId": WORKSPACE, "value": {"id": format!("{id}-team"), "name": id, "members": [{"id": "node", "profileId": format!("{id}-agent")}], "sendEdges": [], "observeEdges": [], "orchestratorMemberId": "node"}},
        "pipeline": {"workspaceId": WORKSPACE, "value": {"id": format!("{id}-pipeline"), "name": id, "steps": [{"id": "node", "name": "Task", "assignedMemberId": "node", "instructions": "Work", "dependencyStepIds": []}]}},
        "command": {"workspaceId": WORKSPACE, "value": {"id": id, "name": id, "teamId": format!("{id}-team"), "pipelineId": format!("{id}-pipeline")}}
    }))
    .expect("valid system")
}

fn definition(id: &str, target: &str, trigger: ScheduleTrigger) -> ScheduleDefinition {
    ScheduleDefinition {
        id: id.into(),
        name: format!("Automation {id}"),
        launch_command_id: target.into(),
        trigger,
        missed_run_policy: MissedRunPolicy::Skip,
        overlap_policy: OverlapPolicy::Skip,
        inputs: BTreeMap::new(),
    }
}

fn run_finished(source: &str, outcomes: &[FinishedOutcome]) -> ScheduleTrigger {
    ScheduleTrigger::Event {
        event: EventTrigger::RunFinished {
            launch_command_id: source.into(),
            outcomes: outcomes.to_vec(),
        },
    }
}

fn files_changed(include: &[&str], exclude: &[&str], debounce_seconds: u32) -> ScheduleTrigger {
    ScheduleTrigger::Event {
        event: EventTrigger::FilesChanged {
            include: include.iter().map(|value| (*value).to_owned()).collect(),
            exclude: exclude.iter().map(|value| (*value).to_owned()).collect(),
            debounce_seconds,
        },
    }
}

fn at(value: &str) -> DateTime<Utc> {
    value.parse().expect("valid instant")
}

fn seconds(base: DateTime<Utc>, value: i64) -> DateTime<Utc> {
    base + chrono::Duration::seconds(value)
}

fn batch(paths: &[&str]) -> ChangeBatch {
    ChangeBatch {
        paths: paths.iter().map(|path| (*path).to_owned()).collect(),
        overflow: false,
    }
}

fn last_outcome(schedule: &ScheduleSnapshot) -> ScheduleOccurrenceOutcome {
    schedule
        .last_occurrence
        .as_ref()
        .expect("recorded occurrence")
        .outcome
}

#[test]
fn a_finished_run_fires_only_matching_rules_once_with_its_identity() {
    let fixture = Fixture::new();
    let enabled = fixture.automation(
        "after-build",
        "deploy",
        run_finished("build", &[FinishedOutcome::Succeeded]),
    );
    assert!(enabled.enabled);
    assert_eq!(enabled.next_due_at, None, "event rules are never due");
    fixture.automation(
        "on-failure",
        "deploy",
        run_finished("build", &[FinishedOutcome::Failed]),
    );
    let t0 = at("2026-09-27T10:00:00Z");
    let mut core = TriggerCore::new(&fixture.snapshot(), t0);

    fixture.start("build-1", "build");
    assert!(
        core.observe(&fixture.snapshot(), Instant::now(), t0)
            .is_empty()
    );
    fixture.succeed("build-1");
    let firings = core.observe(&fixture.snapshot(), Instant::now(), t0);
    assert_eq!(firings.len(), 1, "{firings:?}");
    let firing = &firings[0];
    assert_eq!(firing.schedule_id, "after-build");
    assert_eq!(
        firing.cause,
        EventCause::RunFinished {
            source_run_id: "build-1".into()
        }
    );
    assert_eq!(firing.chain_depth, 1);
    // Observing the same generation again fires nothing new.
    assert!(
        core.observe(&fixture.snapshot(), Instant::now(), t0)
            .is_empty()
    );

    let (schedule, run) = fixture.claim_run(firing, t0).expect("claims the firing");
    let run = run.expect("starts a run");
    assert_eq!(last_outcome(&schedule), ScheduleOccurrenceOutcome::Started);
    let occurrence = schedule.last_occurrence.expect("occurrence");
    assert_eq!(occurrence.run_id.as_deref(), Some(run.id()));
    assert_eq!(occurrence.source_run_id.as_deref(), Some("build-1"));
    assert_eq!(occurrence.chain_depth, Some(1));
    assert_eq!(
        run.definition()
            .launch_command
            .as_ref()
            .map(|command| command.id.as_str()),
        Some("deploy")
    );
    assert_eq!(
        run.trigger(),
        Some(&RunTrigger::Event {
            schedule_id: "after-build".into(),
            schedule_name: "Automation after-build".into(),
            occurrence_id: run.id().to_owned(),
            event: RunTriggerEvent::RunFinished,
            source_run_id: Some("build-1".into()),
            chain_depth: 1,
        })
    );
    // A repeated claim of the same finished run is a no-op.
    assert!(fixture.claim(firing, seconds(t0, 1)).is_none());

    // The failure rule reacts to a failed build only; unwatched runs are quiet.
    fixture.start("build-2", "build");
    fixture.start("deploy-1", "deploy");
    core.observe(&fixture.snapshot(), Instant::now(), t0);
    fixture.fail("build-2");
    let revision = fixture
        .state
        .get_run(WORKSPACE, "deploy-1")
        .expect("reads")
        .expect("exists")
        .revision();
    fixture
        .state
        .commit_cancel_after_native_stop(WORKSPACE, "deploy-1", revision, None)
        .expect("cancels");
    let firings = core.observe(&fixture.snapshot(), Instant::now(), t0);
    assert_eq!(
        firings
            .iter()
            .map(|firing| firing.schedule_id.as_str())
            .collect::<Vec<_>>(),
        vec!["on-failure"]
    );

    // Everything above is durable.
    let reopened = OrchestrationApiState::open(&fixture.root).expect("reopens");
    let store = reopened.snapshot().expect("snapshot");
    let workspace = store.workspace(WORKSPACE).expect("workspace");
    let stored = workspace
        .runs
        .iter()
        .find(|candidate| candidate.id() == run.id())
        .expect("persisted run");
    assert_eq!(stored.trigger(), run.trigger());
    assert_eq!(
        workspace
            .schedules
            .iter()
            .find(|schedule| schedule.value.id == "after-build")
            .map(|schedule| schedule.occurrences.len()),
        Some(1)
    );
}

#[test]
fn a_pipeline_that_restarts_itself_stops_at_the_chain_limit() {
    let fixture = Fixture::new();
    fixture.automation(
        "again",
        "deploy",
        run_finished(
            "deploy",
            &[
                FinishedOutcome::Succeeded,
                FinishedOutcome::Failed,
                FinishedOutcome::Cancelled,
            ],
        ),
    );
    assert_eq!(MAX_TRIGGER_CHAIN_DEPTH, 3);
    let t0 = at("2026-09-27T10:00:00Z");
    let mut core = TriggerCore::new(&fixture.snapshot(), t0);
    fixture.start("manual", "deploy");
    fixture.succeed("manual");
    for hop in 1..=4_u8 {
        let firings = core.observe(&fixture.snapshot(), Instant::now(), t0);
        assert_eq!(firings.len(), 1, "hop {hop}");
        assert_eq!(firings[0].chain_depth, hop);
        // Each hop is past the cooldown, so only the depth limit can stop it.
        let now = seconds(t0, i64::from(hop) * (EVENT_COOLDOWN_SECONDS + 1));
        let (schedule, run) = fixture.claim_run(&firings[0], now).expect("claims");
        if hop <= MAX_TRIGGER_CHAIN_DEPTH {
            let run = run.expect("starts a chained run");
            assert_eq!(run.chain_depth(), hop);
            assert_eq!(last_outcome(&schedule), ScheduleOccurrenceOutcome::Started);
            fixture.succeed(run.id());
        } else {
            assert!(run.is_none(), "the fourth hop never starts");
            assert_eq!(
                last_outcome(&schedule),
                ScheduleOccurrenceOutcome::SkippedChainLimit
            );
            assert_eq!(
                schedule
                    .last_occurrence
                    .and_then(|occurrence| occurrence.chain_depth),
                Some(4)
            );
        }
    }
    assert!(
        core.observe(&fixture.snapshot(), Instant::now(), t0)
            .is_empty()
    );
    let store = fixture.snapshot();
    assert_eq!(store.workspace(WORKSPACE).expect("workspace").runs.len(), 4);
}

#[test]
fn cooldown_overlap_pause_and_admission_are_recorded_with_a_reason() {
    let fixture = Fixture::new();
    fixture.automation(
        "after-build",
        "deploy",
        run_finished("build", &[FinishedOutcome::Succeeded]),
    );
    let t0 = at("2026-09-27T10:00:00Z");
    let firing = |source: &str| EventFiring {
        workspace_id: WORKSPACE.into(),
        schedule_id: "after-build".into(),
        trigger_revision: 0,
        cause: EventCause::RunFinished {
            source_run_id: source.into(),
        },
        observed_at: t0,
        chain_depth: 1,
    };
    let (started, run) = fixture.claim_run(&firing("b1"), t0).expect("claims");
    assert_eq!(last_outcome(&started), ScheduleOccurrenceOutcome::Started);
    assert!(run.is_some());
    let cooled = fixture
        .claim(&firing("b2"), seconds(t0, 5))
        .expect("records");
    assert_eq!(
        last_outcome(&cooled),
        ScheduleOccurrenceOutcome::SkippedCooldown
    );
    // Past the cooldown the first run is still active: overlap skip.
    let overlapping = fixture
        .claim(&firing("b3"), seconds(t0, 40))
        .expect("records");
    assert_eq!(
        last_outcome(&overlapping),
        ScheduleOccurrenceOutcome::SkippedOverlap
    );

    assert!(fixture.state.set_automations_paused(true).expect("pauses"));
    let paused = fixture
        .claim(&firing("b4"), seconds(t0, 80))
        .expect("records");
    assert_eq!(
        last_outcome(&paused),
        ScheduleOccurrenceOutcome::SkippedPaused
    );
    assert!(
        fixture
            .state
            .set_automations_paused(false)
            .expect("resumes")
    );

    let refused = fixture
        .state
        .claim_event_occurrence(&firing("b5"), seconds(t0, 120), Some("runtime-unavailable"))
        .expect("claims")
        .expect("records");
    let occurrence = refused.schedule.last_occurrence.expect("occurrence");
    assert_eq!(occurrence.outcome, ScheduleOccurrenceOutcome::Failed);
    assert_eq!(
        occurrence.failure_code.as_deref(),
        Some("runtime-unavailable")
    );
    assert!(refused.run.is_none());

    // Stale firings write nothing: an unknown rule, a wrong kind of cause
    // or an older trigger revision.
    let before = fixture.snapshot();
    let mut stale = firing("b6");
    stale.trigger_revision = 7;
    assert!(fixture.claim(&stale, seconds(t0, 200)).is_none());
    let mut wrong = firing("b7");
    wrong.cause = EventCause::FilesChanged;
    assert!(fixture.claim(&wrong, seconds(t0, 200)).is_none());
    let mut unknown = firing("b8");
    unknown.schedule_id = "missing".into();
    assert!(fixture.claim(&unknown, seconds(t0, 200)).is_none());
    let after = fixture.snapshot();
    assert_eq!(
        before
            .workspace(WORKSPACE)
            .map(|workspace| workspace.schedules[0].revision),
        after
            .workspace(WORKSPACE)
            .map(|workspace| workspace.schedules[0].revision)
    );
}

#[test]
fn event_rules_are_checked_against_the_workspace() {
    let fixture = Fixture::new();
    let save = |value: ScheduleDefinition| {
        save_schedule(
            &fixture.state,
            SaveScheduleRequest {
                workspace_id: WORKSPACE.into(),
                expected_revision: None,
                value,
            },
        )
    };
    let missing_source = save(definition(
        "watch-missing",
        "deploy",
        run_finished("missing", &[FinishedOutcome::Succeeded]),
    ));
    assert_eq!(
        missing_source.map(|_| ()).map_err(|error| error.code),
        Err("invalid")
    );
    let mut coalescing = definition("files", "deploy", files_changed(&["src/**"], &[], 10));
    coalescing.missed_run_policy = MissedRunPolicy::Coalesce;
    assert!(save(coalescing).is_err());
    assert!(
        save(definition(
            "unsafe",
            "deploy",
            files_changed(&["../x"], &[], 10)
        ))
        .is_err()
    );

    fixture.automation(
        "after-build",
        "deploy",
        run_finished("build", &[FinishedOutcome::Succeeded]),
    );
    // A watched pipeline cannot be deleted while a rule waits for it.
    let build = fixture
        .snapshot()
        .workspace(WORKSPACE)
        .and_then(|workspace| {
            workspace
                .launch_commands
                .iter()
                .find(|command| command.value.id == "build")
                .map(|command| command.revision)
        })
        .expect("build command");
    assert_eq!(
        fixture
            .state
            .delete_launch_command_for_test(WORKSPACE, "build", build)
            .map_err(|error| error.code),
        Err("conflict")
    );
}

#[test]
fn a_long_or_multiline_name_never_invalidates_the_run_trigger() {
    let fixture = Fixture::new();
    let mut value = definition(
        "named",
        "deploy",
        run_finished("build", &[FinishedOutcome::Succeeded]),
    );
    value.name = format!("Nightly\nreview {}", "é".repeat(400));
    let saved = save_schedule(
        &fixture.state,
        SaveScheduleRequest {
            workspace_id: WORKSPACE.into(),
            expected_revision: None,
            value,
        },
    )
    .expect("saves");
    set_schedule_enabled(
        &fixture.state,
        SetScheduleEnabledRequest {
            workspace_id: WORKSPACE.into(),
            id: "named".into(),
            expected_revision: saved.revision,
            enabled: true,
        },
    )
    .expect("enables");
    let (_, run) = fixture
        .claim_run(
            &EventFiring {
                workspace_id: WORKSPACE.into(),
                schedule_id: "named".into(),
                trigger_revision: 0,
                cause: EventCause::RunFinished {
                    source_run_id: "build-1".into(),
                },
                observed_at: at("2026-09-27T10:00:00Z"),
                chain_depth: 1,
            },
            at("2026-09-27T10:00:00Z"),
        )
        .expect("claims");
    let Some(RunTrigger::Event { schedule_name, .. }) = run.expect("starts").trigger().cloned()
    else {
        panic!("event trigger expected");
    };
    assert!(schedule_name.starts_with("Nightly review "));
    assert!(schedule_name.len() <= 256);
    assert!(!schedule_name.chars().any(char::is_control));
}

#[test]
fn timed_runs_record_their_schedule_and_wait_while_paused() {
    let fixture = Fixture::new();
    let t0 = at("2026-09-27T10:00:00Z");
    let enabled = fixture.automation(
        "hourly",
        "deploy",
        ScheduleTrigger::Interval {
            every: 1,
            unit: IntervalUnit::Hours,
            anchor_at: t0,
            time_zone: "UTC".into(),
        },
    );
    fixture.state.set_automations_paused(true).expect("pauses");
    assert!(
        fixture
            .state
            .claim_due_schedule(WORKSPACE, "hourly", enabled.revision, t0, t0, None)
            .is_err(),
        "no claim while paused"
    );
    fixture
        .state
        .set_automations_paused(false)
        .expect("resumes");
    let claim = fixture
        .state
        .claim_due_schedule(WORKSPACE, "hourly", enabled.revision, t0, t0, None)
        .expect("claims after resume");
    let run = claim.run.expect("starts");
    assert_eq!(
        run.trigger(),
        Some(&RunTrigger::Schedule {
            schedule_id: "hourly".into(),
            schedule_name: "Automation hourly".into(),
            occurrence_id: run.id().to_owned(),
        })
    );
    assert_eq!(run.chain_depth(), 0);
}

#[test]
fn file_bursts_fire_once_after_a_quiet_period() {
    let fixture = Fixture::new();
    fixture.automation(
        "on-src",
        "deploy",
        files_changed(&["src/**/*.ts"], &["src/generated/**"], 5),
    );
    let wall = at("2026-09-27T10:00:00Z");
    let mut core = TriggerCore::new(&fixture.snapshot(), wall).with_fold_case(false);
    assert_eq!(
        core.watched_workspaces(),
        BTreeSet::from([WORKSPACE.to_owned()])
    );
    let base = Instant::now();
    let now = |offset: u64| base + Duration::from_secs(offset);

    core.file_changes(WORKSPACE, &batch(&["src/generated/api.ts"]), now(0), wall);
    core.file_changes(WORKSPACE, &batch(&["README.md"]), now(0), wall);
    core.file_changes(
        WORKSPACE,
        &ChangeBatch {
            paths: Vec::new(),
            overflow: true,
        },
        now(0),
        wall,
    );
    assert_eq!(core.next_deadline(now(0), wall), None, "nothing matched");

    core.file_changes(WORKSPACE, &batch(&["src/a.ts"]), now(1), wall);
    core.file_changes(
        WORKSPACE,
        &batch(&["docs/x.md", "src/app/b.ts"]),
        now(3),
        seconds(wall, 3),
    );
    assert_eq!(core.next_deadline(now(3), seconds(wall, 3)), Some(now(8)));
    assert!(core.due(now(7), seconds(wall, 7)).is_empty());
    let firings = core.due(now(8), seconds(wall, 8));
    assert_eq!(firings.len(), 1);
    assert_eq!(firings[0].cause, EventCause::FilesChanged);
    assert_eq!(
        firings[0].chain_depth, 1,
        "a person's edit is the first hop"
    );
    assert_eq!(firings[0].observed_at, seconds(wall, 3));
    assert!(
        core.due(now(30), seconds(wall, 30)).is_empty(),
        "the burst is spent"
    );

    // The durable claim starts a files-changed run.
    let (schedule, run) = fixture
        .claim_run(&firings[0], seconds(wall, 8))
        .expect("claims");
    assert_eq!(last_outcome(&schedule), ScheduleOccurrenceOutcome::Started);
    let run = run.expect("starts");
    assert!(matches!(
        run.trigger(),
        Some(RunTrigger::Event {
            event: RunTriggerEvent::FilesChanged,
            source_run_id: None,
            chain_depth: 1,
            ..
        })
    ));
}

#[test]
fn a_folder_that_keeps_changing_still_fires_within_a_bound() {
    let fixture = Fixture::new();
    fixture.automation("on-src", "deploy", files_changed(&["src/**"], &[], 2));
    let wall = at("2026-09-27T10:00:00Z");
    let mut core = TriggerCore::new(&fixture.snapshot(), wall);
    let base = Instant::now();
    let mut fired = Vec::new();
    for second in 0..30_u64 {
        let now = base + Duration::from_secs(second);
        core.file_changes(WORKSPACE, &batch(&["src/log.txt"]), now, wall);
        fired.extend(core.due(now, wall));
    }
    // Quiet never comes; the burst still fires after ten quiet periods.
    assert_eq!(fired.len(), 1);
}

#[test]
fn a_rules_own_run_never_retriggers_it_through_file_changes() {
    let fixture = Fixture::new();
    fixture.automation("on-src", "deploy", files_changed(&["src/**"], &[], 2));
    let wall = at("2026-09-27T10:00:00Z");
    let mut core = TriggerCore::new(&fixture.snapshot(), wall);
    let base = Instant::now();
    let now = |offset: u64| base + Duration::from_secs(offset);
    core.file_changes(WORKSPACE, &batch(&["src/a.ts"]), now(0), wall);
    let firing = core.due(now(2), wall).pop().expect("fires");
    let (_, run) = fixture.claim_run(&firing, wall).expect("claims");
    let run = run.expect("starts");
    core.observe(&fixture.snapshot(), now(3), wall);

    // While its run works, the rule ignores the files that run writes.
    core.file_changes(WORKSPACE, &batch(&["src/generated.ts"]), now(4), wall);
    assert_eq!(core.next_deadline(now(4), wall), None);
    fixture.succeed(run.id());
    core.observe(&fixture.snapshot(), now(10), wall);
    // ...and briefly after it ended (late watcher events).
    core.file_changes(WORKSPACE, &batch(&["src/late.ts"]), now(11), wall);
    assert_eq!(core.next_deadline(now(11), wall), None);
    // A later change counts again, once the cooldown has passed.
    let later = seconds(wall, EVENT_COOLDOWN_SECONDS + 20);
    core.file_changes(WORKSPACE, &batch(&["src/edit.ts"]), now(20), later);
    assert!(core.next_deadline(now(20), later).is_some());
}

#[test]
fn file_firings_take_the_chain_depth_of_the_runs_that_changed_them() {
    let fixture = Fixture::new();
    fixture.automation("on-src", "deploy", files_changed(&["src/**"], &[], 2));
    fixture.automation(
        "after-build",
        "deploy",
        run_finished("build", &[FinishedOutcome::Succeeded]),
    );
    let wall = at("2026-09-27T10:00:00Z");
    let mut core = TriggerCore::new(&fixture.snapshot(), wall);
    let base = Instant::now();
    let now = |offset: u64| base + Duration::from_secs(offset);

    // A run at depth 2 (an event run started by another chain) is working.
    let (_, deep) = fixture
        .claim_run(
            &EventFiring {
                workspace_id: WORKSPACE.into(),
                schedule_id: "after-build".into(),
                trigger_revision: 0,
                cause: EventCause::RunFinished {
                    source_run_id: "build-x".into(),
                },
                observed_at: wall,
                chain_depth: 2,
            },
            wall,
        )
        .expect("claims");
    let deep = deep.expect("starts");
    assert_eq!(deep.chain_depth(), 2);
    core.observe(&fixture.snapshot(), now(0), wall);
    core.file_changes(WORKSPACE, &batch(&["src/a.ts"]), now(1), wall);
    let firing = core.due(now(3), wall).pop().expect("fires");
    assert_eq!(firing.chain_depth, 3);

    // The same change after a depth-3 run would exceed the limit.
    fixture.succeed(deep.id());
    let (_, deeper) = fixture
        .claim_run(
            &EventFiring {
                workspace_id: WORKSPACE.into(),
                schedule_id: "after-build".into(),
                trigger_revision: 0,
                cause: EventCause::RunFinished {
                    source_run_id: "build-y".into(),
                },
                observed_at: wall,
                chain_depth: 3,
            },
            seconds(wall, EVENT_COOLDOWN_SECONDS + 1),
        )
        .expect("claims");
    assert_eq!(deeper.expect("starts").chain_depth(), 3);
    core.observe(&fixture.snapshot(), now(4), wall);
    let later = seconds(wall, 2 * EVENT_COOLDOWN_SECONDS);
    core.file_changes(WORKSPACE, &batch(&["src/b.ts"]), now(5), later);
    let firing = core.due(now(7), later).pop().expect("fires");
    assert_eq!(firing.chain_depth, 4);
    let skipped = fixture.claim(&firing, later).expect("records");
    assert_eq!(
        last_outcome(&skipped),
        ScheduleOccurrenceOutcome::SkippedChainLimit
    );
}

#[test]
fn the_cooldown_defers_file_firings_instead_of_dropping_them() {
    let fixture = Fixture::new();
    fixture.automation("on-src", "deploy", files_changed(&["src/**"], &[], 2));
    let wall = at("2026-09-27T10:00:00Z");
    let mut core = TriggerCore::new(&fixture.snapshot(), wall);
    let base = Instant::now();
    let now = |offset: u64| base + Duration::from_secs(offset);
    core.file_changes(WORKSPACE, &batch(&["src/a.ts"]), now(0), wall);
    let firing = core.due(now(2), seconds(wall, 2)).pop().expect("fires");
    let (_, run) = fixture
        .claim_run(&firing, seconds(wall, 2))
        .expect("claims");
    fixture.succeed(run.expect("starts").id());
    core.observe(&fixture.snapshot(), now(5), seconds(wall, 5));

    core.file_changes(WORKSPACE, &batch(&["src/b.ts"]), now(10), seconds(wall, 10));
    assert!(
        core.due(now(12), seconds(wall, 12)).is_empty(),
        "cooling down"
    );
    let deadline = core
        .next_deadline(now(12), seconds(wall, 12))
        .expect("pending");
    assert!(deadline >= now(12 + 19), "waits for the cooldown");
    let firings = core.due(now(40), seconds(wall, 40));
    assert_eq!(firings.len(), 1, "fires once the cooldown passed");
}

#[test]
fn paused_or_disabled_rules_watch_and_fire_nothing() {
    let fixture = Fixture::new();
    let enabled = fixture.automation("on-src", "deploy", files_changed(&["src/**"], &[], 2));
    let wall = at("2026-09-27T10:00:00Z");
    let mut core = TriggerCore::new(&fixture.snapshot(), wall);
    let base = Instant::now();
    let now = |offset: u64| base + Duration::from_secs(offset);
    core.file_changes(WORKSPACE, &batch(&["src/a.ts"]), now(0), wall);

    fixture.state.set_automations_paused(true).expect("pauses");
    core.observe(&fixture.snapshot(), now(1), wall);
    assert!(core.watched_workspaces().is_empty());
    assert_eq!(core.next_deadline(now(1), wall), None);
    assert!(core.due(now(5), wall).is_empty());
    core.file_changes(WORKSPACE, &batch(&["src/b.ts"]), now(6), wall);
    fixture
        .state
        .set_automations_paused(false)
        .expect("resumes");
    core.observe(&fixture.snapshot(), now(7), wall);
    assert_eq!(core.watched_workspaces().len(), 1);
    assert!(
        core.due(now(20), wall).is_empty(),
        "paused changes are gone"
    );

    set_schedule_enabled(
        &fixture.state,
        SetScheduleEnabledRequest {
            workspace_id: WORKSPACE.into(),
            id: "on-src".into(),
            expected_revision: enabled.revision,
            enabled: false,
        },
    )
    .expect("disables");
    core.observe(&fixture.snapshot(), now(21), wall);
    assert!(core.watched_workspaces().is_empty());
}

#[test]
fn firing_identity_is_stable_per_cause() {
    let wall = at("2026-09-27T10:00:00Z");
    let firing = EventFiring {
        workspace_id: WORKSPACE.into(),
        schedule_id: "rule".into(),
        trigger_revision: 0,
        cause: EventCause::RunFinished {
            source_run_id: "run-1".into(),
        },
        observed_at: wall,
        chain_depth: 1,
    };
    assert_eq!(firing.cause_key(), "run:run-1");
    let files = EventFiring {
        cause: EventCause::FilesChanged,
        ..firing
    };
    assert_eq!(
        files.cause_key(),
        format!("files:{}", wall.timestamp_millis())
    );
}

/// `contracts/fixtures/triggers-v7-2.json` is also decoded by the TypeScript
/// contract tests: both sides read and write exactly these shapes.
#[test]
fn golden_json_matches_the_typescript_contracts() {
    use crate::orchestration_api::{
        AutomationsStateRequest, AutomationsStateV7, OrchestrationAutomationsChangedEventV7,
        SetAutomationsPausedRequest, StartRunCommand, StartRunTrigger,
    };
    use crate::orchestration_schedule::ScheduleOccurrence;
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/triggers-v7-2.json"
    ))
    .expect("fixture JSON");
    let items = |key: &str| fixture[key].as_array().cloned().expect("fixture list");
    for schedule in items("schedules") {
        let decoded: ScheduleDefinition =
            serde_json::from_value(schedule.clone()).expect("schedule decodes");
        assert!(decoded.validate(), "{schedule}");
        assert_eq!(serde_json::to_value(&decoded).expect("encodes"), schedule);
    }
    for occurrence in items("occurrences") {
        let decoded: ScheduleOccurrence =
            serde_json::from_value(occurrence.clone()).expect("occurrence decodes");
        assert_eq!(serde_json::to_value(&decoded).expect("encodes"), occurrence);
    }
    for trigger in items("runTriggers") {
        let decoded: RunTrigger = serde_json::from_value(trigger.clone()).expect("trigger decodes");
        assert!(decoded.is_valid(), "{trigger}");
        assert_eq!(serde_json::to_value(&decoded).expect("encodes"), trigger);
    }
    let start: StartRunCommand =
        serde_json::from_value(fixture["startRun"].clone()).expect("start decodes");
    assert!(matches!(
        start.trigger,
        Some(StartRunTrigger::Chat { session_id: Some(ref id) }) if id == "chat-session-1"
    ));
    let mut claimed = fixture["startRun"].clone();
    claimed["trigger"] =
        json!({"kind": "schedule", "scheduleId": "s", "scheduleName": "S", "occurrenceId": "o"});
    assert!(serde_json::from_value::<StartRunCommand>(claimed).is_err());
    let mut without = fixture["startRun"].clone();
    if let Some(object) = without.as_object_mut() {
        object.remove("trigger");
    }
    assert!(
        serde_json::from_value::<StartRunCommand>(without)
            .expect("v6 start")
            .trigger
            .is_none()
    );
    // A chat start may also ask for pinned data (v6.4): both additive fields
    // travel in the same command.
    let mut pinned = fixture["startRun"].clone();
    pinned["usePinnedData"] = json!(true);
    let pinned: StartRunCommand = serde_json::from_value(pinned).expect("pinned start decodes");
    assert!(pinned.use_pinned_data && pinned.trigger.is_some());
    assert!(
        !serde_json::from_value::<StartRunCommand>(fixture["startRun"].clone())
            .expect("start decodes")
            .use_pinned_data
    );
    assert_eq!(
        serde_json::to_value(AutomationsStateV7 { paused: true }).expect("encodes"),
        fixture["automationsState"]
    );
    let set: SetAutomationsPausedRequest =
        serde_json::from_value(fixture["setAutomationsPaused"].clone()).expect("decodes");
    assert!(!set.paused);
    assert!(
        serde_json::from_value::<SetAutomationsPausedRequest>(json!({"paused": true, "all": true}))
            .is_err()
    );
    assert!(serde_json::from_value::<AutomationsStateRequest>(json!({})).is_ok());
    assert!(
        serde_json::from_value::<AutomationsStateRequest>(json!({"workspaceId": "w"})).is_err()
    );
    assert_eq!(
        serde_json::to_value(OrchestrationAutomationsChangedEventV7 {
            protocol: 7,
            event_type: "automationsChanged",
            paused: true,
        })
        .expect("encodes"),
        fixture["automationsEvent"]
    );
}
