//! The target's durable command journal of one grant.
//!
//! A controller names every effectful command with a random [`CommandId`].
//! The target admits it through [`CommandJournal::begin`], which needs an
//! [`AuthorizedController`] of this journal's grant:
//!
//! - a new identifier is recorded as an *intent* before any effect, and only
//!   then does the caller run the effect and [`IntentGuard::settle`] it;
//! - the same identifier with the same command returns the recorded outcome,
//!   or [`Admission::InProgress`] while it runs in this process;
//! - the same identifier with a different command is
//!   [`Admission::Conflict`];
//! - an intent without an outcome after a restart, or an entry that cannot
//!   be read, is [`Admission::Unresolved`]: it is never run again
//!   automatically. The host reconciles it with the owner stores and
//!   records the outcome with [`CommandJournal::settle_unresolved`].
//!
//! A command is bound to its identifier by a digest: SHA-256 of
//! `"nano-host-v1" 0x00 "command" 0x00 grantId 0x00 kind 0x00 commandId 0x00`
//! and the command's canonical bytes. The journal stores only that digest,
//! never the command bytes, so no chat text is kept here for deduplication.
//! The digest is not secret: whoever can read the journal and guess a whole
//! command can test the guess.
//!
//! Storage: in the app-owned journal root
//! (`<app_data>/remote-host-v1/journal/`), separate from every rebuildable
//! index, a grant has a directory `<grantId>/` and, beside it, the lock file
//! `<grantId>.lock`. One process at a time holds the lock, from
//! [`CommandJournal::open`] until that journal and every [`IntentGuard`] it
//! admitted are dropped, so no other holder can reconcile or delete a command
//! whose effect may still be running. Per command the directory has two
//! create-only files, `<commandId>.intent.json` and
//! `<commandId>.settled.json`, each written completely and synced to disk
//! (`sync_all`) before the next step. A file that a crash cut short does not
//! parse: the entry then reads as unresolved, never as a wrong outcome. The
//! directory itself is not synced, so durability is claimed for a process
//! crash, not for a power loss (open question R4). Entries live as long as
//! the grant and are deleted with it, and so is the directory
//! ([`CommandJournal::destroy`]); there is no expiry and no size limit here.
//!
//! The lock file is never deleted. Nothing is ever written to it, so it stays
//! empty: no key, command, digest or outcome. Every holder of the grant's
//! journal, before and after a destroy, therefore locks this one file;
//! deleting it could let a later opener lock a new file while an earlier
//! holder still held the old one.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use ring::digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::b64;
use crate::ids::{CommandId, DerivedDomain, GrantId, derive_id};
use crate::policy::AuthorizedController;

/// The suffix of a grant's lock file, `<grantId>.lock`, beside its journal
/// directory.
pub const LOCK_SUFFIX: &str = ".lock";
/// The suffix of intent files.
pub const INTENT_SUFFIX: &str = ".intent.json";
/// The suffix of settlement files.
pub const SETTLED_SUFFIX: &str = ".settled.json";
/// The version of both record formats.
pub const RECORD_VERSION: u32 = 1;

/// The effectful commands of nano-host/1. Reads are not journaled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CommandKind {
    #[serde(rename = "createSession")]
    CreateSession,
    #[serde(rename = "composer.send")]
    ComposerSend,
    #[serde(rename = "composer.remove")]
    ComposerRemove,
    #[serde(rename = "interrupt")]
    Interrupt,
    #[serde(rename = "respond")]
    Respond,
    #[serde(rename = "runs.start")]
    RunsStart,
    #[serde(rename = "runs.cancel")]
    RunsCancel,
    #[serde(rename = "runs.cancelTask")]
    RunsCancelTask,
    #[serde(rename = "runs.reject")]
    RunsReject,
}

