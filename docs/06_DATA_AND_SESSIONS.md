# 06. Data, projects, and sessions

## 1. Sources of truth

PiUI uses a strict hierarchy:

1. **Pi session JSONL** — canonical history, tree, persistent extension entries.
2. **Pi configuration/package locations** — canonical backend runtime configuration.
3. **Project folder filesystem** — canonical project resources.
4. **PiUI SQLite** — UI metadata, registry, and rebuildable index only.
5. **Frontend memory** — transient presentation state.

Deleting items 4–5 must not destroy items 1–3.

## 2. Project model

A project is a registered existing directory.

```ts
interface ProjectRecord {
  id: string;                    // PiUI UUID, not a filesystem-derived public ID
  canonicalPath: string;
  displayPath: string;
  name: string;
  addedAt: string;
  lastOpenedAt?: string;
  orderKey: string;
  trustState: 'unknown' | 'trusted' | 'restricted';
  missingSince?: string;
  runtimeProfileId?: string;
}
```

### Path identity

The host canonicalizes paths using platform rules:

- Windows drive letter/case and UNC are handled without string-only comparison;
- symlinks/junctions are resolved for identity, but the display path is retained;
- trailing separators are normalized;
- a canonical directory is not registered twice;
- nested projects are allowed and considered separate projects;
- a project move is not automatically identified as the same project without filesystem identity evidence; the UI offers Locate.

PiUI does not create `.piui` in a project without a separate decision/ADR. All of its metadata is in the app data directory by default.

## 3. Session discovery

### 3.1 Where to search

The scanner receives explicit Pi session roots from the runtime environment (`PI_CODING_AGENT_SESSION_DIR` takes priority) and treats the existing conventional project-local `<project>/.pi/agent-sessions` as a known directory mapping. A single JSONL file is read with a hard host limit of 128 MiB; an oversized source is retained untouched and is not presented as indexed. The default global Pi location may be used as an initial hint. Project settings files are not parsed for discovery; paths and raw scanner diagnostics are not passed to the WebView.

The session ↔ project association is determined in this order:

1. explicit cwd/project metadata in the session header;
2. normalized path in entries/metadata, if the Pi format defines it;
3. known Pi directory mapping;
4. user-assisted assignment only as PiUI metadata, without changing the session file.

Unassigned sessions are available in a separate system group only in the Advanced/All sessions view, so the project sidebar is not cluttered.

### 3.2 Scanner pipeline

```text
cached SQLite catalog -> immediate sidebar snapshot
filesystem watcher / explicit refresh / Pi runtime exit / polling hint
  -> per-project reconciliation generation
  -> no-follow identity + weak catalog fingerprint
  -> unchanged source: mark seen only
  -> changed source: bounded LF metadata parser + full revision hash
  -> one SQLite batch transaction + complete-only sweep
  -> versioned opaque host event
```

Filesystem traversal, hashing, and SQLite commit run through host `spawn_blocking`, so the Tauri invoke/event task publishes `refreshStarted` immediately and does not block the WebView. Only a proven complete pass becomes `current`; incomplete coverage (an unavailable candidate/root, limit, CAS mismatch, or an empty set of roots without authority) keeps safe cached rows visible, but is published as `degraded` and does not reset the periodic integrity scan counter.

The catalog fingerprint is stored host-side only and includes path, native file ID/inode, size, mtime, bounded prefix/tail continuity digest, and parser version. Mtime or a continuity digest are not considered proof of a content revision: they only allow a repeated catalog parse to be skipped. Timeline and mutation admission use a separate strong observation with identity-bound full revision verification.

For the first turn of a new Pi session, the UI stores a baseline of known opaque IDs before launching Pi and does not auto-select a catalog row until it finds exactly one new persisted row. Short retries use bounded exponential backoff; if JSONL has not yet appeared or candidates are ambiguous, visible `Retry discovery` gives the user an explicit recovery path rather than selecting another session.

