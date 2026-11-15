use std::cell::RefCell;
use std::process::{Command, Stdio};
use std::rc::Rc;

use super::*;
use crate::policy::authorized_for_tests;

const GRANT: &str = "hgr_AAECAwQFBgcICQoLDA0ODw";
const OTHER_GRANT: &str = "hgr_EBESExQVFhcYGRobHB0eHw";
const COMMAND: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MARKER: &[u8] = b"PLAINTEXT-MARKER-7f3a9c";
/// The child process of the crash test reads its journal root here.
const CRASH_DIR_ENV: &str = "PIUI_REMOTE_HOST_JOURNAL_CRASH_DIR";
const CRASH_EXIT: i32 = 86;

fn grant() -> GrantId {
    GrantId::parse(GRANT).expect("grant")
}

fn command() -> CommandId {
    CommandId::parse(COMMAND).expect("command")
}

fn authorized() -> AuthorizedController {
    authorized_for_tests(grant())
}

/// The journal of [`GRANT`] in the journal root `root`.
fn open(root: &Path) -> Result<CommandJournal, JournalError> {
    CommandJournal::open(root, grant())
}

/// The directory of [`GRANT`]'s entries in the journal root `root`.
fn grant_dir(root: &Path) -> PathBuf {
    root.join(GRANT)
}

fn body(text: &[u8]) -> Vec<u8> {
    let mut bytes = br#"{"text":""#.to_vec();
    bytes.extend_from_slice(text);
    bytes.extend_from_slice(br#""}"#);
    bytes
}

fn request(canonical: &[u8]) -> CommandRequest<'_> {
    CommandRequest {
        command_id: command(),
        kind: CommandKind::ComposerSend,
        canonical,
    }
}

fn execute(journal: &CommandJournal, canonical: &[u8]) -> IntentGuard {
    match journal
        .begin(authorized(), request(canonical))
        .expect("begin")
    {
        Admission::Execute(guard) => guard,
        other => panic!("expected execution, got {other:?}"),
    }
}

#[test]
fn a_new_command_is_recorded_before_its_effect_and_settled_once() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    let bytes = body(b"hello");
    let guard = execute(&journal, &bytes);
    assert!(
        grant_dir(root.path())
            .join(format!("{COMMAND}{INTENT_SUFFIX}"))
            .is_file(),
        "the intent exists before the effect"
    );
    assert_eq!(guard.entry().seq, 1);
    assert_eq!(
        guard.entry().derived_id,
        Some(derive_id(DerivedDomain::Composer, &grant(), &command()))
    );
    assert!(matches!(
        journal.begin(authorized(), request(&bytes)),
        Ok(Admission::InProgress)
    ));
    assert!(matches!(
        journal.begin(authorized(), request(&body(b"other"))),
        Ok(Admission::Conflict)
    ));
    guard
        .settle(CommandOutcome::Applied { revision: Some(3) })
        .expect("settle");
    assert!(matches!(
        journal.begin(authorized(), request(&bytes)),
        Ok(Admission::Settled(CommandOutcome::Applied {
            revision: Some(3)
        }))
    ));
    let other_kind = CommandRequest {
        kind: CommandKind::Interrupt,
        ..request(&bytes)
    };
    assert!(matches!(
        journal.begin(authorized(), other_kind),
        Ok(Admission::Conflict)
    ));
    assert_eq!(
        journal.settle_unresolved(&command(), CommandOutcome::CancelledByRevocation),
        Err(JournalError::AlreadySettled)
    );
}

#[test]
fn the_journal_admits_only_its_own_grant() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    let other = authorized_for_tests(GrantId::parse(OTHER_GRANT).expect("grant"));
    assert!(matches!(
        journal.begin(other, request(b"{}")),
        Err(JournalError::WrongGrant)
    ));
    assert_eq!(journal.list().expect("list"), Listing::default());
}

