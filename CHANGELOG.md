# Changelog

All notable changes to Nano Desktop (formerly PiUI) are documented here.

Nano Desktop is currently a developer preview. Versions before 1.0 may change without a stable migration promise; changes to typed host contracts remain versioned under `contracts/`.

## [0.3.12] - 2026-11-25

### Added

- **Computer Use in local Claude Code chats.** Work with app windows on Windows and Linux X11. Full access lets the agent capture a window and operate it autonomously. Native permissions use Claude Code's approval settings. Enable or revoke access from the chat's actions menu.

### Fixed

- **Microphone support in the Linux AppImage.** The package now includes the media plug-ins WebKit uses to capture sound.
- **Signed updates from local Linux builds.** The release builder provides the updater keys to the signing stage and checks both Linux packages have update signatures.

## [0.3.11] - 2026-11-22

### Changed

- **One "Running" per chat.** A running chat shows its progress once, in the feed. The header badge now appears only for a failed or closed chat, and only a tab that is out of view spins.

### Fixed

- **Pi starts on Linux when several Node.js versions are installed.** Nano Desktop now runs Pi on the first Node.js that meets Pi's own requirement (22.19 or newer for Pi 1.5) instead of the first one it finds, so an nvm or fnm Node.js is used over an older system one. When none is new enough, Settings → Harnesses names the required and the found version.
- **Pasting a screenshot works on Linux.** The Linux window received an empty paste for a copied image, so nothing was attached; the image is now read from the clipboard and attached as on Windows.
- **Dictation works on Linux.** The app now asks for the microphone when you press dictate; before, Linux silently refused it. The AppImage, whose built-in browser engine records no compressed audio, records WAV instead.

## [0.3.10] - 2026-11-20

### Changed

- **The chat shows what the agent is doing while it writes a long call.** A file or command the model is still composing appears at once as a running step with its name, instead of minutes of "Thinking…".
- **Subagent calls stay in view.** A folded turn lists who the agent called and what it asked of them; a Pi subagent call names the agent and its task.
- **Calls that answered with an error are counted plainly.** A search with no match or a timed-out try reads "Returned an error: N" in a muted color, not a red failure count. A failed turn still says so.
- **Reasoning levels have one name everywhere.** The model picker, the chat chip and the pipeline editors use the same label for each level (Extra high, Max and so on). Pi offers only the levels its model settings allow: a custom model without `thinkingLevelMap` stops at High.

### Fixed

- New and built-in pipelines use the harness's own default model and provider (for Pi, the one Pi starts with) instead of the first model of an older remembered list, which could be a model the account cannot use.
- Agents now start in a plain working folder path. The Windows `\\?\` prefix broke MSBuild, .NET and Node in the agent's commands.

## [0.3.9] - 2026-11-20

### Added

- **Cancel while dictating.** While a voice recording is in progress the message bar holds only **Cancel**, **Stop** and **Send**, as on the web. Cancel works like Esc: a recording shorter than five seconds leaves nothing, a longer one stays as an unsent recording you can still send or delete.

### Changed

- **Branching a Pi chat copies the conversation.** A branch now opens with the earlier messages already in it, as it does for Claude Code and Codex, instead of an empty chat with a text summary in the message box. Branching from a message keeps everything before it. A chat whose session file cannot be found, and Nano chats, still open a linked branch.

### Fixed

- A transcription no longer ends with an invented subtitle credit such as "Субтитры сделал DimaTorzok".

### Internal

- Groundwork for the unified Nano shell lands without any visible change: the shared graph compiler, the second graph kernel protocol and the security core for connected computers (ADR-059 and ADR-080). Nothing in the app uses them yet.

## [0.3.8] - 2026-11-19

### Added

- **Macro keys.** In the list a space opens, the first nine macros carry the digits 1 to 9: press one to insert that macro. In Settings → Macros each macro can also get a **Key**, one letter that inserts it at once from the same list.

### Fixed

- Macro names in the list, the hover card and Settings no longer carry the `//`; the inserted text is still `//name`.
- A long list of macros scrolls inside its menu, follows the arrow keys and no longer runs off the top of the window. The new-chat screen sits lower, so the list has room above the composer.

## [0.3.7] - 2026-11-18

### Added

- **Online updates.** Builds from this version on offer new versions in Settings → About (**Check for updates**, then **Download and restart**). Every download is checked against the key built into the app before it runs. Turn on **Check for updates automatically** to hear about new versions without looking.