### 3.3 Partial writes

If a file ends without LF:

- the final incomplete line is kept only as a scanner tail buffer;
- it is not indexed as an entry;
- on the next change, bytes are appended;
- after a prolonged lack of changes, the UI may show a non-destructive warning;
- no repair write is performed automatically.

### 3.4 Rotation/move/delete

- rename/move is matched by file ID/hash where possible;
- trash/delete removes the index projection, but the project record remains;
- a file appearing at the same path with a different identity is treated as a new scan generation;
- the scanner cancels stale jobs by generation token.

## 4. Session projection

```ts
interface SessionProjection {
  id: string;
  fileUri: string;
  projectId?: string;
  piSessionId?: string;
  name?: string;
  titleSource: 'pi-name' | 'first-user-message' | 'date-id' | 'ui-alias';
  createdAt?: string;
  updatedAt?: string;
  firstUserPreview?: string;
  lastMessagePreview?: string;
  entryCount: number;
  branchCount?: number;
  currentLeafId?: string;
  modelRef?: string;
  parseState: 'healthy' | 'partial' | 'unsupported' | 'corrupt';
  fileRevision: string;
}
```

Title fallback:

1. Pi session name;
2. first non-empty user message, sanitized and length-limited;
3. localized date + short ID.

PiUI does not make a hidden LLM call to generate a title.

## 5. SQLite schema

Recommended tables:

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  display_path TEXT NOT NULL,
  name TEXT NOT NULL,
  order_key TEXT NOT NULL,
  trust_state TEXT NOT NULL,
  runtime_profile_id TEXT,
  added_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  missing_since INTEGER
);

CREATE TABLE sessions_index (
  id TEXT PRIMARY KEY,
  file_uri TEXT NOT NULL UNIQUE,
  project_id TEXT,
  pi_session_id TEXT,
  name TEXT,
  title_source TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  first_user_preview TEXT,
  last_message_preview TEXT,
  entry_count INTEGER NOT NULL,
  branch_count INTEGER,
  current_leaf_id TEXT,
  model_ref TEXT,
  parse_state TEXT NOT NULL,
  file_revision TEXT NOT NULL,
  index_generation INTEGER NOT NULL
);

CREATE TABLE session_ui_state (
  session_id TEXT PRIMARY KEY,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived_in_ui INTEGER NOT NULL DEFAULT 0,
  ui_alias TEXT,
  last_opened_at INTEGER,
  scroll_anchor_entry_id TEXT,
  scroll_anchor_offset REAL
);

CREATE TABLE drafts (
  project_id TEXT NOT NULL,
  session_id TEXT,
  body TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, session_id)
);

CREATE TABLE attachment_refs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  source_kind TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  managed_uri TEXT,
  sha256 TEXT,
  mime TEXT,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE extension_grants (
  extension_id TEXT NOT NULL,
  project_id TEXT,
  permission TEXT NOT NULL,
  decision TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(extension_id, project_id, permission)
);