impl CommandKind {
    /// Every kind.
    pub const ALL: [Self; 9] = [
        Self::CreateSession,
        Self::ComposerSend,
        Self::ComposerRemove,
        Self::Interrupt,
        Self::Respond,
        Self::RunsStart,
        Self::RunsCancel,
        Self::RunsCancelTask,
        Self::RunsReject,
    ];

    /// The wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CreateSession => "createSession",
            Self::ComposerSend => "composer.send",
            Self::ComposerRemove => "composer.remove",
            Self::Interrupt => "interrupt",
            Self::Respond => "respond",
            Self::RunsStart => "runs.start",
            Self::RunsCancel => "runs.cancel",
            Self::RunsCancelTask => "runs.cancelTask",
            Self::RunsReject => "runs.reject",
        }
    }

    /// The owner store identifier this kind derives from the command.
    #[must_use]
    pub const fn derived_domain(self) -> Option<DerivedDomain> {
        match self {
            Self::CreateSession => Some(DerivedDomain::Session),
            Self::ComposerSend => Some(DerivedDomain::Composer),
            Self::RunsStart => Some(DerivedDomain::Run),
            _ => None,
        }
    }
}

/// Why a command certainly had no effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotAppliedReason {
    /// The owner store refused the effect.
    OwnerRefused,
    /// Reconciliation after a restart found no effect.
    AbsentAfterRestart,
}

/// Why the effect of a command is unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnknownReason {
    /// The host restarted while the effect could have been under way.
    HostRestarted,
    /// The composer cannot tell whether the message was delivered.
    DeliveryUncertain,
    /// The owner store failed in a way that leaves the effect open.
    EffectUncertain,
}

/// The recorded outcome of a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandOutcome {
    /// The effect happened.
    Applied {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision: Option<u64>,
    },
    /// The effect certainly did not happen. Never repeated automatically.
    NotApplied { reason: NotAppliedReason },
    /// The effect may have happened. Never repeated.
    OutcomeUnknown { reason: UnknownReason },
    /// The grant was revoked before the effect started.
    CancelledByRevocation,
}

/// One command offered for admission.
#[derive(Clone, Copy, Debug)]
pub struct CommandRequest<'a> {
    pub command_id: CommandId,
    pub kind: CommandKind,
    /// The canonical bytes of the command as accepted. Only hashed.
    pub canonical: &'a [u8],
}

/// The digest that binds a command to its identifier.
#[must_use]
pub fn binding_digest(grant: &GrantId, request: &CommandRequest<'_>) -> [u8; 32] {
    let mut context = digest::Context::new(&digest::SHA256);
    let command_id = request.command_id.text();
    for part in [
        b"nano-host-v1".as_slice(),
        b"command",
        grant.as_str().as_bytes(),
        request.kind.as_str().as_bytes(),
        command_id.as_bytes(),
    ] {
        context.update(part);
        context.update(&[0]);
    }
    context.update(request.canonical);
    let mut out = [0u8; 32];
    out.copy_from_slice(context.finish().as_ref());
    out
}

/// The answer of [`CommandJournal::begin`].
#[derive(Debug)]
pub enum Admission {
    /// The intent is durable: run the effect, then settle the guard.
    Execute(IntentGuard),
    /// The same command was settled with this outcome.
    Settled(CommandOutcome),
    /// The same command is running in this process.
    InProgress,
    /// The command has no recorded outcome after a restart, or its entry
    /// cannot be read. It is not run.
    Unresolved,
    /// The identifier was used for a different command.
    Conflict,
}

/// The state of a journal entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryStatus {
    /// Running in this process.
    Executing,
    /// No recorded outcome; needs reconciliation.
    Unresolved,
    /// Settled.
    Settled(CommandOutcome),
}

/// A readable journal entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JournalEntry {
    pub command_id: CommandId,
    pub kind: CommandKind,
    /// The admission order within this journal, from 1.
    pub seq: u64,
    pub derived_id: Option<Uuid>,
    pub status: EntryStatus,
}