## [0.3.6] - 2026-11-18

### Changed

- While the agent works, **Stop** stands where **Send** is; **Send** comes back as soon as you type. A message written during a turn waits in a compact queue, where each one has **Send now** (the agent reads it at its next step) and **Edit**. The "Right away / After this turn" switch is gone.
- Pi extension notices that are service messages (loaded, mode changed, tasks reset, an unsupported request) no longer appear in the chat. An extension error says plainly that the chat keeps working, with the extension's own words under **Details** and **Ask the agent**.
- Releases built on your own computer can publish the signed update feed (`scripts/publish-update.mjs`); the feed address defaults to this repository's `updater` release, so only the key pair is needed.

### Fixed

- While a voice message records there is one send button: it stops the recording and sends what was said.
- The project highlighted in the sidebar is always the project of the open chat; adding a project opens a new chat in it.
- Text of your own messages shows its selection.

## [0.3.5] - 2026-11-18

### Added

- **Files in chat.** Images, audio, video and other files the agent writes, reads or generates appear in the chat with a preview or a file card, and **Open**, **Save as…** and **Open containing folder**. Only files in the chat's own folder, files the agent itself wrote, and files the app stored are shown; installers and scripts are never opened, only saved or shown in their folder (ADR-074).
- **Interactive answers, complete.** Agent widgets now show images, galleries, video and audio players with markers and seeking, crop frames and regions on an image, and formulas. Pictures come only from files of the project or the chat; nothing is loaded from the internet (ADR-077).
- **Links in answers open.** Clicking a link asks in a system dialog, with the full address, before your browser opens it.
- **Formulas** in answers are typeset.
- **Fusion:** change the sidekick's model, reasoning or Fast later, or switch to a sidekick of another agent after detaching the current one. **Resume pair** after Stop pair, send your own correction to the running sidekick, and check or deliver again a report whose delivery is unknown.

### Changed

- Chat text is parsed as full CommonMark and GitHub Markdown: nested lists, code blocks of any fence, tables, escapes and entities render as the agent wrote them, and an unfinished block no longer flickers while it streams (ADR-075).
- Fusion pairs of different agents work in every permission mode: the sidekick is narrowed to at most the lead's writes, commands, network and MCP instead of being refused, and the picker shows what it will be allowed. Reads outside the project are allowed (ADR-076).
- "New chat in <project>" selects that project even when the new-chat screen is already open.

### Fixed

- Pi and Nano no longer show a tool's arguments as an answer, and a reopened chat keeps its reasoning and tools.
- Codex reasoning parts no longer run together; long Codex chats open with all their history.
- A chat held open by another Codex process opens for reading. Resume reconnects when that process releases the chat.
- Codex warning events show their message in the chat timeline.
- An answer split by an ACP tool update stays one message; a cancelled answer is marked stopped.
- A message that starts with a tag such as `<task>` no longer disappears from Claude history; an image-only message keeps its turn.
- A JSON answer is no longer hidden as service data; a failed compaction says so.
- Selecting text while an answer streams no longer scrolls away; the reading position is kept by message.
- Fusion: Stop pair can no longer be undone by a late tool call or an automatic report, and an unconfirmed send never starts a second sidekick.

## [0.3.4] - 2026-11-18

### Added

- Pair Nano Web with this computer to open project pipelines and follow their runs from a phone or another computer. Previously remembered browsers need approval on the computer for the expanded access. Older desktop versions continue to offer their chat workspace.

## [0.3.2] - 2026-11-17

### Added

- **Dictation sources.** Settings → Dictation chooses what turns speech into text: your Nano subscription, OpenAI, Groq, or your own OpenAI-compatible address (for example a local Whisper server). The dictation button now appears without a Nano sign-in once a source is set up. API keys are entered in a system dialog and kept in the Windows credential store; the app's window never sees them (ADR-061).
- **Macros.** Settings → Macros keeps your ready prompts and sets of skills. Press Space in an empty message, or Space twice after text, to open the list of macros; pick one with the mouse or the arrow keys, or type part of its name to narrow the list. The chosen macro takes the place of that space, and Escape closes the list and keeps a plain space. A typed `//name` still works. The macro is highlighted as you type; hover it, or move the caret onto it, to see what it adds and to open it for editing, or press `F2`. Sending replaces it with its text, with skills written the way the chat's agent expects (ADR-060).

