# Shared conversation presentation

Stage 5 of [Nano unification](NANO_UNIFICATION.md) extracts Desktop's existing
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

The shared surface makes no requests on mount. Reading history is optional;
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

## Parity boundary

The shared browser surface is a presentation experiment, not a replacement for
all native or Blazor chat workflows. Existing native composer, attachments and
provider transport retain their owners. The opt-in Blazor adapter keeps its
existing composer, uploads, SSE, history paging, preview and approval services.
Cloud search over a windowed projection must not be described as full-history
search. Native plugin/custom tool rendering is only supplied by the native
wrapper; the browser artifact keeps the generic readable fallback.

The remaining migration scenarios are composer parity, pagination and
full-history search, inline media and preview/download behavior,
provider-specific extension UI, native plugin panels and accessibility/layout
parity across the complete legacy screen. These must be checked in their owning
application before replacing that screen. No provider turn, deployment or
installed application replacement is implied by the synthetic owner fixtures.