#[test]
fn the_digest_binds_grant_kind_identifier_and_bytes() {
    let bytes = body(b"x");
    let base = binding_digest(&grant(), &request(&bytes));
    let other_grant = GrantId::parse(OTHER_GRANT).expect("grant");
    assert_ne!(base, binding_digest(&other_grant, &request(&bytes)));
    let other_kind = CommandRequest {
        kind: CommandKind::Respond,
        ..request(&bytes)
    };
    assert_ne!(base, binding_digest(&grant(), &other_kind));
    let other_id = CommandRequest {
        command_id: CommandId::generate(),
        ..request(&bytes)
    };
    assert_ne!(base, binding_digest(&grant(), &other_id));
    assert_ne!(base, binding_digest(&grant(), &request(&body(b"y"))));
}

#[test]
fn no_command_text_is_stored() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    let bytes = body(MARKER);
    execute(&journal, &bytes)
        .settle(CommandOutcome::NotApplied {
            reason: NotAppliedReason::OwnerRefused,
        })
        .expect("settle");
    // Closed first: Windows refuses reads of the locked lock file.
    drop(journal);
    let mut files = Vec::new();
    for entry in fs::read_dir(root.path()).expect("read root") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            for entry in fs::read_dir(&path).expect("read dir") {
                files.push(entry.expect("entry").path());
            }
        } else {
            files.push(path);
        }
    }
    assert_eq!(files.len(), 3, "the lock file, an intent and a settlement");
    let encoded_marker = b64::encode(MARKER);
    for path in files {
        let contents = fs::read(&path).expect("read");
        assert!(
            !contents
                .windows(MARKER.len())
                .any(|window| window == MARKER)
        );
        assert!(
            !contents
                .windows(encoded_marker.len())
                .any(|window| window == encoded_marker.as_bytes())
        );
    }
}

#[test]
fn a_second_holder_is_refused_while_the_journal_is_open() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    assert!(matches!(open(root.path()), Err(JournalError::Locked)));
    drop(journal);
    assert!(open(root.path()).is_ok());
}

#[test]
fn a_dropped_guard_leaves_the_command_unresolved() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    let bytes = body(b"hello");
    drop(execute(&journal, &bytes));
    assert!(matches!(
        journal.begin(authorized(), request(&bytes)),
        Ok(Admission::Unresolved)
    ));
    let listing = journal.list().expect("list");
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].status, EntryStatus::Unresolved);
}

/// Runs only inside the child process of the crash test: it records an
/// intent and ends the process without settling or unwinding.
#[test]
fn crash_child() {
    let Some(root) = std::env::var_os(CRASH_DIR_ENV) else {
        return;
    };
    let journal = open(Path::new(&root)).expect("open");
    let guard = execute(&journal, &body(b"hello"));
    std::mem::forget(guard);
    std::process::exit(CRASH_EXIT);
}

#[test]
fn an_intent_interrupted_by_a_crash_is_never_replayed() {
    let root = tempfile::tempdir().expect("dir");
    let status = Command::new(std::env::current_exe().expect("test binary"))
        .args([
            "journal::tests::crash_child",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CRASH_DIR_ENV, root.path())
        .stdout(Stdio::null())
        .status()
        .expect("child");
    assert_eq!(
        status.code(),
        Some(CRASH_EXIT),
        "the child ends after the intent"
    );

    let journal = open(root.path()).expect("the lock died with the child");
    let bytes = body(b"hello");
    assert!(matches!(
        journal.begin(authorized(), request(&bytes)),
        Ok(Admission::Unresolved)
    ));
    assert!(matches!(
        journal.begin(authorized(), request(&body(b"other"))),
        Ok(Admission::Conflict)
    ));
    let listing = journal.list().expect("list");
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].status, EntryStatus::Unresolved);
    let outcome = CommandOutcome::OutcomeUnknown {
        reason: UnknownReason::HostRestarted,
    };
    journal
        .settle_unresolved(&command(), outcome)
        .expect("reconcile");
    assert!(matches!(
        journal.begin(authorized(), request(&bytes)),
        Ok(Admission::Settled(recorded)) if recorded == outcome
    ));

    // Admission numbers continue after the recorded ones.
    let next = CommandRequest {
        command_id: CommandId::generate(),
        ..request(&bytes)
    };
    let Ok(Admission::Execute(guard)) = journal.begin(authorized(), next) else {
        panic!("a new command executes");
    };
    assert_eq!(guard.entry().seq, 2);
}