- **Remote access from Nano Web.** Settings → Nano turns on access to this computer's chats from the Nano web app on a phone or another computer. A new browser is approved at the computer with a six-digit code shown on both screens; a remembered browser reconnects without asking. It can read and continue chats, answer approvals and pick models, and nothing else: no settings, files, plugins or account actions. Off by default, never in safe mode or when signed out (ADR-062).

### Changed

- Pipelines: **Start** and **Output** are ordinary blocks of the canvas. Drag them, move them with the arrow keys, box-select them or press Arrange; they stay where you leave them and keep their place after Save. A wire dragged to or from Start explains why a step does or does not start with the run, and a declared Output wire is selected and deleted like any other connection.
- While a Fusion pair works, the sidekick's chat is shown under its lead in the chat list without being opened first.
- Russian: the send choice while an agent works reads **В очередь / Сразу** instead of **В очередь / Уточнить ход**.
- A new chat is named after its first message instead of `New Claude Code session`. A Fusion sidekick's chat is named `Sidekick · ` and the name of its lead. An older chat that still has the generated name takes its first message as the name the next time it is opened.
- The reasoning control is a gauge instead of a row of bars: a tapered rail with a stop for each level, a thumb on the chosen one and Auto as its own button beside it. Press and slide along the rail to choose a level. Keyboard and screen-reader behaviour is unchanged.

### Fixed

- Linux: agents and Node.js installed through nvm, fnm, volta, bun, pnpm or a user npm prefix are found when Nano Desktop is started from the desktop menu. A harness that cannot start without Node.js says so instead of "Could not load models", and an agent that lists no models says what to do (ADR-063).
- Pipelines: Delete after clicking an automatic wire no longer removes the step that was selected before. A step moved left of or above the canvas origin keeps its place after reopening and no longer stops Export JSON or Save as template. New steps are no longer created on top of each other, arrow-key moves are kept, and Tab no longer traps keyboard focus inside the canvas.
- Pipelines: clicking an automatic wire after a marquee selection now replaces that selection, so Delete cannot remove several steps; automatic wires are no longer Tab stops. Arrow keys move a marquee selection as a group and the move is kept and can be undone. Tab is no longer swallowed on the canvas in safe mode.
- A message sent into a running turn appears in the chat at once, marked as not read yet. It used to appear only when the agent read it at its next step, which could take half a minute.
- OpenCode models show their reasoning levels in the model picker, in a new chat and in an open one. Each model offers its own levels, and `default` is no longer listed as a level.
- The new-chat harness, model, reasoning, speed and permission picks are remembered as soon as they are made, not when a message is sent. A project without its own choice starts from the latest one, and a harness that was still being checked at startup takes over once it is ready.
- A project that is not trusted yet shows the harness's known models instead of an empty list; the project's own list replaces it after you trust the folder.
- Codex starts when its originator is overridden in the environment (`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`); its version was not recognized and Codex was refused.
- The OpenCode model list no longer waits five seconds for the native listing on every request: known models answer at once and the listing is read again in the background.
- Harnesses you used before load their model lists for the current project in the background, so switching harness shows them at once.

## [0.3.1]

### Added

- Nano's emerald style is the default, with selectable Chaos and declarative plugin styles independent of light/dark appearance.
- Explicit **This computer** and **Nano Cloud** work locations preserve separate execution, files, permissions and histories. The desktop remains useful without a Nano subscription.
- Shared graph, conversation and composer presentation for Desktop and the existing Nano web owners, including rich media, complete-history search, safe fallback and separate printing. Server avatars remain entitlement-controlled and are not bundled for offline use.
- The new-chat executor picker has two tabs, **Direct** and **Pipelines**. A ready pipeline or template becomes the chat's executor instead of opening the editor: the message you send is the input of the pipeline's first element and the pipeline runs automatically. A template is saved as a new pipeline of the project on the first send (ADR-053); a line under the composer says so and a toast confirms it. **Manage pipelines** opens the editor and appears only in the Pipelines tab.
- Model favorites. The model list has **Favorites** and **All models** tabs, a heart on every model, and `Shift+Enter` to toggle the highlighted model. Favorites are a local preference kept per harness.
- **Settings → Harnesses → Connect.** Each harness row has a Connect dialog. For Codex, Claude Code and Pi, Nano Desktop can open a terminal that runs the harness's own sign-in; the app never sees the credentials (ADR-054).

