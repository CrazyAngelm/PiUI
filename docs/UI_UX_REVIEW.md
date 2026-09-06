# PiUI: UI/UX review and refinement

## Product contract

PiUI should make it easy to choose a project, start or resume a conversation,
read ongoing work, and handle requests without losing context or edits.
Workspace definitions are secondary to ordinary chats. Existing typed host
operations, trust decisions, safe mode, and readable native history remain
authoritative. This pass improves the existing Svelte desktop, without a new
framework, agent harness, visual dependency, or startup network request.

## Assessment

The existing neutral themes, native font stack, labelled controls and separate
session/workspace views are a sound basis. A wholesale visual rewrite would not
address the main usability problems:

- The navigation gave Settings and legacy history nearly the same prominence
  as starting a chat; selected sessions had the same surface as hover states.
- New-chat copy repeated runtime implementation and readiness explanations.
- Project selection could leave another project's chat in the main pane.
- New chat, project changes, session links and legacy history bypassed the
  workspace editor's existing unsaved-change confirmation.
- The conversation grid reserved a row for an optional error: without that
  error, the composer occupied the flexible row. Viewport heights also ignored
  variable-height safe-mode and error banners.
- The new shell lacked follow-to-latest behavior; reading an ongoing chat did
  not have a deliberate position/return-to-latest interaction.
- Windows showed Mac shortcut symbols. Collapsed narrow navigation retained
  keyboard-focusable controls. Modal markup did not itself contain focus.
- Settings offered density and conversation width, but the new shell did not
  consistently apply them to session rows and the composer.

## Implemented direction

Keep a quiet, project-oriented sidebar and give New chat primary emphasis.
Move Settings and indexed history to the utility area. Distinguish the selected
chat from a hovered row; preserve complete titles in accessible text and native
tooltips. State the search scope and offer Clear filters for a filtered empty
list, or Start a chat for a genuinely empty project.

The new-chat form leads with Project and Harness. Availability/setup and model/
permission controls are disclosures. Unsupported choices and their actual
reasons remain inspectable. Trust remains a separate explicit decision, with
its non-sandbox explanation. Failure messages remain visible and retain input.

Changing projects clears an out-of-scope selected chat without stopping it.
Opening a chat from another surface synchronizes its project. Unsaved editors
require Keep editing or Discard changes before route changes. Escape keeps the
editor. Modals contain focus and make the underlying shell inert; inspector
opening moves focus and closing restores its trigger. Narrow hidden navigation
is inert, and keyboard search opens it before focusing the input.

The shell fits the available viewport with independent scrolling regions. The
composer stays below the conversation regardless of optional errors/banners.
Conversation updates follow the end until the reader scrolls up; Back to latest
resumes following. ResizeObserver observes the viewport and content, and is
disconnected with the view. No polling or duplicated transcript state is added.

## Verification boundaries

Unit coverage checks project/session context and platform shortcut labels.
The existing isolated Tauri/WebView2 harness additionally exercises modal focus,
unsaved navigation, native session creation, composer geometry, and following/
reading position. A synthetic content-size fixture is used only for scroll
geometry; it is never persisted as conversation content or described as a
provider response. Native runtime lifecycle remains separately tested.

The initial native test failure reproduced before UI changes. Investigation
found an ambiguous test selector: it selected the sidebar Harness filter
instead of the creation form's Harness. The form now
has explicit control IDs and the test targets them. Failed native creation is
captured as an actual WebView screenshot for diagnosis.

Windows evidence cannot establish Linux WebKitGTK behavior, screen-reader speech
quality, or successful authenticated model responses. Asset-size smoke is not
an idle-RSS measurement. These distinctions must remain in release reporting.

## Deliberately excluded

No decorative animation, external font/icon package, fabricated chat examples,
new account system, or new agent capability is needed to improve these flows.
The existing native system font and semantic color palette are retained.

The same investigation reproduced a real Codex startup failure on Windows:
Rust supplied an extended-length canonical path and Codex returned a drive path
for the same folder. Comparison now normalizes both using Node’s Windows
namespace conversion. The POSIX comparison is unchanged; different workspaces
remain rejected. The regression failed before the fix and passed afterward;
the isolated real adapter then reached Idle and its Job Object closed empty.

## Local verification result

- Svelte/TypeScript check: no errors or warnings.
- Frontend: 150 tests passed; contract command: 22 tests passed.
- Rust workspace: 318 passed, 11 existing ignored tests; clippy and formatting passed.
- Codex adapter: 15 tests passed, including canonical Windows paths and rejection of a genuinely different project.
- Classic native E2E: passed, including generic history fallback, modal keyboard handling and safe mode (`target/piui-evidence/26604-1788697628159/report.json`).
- Native workspace: `target/piui-evidence/28012-1788697591831/report.json`, passed with Codex 0.147.0; normal and safe-mode flows, eight screenshots and complete process cleanup.
- Initial frontend asset graph: 167,623 bytes before the pass; 177,451 bytes after the UI changes, under the existing 266,240-byte smoke ceiling. No new dependency.

Native model turns with user credentials and Linux WebKitGTK were not exercised.
