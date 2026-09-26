//! Durable calendar and event triggers for orchestration launch commands.
//!
//! This module computes nominal occurrence times and validates event rules
//! only. Native execution still goes through the existing orchestration run
//! journal and runtime adapters.

use crate::automation_paths::{MAX_PATTERNS, parse_patterns};
use chrono::offset::LocalResult;
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntervalUnit {
    Minutes,
    Hours,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScheduleTrigger {
    Once {
        at: DateTime<Utc>,
        time_zone: String,
    },
    Interval {
        every: u64,
        unit: IntervalUnit,
        anchor_at: DateTime<Utc>,
        time_zone: String,
    },
    /// Wall-clock occurrences (v7.1): `time` (`HH:MM`) on the ISO weekdays in
    /// `days` (1 = Monday ... 7 = Sunday), in the IANA `time_zone`, never
    /// before `starts_at`. A local time skipped by a clock change runs at the
    /// first valid minute after the gap; a repeated local time runs once, first.
    Calendar {
        time: String,
        days: Vec<u8>,
        starts_at: DateTime<Utc>,
        time_zone: String,
    },
    /// Event rules (v7.2). They have no due time: the host fires them when
    /// it observes the event while it runs.
    Event { event: EventTrigger },
}

/// How a watched run ended (v7.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FinishedOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

/// Shortest and longest quiet period before a file-change automation fires.
pub(crate) const MIN_DEBOUNCE_SECONDS: u32 = 2;
pub(crate) const MAX_DEBOUNCE_SECONDS: u32 = 3_600;

/// What an event automation waits for (v7.2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EventTrigger {
    /// A run of `launch_command_id` ended with one of `outcomes`.
    RunFinished {
        launch_command_id: String,
        outcomes: Vec<FinishedOutcome>,
    },
    /// Files matching `include` and not `exclude` changed in the project
    /// folder, then stayed quiet for `debounce_seconds`.
    FilesChanged {
        include: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        exclude: Vec<String>,
        debounce_seconds: u32,
    },
}

impl EventTrigger {
    /// Structural checks; the source launch command is checked against the
    /// workspace on save.
    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::RunFinished {
                launch_command_id,
                outcomes,
            } => {
                let mut seen = outcomes.clone();
                seen.sort();
                seen.dedup();
                !launch_command_id.trim().is_empty()
                    && !outcomes.is_empty()
                    && seen.len() == outcomes.len()
            }
            Self::FilesChanged {
                include,
                exclude,
                debounce_seconds,
            } => {
                !include.is_empty()
                    && include.len() <= MAX_PATTERNS
                    && exclude.len() <= MAX_PATTERNS
                    && parse_patterns(include).is_ok()
                    && parse_patterns(exclude).is_ok()
                    && (MIN_DEBOUNCE_SECONDS..=MAX_DEBOUNCE_SECONDS).contains(debounce_seconds)
            }
        }
    }

    /// The launch command whose runs this rule watches.
    pub(crate) fn source_launch_command_id(&self) -> Option<&str> {
        match self {
            Self::RunFinished {
                launch_command_id, ..
            } => Some(launch_command_id),
            Self::FilesChanged { .. } => None,
        }
    }
}

/// Parsed calendar trigger: local time, weekday mask (Monday first) and zone.
struct CalendarRule {
    time: NaiveTime,
    days: [bool; 7],
    zone: Tz,
    starts_at: DateTime<Utc>,
}

/// Longest civil-time gap stepped over when a local time does not exist.
const MAX_GAP_MINUTES: i64 = 180;
/// Every selected weekday recurs within this many local days of any instant.
const SEARCH_DAYS: i64 = 9;

fn parse_local_time(value: &str) -> Option<NaiveTime> {
    let (hour, minute) = value.split_once(':')?;
    if hour.len() != 2
        || minute.len() != 2
        || !hour.bytes().all(|byte| byte.is_ascii_digit())
        || !minute.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    NaiveTime::from_hms_opt(hour.parse().ok()?, minute.parse().ok()?, 0)
}