### Changed

- The reasoning control is a rising slanted ramp with one readout; keyboard and screen-reader behaviour is unchanged.
- "Pi session history" is now **Session history**. For Pi and Prime Agent it still shows the native index. For other harnesses it lists chats started in Nano Desktop as read-only transcripts with an **Open chat** button; sessions created in those harnesses' own apps are not discovered.
- **Settings → Harnesses** is a calmer list of rows with details on demand. External model providers (ChatGPT plan and API providers) moved from **Settings → Nano account** to **Settings → Harnesses → Nano → Connect**.

## [0.3.0]

### Added

- The Windows x64 installer and portable build include Nano's Pi runtime, Node, and search tools. Nano includes the BES Deep Mode skill and the `/skill-paths` command.
- OpenCode, Prime Agent, and Goose can show entitled Nano modes alongside their own models on verified Windows releases. The Codex group is available when the selected Nano workspace advertises a verified Responses route.
- On Windows, **Settings → Nano account → External model providers** connects a ChatGPT plan or an HTTPS OpenAI-compatible API key for the Nano harness.

### Changed

- PiUI is now Nano Desktop (ADR-046): the product name, window title, tray, installer and executable (`nano-desktop.exe`) change. Saved data, settings, systems, plugins and native histories keep their names and keep working; nothing is migrated.
- Windows autostart registers the value "Nano Desktop" and removes a stale "PiUI" value when you toggle it.
- Builds are several times faster. The desktop library is built once instead of three times (the unused static and dynamic library outputs each repeated the whole-program optimization), release code generation uses every core, and dev builds keep only line numbers as debug info.
- `target/` is kept between builds as a size-bounded compile cache instead of being deleted after every release. `pnpm build:cache` shows, prunes or removes it, and every release build prunes it.
- `pnpm build:portable` builds only the portable Windows executable for a quick local update and replaces `artifacts/` with it; a copy that is still running is moved aside.
- Less background work. Native harness discovery is reused for 30 seconds (Settings → Harnesses → Check reads the machine again), checking a present project folder no longer writes to the index, the session and project watchers drop irrelevant file events early, and bursts of board, run, Fusion and automation events share one follow-up read.
- Smoother streaming. A streamed token no longer regroups the whole transcript or rebuilds the run graph, the reading position is saved once scrolling settles, and the startup theme check no longer loads the plugin manifest validators.
- The bootstrap, preference, project rename and pin, session catalog and update auto-check commands no longer run on the main thread.
- The Home composer loads the dictation button and the pipeline inputs bar on first use, which brings the first-paint bundle back inside its budget.

### Fixed

- The executor picker no longer repeats a failed pipeline catalog request in a loop; the error stays until the picker is reopened.

## [0.2.11] - 2026-11-11

### Added

- Built-in ACP agents (ADR-045): Gemini CLI (`--acp`), OpenCode, Qwen Code, GitHub Copilot CLI, Goose, Kimi Code and Cursor, next to the descriptors users and plugins add. They are trusted by shipping; sign-in and secret environment names still need your own action and consent.
- Settings → Harnesses shows "Newer than tested" beside an enabled launch action when an installed release is above the tested range (`versionStatus` in the harness summary, additive).
- Windows: an npm shim that points to a native executable, such as OpenCode's `opencode.cmd`, now resolves to that executable without `cmd.exe`.
- A rejected startup request or missing required field of a native harness fails with the typed `native-protocol-mismatch` code.

### Changed

- Only the minimum version of a tested range is enforced for Codex (0.147.0), Claude Code (2.1.0), Prime Agent (0.9.2) and Hermes (0.21.0); a newer release starts. The real gate is the harness identity, the protocol handshake and the settings it applies, which still fail closed. Prime Agent 0.9.5 and Claude Code 3.x, like Codex since 0.2.10, are no longer refused for their version alone.
- ACP agents no longer need a per-version confirmation. Command-line trust for user and plugin descriptors and the per-name consent for secret environment variables are unchanged; a version string never invalidates trust.
- Codex: the `--disable` feature switches follow `codex features list`. A name the CLI no longer registers is dropped; a missing switch that enforces a requested policy stops the start instead of being skipped.
- Native bridges tolerate additions: an unknown well-formed notification, item or content becomes one fallback block per type, documented housekeeping notifications (Codex `configWarning`, `remoteControl/status/changed`, `account/updated`) are ignored, and an unknown server request gets an error reply and is never approved.
- Gemini CLI starts with `--acp` instead of the deprecated `--experimental-acp`.
- The example ACP plugin (`examples/plugins/acp-agent`) adds Auggie, because OpenCode is built in now.
- Pipelines: the editor reopens the last pipeline and the start screen lists saved ones; Save and Mod+S need changes; canvas inputs are colored dots with stable wire colors and per-branch router wiring.
- Shell: Home is a heading and the composer; the palette adds Open automations and Refresh projects; Retry reconnects the event stream; repeated secondary text is gone.