#[test]
fn unreadable_entries_stay_unresolved() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    let bytes = body(b"hello");
    execute(&journal, &bytes)
        .settle(CommandOutcome::Applied { revision: None })
        .expect("settle");

    // A settlement cut short by a crash: unresolved, and replaceable.
    let settled = grant_dir(root.path()).join(format!("{COMMAND}{SETTLED_SUFFIX}"));
    let complete = fs::read(&settled).expect("settled");
    fs::write(&settled, &complete[..complete.len() / 2]).expect("truncate");
    assert!(matches!(
        journal.begin(authorized(), request(&bytes)),
        Ok(Admission::Unresolved)
    ));
    journal
        .settle_unresolved(&command(), CommandOutcome::Applied { revision: None })
        .expect("reconcile");
    assert!(matches!(
        journal.begin(authorized(), request(&bytes)),
        Ok(Admission::Settled(CommandOutcome::Applied {
            revision: None
        }))
    ));

    // An intent cut short: unresolved for good, listed as unreadable.
    let intent = grant_dir(root.path()).join(format!("{COMMAND}{INTENT_SUFFIX}"));
    let complete = fs::read(&intent).expect("intent");
    fs::write(&intent, &complete[..complete.len() - 2]).expect("truncate");
    assert!(matches!(
        journal.begin(authorized(), request(&bytes)),
        Ok(Admission::Unresolved)
    ));
    assert_eq!(journal.list().expect("list").unreadable, vec![command()]);
    assert_eq!(
        journal.settle_unresolved(&command(), CommandOutcome::CancelledByRevocation),
        Err(JournalError::Unreadable)
    );

    // A record moved from another grant's journal does not count.
    let other_root = tempfile::tempdir().expect("dir");
    let other_grant = GrantId::parse(OTHER_GRANT).expect("grant");
    let other = CommandJournal::open(other_root.path(), other_grant.clone()).expect("open");
    fs::write(
        other_root
            .path()
            .join(OTHER_GRANT)
            .join(format!("{COMMAND}{INTENT_SUFFIX}")),
        &complete,
    )
    .expect("copy");
    assert!(matches!(
        other.begin(authorized_for_tests(other_grant), request(&bytes)),
        Ok(Admission::Unresolved)
    ));
}