impl CalendarRule {
    fn parse(time: &str, days: &[u8], starts_at: DateTime<Utc>, time_zone: &str) -> Option<Self> {
        let time = parse_local_time(time)?;
        let zone: Tz = time_zone.parse().ok()?;
        if days.is_empty() || days.len() > 7 {
            return None;
        }
        let mut mask = [false; 7];
        for day in days {
            let index = usize::from(day.checked_sub(1)?);
            if index >= 7 || mask[index] {
                return None;
            }
            mask[index] = true;
        }
        Some(Self {
            time,
            days: mask,
            zone,
            starts_at,
        })
    }

    fn runs_on(&self, date: NaiveDate) -> bool {
        usize::try_from(date.weekday().num_days_from_monday())
            .ok()
            .and_then(|index| self.days.get(index).copied())
            .unwrap_or(false)
    }

    /// The instant this rule fires on a local date, if it runs that day.
    fn occurrence_on(&self, date: NaiveDate) -> Option<DateTime<Utc>> {
        if !self.runs_on(date) {
            return None;
        }
        let local = date.and_time(self.time);
        let resolve = |result: LocalResult<DateTime<Tz>>| match result {
            LocalResult::Single(value) => Some(value.with_timezone(&Utc)),
            LocalResult::Ambiguous(earliest, _) => Some(earliest.with_timezone(&Utc)),
            LocalResult::None => None,
        };
        resolve(self.zone.from_local_datetime(&local)).or_else(|| {
            (1..=MAX_GAP_MINUTES).find_map(|minutes| {
                resolve(
                    self.zone
                        .from_local_datetime(&(local + Duration::minutes(minutes))),
                )
            })
        })
    }

    fn local_date(&self, instant: DateTime<Utc>) -> NaiveDate {
        instant.with_timezone(&self.zone).date_naive()
    }

    /// First occurrence strictly after `instant` and not before `starts_at`.
    fn first_after(&self, instant: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let floor = instant.max(self.starts_at - Duration::milliseconds(1));
        let start = self.local_date(floor) - Duration::days(1);
        (0..=SEARCH_DAYS)
            .filter_map(|offset| self.occurrence_on(start + Duration::days(offset)))
            .find(|candidate| *candidate > floor && *candidate >= self.starts_at)
    }