### Fixed

- Harness catalog: a second model picker no longer waits for resource discovery; parallel requests queue their discoveries instead of overwriting each other, and a degraded discovery shows a warning with Retry while keeping the listed models and skills.

## [0.2.10] - 2026-10-31

### Changed

- Native harnesses newer than the tested range now start: only a version older than the audited minimum is refused. Settings -> Harnesses shows a non-blocking "newer than tested" note for Codex and ACP agents. The audited Codex ceiling is 0.166.

### Fixed

- Codex 0.165 reports the Fast tier as `priority`; a default thread no longer shows Standard while running Fast.
- Codex account, queue and hook notifications no longer appear as "Unsupported Codex event" rows.

## [0.2.9] - 2026-10-23

### Added

- Fast mode for Fusion roles (lead and sidekick separately) and the pipeline assistant on models that support it. `FusionRoleV1.serviceTier` is optional; pairs saved by 0.2.8 load unchanged.
- The sidebar nests a Fusion sidekick chat under its lead (collapsible, with a count and the hidden chats' status on the lead).

### Changed

- Calmer transcript: activity groups stay closed until clicked, align with the answer text, list actions in one phrase without "Thought", show `+N −M` edit totals and use the answer's font size; prose line height and inline code are tighter.

### Fixed

- Codex `turn/moderationMetadata` notifications no longer appear as "Unsupported Codex event" rows.

## [0.2.8] - 2026-10-22

### Added

- Fusion (ADR-043, docs/FUSION.md): a new-chat mode that pairs a lead (Claude Code or Codex) with one persistent sidekick (Claude Code, Codex or Pi) in the same folder. The lead gets a `sidekick` tool to brief, wait for, correct, steer, stop and review the sidekick; reports arrive once, as the tool result or as one follow-up when the lead is idle, with PiUI facts (changed files, approvals) kept apart from the sidekick's own text. Pairs never give the sidekick more authority than the lead; a stopped or interrupted round is proven finished before anything else starts, and a restart never replays work.

### Fixed

- Agents of a running pipeline follow the run's saved settings (ADR-044): the host refuses messages, model, settings and mode changes and "allow for this chat" approvals for them. Stopping a turn, renaming and answering a request once still work, and the chat view links to the run instead of showing a composer.

## [0.2.7] - 2026-09-29

### Added

- Sub-pipelines (ADR-042, orchestration v6.7): a saved pipeline can run as one step of another. The step maps the child's inputs (fixed value, run input or an upstream result), starts an ordinary child run and returns the child's declared outputs; an Output block on the canvas declares what a pipeline returns. Runs link parent and child; cancelling the parent cancels the child; cycles and nesting deeper than 4 are refused.
- System file version 5: exports carry sub-pipeline steps (by pipeline name) and outputs; versions 1-4 still import.
- Project board and teammates (ADR-041).

### Changed

- Saving a pipeline that would break another pipeline using it as a sub-pipeline is refused with the affected pipelines named; referenced pipelines cannot be deleted.
- Board and chat pipeline answers use a pipeline's declared outputs when it has them.

## [0.2.6] - 2026-09-28

### Added

- Project board (ADR-041): a per-project kanban that can be turned on or off. Cards have status columns, a drawer with comments and activity, undo, keyboard moves and drag and drop. Agents in chats (Claude Code, Hermes, ACP, Prime, fresh Codex threads) get a `board` tool: they see the chat's active card, check for similar cards before creating one, and never close a card themselves.
- Teammates: addressable `@handle` workers per project, backed by one agent with a model or by a saved pipeline. Assigning a card to a teammate starts a run (asked in the Inbox by default); the result is posted to the card, which moves to In review or Blocked. Runs have a concurrency limit, a persisted queue, a cooldown and a chain-depth limit.

### Fixed

- Pickers and menus opened from dialogs no longer render behind the dialog.

## [0.2.5] - 2026-09-28

### Added

- Chat pipelines (ADR-040): a chat's first message can start a saved pipeline. The composer's "Who answers" chip lists harnesses, the project's pipelines and templates; the chat shows a run card (steps, answer, stop, run again, open run) and continues with the pipeline's answering agent, which receives the result in the next message.
- Pipeline templates for every project or one project: "Save as template…" in the editor; a template opens as an unsaved draft. The Start block can accept chat messages and make a pipeline the project's default for new chats.

### Changed

- Project, permissions and worktree of a new chat share one context chip; the model chip shows only for direct chats.
- Model pickers show the project's last model catalog at once while the harness probe runs; templates open without waiting for models.

## [0.2.4] - 2026-09-28

### Added

- Pipeline assistant: a model picker beside the harness picker, with reasoning levels. A new conversation starts with the chosen model; a running one switches natively and keeps its history. The choice is remembered per harness.

### Changed

- One model picker for the new chat composer, the open chat and the pipeline assistant: capability icons instead of repeated text badges, and reasoning as a slanted level gauge where every level fits (it used to overflow).
- Visual direction "Chaos" (`docs/UI_STYLE.md`): `--piui-chaos-*` accent tokens in every theme.

## [0.2.3] - 2026-09-27

### Added

- Ctrl+K lists the open chat's native `/` commands (Pi extension, prompt-template and skill commands, or another harness's own commands) from the composer's catalog; choosing one puts it in the message box, like the `/` menu.
- Review panel: split a hunk into its separate changes and stage, unstage, revert or comment on one part; staged renames show as one renamed file instead of a deletion and a new file.
- Settings → Worktrees lists the worktrees PiUI created and removes one whose chats were deleted, after showing the uncommitted changes it would lose.

