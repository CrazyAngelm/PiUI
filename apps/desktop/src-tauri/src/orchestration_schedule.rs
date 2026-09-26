//! Durable calendar triggers for orchestration launch commands.
//!
//! This module computes nominal occurrence times only. Native execution still
//! goes through the existing orchestration run journal and runtime adapters.

use chrono::{DateTime, Duration, Utc};
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
        !self.id.trim().is_empty()
            && !self.name.trim().is_empty()
            && !self.launch_command_id.trim().is_empty()
            && !self.trigger.time_zone().trim().is_empty()
            && self.trigger.interval_duration().is_some()
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
    pub(crate) fn time_zone(&self) -> &str {
        match self {
            Self::Once { time_zone, .. } | Self::Interval { time_zone, .. } => time_zone,
        }
    }

    pub(crate) fn initial_due(&self) -> DateTime<Utc> {
        match self {
            Self::Once { at, .. } => *at,
            Self::Interval { anchor_at, .. } => *anchor_at,
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

    /// Latest fixed-rate nominal occurrence at or before `instant`.
    pub(crate) fn latest_at_or_before(&self, instant: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let Self::Interval { anchor_at, .. } = self else {
            return (self.initial_due() <= instant).then_some(self.initial_due());
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

    /// First fixed-rate nominal occurrence strictly after `instant`.
    pub(crate) fn first_after(&self, instant: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Self::Once { .. } => None,
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
    let digest = hash.finalize();
    let mut result = String::with_capacity(9 + digest.len() * 2);
    result.push_str("schedule-");
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
}