    /// Latest occurrence at or before `instant`, not before `starts_at`.
    fn latest_at_or_before(&self, instant: DateTime<Utc>) -> Option<DateTime<Utc>> {
        if instant < self.starts_at {
            return None;
        }
        let end = self.local_date(instant) + Duration::days(1);
        (0..=SEARCH_DAYS)
            .filter_map(|offset| self.occurrence_on(end - Duration::days(offset)))
            .find(|candidate| *candidate <= instant && *candidate >= self.starts_at)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissedRunPolicy {
    Skip,
    Coalesce,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverlapPolicy {
    Allow,
    Skip,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDefinition {
    pub id: String,
    pub name: String,
    pub launch_command_id: String,
    pub trigger: ScheduleTrigger,
    pub missed_run_policy: MissedRunPolicy,
    pub overlap_policy: OverlapPolicy,
    /// Input values for every run this schedule starts (additive). They are
    /// validated against the launch target's pipeline on save and enable.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub inputs: BTreeMap<String, serde_json::Value>,
}

impl ScheduleDefinition {
    pub(crate) fn validate(&self) -> bool {
        let timing = match &self.trigger {
            // Events are never "missed": nothing is replayed after a restart.
            ScheduleTrigger::Event { event } => {
                event.valid() && self.missed_run_policy == MissedRunPolicy::Skip
            }
            trigger => trigger
                .time_zone()
                .is_some_and(|zone| !zone.trim().is_empty()),
        };
        !self.id.trim().is_empty()
            && !self.name.trim().is_empty()
            && !self.launch_command_id.trim().is_empty()
            && timing
            && self.trigger.interval_duration().is_some()
            && self.trigger.calendar_valid()
    }

    /// Input values change what agents are asked to do, so they are part of
    /// the execution a schedule was enabled for.
    pub(crate) fn execution_equals(&self, other: &Self) -> bool {
        self.launch_command_id == other.launch_command_id
            && self.trigger == other.trigger
            && self.missed_run_policy == other.missed_run_policy
            && self.overlap_policy == other.overlap_policy
            && self.inputs == other.inputs
    }
}

impl ScheduleTrigger {
    /// The display zone of a timed rule; event rules have none.
    pub(crate) fn time_zone(&self) -> Option<&str> {
        match self {
            Self::Once { time_zone, .. }
            | Self::Interval { time_zone, .. }
            | Self::Calendar { time_zone, .. } => Some(time_zone),
            Self::Event { .. } => None,
        }
    }

    pub(crate) fn event(&self) -> Option<&EventTrigger> {
        match self {
            Self::Event { event } => Some(event),
            _ => None,
        }
    }

    fn calendar(&self) -> Option<CalendarRule> {
        match self {
            Self::Calendar {
                time,
                days,
                starts_at,
                time_zone,
            } => CalendarRule::parse(time, days, *starts_at, time_zone),
            _ => None,
        }
    }

    /// Calendar triggers need a strict `HH:MM`, 1-7 unique ISO weekdays and
    /// a known IANA zone; the other triggers have nothing to check here.
    pub(crate) fn calendar_valid(&self) -> bool {
        !matches!(self, Self::Calendar { .. }) || self.calendar().is_some()
    }

    /// The first due time of a timed rule; event rules are never due.
    pub(crate) fn initial_due(&self) -> Option<DateTime<Utc>> {
        match self {
            Self::Once { at, .. } => Some(*at),
            Self::Interval { anchor_at, .. } => Some(*anchor_at),
            Self::Calendar { starts_at, .. } => Some(
                self.calendar()
                    .and_then(|rule| rule.first_after(*starts_at - Duration::milliseconds(1)))
                    .unwrap_or(*starts_at),
            ),
            Self::Event { .. } => None,
        }
    }

    pub(crate) fn interval_duration(&self) -> Option<Duration> {
        let Self::Interval { every, unit, .. } = self else {
            return Some(Duration::zero());
        };
        let every = i64::try_from(*every).ok().filter(|value| *value > 0)?;
        let seconds = every.checked_mul(match unit {
            IntervalUnit::Minutes => 60,
            IntervalUnit::Hours => 3_600,
        })?;
        Duration::try_seconds(seconds)
    }

    /// Latest nominal occurrence at or before `instant`.
    pub(crate) fn latest_at_or_before(&self, instant: DateTime<Utc>) -> Option<DateTime<Utc>> {
        if let Self::Calendar { .. } = self {
            return self.calendar()?.latest_at_or_before(instant);
        }
        let Self::Interval { anchor_at, .. } = self else {
            return self.initial_due().filter(|due| *due <= instant);
        };
        if *anchor_at > instant {
            return None;
        }
        let duration_ms = self.interval_duration()?.num_milliseconds();
        let elapsed_ms = instant
            .timestamp_millis()
            .checked_sub(anchor_at.timestamp_millis())?;
        let steps = elapsed_ms.checked_div(duration_ms)?;
        add_milliseconds(*anchor_at, duration_ms.checked_mul(steps)?)
    }

    /// First nominal occurrence strictly after `instant`.
    pub(crate) fn first_after(&self, instant: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Self::Once { .. } | Self::Event { .. } => None,
            Self::Calendar { .. } => self.calendar()?.first_after(instant),
            Self::Interval { anchor_at, .. } if *anchor_at > instant => Some(*anchor_at),
            Self::Interval { anchor_at, .. } => {
                let duration_ms = self.interval_duration()?.num_milliseconds();
                let elapsed_ms = instant
                    .timestamp_millis()
                    .checked_sub(anchor_at.timestamp_millis())?;
                let steps = elapsed_ms.checked_div(duration_ms)?.checked_add(1)?;
                add_milliseconds(*anchor_at, duration_ms.checked_mul(steps)?)
            }
        }
    }
}

fn add_milliseconds(value: DateTime<Utc>, milliseconds: i64) -> Option<DateTime<Utc>> {
    value.checked_add_signed(Duration::milliseconds(milliseconds))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleOccurrenceOutcome {
    Started,
    SkippedMissed,
    SkippedOverlap,
    Failed,
    /// v7.2: the run would exceed the event chain depth limit.
    SkippedChainLimit,
    /// v7.2: this automation started a run less than the cooldown ago.
    SkippedCooldown,
    /// v7.2: all automations were paused.
    SkippedPaused,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleOccurrence {
    pub id: String,
    pub nominal_at: DateTime<Utc>,
    pub recorded_at: DateTime<Utc>,
    pub outcome: ScheduleOccurrenceOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    /// v7.2: the finished run a "pipeline finished" rule reacted to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_run_id: Option<String>,
    /// v7.2: event hops the started (or refused) run would have.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_depth: Option<u8>,
}

/// Recorded outcomes kept per automation. Older entries are dropped first,
/// but never one whose run is still active (overlap checks read them).
pub(crate) const MAX_STORED_OCCURRENCES: usize = 200;

/// Appends `occurrence` and trims the history to its bound.
pub(crate) fn push_occurrence(
    occurrences: &mut Vec<ScheduleOccurrence>,
    occurrence: ScheduleOccurrence,
    run_active: impl Fn(&str) -> bool,
) {
    occurrences.push(occurrence);
    while occurrences.len() > MAX_STORED_OCCURRENCES {
        let Some(index) = occurrences
            .iter()
            .position(|item| item.run_id.as_deref().is_none_or(|run| !run_active(run)))
        else {
            break;
        };
        occurrences.remove(index);
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSchedule {
    pub revision: u64,
    pub trigger_revision: u64,
    pub value: ScheduleDefinition,
    pub enabled: bool,
    #[serde(default)]
    pub enabled_launch_command_revision: Option<u64>,
    pub next_due_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub occurrences: Vec<ScheduleOccurrence>,
}

impl StoredSchedule {
    pub(crate) fn snapshot(&self) -> ScheduleSnapshot {
        ScheduleSnapshot {
            revision: self.revision,
            trigger_revision: self.trigger_revision,
            value: self.value.clone(),
            enabled: self.enabled,
            next_due_at: self.next_due_at,
            last_occurrence: self.occurrences.last().cloned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleSnapshot {
    pub revision: u64,
    pub trigger_revision: u64,
    pub value: ScheduleDefinition,
    pub enabled: bool,
    pub next_due_at: Option<DateTime<Utc>>,
    pub last_occurrence: Option<ScheduleOccurrence>,
}

pub(crate) fn occurrence_id(
    schedule_id: &str,
    trigger_revision: u64,
    nominal_at: DateTime<Utc>,
) -> String {
    let mut hash = Sha256::new();
    hash.update(schedule_id.as_bytes());
    hash.update([0]);
    hash.update(trigger_revision.to_be_bytes());
    hash.update([0]);
    hash.update(nominal_at.timestamp_millis().to_be_bytes());
    hex_identity("schedule-", hash)
}

/// Deterministic identity of one event firing (v7.2): the same finished run
/// or the same file burst always yields the same occurrence and run id, so
/// a repeated observation cannot start a second run.
pub(crate) fn event_occurrence_id(schedule_id: &str, trigger_revision: u64, cause: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(schedule_id.as_bytes());
    hash.update([0]);
    hash.update(trigger_revision.to_be_bytes());
    hash.update([0]);
    hash.update(cause.as_bytes());
    hex_identity("event-", hash)
}

fn hex_identity(prefix: &str, hash: Sha256) -> String {
    let digest = hash.finalize();
    let mut result = String::with_capacity(prefix.len() + digest.len() * 2);
    result.push_str(prefix);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(value: &str) -> DateTime<Utc> {
        value.parse().expect("valid fixture instant")
    }

    fn calendar(time: &str, days: &[u8], starts_at: &str, zone: &str) -> ScheduleTrigger {
        ScheduleTrigger::Calendar {
            time: time.into(),
            days: days.to_vec(),
            starts_at: at(starts_at),
            time_zone: zone.into(),
        }
    }

    #[test]
    fn calendar_runs_at_local_wall_time_on_selected_weekdays() {
        // 2026-09-25 is a Friday; weekdays at 09:00 in Moscow (UTC+3).
        let trigger = calendar(
            "09:00",
            &[1, 2, 3, 4, 5],
            "2026-09-25T10:00:00Z",
            "Europe/Moscow",
        );
        assert!(trigger.calendar_valid());
        // Friday 09:00 MSK is 06:00Z, before the start, so Monday comes next.
        assert_eq!(trigger.initial_due(), Some(at("2026-09-28T06:00:00Z")));
        assert_eq!(
            trigger.first_after(at("2026-09-28T06:00:00Z")),
            Some(at("2026-09-29T06:00:00Z"))
        );
        assert_eq!(
            trigger.latest_at_or_before(at("2026-10-03T12:00:00Z")),
            Some(at("2026-10-02T06:00:00Z"))
        );
        assert_eq!(
            trigger.latest_at_or_before(at("2026-09-25T12:00:00Z")),
            None
        );
    }

    #[test]
    fn calendar_follows_daylight_saving_changes() {
        // Berlin leaves summer time on 2026-10-25: 08:00 local moves from 06:00Z to 07:00Z.
        let trigger = calendar(
            "08:00",
            &[1, 2, 3, 4, 5, 6, 7],
            "2026-10-23T00:00:00Z",
            "Europe/Berlin",
        );
        assert_eq!(
            trigger.first_after(at("2026-10-24T12:00:00Z")),
            Some(at("2026-10-25T07:00:00Z"))
        );
        assert_eq!(
            trigger.first_after(at("2026-10-23T12:00:00Z")),
            Some(at("2026-10-24T06:00:00Z"))
        );
        // 02:30 does not exist on 2026-03-29 in Berlin: it runs at 03:00 local (01:00Z).
        let gap = calendar("02:30", &[7], "2026-03-01T00:00:00Z", "Europe/Berlin");
        assert_eq!(
            gap.first_after(at("2026-03-28T00:00:00Z")),
            Some(at("2026-03-29T01:00:00Z"))
        );
        // 02:30 occurs twice on 2026-10-25: the first occurrence (CEST, 00:30Z) wins.
        let repeated = calendar("02:30", &[7], "2026-10-01T00:00:00Z", "Europe/Berlin");
        assert_eq!(
            repeated.first_after(at("2026-10-24T00:00:00Z")),
            Some(at("2026-10-25T00:30:00Z"))
        );
    }

    #[test]
    fn calendar_rejects_malformed_rules() {
        for trigger in [
            calendar("9:00", &[1], "2026-09-25T00:00:00Z", "UTC"),
            calendar("24:00", &[1], "2026-09-25T00:00:00Z", "UTC"),
            calendar("09:60", &[1], "2026-09-25T00:00:00Z", "UTC"),
            calendar("09:00", &[], "2026-09-25T00:00:00Z", "UTC"),
            calendar("09:00", &[0], "2026-09-25T00:00:00Z", "UTC"),
            calendar("09:00", &[8], "2026-09-25T00:00:00Z", "UTC"),
            calendar("09:00", &[1, 1], "2026-09-25T00:00:00Z", "UTC"),
            calendar("09:00", &[1], "2026-09-25T00:00:00Z", "Mars/Olympus"),
        ] {
            assert!(!trigger.calendar_valid(), "{trigger:?}");
        }
    }

    #[test]
    fn calendar_trigger_round_trips_in_camel_case() {
        let trigger = calendar("07:30", &[6, 7], "2026-09-25T00:00:00Z", "Asia/Bangkok");
        let json = serde_json::to_value(&trigger).expect("serializes");
        assert_eq!(
            json,
            serde_json::json!({"type": "calendar", "time": "07:30", "days": [6, 7], "startsAt": "2026-09-25T00:00:00Z", "timeZone": "Asia/Bangkok"})
        );
        assert_eq!(
            serde_json::from_value::<ScheduleTrigger>(json).expect("parses"),
            trigger
        );
    }

    #[test]
    fn fixed_rate_interval_does_not_drift() {
        let trigger = ScheduleTrigger::Interval {
            every: 15,
            unit: IntervalUnit::Minutes,
            anchor_at: at("2026-09-09T10:00:00Z"),
            time_zone: "Asia/Bangkok".into(),
        };
        assert_eq!(
            trigger.latest_at_or_before(at("2026-09-09T10:46:00Z")),
            Some(at("2026-09-09T10:45:00Z"))
        );
        assert_eq!(
            trigger.first_after(at("2026-09-09T10:46:00Z")),
            Some(at("2026-09-09T11:00:00Z"))
        );
    }

    #[test]
    fn occurrence_identity_is_stable_but_trigger_revision_is_distinct() {
        let nominal = at("2026-09-09T10:00:00Z");
        assert_eq!(
            occurrence_id("daily", 3, nominal),
            occurrence_id("daily", 3, nominal)
        );
        assert_ne!(
            occurrence_id("daily", 3, nominal),
            occurrence_id("daily", 4, nominal)
        );
    }

    #[test]
    fn zero_and_unrepresentable_intervals_are_invalid() {
        for every in [0, u64::MAX] {
            let schedule = ScheduleDefinition {
                id: "schedule".into(),
                name: "Schedule".into(),
                launch_command_id: "launch".into(),
                trigger: ScheduleTrigger::Interval {
                    every,
                    unit: IntervalUnit::Hours,
                    anchor_at: at("2026-09-09T10:00:00Z"),
                    time_zone: "UTC".into(),
                },
                missed_run_policy: MissedRunPolicy::Skip,
                overlap_policy: OverlapPolicy::Skip,
                inputs: BTreeMap::new(),
            };
            assert!(!schedule.validate());
        }
    }

    #[test]
    fn stored_schedules_without_inputs_keep_their_shape_and_inputs_round_trip() {
        let stored = serde_json::json!({
            "id": "nightly", "name": "Nightly", "launchCommandId": "launch",
            "trigger": {"type": "once", "at": "2026-09-09T10:00:00Z", "timeZone": "UTC"},
            "missedRunPolicy": "skip", "overlapPolicy": "allow"
        });
        let old: ScheduleDefinition = serde_json::from_value(stored.clone()).expect("old shape");
        assert!(old.inputs.is_empty());
        assert_eq!(serde_json::to_value(&old).expect("serializes"), stored);

        let mut with_inputs = stored;
        with_inputs["inputs"] = serde_json::json!({"task": "Review", "urgent": true});
        let current: ScheduleDefinition =
            serde_json::from_value(with_inputs.clone()).expect("inputs");
        assert_eq!(current.inputs.len(), 2);
        assert_eq!(
            serde_json::to_value(&current).expect("serializes"),
            with_inputs
        );
        assert!(!old.execution_equals(&current));
        let mut unknown = with_inputs;
        unknown["inputValues"] = serde_json::json!({});
        assert!(serde_json::from_value::<ScheduleDefinition>(unknown).is_err());
    }

    fn event_schedule(event: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": "after-build", "name": "After build", "launchCommandId": "deploy",
            "trigger": {"type": "event", "event": event},
            "missedRunPolicy": "skip", "overlapPolicy": "skip"
        })
    }

    #[test]
    fn event_triggers_round_trip_in_their_contract_shape() {
        for event in [
            serde_json::json!({"kind": "run-finished", "launchCommandId": "build", "outcomes": ["succeeded", "failed"]}),
            serde_json::json!({"kind": "files-changed", "include": ["src/**/*.ts", "*.md"], "debounceSeconds": 10}),
            serde_json::json!({"kind": "files-changed", "include": ["docs/"], "exclude": ["docs/draft/**"], "debounceSeconds": 3600}),
        ] {
            let stored = event_schedule(event);
            let schedule: ScheduleDefinition =
                serde_json::from_value(stored.clone()).expect("event schedule");
            assert!(schedule.validate(), "{stored}");
            assert_eq!(serde_json::to_value(&schedule).expect("serializes"), stored);
            assert_eq!(schedule.trigger.initial_due(), None);
            assert_eq!(schedule.trigger.time_zone(), None);
            assert_eq!(
                schedule.trigger.first_after(at("2026-09-09T10:00:00Z")),
                None
            );
            assert_eq!(
                schedule
                    .trigger
                    .latest_at_or_before(at("2026-09-09T10:00:00Z")),
                None
            );
        }
        // Unknown fields and kinds stay closed.
        for event in [
            serde_json::json!({"kind": "run-finished", "launchCommandId": "build", "outcomes": ["succeeded"], "extra": 1}),
            serde_json::json!({"kind": "clock-ticked"}),
            serde_json::json!({"kind": "run-finished", "launchCommandId": "build", "outcomes": ["uncertain"]}),
        ] {
            assert!(serde_json::from_value::<ScheduleDefinition>(event_schedule(event)).is_err());
        }
    }

    #[test]
    fn event_triggers_refuse_empty_duplicate_or_unbounded_rules() {
        let parse = |event: serde_json::Value| -> ScheduleDefinition {
            serde_json::from_value(event_schedule(event)).expect("decodes")
        };
        for event in [
            serde_json::json!({"kind": "run-finished", "launchCommandId": " ", "outcomes": ["failed"]}),
            serde_json::json!({"kind": "run-finished", "launchCommandId": "build", "outcomes": []}),
            serde_json::json!({"kind": "run-finished", "launchCommandId": "build", "outcomes": ["failed", "failed"]}),
            serde_json::json!({"kind": "files-changed", "include": [], "debounceSeconds": 10}),
            serde_json::json!({"kind": "files-changed", "include": ["../secrets/*"], "debounceSeconds": 10}),
            serde_json::json!({"kind": "files-changed", "include": ["src/*"], "exclude": ["C:/x"], "debounceSeconds": 10}),
            serde_json::json!({"kind": "files-changed", "include": ["src/*"], "debounceSeconds": 1}),
            serde_json::json!({"kind": "files-changed", "include": ["src/*"], "debounceSeconds": 3601}),
        ] {
            assert!(!parse(event.clone()).validate(), "{event}");
        }
        let too_many: Vec<String> = (0..=MAX_PATTERNS)
            .map(|index| format!("a{index}/*"))
            .collect();
        assert!(
            !parse(serde_json::json!({"kind": "files-changed", "include": too_many, "debounceSeconds": 10}))
                .validate()
        );
        // Nothing is replayed for events, so "run once when PiUI opens" is refused.
        let mut coalesce = parse(
            serde_json::json!({"kind": "files-changed", "include": ["src/*"], "debounceSeconds": 10}),
        );
        assert!(coalesce.validate());
        coalesce.missed_run_policy = MissedRunPolicy::Coalesce;
        assert!(!coalesce.validate());
    }

    #[test]
    fn older_occurrences_decode_and_new_fields_stay_optional() {
        let old = serde_json::json!({
            "id": "schedule-1", "nominalAt": "2026-09-09T10:00:00Z", "recordedAt": "2026-09-09T10:00:01Z",
            "outcome": "skippedOverlap"
        });
        let decoded: ScheduleOccurrence = serde_json::from_value(old.clone()).expect("old shape");
        assert_eq!(decoded.source_run_id, None);
        assert_eq!(serde_json::to_value(&decoded).expect("serializes"), old);
        let mut chained = old;
        chained["outcome"] = serde_json::json!("skippedChainLimit");
        chained["sourceRunId"] = serde_json::json!("build-run");
        chained["chainDepth"] = serde_json::json!(4);
        let decoded: ScheduleOccurrence =
            serde_json::from_value(chained.clone()).expect("event shape");
        assert_eq!(
            decoded.outcome,
            ScheduleOccurrenceOutcome::SkippedChainLimit
        );
        assert_eq!(serde_json::to_value(&decoded).expect("serializes"), chained);
    }

    #[test]
    fn occurrence_history_is_bounded_but_keeps_active_runs() {
        let occurrence = |index: usize, run: Option<&str>| ScheduleOccurrence {
            id: format!("occurrence-{index}"),
            nominal_at: at("2026-09-09T10:00:00Z"),
            recorded_at: at("2026-09-09T10:00:00Z"),
            outcome: ScheduleOccurrenceOutcome::Started,
            run_id: run.map(str::to_owned),
            failure_code: None,
            source_run_id: None,
            chain_depth: None,
        };
        let mut history = vec![occurrence(0, Some("active-run"))];
        for index in 1..=MAX_STORED_OCCURRENCES + 5 {
            push_occurrence(&mut history, occurrence(index, Some("done")), |run| {
                run == "active-run"
            });
        }
        assert_eq!(history.len(), MAX_STORED_OCCURRENCES);
        assert_eq!(history[0].id, "occurrence-0");
        assert_eq!(
            history.last().map(|item| item.id.as_str()),
            Some(format!("occurrence-{}", MAX_STORED_OCCURRENCES + 5).as_str())
        );
    }

    #[test]
    fn event_occurrence_identity_depends_on_cause_and_revision() {
        assert_eq!(
            event_occurrence_id("after-build", 1, "run:build-1"),
            event_occurrence_id("after-build", 1, "run:build-1")
        );
        assert_ne!(
            event_occurrence_id("after-build", 1, "run:build-1"),
            event_occurrence_id("after-build", 1, "run:build-2")
        );
        assert_ne!(
            event_occurrence_id("after-build", 1, "run:build-1"),
            event_occurrence_id("after-build", 2, "run:build-1")
        );
        assert!(event_occurrence_id("a", 0, "files:1").starts_with("event-"));
    }
}