#[test]
fn outcomes_have_a_closed_wire_form() {
    let cases = [
        (
            CommandOutcome::Applied { revision: None },
            r#"{"type":"applied"}"#,
        ),
        (
            CommandOutcome::Applied { revision: Some(7) },
            r#"{"type":"applied","revision":7}"#,
        ),
        (
            CommandOutcome::NotApplied {
                reason: NotAppliedReason::AbsentAfterRestart,
            },
            r#"{"type":"not-applied","reason":"absent-after-restart"}"#,
        ),
        (
            CommandOutcome::OutcomeUnknown {
                reason: UnknownReason::DeliveryUncertain,
            },
            r#"{"type":"outcome-unknown","reason":"delivery-uncertain"}"#,
        ),
        (
            CommandOutcome::CancelledByRevocation,
            r#"{"type":"cancelled-by-revocation"}"#,
        ),
    ];
    for (outcome, text) in cases {
        assert_eq!(serde_json::to_string(&outcome).expect("json"), text);
        assert_eq!(
            serde_json::from_str::<CommandOutcome>(text).expect("parse"),
            outcome
        );
    }
    assert!(serde_json::from_str::<CommandOutcome>(r#"{"type":"applied","extra":1}"#).is_err());
    assert!(serde_json::from_str::<CommandOutcome>(r#"{"type":"refused"}"#).is_err());
}

#[test]
fn destroy_removes_the_journal_with_its_grant() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    let bytes = body(b"hello");
    let guard = execute(&journal, &bytes);
    guard
        .settle(CommandOutcome::Applied { revision: None })
        .expect("settle");
    let running = CommandRequest {
        command_id: CommandId::generate(),
        ..request(&bytes)
    };
    let Ok(Admission::Execute(guard)) = journal.begin(authorized(), running) else {
        panic!("execute");
    };
    let failed = journal.destroy().expect_err("a command is running");
    assert_eq!(failed.error, JournalError::Busy);
    let journal = failed.journal;
    assert!(matches!(open(root.path()), Err(JournalError::Locked)));
    drop(guard);
    journal.destroy().expect("destroy");
    assert!(!grant_dir(root.path()).exists());
    // Only the empty lock file stays, so that every later holder locks it.
    let lock = root.path().join(format!("{GRANT}{LOCK_SUFFIX}"));
    assert_eq!(fs::metadata(&lock).expect("the lock file stays").len(), 0);
    assert_eq!(fs::read_dir(root.path()).expect("root").count(), 1);
}

#[test]
fn a_failed_destroy_keeps_the_journal_locked_and_can_continue() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    execute(&journal, &body(b"hello"))
        .settle(CommandOutcome::Applied { revision: None })
        .expect("settle");
    // A file that is not the journal's own is never removed by it.
    let foreign = grant_dir(root.path()).join("foreign.txt");
    fs::write(&foreign, b"not a journal file").expect("foreign");
    let failed = journal.destroy().expect_err("the directory is not empty");
    assert!(matches!(failed.error, JournalError::Io(_)));
    assert!(foreign.is_file());
    assert!(matches!(open(root.path()), Err(JournalError::Locked)));
    fs::remove_file(&foreign).expect("remove");
    failed.journal.destroy().expect("destroy");
    assert!(!grant_dir(root.path()).exists());
}

#[test]
fn an_outstanding_guard_keeps_the_journal_locked() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    let bytes = body(b"hello");
    let guard = execute(&journal, &bytes);
    // The effect is still running when its journal handle goes away.
    drop(journal);
    assert!(
        matches!(open(root.path()), Err(JournalError::Locked)),
        "a second holder could reconcile or delete the running command"
    );
    guard
        .settle(CommandOutcome::Applied { revision: None })
        .expect("the running command settles");
    let reopened = open(root.path()).expect("the last guard released the lock");
    assert!(matches!(
        reopened.begin(authorized(), request(&bytes)),
        Ok(Admission::Settled(CommandOutcome::Applied {
            revision: None
        }))
    ));
}

#[test]
fn every_holder_after_a_destroy_locks_the_same_file() {
    let root = tempfile::tempdir().expect("dir");
    let journal = open(root.path()).expect("open");
    execute(&journal, &body(b"hello"))
        .settle(CommandOutcome::Applied { revision: None })
        .expect("settle");
    // A second opener runs at the earliest moment it can: right after
    // destroy gave up the lock, before destroy returns.
    let second = Rc::new(RefCell::new(None));
    let slot = Rc::clone(&second);
    let path = root.path().to_path_buf();
    AFTER_DESTROY_RELEASE.with(|step| {
        *step.borrow_mut() = Some(Box::new(move || *slot.borrow_mut() = Some(open(&path))));
    });
    let destroyed = journal.destroy().map_err(|failed| failed.error);
    let second = second
        .borrow_mut()
        .take()
        .expect("the opener ran inside destroy")
        .expect("the released lock is free");
    assert!(
        matches!(open(root.path()), Err(JournalError::Locked)),
        "a third opener holds the journal while the second still does"
    );
    destroyed.expect("destroy");
    drop(second);
    assert!(open(root.path()).is_ok());
}