### Changed

- "Continue in another harness" lists the changed files even when the review panel was never opened.

### Fixed

- Plugin panels no longer miss their ready deadline on a busy machine: a loading panel frame stays transparent instead of hidden, so the browser engine does not deprioritize it.
- `pnpm contract:test` in the desktop app runs every contract test again: a duplicated script entry had dropped five of them.

### Removed

- The classic interfaces: the previous workspace shell (`?view=legacy`) and the Pi-only view (`?view=classic`), with the Settings → About "Classic view" row. Everything they offered is in the default interface (see `docs/CLASSIC_PARITY.md`); both URLs now open it.
- The host commands only those views used: the classic live Pi runtime (`start_runtime`, `start_personal_chat`, `send_prompt`, `send_steer`, `send_follow_up`, `abort_runtime`, `stop_live_runtime`, `get_runtime_*`, `set_runtime_*`, `respond_extension_ui`), the fake runtime (`run_fake_scenario`, `start_fake_runtime`, `stop_runtime`), the unversioned duplicates (`bootstrap`, `update_preferences`, `list_extensions`, `set_extension_enabled`, `add_project`, `pick_and_add_project`), `list_sessions`, `list_personal_sessions`, `get_timeline`, `get_tree`, `get_personal_tree` and `probe_system_runtime`. Every other command keeps its name and version.
- The Windows WebView2 E2E `--classic` and `--workspace` scenarios (`test:e2e:classic`, `test:e2e:workspace`).
- Plugin manifest version 2 (version 1 still works unchanged): status-bar items and keyboard shortcuts for a plugin's own commands. PiUI's shortcuts always win, and Settings → Plugins shows every conflict. New example `status-tools`; `pnpm create-plugin` writes version 2.
- MCP tool servers from plugins: once you offer one in Settings → Plugins, new Claude Code, Hermes and ACP agent chats get it for that chat only, started under the same Node.js limits as plugin backends. Your harness settings are never changed; Codex, Pi, Prime Agent and pipeline runs never get plugin servers.
- Chat renderers from plugins: a plugin can show chosen tool calls in its own sandboxed view inside the chat. The plain view is always one click away and takes over when the plugin is off or its view fails. New example `tool-cards`.
- A dialog whose content scrolls can now be scrolled with the keyboard.

### Security

