# 06. Данные, проекты и сессии

## 1. Источники истины

PiUI использует строгую иерархию:

1. **Pi session JSONL** — каноническая история, дерево, persistent extension entries.
2. **Pi configuration/package locations** — канонический backend runtime configuration.
3. **Файловая система project folder** — канонические project resources.
4. **PiUI SQLite** — только UI metadata, registry и rebuildable index.
5. **Frontend memory** — transient presentation state.

Удаление пунктов 4–5 не должно уничтожать пункты 1–3.

## 2. Project model

Проект — зарегистрированная существующая директория.

```ts
interface ProjectRecord {
  id: string;                    // PiUI UUID, не filesystem-derived public ID
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

Host canonicalizes path с platform rules:

- Windows drive letter/case и UNC обрабатываются без string-only сравнения;
- symlinks/junctions разрешаются для identity, но display path сохраняется;
- trailing separators нормализуются;
- одна canonical directory не регистрируется дважды;
- nested projects допустимы и считаются отдельными projects;
- project move не определяется автоматически как тот же project без filesystem identity evidence; UI предлагает Locate.

PiUI не создаёт `.piui` в проекте без отдельного решения/ADR. Все собственные metadata по умолчанию находятся в app data directory.

## 3. Session discovery

### 3.1 Где искать

Scanner получает explicit Pi session roots из runtime environment (`PI_CODING_AGENT_SESSION_DIR` имеет приоритет) и рассматривает существующий conventional project-local `<project>/.pi/agent-sessions` как известную directory mapping. Один JSONL читается с жёстким host limit 128 MiB; oversized source сохраняется нетронутым и не выдаётся за проиндексированный. Default global Pi location может использоваться как initial hint. Project settings files не парсятся ради discovery; пути и raw scanner diagnostics не передаются в WebView.

Связь session ↔ project определяется в порядке:

1. явный cwd/project metadata session header;
2. нормализованный path в entries/metadata, если формат Pi это определяет;
3. известная directory mapping Pi;
4. user-assisted assignment только как PiUI metadata, без изменения session file.

Unassigned sessions доступны в отдельной системной группе только в Advanced/All sessions view, чтобы sidebar проекта не загрязнялся.

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

Filesystem traversal, hashing и SQLite commit запускаются через host `spawn_blocking`, поэтому Tauri invoke/event task публикует `refreshStarted` сразу и не блокирует WebView. Только доказанно complete pass становится `current`; incomplete coverage (unavailable candidate/root, limit, CAS mismatch или пустой набор roots без authority) оставляет safe cached rows видимыми, но публикуется как `degraded` и не сбрасывает счётчик periodic integrity scan.

Catalog fingerprint хранится только host-side и включает path, native file ID/inode, size, mtime, bounded prefix/tail continuity digest и parser version. Mtime или continuity digest не считаются доказательством content revision: они позволяют только пропустить повторный catalog parse. Timeline и mutation admission используют отдельное strong observation с identity-bound full revision verification.

Для первого turn новой Pi-сессии UI сохраняет baseline известных opaque IDs до запуска Pi и не auto-select'ит catalog row, пока не найдёт ровно один новый persisted row. Краткие retries имеют bounded exponential backoff; если JSONL ещё не появился или candidates неоднозначны, visible `Retry discovery` даёт пользователю явный recovery path вместо выбора чужой сессии.

### 3.3 Partial writes

Если файл заканчивается без LF:

- последняя неполная строка хранится только как scanner tail buffer;
- она не индексируется как entry;
- при следующем change bytes дописываются;
- после длительного отсутствия изменений UI может показать non-destructive warning;
- никакая repair write не выполняется автоматически.

### 3.4 Rotation/move/delete

- rename/move сопоставляется по file ID/hash where possible;
- trash/delete удаляет index projection, но запись проекта остаётся;
- появление файла с тем же path и другим identity считается новым scan generation;
- scanner отменяет устаревшие jobs по generation token.

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
2. первая непустая user message, очищенная и ограниченная длиной;
3. локализованная дата + короткий ID.

PiUI не делает скрытый LLM-вызов для генерации title.

## 5. SQLite schema

Рекомендуемые таблицы:

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

FTS может не индексировать thinking/tool payload по default privacy setting.

## 6. Миграции

- App-owned metadata проходит обычные forward migrations.
- Rebuildable `sessions_index`/FTS имеют independent generation and can be dropped/rebuilt.
- Перед destructive metadata migration создаётся локальный backup DB.
- Downgrade не обещается для mutable UI metadata; release rollback умеет восстановить previous backup.
- Session JSONL никогда не участвует в PiUI DB migration.
- Migration failure открывает app read-only/safe mode, не блокируя export path.

## 7. Session timeline paging

Для неактивной сессии timeline читается scanner/repository страницами. Для активной:

1. initial snapshot сверяется с Pi `get_entries`/state;
2. historical pages могут приходить из read-only projection;
3. live deltas идут от RPC;
4. после append scanner подтверждает file revision;
5. при расхождении IDs host делает resync, не сливает строки эвристически.

Desktop semantic timeline имеет `projectionVersion: 2`. Discovery/index path сохраняет только 120-character previews и не несёт стоимость rich rendering. Только bounded render rescan известной session повторно разбирает allowlisted Pi v3 content:

- user/assistant Markdown: до 64 KiB на block;
- reasoning/tool/custom/compaction: до 16 KiB;
- суммарный display budget: 4 MiB с сохранением newest content;
- `toolCall` + `toolResult` коррелируются внутри host и превращаются в один block;
- call IDs, tool arguments/commands, raw entry JSON и unknown payload не пересекают IPC;
- display-текст проходит bounded lexical path redaction: project prefix становится `<workspace>`, прочие absolute drive/UNC/POSIX paths — `<external-path>/<leaf>`;
- runtime tool labels проходят ту же allowlist и неизвестные имена становятся `Tool activity`;
- превышение budget обозначается `truncated`, а не маскируется как полный ответ.

Первый latest-page request создаёт один host-private immutable projection cache для пары session/revision. Перед reuse older cursor host делает identity-bound streamed full-revision verification и canonical header attribution; cached blocks не выдаются за current после same-size/mtime rewrite или path replacement. Новый latest request снова наблюдает Pi JSONL и атомарно заменяет bounded cache.

Frontend преобразует соседние `tool`/`thinking` blocks в одну activity group. Группа сворачивается после успешного завершения, раскрывается для running/failed/interrupted state и сохраняет ручное состояние при streaming updates. Это не меняет порядок blocks и не добавляет второй формат чатов.

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

Если file revision изменился, response указывает `staleCursor`, UI сохраняет визуальный anchor и запрашивает новый page.

## 8. Tree representation

Pi session format формирует дерево через entry IDs/parent IDs. PiUI создаёт read-only projection:

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

- orphan node не удаляется; показывается diagnostic root group;
- cycle считается corruption и разрывается только в projection;
- порядок siblings берётся из file/event order;
- current path определяется Pi state, если доступен, иначе последним leaf как heuristic с маркировкой;
- navigation command никогда не реализуется записью `parentId`.

## 9. Drafts

- draft сохраняется debounce, например 500–1000 ms, и при blur/window close;
- один draft на `(project, session|null)`;
- новый чат имеет `sessionId = null`, затем draft atomically rekeys на созданную session;
- attachment references сохраняются без base64;
- после успешной отправки draft очищается только после command accepted;
- после crash text восстанавливается;
- sensitive draft не попадает в logs/search index;
- optional setting полностью отключает persistence drafts.

## 10. Attachment storage

App-managed location:

```text
<app-data>/attachments/<sha256-prefix>/<sha256>/<sanitized-name>
```

Metadata хранит original path и copy time, но UI может скрывать sensitive absolute path в обычном view.

Rules:

- copy использует temp file + fsync/atomic rename where supported;
- hash проверяется после copy;
- одинаковое содержимое дедуплицируется физически, references остаются отдельными;
- cleanup удаляет blob только если нет refs и прошло grace period;
- attachment quota настраивается;
- session trash не немедленно удаляет managed blob до grace period;
- внешний файл не считается permanent без managed copy.

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
- active/trashed not mixed.

Privacy defaults:

- raw tool arguments/results не индексируются;
- thinking не индексируется;
- excluded paths/session types можно настроить;
- index can be wiped/rebuilt;
- search result snippet sanitizes Markdown and paths;
- no remote embedding/indexing.

## 12. File watcher strategy

- watcher создаётся host-side на resolved Pi session roots и на подтверждённые project-local roots, не на каждый file;
- `notify` events считаются lossy scheduling hints: в WebView приходит только versioned `{ protocol, sequence, kind }`, без path/event/error payload;
- events coalesced 200 ms; active selected catalog reconciliation получает hint первым;
- overflow означает complete bounded reconciliation, не потерю cached state;
- frontend всегда запускает редкий bounded polling через allowlisted catalog refresh command; watcher unavailable лишь убирает ускоряющий hint и никогда не лишает reconciliation fallback;
- stale/duplicate hints coalesced per project; cached rows не очищаются до successful complete sweep, а incomplete sweep не маркируется `current`;
- network filesystems и WSL mounts тестируются отдельно;
- periodic integrity scan остаётся обязательным для same-stat in-place rewrite, который watcher/fingerprint не может доказательно исключить.

## 13. Concurrent access CLI ↔ PiUI

Возможен одновременный доступ к одной session из CLI и PiUI. До подтверждения upstream locking semantics PiUI применяет осторожную модель:

- scanner допускает внешние appends;
- active runtime сравнивает revision/state;
- при обнаружении второго writer показывает conflict banner;
- не пытается merge два running turns;
- пользователь выбирает: открыть read-only, остановить локальный runtime или создать fork/clone;
- filesystem lock PiUI не выдаёт за гарантию, если Pi его не соблюдает;
- data loss prevention важнее seamless multi-writer.

Этот сценарий обязателен для spike и stress tests.

## 14. Export

Приоритет — Pi RPC export. Host предоставляет generic export только как отдельный формат PiUI и не называет его upstream export.

Форматы:

- Pi-native export через runtime;
- Markdown transcript;
- JSON diagnostic/raw projection;
- optional HTML standalone после sanitization.

Экспорт:

- не изменяет session;
- явно указывает branch/current path;
- позволяет исключить thinking/tool raw data;
- обрабатывает local images как copied assets или data URLs с size warning;
- пишет temp + atomic rename;
- не перезаписывает без confirmation.

## 15. Trash и восстановление

PiUI использует системную корзину, где возможно. Он хранит tombstone только для UI refresh/undo window, не копию session content.

`Undo`:

- доступен, если platform API вернул recoverable location/handle;
- иначе UI честно направляет в system Trash;
- при collision recovery создаёт безопасное имя и затем scanner сопоставляет Pi metadata;
- активный runtime никогда не остаётся привязан к trashed file.

## 16. Backup и recovery

PiUI не становится backup system, но:

- перед любым host-side file move проверяет source/destination;
- diagnostics умеет перечислить recent session paths;
- corrupted JSONL можно открыть read-only до последней валидной line;
- optional recovery copy создаётся только по явному действию;
- repair никогда не переписывает original in place;
- DB backup не выдаётся за backup chats.

## 17. Data retention

Настройки:

- logs retention (default короткий, например 7 дней);
- attachment cache quota/grace period;
- thumbnail cache;
- FTS on/off и clear;
- draft persistence on/off;
- diagnostics bundle preview.

Pi sessions не получают automatic retention policy от PiUI 1.0.

## 18. Acceptance criteria данных

- Удаление PiUI DB и повторный запуск восстанавливают projects при наличии registry backup/import и полностью перестраивают sessions index; session files неизменны.
- Scanner корректно обрабатывает partial last line и fragmented UTF-8.
- Duplicate canonical project path не создаётся на Windows/Linux.
- External CLI append появляется без app restart.
- Concurrent writer обнаруживается и не вызывает silent merge.
- Timeline page сохраняет anchor при reindex.
- Managed attachment hash/provenance проверяемы.
- Trash не оставляет active runtime.
- FTS можно полностью очистить без удаления sessions.
- Ни один code path не пишет Pi entry/parent ID напрямую.
