# ADR-068 — Chat tabs, split panes and a collapsible sidebar

Status: accepted, 2026-11-16.

## Context

Only one chat was on screen. Switching meant going back to the sidebar, and
comparing or watching two agents at once was impossible. The sidebar also
could not be hidden, so a wide chat area was never possible on a small window.

## Decision

Opened chats stay as **tabs** above the chat area. Up to **four chats** can be
on screen at once, in **panes** that split left/right and top/bottom. The
sidebar has a Hide button beside New chat. Everything is local UI state: no
host call, no contract, no native history format changes.

### Model

- The **selected chat stays the route** (`{ name: 'chat', sessionId }`). Panes
  do not add a second notion of "current chat". The selected chat is shown in
  the **active pane**; the other panes show chats beside it.
- **Tabs** are an ordered list of chat ids. A tab is not a view of its own: it
  is a shortcut to a chat. Closing a tab or a pane never closes, stops or
  deletes the chat.
- The **layout** is a binary tree (`paneLayout.ts`): a leaf is a pane
  (`id`, `sessionId`), a split has a direction (`row` or `column`), a ratio
  (clamped to 0.2 to 0.8) and two children. Closing a pane makes its sibling
  take the parent's place. A chat is in at most one pane.
- The chat area **draws the tree as one flat keyed list** in reading order,
  each pane placed by the fractions the tree gives it (`placePanes`) and each
  splitter drawn over the seam after the pane it follows. A chat therefore
  stays mounted, with its scroll position, composer and open details, when a
  pane opens or closes beside it. A chat that is itself moved to another edge
  gets a new pane and is mounted again; its reading position comes back from
  the saved one. Drawing the tree as nested elements mounted every chat again
  on each such change.
- A pane that is not the selected chat loads through `store.showSession`
  (the same host calls as `openSession`, own loading and error state, the
  route unchanged). Selecting a chat that is already loaded and on screen is
  `store.focusSession`: no host request.

### Limits

- At most **4 panes** and **12 tabs**. A 13th tab drops the oldest tab that is
  not on screen. A fifth pane is refused (a menu entry is disabled, the
  sidebar action explains in a message).

### Persistence

- `piui.shell.workbench.v1`: `{ tabs, layout, activePaneId }`, written on every
  change and read once. The layout is validated strictly (shape, at most four
  panes, unique pane and chat ids, finite ratio, clamped). A broken value is
  ignored as a whole; nothing is repaired halfway.
- `piui.shell.sidebar`: `collapsed` or `open`.
- The route key `piui.shell.route.v1` is unchanged.
- Tabs and panes of chats that no longer exist are dropped once the catalog has
  loaded without error; an empty catalog from a failed load prunes nothing.

### First paint and lazy code

`AppShell`, `Sidebar`, `NavRail`, the workspace store and `lazyViews` ship in
the first paint and got only the minimum: the sidebar collapse flag and
shortcut, three small store fields (`shownSessions`, `paneLoading`,
`paneErrors`) with `focusSession`, `showSession`, `loadingFor`, `errorFor`, the
sidebar's Hide button, drag source and "Open to the side" entry, the rail's
Show button and the attention dot. All pane and tab logic is in
`app/shell/panes/` and reached by dynamic import: `ChatWorkbench` is the lazy
`chat` view, `TabStrip` the lazy `tabs` view, `workbench.svelte.ts` the state.
`lib/ui/ContextMenu.svelte` is a new primitive (bits-ui ContextMenu with the
`MenuEntry` items and `piui-menu` look of `Menu`).

The merge with master then put the first screen over its budget, so the
new-chat composer no longer ships its pipeline code with it: the executor
picker, the chat-pipeline store and the template helpers are one chunk loaded
right after mount (`chatPipelines/lazyPipelines.svelte.ts`). A plain chip with
the current agent stands in the picker's place until then, and a new chat
waits for the chunk as it already waited for the project's library. If the
chunk cannot load, new chats talk directly with the agent last used, as in
safe mode, the project keeps the executor it remembered, and the chip offers
to load the code again.

### Keyboard

- Mod+B hides or shows the sidebar (not in a narrow window, which keeps its
  drawer). Mod+W closes the selected chat's tab. Ctrl+Tab and Ctrl+Shift+Tab
  select the next and previous tab. F6 and Shift+F6 move to the next and
  previous pane and focus its composer.
- Tabs are a `tablist` with a roving tabindex: arrows, Home and End move
  focus, Enter or Space select, Delete closes, Shift+F10 or the Menu key opens
  the tab menu. A tablist may hold tabs only, so a tab's close button is a
  pointer shortcut outside the tab order and the accessibility tree. A pane
  splitter is a focusable `separator`: arrows move it by 2% (10% with Shift),
  Home resets it to the middle. The tab order is the reading order: a pane,
  the splitter after it, then the next pane.
- Only the active pane handles chat shortcuts (Mod+F, Mod+Alt+B, Mod+Shift+G),
  keeps the page landmark and takes focus when it opens. Other panes are named
  by the chat title.
- Dragging a chat (sidebar row or tab) over a pane shows where it will land:
  the outer quarter of a pane is an edge (a new pane), the middle replaces the
  pane's chat. Every drag action also has a menu entry.

### Narrow windows

At 760px and below the chat area shows the selected chat only, as before; the
layout is kept and returns when the window widens. "Open to the side" is not
offered there. A pane narrower than 720px has no inspector (details, review)
and its header drops the status badge and the project name under 560px.

### Several chats at once

Parts of a chat view that were written for one instance were checked:
element ids already carry the chat id; the composer no longer takes focus when
it opens in a pane that is not active, and files dropped on the desktop window
go to the active pane's composer only. Attention treats every chat in a pane
as seen.

## Left out

- The **same chat in two panes**. One chat has one composer and one draft; a
  second view of it invites conflicting edits. Opening a chat that is on screen
  focuses or moves its pane.
- Panes for **non-chat views** (settings, pipelines, inbox). They are routes,
  not chats, and keep the whole area.
- Tab groups, pinning, tabs across windows and arbitrary-depth layouts beyond
  four panes.

## Consequences

- The chat area is one lazy chunk larger; first paint grew by a few small
  fields and one button each in the sidebar and rail.
- A chat in a pane has its own load and error state next to the selected chat's
  `sessionLoading` and `sessionError`; the store routes an error to whichever
  shows the chat.
- Moving the selection between panes writes the route key, so a restart reopens
  the last focused chat and its panes.