/// Every entry of a journal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    /// Readable entries in admission order.
    pub entries: Vec<JournalEntry>,
    /// Identifiers whose intent cannot be read. They stay unresolved.
    pub unreadable: Vec<CommandId>,
}

/// A journal failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum JournalError {
    #[error("another process holds this journal")]
    Locked,
    #[error("the authorization belongs to another grant")]
    WrongGrant,
    #[error("the command is running")]
    Executing,
    #[error("the command has no readable intent")]
    Unreadable,
    #[error("the command is already settled")]
    AlreadySettled,
    #[error("the journal still has running commands")]
    Busy,
    #[error("journal storage failed: {0:?}")]
    Io(io::ErrorKind),
}

impl From<io::Error> for JournalError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.kind())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntentRecord {
    version: u32,
    grant_id: GrantId,
    command_id: CommandId,
    kind: CommandKind,
    binding_digest: String,
    seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    derived_id: Option<Uuid>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettledRecord {
    version: u32,
    command_id: CommandId,
    binding_digest: String,
    outcome: CommandOutcome,
}

struct Intent {
    kind: CommandKind,
    binding: [u8; 32],
    seq: u64,
    derived_id: Option<Uuid>,
}

enum Settlement {
    Absent,
    Recorded(CommandOutcome),
    Unreadable,
}

enum IntentRead {
    Absent,
    Unreadable,
    Valid(Intent),
}

enum Stored {
    Absent,
    Unreadable,
    Present(Intent, Settlement),
}

struct Live {
    executing: HashMap<CommandId, [u8; 32]>,
    next_seq: u64,
}

struct Shared {
    dir: PathBuf,
    grant: GrantId,
    live: Mutex<Live>,
    /// The locked lock file. The journal and every guard share it, and
    /// dropping the last of them is the only release.
    _lock: File,
}

impl Shared {
    fn live(&self) -> MutexGuard<'_, Live> {
        // The protected data stays consistent across a panic: every update
        // is a single insert, remove or increment.
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn path(&self, id: &CommandId, suffix: &str) -> PathBuf {
        self.dir.join(format!("{}{suffix}", id.text()))
    }

    fn read_intent(&self, id: &CommandId) -> Result<IntentRead, JournalError> {
        let Some(bytes) = read_optional(&self.path(id, INTENT_SUFFIX))? else {
            return Ok(IntentRead::Absent);
        };
        let parsed = serde_json::from_slice::<IntentRecord>(&bytes)
            .ok()
            .and_then(|record| {
                let binding = b64::decode_array::<32>(&record.binding_digest)?;
                let expected_derived = record
                    .kind
                    .derived_domain()
                    .map(|domain| derive_id(domain, &self.grant, id));
                (record.version == RECORD_VERSION
                    && record.command_id == *id
                    && record.grant_id == self.grant
                    && record.seq > 0
                    && record.derived_id == expected_derived)
                    .then_some(Intent {
                        kind: record.kind,
                        binding,
                        seq: record.seq,
                        derived_id: record.derived_id,
                    })
            });
        Ok(parsed.map_or(IntentRead::Unreadable, IntentRead::Valid))
    }

    fn read_settlement(&self, id: &CommandId, intent: &Intent) -> Result<Settlement, JournalError> {
        let Some(bytes) = read_optional(&self.path(id, SETTLED_SUFFIX))? else {
            return Ok(Settlement::Absent);
        };
        let recorded = serde_json::from_slice::<SettledRecord>(&bytes)
            .ok()
            .filter(|record| {
                record.version == RECORD_VERSION
                    && record.command_id == *id
                    && b64::decode_array::<32>(&record.binding_digest) == Some(intent.binding)
            });
        Ok(recorded.map_or(Settlement::Unreadable, |record| {
            Settlement::Recorded(record.outcome)
        }))
    }