CREATE TABLE trusted_ui_packages (
  package_fingerprint TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE index_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

FTS projection optional:

```sql
CREATE VIRTUAL TABLE message_fts USING fts5(
  session_id UNINDEXED,
  entry_id UNINDEXED,
  role UNINDEXED,
  body,
  tokenize = 'unicode61'
);
```

FTS may not index thinking/tool payload under the default privacy setting.

## 6. Migrations

- App-owned metadata undergoes normal forward migrations.
- Rebuildable `sessions_index`/FTS have an independent generation and can be dropped/rebuilt.
- A local backup DB is created before a destructive metadata migration.
- Downgrade is not promised for mutable UI metadata; release rollback can restore the previous backup.
- Session JSONL never participates in a PiUI DB migration.
- A migration failure opens the app in read-only/safe mode without blocking the export path.

## 7. Session timeline paging

For an inactive session, the timeline is read in pages by the scanner/repository. For an active session:

1. the initial snapshot is reconciled with Pi `get_entries`/state;
2. historical pages may come from the read-only projection;
3. live deltas arrive through RPC;
4. after append, the scanner confirms the file revision;
5. on ID divergence, the host resynchronizes and does not merge lines heuristically.

The desktop semantic timeline has `projectionVersion: 2`. The discovery/index path retains only 120-character previews and does not bear the cost of rich rendering. Only a bounded render rescan of a known session reparses allowlisted Pi v3 content:

- user/assistant Markdown: up to 64 KiB per block;
- reasoning/tool/custom/compaction: up to 16 KiB;
- total display budget: 4 MiB while retaining newest content;
- `toolCall` + `toolResult` are correlated inside the host and converted into one block;
- call IDs, tool arguments/commands, raw entry JSON, and unknown payloads do not cross IPC;
- display text passes through bounded lexical-path redaction: the project prefix becomes `<workspace>`, other absolute drive/UNC/POSIX paths become `<external-path>/<leaf>`;
- runtime tool labels pass through the same allowlist and unknown names become `Tool activity`;
- exceeding the budget is marked `truncated`, not disguised as a complete response.

The first latest-page request creates one host-private immutable projection cache for the session/revision pair. Before reusing an older cursor, the host performs identity-bound streamed full-revision verification and canonical header attribution; cached blocks are not presented as current after a same-size/mtime rewrite or path replacement. A new latest request observes Pi JSONL again and atomically replaces the bounded cache.

The frontend converts adjacent `tool`/`thinking` blocks into one activity group. The group collapses after successful completion, expands for a running/failed/interrupted state, and retains its manual state during streaming updates. This does not change block order or introduce a second chat format.

Cursor:

```ts
interface EntryPageCursor {
  sessionId: string;
  direction: 'older' | 'newer';
  anchorEntryId?: string;
  fileRevision: string;
  limit: number;
}
```

If the file revision changed, the response indicates `staleCursor`; the UI retains the visual anchor and requests a new page.

## 8. Tree representation

The Pi session format forms a tree through entry IDs/parent IDs. PiUI creates a read-only projection:

```ts
interface SessionTreeNode {
  entryId: string;
  parentId?: string;
  roleOrType: string;
  createdAt?: string;
  preview?: string;
  children: string[];
  isCurrentPath: boolean;
}
```

Rules:

- an orphan node is not deleted; it is displayed in a diagnostic root group;
- a cycle is considered corruption and is broken only in the projection;
- sibling order is taken from file/event order;
- the current path is determined by Pi state when available, otherwise by the final leaf as a marked heuristic;
- a navigation command is never implemented by writing `parentId`.

## 9. Drafts

- a draft is saved with debounce, for example 500–1000 ms, and on blur/window close;
- one draft per `(project, session|null)`;
- a new chat has `sessionId = null`, then the draft is atomically rekeyed to the created session;
- attachment references are stored without base64;
- after successful sending, the draft is cleared only after the command is accepted;
- text is restored after a crash;
- a sensitive draft does not enter logs/search index;
- an optional setting fully disables draft persistence.

## 10. Attachment storage

App-managed location:

```text
<app-data>/attachments/<sha256-prefix>/<sha256>/<sanitized-name>
```

Metadata retains the original path and copy time, but the UI may hide a sensitive absolute path in the standard view.

Rules:

- copy uses a temp file + fsync/atomic rename where supported;
- the hash is checked after copying;
- identical content is physically deduplicated; references remain separate;
- cleanup deletes a blob only if there are no refs and the grace period has elapsed;
- attachment quota is configurable;
- session trash does not immediately delete a managed blob before the grace period;
- an external file is not considered permanent without a managed copy.

## 11. Search

MVP search:

- session title/name;
- first/last preview;
- optional message body FTS.

Filters:

- project;
- date range;
- model/provider where indexed;
- has image/tool/error;
- active/trashed are not mixed.

Privacy defaults:

- raw tool arguments/results are not indexed;
- thinking is not indexed;
- excluded paths/session types can be configured;
- the index can be wiped/rebuilt;
- a search result snippet sanitizes Markdown and paths;
- no remote embedding/indexing.

## 12. File watcher strategy

- a watcher is created host-side on resolved Pi session roots and confirmed project-local roots, not for every file;
- `notify` events are considered lossy scheduling hints: only versioned `{ protocol, sequence, kind }` reaches the WebView, without path/event/error payload;
- events are coalesced for 200 ms; active selected catalog reconciliation receives the hint first;
- overflow means complete bounded reconciliation, not loss of cached state;
- the frontend always runs infrequent bounded polling through the allowlisted catalog refresh command; an unavailable watcher only removes the accelerating hint and never removes the reconciliation fallback;
- stale/duplicate hints are coalesced per project; cached rows are not cleared before a successful complete sweep, and an incomplete sweep is not marked `current`;
- network filesystems and WSL mounts are tested separately;
- a periodic integrity scan remains mandatory for a same-stat in-place rewrite that the watcher/fingerprint cannot conclusively exclude.

## 13. Concurrent access CLI ↔ PiUI

Concurrent access to one session from the CLI and PiUI is possible. Until upstream locking semantics are confirmed, PiUI applies a cautious model:

- the scanner permits external appends;
- the active runtime compares revision/state;
- when a second writer is detected, it displays a conflict banner;
- it does not attempt to merge two running turns;
- the user chooses: open read-only, stop the local runtime, or create a fork/clone;
- PiUI does not present a filesystem lock as a guarantee if Pi does not honor it;
- data-loss prevention is more important than seamless multi-writer operation.

This scenario is mandatory for spike and stress tests.

## 14. Export

Pi RPC export has priority. The host provides generic export only as a separate PiUI format and does not call it upstream export.

Formats:

- Pi-native export through runtime;
- Markdown transcript;
- JSON diagnostic/raw projection;
- optional standalone HTML after sanitization.

Export:

- does not change the session;
- explicitly indicates branch/current path;
- allows thinking/tool raw data to be excluded;
- handles local images as copied assets or data URLs with a size warning;
- writes temp + atomic rename;
- does not overwrite without confirmation.

## 15. Trash and recovery

PiUI uses the system Trash where possible. It retains a tombstone only for UI refresh/undo window, not a copy of session content.

`Undo`:

- is available if the platform API returned a recoverable location/handle;
- otherwise the UI honestly directs the user to the system Trash;
- on recovery collision, it creates a safe name and then the scanner matches Pi metadata;
- an active runtime never remains attached to a trashed file.

## 16. Backup and recovery

PiUI does not become a backup system, but:

- before any host-side file move, it checks source/destination;
- diagnostics can list recent session paths;
- corrupted JSONL can be opened read-only through the last valid line;
- an optional recovery copy is created only by explicit action;
- repair never overwrites the original in place;
- a DB backup is not presented as a chat backup.

## 17. Data retention

Settings:

- logs retention (short by default, for example 7 days);
- attachment cache quota/grace period;
- thumbnail cache;
- FTS on/off and clear;
- draft persistence on/off;
- diagnostics bundle preview.

Pi sessions receive no automatic retention policy from PiUI 1.0.

## 18. Data acceptance criteria

- Deleting the PiUI DB and restarting restores projects when a registry backup/import is available and fully rebuilds the sessions index; session files remain unchanged.
- The scanner correctly handles a partial final line and fragmented UTF-8.
- No duplicate canonical project path is created on Windows/Linux.
- An external CLI append appears without an app restart.
- A concurrent writer is detected and does not cause a silent merge.
- A timeline page retains its anchor on reindex.
- Managed attachment hash/provenance is verifiable.
- Trash does not leave an active runtime.
- FTS can be completely cleared without deleting sessions.
- No code path writes a Pi entry/parent ID directly.
