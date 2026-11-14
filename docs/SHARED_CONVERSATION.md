# Shared conversation presentation

The shared boundary in [Nano unification](NANO_UNIFICATION.md) extracts Desktop's existing
transcript and approval presentation without changing native history formats,
runtime ownership or the existing isolated Cloud window.

`app/chat/transcript/Transcript.svelte` remains the native entry point used by
chat, history and run inspection. It supplies native history reads, the trusted
plugin registry and the existing sandboxed plugin frame. The display is
`shared/conversation/ConversationTranscript.svelte`; activity grouping, tool
rows, Markdown, diffs and Fusion brief cards remain the existing components.
`ApprovalCard.svelte` similarly keeps workspace-store dispatch and native
run/Fusion restrictions while rendering the shared `ApprovalRequest.svelte`.

The browser entry is `packages/nano-ui/src/conversation.ts`. Its separate
`vite.conversation.config.ts` build emits `dist-conversation/nano-conversation.js`,
`nano-conversation.css` and `conversation-manifest.json`. It does not add
conversation code to the graph artifact. The build rejects native/Lab transports,
native plugin frames and the Desktop global locale. CSS, locale, tooltip portals
and form IDs belong to each mounted island. The host owns and constrains the
mount element; the transcript owns its internal scroll region.

## Owner contract

`contracts/conversation-presentation-v1.ts` is an in-memory presentation API.
`TimelineBlock` and `WorkspaceApproval` are existing projections, not a second
stored chat format. An owner explicitly identifies its location, account/workspace
scope and session. It supplies snapshots and optional history, approval,
attachment-opening, reconnect and per-message operations. No operation implies HTTP, native
IPC, a Lab host or authority to use another owner's files. Attachment metadata
contains opaque IDs and labels; only the owner resolves or previews them.

`update(identity, snapshot)` accepts only the current owner. `setOwner` retires
and aborts prior operations before publishing another owner. An invalid owner
transition retires the previous owner as well. A stale operation cannot apply
history, notification or approval failure to a new session. A reconnect result
cannot replace a streaming snapshot delivered after that reconnect began.
Snapshots remain authoritative: an approval acknowledgement alone does not remove
a request from the display. The owner must publish its resulting state.

Stage 6 adds optional `messageControls` and `actOnMessage`. Controls bind an
opaque content/reference ID to a displayed block and list available copy, edit,
branch, repeat and refresh actions, plus owner-formatted usage. The owner resolves
the current target and checks eligibility again before dispatch. Each rendered
button retains its original owner generation and control ID, so an old DOM node
cannot borrow a replacement owner's authority before the next render. Pending
duplicates are refused per action; a pending copy does not block an eligible edit.
Failures stay with the current content and owner. The
renderer never implements clipboard policy, branching, billing or message delivery.
An absent controls field preserves native copy/full-answer behavior; an explicitly
present array delegates the footer to the owner. These additive fields do not
change native IPC or persisted history.

The Blazor owner uses its existing actions: edit places text in the composer
without sending; repeat starts a new turn; interrupted refresh reads state without
resending. Copy feedback and branch placement/navigation are also fenced after
awaits, including a departure and return to the same conversation or workspace
tab. Pending branch admission survives those presentation changes for its original
account/session until the operation finishes. Header, footer and polling recovery
share one quiet history read per owner, preventing an older response from erasing
a recovered answer. Detached temporary-chat cleanup retains its original account
context and storage key without taking navigation back from the user.

The shared surface has no implicit transport. Explicit media/header decoration
ports may start owner-authorized display work on mount. Reading history is optional;
without that port, search covers only the supplied snapshot. Reconnection is
explicit, owner-provided and never starts an internal retry loop. Missing
approval/opening capabilities leave the corresponding actions unavailable. Safe
mode and signed-out policy remain native-owner decisions; the shared display
cannot bypass them.

Reading-position persistence is an optional internal native-wrapper store. The
shared browser surface receives no store and never persists account/session
identifiers, including when it displays a temporary cloud chat. Search without
a full-history port follows the owner's current loaded window as it streams or
pages older messages.

## Rich presentation, composer and print

Optional media ports resolve owner-authorized images, audio and video, and keep
Open and Download separate. Paging and full-history search invoke existing owner
reads; a window-only owner still searches only its supplied snapshot. Trusted
message decorators reuse existing safe code/math/widget renderers. They preserve
unchanged widget state and immediately retire removed controls. Off-window search
never grants a historical widget execution authority.

`decorateMessageHeader` receives a separate empty element for the owner's
existing author/date presentation. The web uses its existing Blazor face/pet
component there; native presentation does not acquire a new cloud dependency.
Generic author text remains until the host marks its slot active. All decoration
operations share the current owner generation and disposal boundary.

`contracts/composer-presentation-v1.ts` and `shared/composer/` share keyboard,
auto-grow and visual rules on owner-managed textarea DOM. Native mention/slash
menus retain priority. The web keeps its Razor textarea, InputFile, voice controls
and original IDs. The module neither assigns draft text nor stores files or
request identities. Native queues, Fusion and pipelines, and web send/steer/voice
semantics remain in their existing controllers.

Print mode renders every supplied block, including expanded generic tool text,
without live actions, approval controls or interactive windowing. The owner
collects complete history and resolves authorized resources into a separate print
frame. `ready()` flushes Svelte DOM; the owner separately awaits header/media/font
work. This does not switch the live renderer, change its scroll or touch a draft.

## Owner boundaries and verification

History read failure is separate from connection state: Retry history must not
disable an approval for a connected turn. Existing owner requests to reveal the
latest message use `scrollToEnd(force, smooth)`; ordinary updates respect a
reader who scrolled up. Group owners opt into polite additions on the message
log, leaving search and other controls outside that live region.

Rich Markdown images are typed inert placeholders. The shared component has no
image-loading authority: only the existing trusted web decorator validates a URL
and creates its image in an empty owner slot. Native rendering does not fetch
Markdown images. Failed or unsafe media remains readable as its alternative text.
Bare HTTP links follow the same existing web-owner link policy.

Stage 8 enables the shared presentation by default for personal, temporary,
guest/support, group and voice owners while preserving their distinct services
and admission rules. Empty new/guest views retain their existing introduction
until a message exists. A failed shared module restores usable owner presentation
and editor behavior. Presentation identity is independent of draft persistence;
a guest or support view does not gain persistence or ordinary account authority.

Group polling, target order, rounds and cancellation remain group operations.
Voice recording, signaling, speaker/microphone controls, retries and transcript
updates remain voice operations. OfficeView, document versions, Results and live
browser/document controls stay web-owned. Native extensions, custom tool frames,
harness permissions, histories and queues stay native-owned. These are deliberate
platform boundaries, not unfinished copies of the shared transcript.

The stage ledger records final checks and their actual or synthetic boundaries.
No provider turn, deployment or installed-application replacement is implied by
owner fixtures. Stage 8 implementation and its four-review gate are complete;
the recorded checks are not a release or installer claim.
