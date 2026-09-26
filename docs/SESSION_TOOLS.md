# Session tools: review, worktree chats, handoffs, terminal sessions

Status: 2026-09-27, branch `feat/session-tools`. Plan item P3.11 (second half)
and classic parity gap 1 ([CLASSIC_PARITY.md](CLASSIC_PARITY.md)). Decision
record: ADR-036 in [10_ADR.md](10_ADR.md).

Three independently versioned host commands, all allowlisted in the Tauri
invoke list, with TypeScript contracts and one golden fixture
(`contracts/fixtures/workspace-session-tools-v1.json`) that the host DTOs and
the clients both check:

| Command | Contract | Purpose |
| --- | --- | --- |
| `workspace_review_v1` | `contracts/workspace-review-v1.ts` | Git changes of a chat's folder: status, diff, stage, unstage, revert |
| `workspace_placement_v1` | `contracts/workspace-placement-v1.ts` | Worktree chats, handoff links, where a chat came from |
| `workspace_adopt_v1` | `contracts/workspace-adopt-v1.ts` | Continue a Pi session started in the terminal |

Workspace v15 (commands, events, catalog) and the v11 session registry format
are unchanged.

## Git on the host

`piui_runtime::git` runs git for every tool:

- Resolved from absolute `PATH` entries only and started without a shell,
  with a fixed argument vector (paths only after `--`, `--literal-pathspecs`).
- Contained like host scripts: a Windows Job Object assigned before the
  process resumes, or a Unix process group; the whole tree ends with the call.
- Bounded: stdout is cut at 8 MiB (status, one diff) and the call fails as
  too large rather than truncating silently; timeouts of 30 s for reads, 60 s
  for index and work-tree changes, 10 min for `worktree add`.
- Repository hooks never run (`core.hooksPath` points at an empty PiUI-owned
  folder), `core.fsmonitor`, the pager, external diff and textconv are off,
  paths are not quoted, `GIT_*` variables that could point git at another
  repository are removed, prompts are off and reads set
  `GIT_OPTIONAL_LOCKS=0` so a status never rewrites the index. Clean and
  smudge filters the user configured still apply, as with any git command.
- Nothing logs arguments, paths or output. Refusals are classified from git's
  stable (`LC_ALL=C`) stderr into typed codes (`NOT_A_REPOSITORY`,
  `GIT_REFUSED` for "dubious ownership", `GIT_BUSY` for `index.lock`, …).

## Review panel (`workspace_review_v1`)

Opened from the chat header (git-compare icon, `Mod+Shift+G`) or from a
worktree's details; it replaces the details panel while open (one inspector)
and its width is adjustable by pointer and arrow keys and remembered.

- **Scope.** The chat's working folder: its trusted project folder, or its
  verified worktree. The review lists only the project folder's part of the
  repository (a project in `repo/apps/web` sees `apps/web/`). Personal chats
  and folders outside git show "No git repository here".
- **Trust and safe mode.** Every call needs a trusted project (git runs in the
  folder). Reads work in safe mode (`readOnly: true`); every action is refused
  with `SAFE_MODE`.
- **Status.** `git status --porcelain=v2 -z --untracked-files=all
  --no-renames` plus `git diff --numstat` for staged and unstaged counts. One
  entry per path and area (`staged`, `unstaged`, `untracked`); conflicts and
  submodules are listed without actions. At most 2000 entries; paths that are
  not UTF-8 or contain control characters are counted, not shown.
- **Diff.** `git diff [--cached] --binary --full-index -U3 --no-renames` of
  one path. The panel shows it without `index` lines through the transcript's
  diff viewer; binary, too-large (over 512 KiB of diff), symlink, submodule and
  conflict changes are summarized. Untracked files show as new-file diffs from
  a bounded read (256 KiB shown, the first 1 MiB plus size and modification
  time fingerprinted). The diff carries the SHA-256 `fingerprint` of the exact
  output.
- **Actions.** Stage, unstage and revert name the reviewed fingerprint and
  optionally a hunk. The host recomputes the diff, refuses with `STALE` when
  it changed, and applies exactly those bytes (the whole output, or the hunk
  with its `diff --git`/`---`/`+++` lines) with `git apply [--cached]
  [--reverse] --whitespace=nowarn`, which checks every context line again.
  Single hunks are offered only for text files that exist on both sides; new,
  deleted, binary and type-changed files change as a whole. An untracked file
  is staged with `git add` after its fingerprint check. Revert discards
  unstaged changes only (unstage first); a change too large to show is not
  reverted; an intent-to-add file is unstaged first.
- **Nothing is deleted permanently.** Reverting an untracked file moves it to
  the system trash through `piui_platform::move_file_to_trash`: the Windows
  Recycle Bin (`SHFileOperationW` with undo; if the file cannot be recycled
  Windows asks before deleting it and a refusal leaves it in place) or the
  freedesktop.org trash on Linux. Links and folders are refused; macOS has no
  trash support yet and refuses (`TRASH_UNAVAILABLE`).
- **Confirmation.** A revert dialog shows the exact hunk or file diff that
  will be lost (or the file that goes to the Trash) before anything happens.
- **Comments.** "Comment…" on a hunk (keyboard) or the button in front of a
  line (pointer) opens a small form: pick the line, write a note, "Add to
  message". PiUI appends a quoted reference to the chat's draft — `` `path:line` ``
  (or "removed line N"), the line as a quote, then the note — and remounts
  the composer with it. Nothing is sent until the person sends it.
- **Refresh** on demand and when a turn ends (running → idle/closed).

## Worktree chats (`workspace_placement_v1`)