    fn read(&self, id: &CommandId) -> Result<Stored, JournalError> {
        match self.read_intent(id)? {
            IntentRead::Absent => Ok(Stored::Absent),
            IntentRead::Unreadable => Ok(Stored::Unreadable),
            IntentRead::Valid(intent) => {
                let settlement = self.read_settlement(id, &intent)?;
                Ok(Stored::Present(intent, settlement))
            }
        }
    }

    fn write_settlement(
        &self,
        id: &CommandId,
        binding: &[u8; 32],
        outcome: CommandOutcome,
    ) -> Result<(), JournalError> {
        let record = SettledRecord {
            version: RECORD_VERSION,
            command_id: *id,
            binding_digest: b64::encode(binding),
            outcome,
        };
        write_new(&self.path(id, SETTLED_SUFFIX), &record)
    }

    fn command_ids(&self) -> Result<Vec<CommandId>, JournalError> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let name = entry?.file_name();
            if let Some(id) = name
                .to_str()
                .and_then(|name| name.strip_suffix(INTENT_SUFFIX))
                .and_then(|id| CommandId::parse(id).ok())
            {
                ids.push(id);
            }
        }
        Ok(ids)
    }
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, JournalError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Creates `path`, which must not exist, with the whole record, and syncs it.
fn write_new<T: Serialize>(path: &Path, record: &T) -> Result<(), JournalError> {
    let mut bytes =
        serde_json::to_vec(record).map_err(|_| JournalError::Io(io::ErrorKind::InvalidData))?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let written = file.write_all(&bytes).and_then(|()| file.sync_all());
    if let Err(error) = written {
        drop(file);
        // Nothing ran on the strength of this file yet; a partial file would
        // only block the identifier.
        let _ = fs::remove_file(path);
        return Err(error.into());
    }
    Ok(())
}

/// The journal of one grant, held by one process at a time: its lock lasts
/// until the journal and every [`IntentGuard`] it admitted are dropped.
pub struct CommandJournal {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for CommandJournal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CommandJournal")
            .field("dir", &self.shared.dir)
            .field("grant", &self.shared.grant)
            .finish_non_exhaustive()
    }
}