- The guard against the app window showing the plugin panel origin now also covers macOS and Linux: such a page is sent back to the app as soon as it starts loading (Windows still refuses the navigation before it starts), PiUI's own commands refuse calls from it on every platform, and plugin files other than panel pages are served with a sandbox policy.
- Plugin backends run under Node's permission model: a backend reads its own package, reads and writes its data folder, reaches a project folder only with `project.read` / `project.write`, and never starts other programs or worker threads; network access is blocked without `network` when the Node.js in use can block it. Node.js older than 22.13 no longer starts plugin backends. The trust review shows the exact flags and what is enforced, and still says that plugins are trusted code, not a sandbox.

## [0.2.2] - 2026-09-27

### Security

- On Windows the app window refuses to navigate to the plugin panel origin, so a top-level document there can never receive the app's IPC bridge. Panel frames are unaffected.

## [0.2.1] - 2026-09-27

### Added

- Composer attachments: images go to Codex, Claude Code, Pi and Hermes when the harness and model accept them; other files are inserted as path references after a confirmation, never copied into the project. `@` mentions list project files (respecting `.gitignore`), `$` mentions list Codex skills, and the `/` menu shows each harness's own commands.
- Session tools: a git review panel (stage, unstage and revert per hunk or file with the exact reviewed patch; untracked files go to the system trash), chats in their own git worktree, "Continue in another harness" with an editable handoff, and "Continue in PiUI" for a Pi session started in the terminal.
- Plugins v1: installable packages with a trust review, contained Node backends, sandboxed chat panels, palette commands and composer actions, plugin pipeline nodes (orchestration v6.5), themes, templates and ACP agents; a plugin SDK, `pnpm create-plugin` and four examples. Pi Tier 1A commands now appear in the new interface.

### Fixed

- The new-chat composer keeps the chosen harness and model when the catalog refreshes.

## [0.2.0] - 2026-09-27

PiUI is now a desktop workbench for native agent harnesses and multi-agent pipelines, not only a shell for Pi sessions. Harnesses still own inference, tools, credentials and history; PiUI never adds its own agent loop or provider client.

### Harnesses and chat

- New default interface: a sidebar with projects and their chats, Inbox, Pipelines, Runs, Automations and Settings; a composer-first home; a Ctrl+K command palette; dark and light themes; English and Russian copy (Russian loads on demand).
- One chat surface for Codex (app-server 0.147.x–0.157.x), Claude Code (2.1 or a later 2.x release), Pi, Hermes (0.21.0) and Prime Agent (0.9.2–0.9.3), with a harness → model → reasoning picker that uses each harness's own catalog.
- Claude Code runs only on the user's Claude subscription: PiUI starts the installed `claude`, removes API-key and cloud-provider variables, refuses other sign-in methods, keeps fast mode off and stops a session that reports paid extra usage. The composer shows the sign-in status before the first message.
- Codex-style transcript: activity summaries, typed tool rows, unified diffs, inline approvals, Codex MCP form requests as approval cards, a message queue with steer and follow-up, slash commands and in-chat search (Ctrl+F).
- Settings sections for General, Harnesses, Extensions (separate Pi and Prime Agent inventories), Projects (rename, pin, remove, trust), Shortcuts and About. Read-only Pi and Prime history from the index keeps paging, cross-folder search and a branch summary.

### Pipelines, runs and automations

- Pipeline editor on Svelte Flow: agent and router nodes, typed result, route, message, observation and delegation connections, templates (chain, parallel, orchestrator, review loop, router), undo/redo, automatic layout, checks, save and run.
- Run inputs (`{{input.name}}` with a typed start form) and review-loop limits that wait for a person at the limit.
- One-shot model-call nodes and host-run script nodes (Node.js, Python, PowerShell) with a code editor, a "Test script" action and a visible "not a sandbox" warning; a node changes between agent, model call and script in one undoable step.
- A read-only pipeline assistant proposes whole-graph changes that are checked before they apply.
- Runs view: a run canvas with recorded step states, live activity, a step panel (result, conversation, inputs, attempts, usage) and operator actions (approve, reject, run again from a step, cancel, retry, record an outcome).
- Automations: one-time, interval and day-of-week schedules (DST-safe) that start pipelines while PiUI is open; each schedule is turned on separately.

### Reliability