- **Create.** The new chat composer's "Local" chip → "New worktree…" opens a
  dialog with the branch name (a suggested `piui/chat-xxxxxx`, checked by PiUI
  and `git check-ref-format`, refused if it exists), the folder
  `<app data>/worktrees/<project>-<id8>/<folder>` shown home-relative, the
  commit it starts from and a note when the project has uncommitted changes
  (they are not included; nothing is copied). "Use this worktree" keeps the
  choice for the next chat of that project. Sending runs `git worktree add -b
  <branch> <folder> <commit>` with exactly the confirmed branch, folder and
  commit (a moved HEAD or a taken folder is `STALE`), verifies the new
  worktree, records the placement and starts the chat in the project's place
  inside the worktree. If the chat cannot start, the fresh worktree is removed
  (git refuses if anything changed); the branch stays.
- **Trust** follows the project: before each start git confirms that the
  worktree's common git directory is still the project's
  (`rev-parse --git-common-dir`) and that the folder is PiUI's managed one.
- **Details** show the branch (copy), folder, starting commit, "Review
  changes" and "Remove worktree…". The sidebar marks worktree chats with a
  branch icon (and "in worktree <branch>" for screen readers).
- **Remove.** A confirmation names the folder and says the branch stays. A
  worktree with changes or untracked files answers `dirty`: the dialog lists
  them and removal needs an explicit "I understand these N changes will be
  lost" (they are deleted with the folder, not trashed); the host refuses
  when the changes differ from the confirmed ones. Idle chats of that worktree
  are stopped first; a working chat is a conflict. The branch is never
  deleted. An empty folder stays at the old path so harness histories that
  name it stay readable; the chat cannot start again (`WORKTREE_REMOVED`).
  Deleting a worktree chat keeps its worktree (the delete dialog says so).
- **Placement storage.** One JSON file per chat in
  `<app data>/workspace-placement-v1/`, written to a temporary file and
  renamed; unknown fields are refused; a file that cannot be read fails that
  chat's start closed. A placement is written before the chat's registry row
  and removed if the start fails.

## Continue in another harness

Chat menu → "Continue in another harness…" opens Home for the same project
with a banner and an editable draft built only from what the chat shows: the
last request (quoted, up to 1200 characters), the start of the last answer
(600) and, when the review panel was opened for that chat, the changed files.
The template is translated; the quoted history is not. The person picks the
harness and model, edits and sends. The new chat records `continuedFrom` and
its details link back; a worktree chat continues in the same worktree unless
the person picks otherwise. Nothing is converted between history formats and
the source chat is untouched. "Cancel" restores the earlier new-chat draft.

## Continue a terminal Pi session (`workspace_adopt_v1`)

Pi session history → a session → "Continue in PiUI" → a confirmation that
asks to close it in the Pi terminal app first. The host, in a trusted Pi
folder and outside safe mode:

1. checks the folder kind (Prime Agent folders are refused), separate Pi and
   Prime roots and the indexed ownership, header project and stable revision
   of the session file (`admit_session_revision`, then a second observation);
2. refuses when the classic live runtime holds a session of that folder, or
   when the file was written in the last 10 s (`SESSION_ALREADY_ACTIVE`: it may
   still be open in the terminal);
3. returns the chat already bound to that file, or registers a closed Pi chat
   bound to it (placement `adopted`).

The UI then opens it with the ordinary `openSession`, which resumes the file
with `pi --session`. PiUI never writes or renames the session file: an
adopted chat starts without `--name` and keeps its PiUI title unless renamed
in PiUI. Pi appends new turns itself. Concurrent writers from the terminal and
PiUI remain risk R-06: the 10 s check catches an active turn, not an idle
terminal left open.

## Compatibility and rollback

The session registry (`workspace-registry-v11`) keeps its exact format, so an
older PiUI still reads every chat. It does not read placement files: there, a
worktree chat would try to start in the project folder (its native history
names the worktree, so most harnesses refuse or start fresh), an adopted Pi
session would get its PiUI title written into the session file by `--name`,
and handoff links are not shown. Nothing is deleted by the older build.

## UI Lab

`?lab=demo` has a fake repository for `piui` (a staged file, a two-hunk
change, a binary file, a deletion, a new file), a worktree chat "Try a denser
review layout" with uncommitted changes, handoffs and adoption of the demo
history ("Make the session index incremental"; "Draft release notes for 0.2.0"
behaves as still open in the terminal). `?lab=safe` shows the review
read-only. The lab's git is an in-memory model (`host-api/lab/gitFake.ts`).

## Tests

- Rust: git runner, parsers and exact hunk patches on temporary repositories
  (including hooks that must not run, literal pathspecs and CRLF work trees
  under `core.autocrlf`); review, placement
  and adoption host tests with real git and the production bridge runner
  around a test adapter; placement store; the shared contract fixture.
- TypeScript: clients against the fixture, the lab git and fakes, review and
  placement stores, the comment and handoff builders, Russian completeness.
- Playwright (`e2e/session-tools.spec.ts`): review, worktrees, handoffs and
  adoption with their failure paths and keyboard use, and an axe-core audit
  (serious and critical fail) of the new panels and dialogs in both themes.
  Diff line numbers use the faint text token so they keep 4.5:1 contrast in
  the review panel and the transcript.

## Known gaps

- macOS has no trash support; reverting an untracked file is refused there.
- Clean/smudge filters configured for a repository still run during reads.
- Hunks cannot be split or edited; renames show as a deletion and a new file.
- A worktree left behind by a deleted chat has no management screen yet.
- A handoff lists changed files only when the review panel was opened for the
  source chat in this window.