impl CommandJournal {
    /// Opens the journal of `grant` in the journal root `root`, creating
    /// what is missing: it takes the lock of `<grantId>.lock` first, and only
    /// then, as the holder, creates the directory `<grantId>/`.
    ///
    /// # Errors
    /// [`JournalError::Locked`] when another holder has it, or
    /// [`JournalError::Io`].
    pub fn open(root: &Path, grant: GrantId) -> Result<Self, JournalError> {
        // A grant identifier is one path component: its prefix and
        // base64url text have no separator and no dot.
        let name = grant.as_str();
        fs::create_dir_all(root)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(format!("{name}{LOCK_SUFFIX}")))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Err(JournalError::Locked),
            Err(fs::TryLockError::Error(error)) => return Err(error.into()),
        }
        let dir = root.join(name);
        fs::create_dir_all(&dir)?;
        let shared = Shared {
            dir,
            grant,
            live: Mutex::new(Live {
                executing: HashMap::new(),
                next_seq: 1,
            }),
            _lock: lock,
        };
        let mut last = 0;
        for id in shared.command_ids()? {
            if let IntentRead::Valid(intent) = shared.read_intent(&id)? {
                last = last.max(intent.seq);
            }
        }
        shared.live().next_seq = last.saturating_add(1);
        Ok(Self {
            shared: Arc::new(shared),
        })
    }

    /// The grant of this journal.
    #[must_use]
    pub fn grant(&self) -> &GrantId {
        &self.shared.grant
    }

    /// Admits a command of an authorized controller.
    ///
    /// # Errors
    /// [`JournalError::WrongGrant`] or [`JournalError::Io`]. An I/O error
    /// leaves no intent: the command did not run.
    pub fn begin(
        &self,
        authorization: AuthorizedController,
        request: CommandRequest<'_>,
    ) -> Result<Admission, JournalError> {
        if authorization.grant_id() != &self.shared.grant {
            return Err(JournalError::WrongGrant);
        }
        let id = request.command_id;
        let binding = binding_digest(&self.shared.grant, &request);
        let seq = {
            let mut live = self.shared.live();
            if let Some(running) = live.executing.get(&id) {
                return Ok(if *running == binding {
                    Admission::InProgress
                } else {
                    Admission::Conflict
                });
            }
            match self.shared.read(&id)? {
                Stored::Absent => {}
                Stored::Unreadable => return Ok(Admission::Unresolved),
                Stored::Present(intent, _) if intent.binding != binding => {
                    return Ok(Admission::Conflict);
                }
                Stored::Present(_, settlement) => {
                    return Ok(match settlement {
                        Settlement::Recorded(outcome) => Admission::Settled(outcome),
                        Settlement::Absent | Settlement::Unreadable => Admission::Unresolved,
                    });
                }
            }
            let seq = live.next_seq;
            live.next_seq = seq.saturating_add(1);
            live.executing.insert(id, binding);
            seq
        };
        let derived_id = request
            .kind
            .derived_domain()
            .map(|domain| derive_id(domain, &self.shared.grant, &id));
        let record = IntentRecord {
            version: RECORD_VERSION,
            grant_id: self.shared.grant.clone(),
            command_id: id,
            kind: request.kind,
            binding_digest: b64::encode(&binding),
            seq,
            derived_id,
        };
        if let Err(error) = write_new(&self.shared.path(&id, INTENT_SUFFIX), &record) {
            self.shared.live().executing.remove(&id);
            return Err(error);
        }
        Ok(Admission::Execute(IntentGuard {
            shared: Arc::clone(&self.shared),
            entry: JournalEntry {
                command_id: id,
                kind: request.kind,
                seq,
                derived_id,
                status: EntryStatus::Executing,
            },
            binding,
        }))
    }

    /// Records the reconciled outcome of an unresolved entry. A settlement
    /// file that cannot be read is replaced; a readable one never is.
    ///
    /// # Errors
    /// [`JournalError::Executing`], [`JournalError::Unreadable`] (no
    /// readable intent), [`JournalError::AlreadySettled`] or
    /// [`JournalError::Io`].
    pub fn settle_unresolved(
        &self,
        id: &CommandId,
        outcome: CommandOutcome,
    ) -> Result<(), JournalError> {
        // Held throughout, so no admission of `id` interleaves.
        let live = self.shared.live();
        if live.executing.contains_key(id) {
            return Err(JournalError::Executing);
        }
        match self.shared.read(id)? {
            Stored::Absent | Stored::Unreadable => Err(JournalError::Unreadable),
            Stored::Present(_, Settlement::Recorded(_)) => Err(JournalError::AlreadySettled),
            Stored::Present(intent, settlement) => {
                if matches!(settlement, Settlement::Unreadable) {
                    fs::remove_file(self.shared.path(id, SETTLED_SUFFIX))?;
                }
                self.shared.write_settlement(id, &intent.binding, outcome)
            }
        }
    }

    /// Every entry: readable ones in admission order, then the identifiers
    /// whose intent cannot be read.
    ///
    /// # Errors
    /// [`JournalError::Io`].
    pub fn list(&self) -> Result<Listing, JournalError> {
        let executing: Vec<CommandId> = self.shared.live().executing.keys().copied().collect();
        let mut listing = Listing::default();
        for id in self.shared.command_ids()? {
            let status = |settlement: Settlement| {
                if executing.contains(&id) {
                    EntryStatus::Executing
                } else {
                    match settlement {
                        Settlement::Recorded(outcome) => EntryStatus::Settled(outcome),
                        Settlement::Absent | Settlement::Unreadable => EntryStatus::Unresolved,
                    }
                }
            };
            match self.shared.read(&id)? {
                Stored::Absent => {}
                Stored::Unreadable if executing.contains(&id) => {}
                Stored::Unreadable => listing.unreadable.push(id),
                Stored::Present(intent, settlement) => listing.entries.push(JournalEntry {
                    command_id: id,
                    kind: intent.kind,
                    seq: intent.seq,
                    derived_id: intent.derived_id,
                    status: status(settlement),
                }),
            }
        }
        listing.entries.sort_by_key(|entry| entry.seq);
        listing.unreadable.sort();
        Ok(listing)
    }

    /// Deletes the journal with its grant: only this journal's own files,
    /// then the directory, which must then be empty. All of it happens under
    /// the lock, which is released when this returns; the empty lock file
    /// stays (see the module documentation).
    ///
    /// # Errors
    /// [`JournalError::Busy`] while an [`IntentGuard`] exists, or
    /// [`JournalError::Io`]. The journal then comes back still locked, and a
    /// later call continues the deletion.
    pub fn destroy(self) -> Result<(), DestroyError> {
        if Arc::strong_count(&self.shared) > 1 || !self.shared.live().executing.is_empty() {
            return Err(DestroyError {
                journal: self,
                error: JournalError::Busy,
            });
        }
        let removed = self
            .remove_entries()
            .and_then(|()| fs::remove_dir(&self.shared.dir).map_err(JournalError::from));
        if let Err(error) = removed {
            return Err(DestroyError {
                journal: self,
                error,
            });
        }
        // The release. The lock file stays, so a later holder locks it again.
        drop(self);
        #[cfg(test)]
        after_destroy_release();
        Ok(())
    }

    fn remove_entries(&self) -> Result<(), JournalError> {
        for entry in fs::read_dir(&self.shared.dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let ours = [INTENT_SUFFIX, SETTLED_SUFFIX].iter().any(|suffix| {
                name.strip_suffix(suffix)
                    .is_some_and(|id| CommandId::parse(id).is_ok())
            });
            if ours {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}

/// A journal that could not be destroyed.
#[derive(Debug)]
pub struct DestroyError {
    /// The journal, still locked.
    pub journal: CommandJournal,
    pub error: JournalError,
}

/// A durable intent whose effect the caller runs now. Dropping it without
/// [`IntentGuard::settle`] leaves the entry unresolved. It keeps the
/// journal's lock, also after its [`CommandJournal`] is dropped, so no other
/// holder can reconcile or delete the entry while the effect may run.
pub struct IntentGuard {
    shared: Arc<Shared>,
    entry: JournalEntry,
    binding: [u8; 32],
}

impl std::fmt::Debug for IntentGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IntentGuard")
            .field("entry", &self.entry)
            .finish_non_exhaustive()
    }
}

impl IntentGuard {
    /// The admitted entry.
    #[must_use]
    pub fn entry(&self) -> &JournalEntry {
        &self.entry
    }

    /// Records the outcome of the effect.
    ///
    /// # Errors
    /// [`JournalError::Io`]; the entry then stays unresolved.
    pub fn settle(self, outcome: CommandOutcome) -> Result<(), JournalError> {
        self.shared
            .write_settlement(&self.entry.command_id, &self.binding, outcome)
    }
}

impl Drop for IntentGuard {
    fn drop(&mut self) {
        self.shared.live().executing.remove(&self.entry.command_id);
    }
}

/// Tests only: a step that [`after_destroy_release`] runs.
#[cfg(test)]
type DestroySeam = Box<dyn FnOnce()>;

#[cfg(test)]
thread_local! {
    /// Tests only: runs once on this thread right after
    /// [`CommandJournal::destroy`] gave up its lock, the earliest moment at
    /// which another opener can take it.
    static AFTER_DESTROY_RELEASE: std::cell::RefCell<Option<DestroySeam>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn after_destroy_release() {
    if let Some(step) = AFTER_DESTROY_RELEASE.with(|slot| slot.borrow_mut().take()) {
        step();
    }
}

#[cfg(test)]
mod tests;