- Native starts no longer hold a global gate, event bursts apply backpressure instead of failing the queue, orchestration reads run off the UI thread and manual runs resume after a restart.
- The browser UI Lab (`pnpm --filter @piui/desktop dev`) answers every host command with a deterministic in-memory fake, with `demo`, `empty`, `safe` and `long` scenarios.
- The previous interface stays reachable from Settings → About (`?view=legacy`) for this release and is removed in the next one.

### Release engineering

- Signed automatic updates are built in but stay off until a release is built with an updater public key and endpoint. Settings → About then shows the version, "Check for updates", release notes and "Download and restart" with a confirmation. The Tauri updater verifies every download against the built-in public key before installing, and background checks happen only after the user turns on "Check for updates automatically" (off by default).
- The release workflow builds Windows (NSIS installer and portable executable), Linux (`.deb` and AppImage) and experimental macOS (universal `.dmg`) packages with SHA-256 checksums, Authenticode signing when a certificate is provided, and a signed update feed when the updater key is provided. Releases stay GitHub pre-releases until the Windows build is code-signed.
- `pnpm repo:check` now fails when the declared PiUI versions disagree or the changelog has no entry for the current version.

### Foundation work since 0.1.1

- Added Host Protocol v10 with explicit Pi versus Prime Agent 0.8.1 project kinds, separate session roots and global extension inventories, bounded future Prime activity contracts, and a Pi-only v9 compatibility surface.
- Added read-only Prime root-session catalogs with multiple distinct sessions per project. Prime live start/continue/prompt/stop now fails closed because 0.8.1 uses a shared detached daemon that the per-runtime supervisor cannot safely own without risking other clients.
- Bounded Prime activity snapshots and UI helper retention to the established 256-event runtime queue, and drop raw `bash_output` chunks before event-channel backpressure while retaining typed terminal summaries.
- Added the missing v10 folder-picker contract, replaced Prime native handshake IDs with opaque catalog IDs at start/event DTO boundaries, and made global extension toggles await and verify runtime settings persistence for both managers.
- Upgraded the static Prime spike to hash the actual `dist/bundle/cli.js` literal local import closure (40 files in the measured 0.8.1 install) and record shared-daemon live control as unauthorized.
- Added a passing repository-target-only Windows Tauri E2E harness. A feature-gated debug-only exact-origin loopback driver replaces unavailable WebView2 CDP, and an outside-Job controller proves an empty Job before bounded fixture removal. The Linux WebKit E2E gate remains open.
- Re-baselined the emitted frontend asset smoke gate to 260 KiB and recorded the current v10 build at 259,817 bytes (6,423 bytes headroom); public 1.0 performance gates remain open.

## [0.1.1] - 2026-07-27

- Added typed Extension UI Protocol v9, a bounded host-side dialog mailbox, declarative contribution discovery, and safe contribution projection for Pi extensions.
- Added runtime command discovery, keyboard slash-command completion, provenance-aware command palette entries, and composer command actions that only draft invocations.
- Replaced the native model control with an accessible, theme-owned searchable picker grouped by provider; unavailable current models remain visible rather than silently changing selection.
- Fixed personal new-chat reconciliation: a selected transient row now resolves to the first durable Pi session without a false persistence error or manual sidebar navigation.
- Added explicit extension fallback, compatibility, command-collision, and new-chat regression coverage; documented the measured frontend asset-budget re-baseline.

## [0.1.0] - 2026-07-26

- Published the initial MIT-licensed public source repository with contribution, security, conduct, issue, and pull-request policies.
- Added an English-first README, a complete Russian README, and English product, architecture, security, testing, and release documentation.
- Added the first unsigned Windows x64 developer-preview release path: an NSIS installer, portable executable, and SHA-256 checksums.
- Replaced the placeholder desktop icon with the PiUI application icon and generated desktop platform assets.
- Added repository privacy auditing, CI, Dependabot, and tag-driven GitHub release automation.
- Added persistent appearance preferences for theme, density, reduced motion, chat text size, and conversation width.
- Added cache-first session discovery, bounded transcript rendering, explicit project trust, personal chats, and typed local Pi RPC streaming.
- Added safe rebuildable indexing, versioned host contracts, extension manifest validation, fake runtime scenarios, and platform/security foundations.

[Unreleased]: https://github.com/CrazyAngelm/PiUI/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/CrazyAngelm/PiUI/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/CrazyAngelm/PiUI/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/CrazyAngelm/PiUI/releases/tag/v0.1.0
