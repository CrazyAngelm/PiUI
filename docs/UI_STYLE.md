# PiUI interface rules

Nano Desktop is a focused desktop workbench. Keep the graph and conversation as
the main content. These rules apply to chat, systems, library, settings and
dialogs in every built-in style and compatible plugin palette.

Built-in styles (2026-11-13): **Nano** is the default, using the personal Nano
web product's «Свет» emerald palette and rounded, quiet markers. **Chaos** keeps
the previous graphite/burgundy palette, crimson/gold accents and slanted markers.
Style is independent of Light, Dark and System appearance. The local
`piui.appearance.style` preference is applied before mounting and needs no account
or network; an existing explicit style choice is preserved. Appearance and plugin
palette selections are not changed when a style is selected. Active v1 plugin
palettes retain the previous base colors for omitted tokens, so existing partial
palettes keep their contrast. Disabling the palette restores the chosen style.

Use semantic colors and `--piui-decoration-*` ornament tokens. The old
`--piui-chaos-*` names retain their original palette for existing consumers and
saved teammate colors. Shapes belong to the style tokens, not literal polygons
in individual screens. Text surfaces stay calm and readable; accents belong to
gauges, current selection and popovers, never a whole screen of glow.

- Use `styles/tokens.css` for colors, typography, spacing and radii. The existing
  13px UI base, 4px spacing unit, 6px control radius and 10/16px surface radii are
  the shared scale. Larger text is for conversation reading and page titles.
  Do not add another font, palette or component framework per screen.
- Use the style's solid action color for the primary action. Use a quiet tinted surface for
  selection; hover, selection and keyboard focus remain distinguishable.
  Gradients and glow belong to style accents (a lit gauge, the current item),
  not to backgrounds of whole panels. Avoid oversized cards and heavy outlines.
- Keep controls compact and labels close to fields. Grow writing areas, not
  every control. Task editing has a large area and a focused modal. Panels
  resize with pointer or keyboard and remember widths.
- Work location uses compact monitor and cloud icons with localized accessible
  names and tooltips, stacked at the bottom of the navigation rail. The local
  indicator stays visibly selected; only the cloud icon is an action.
- Primary navigation is a 48px icon rail at the far left (`--piui-rail-width`):
  New chat, Search, Inbox, Pipelines, Runs, Automations and a More menu for
  other views. Rail buttons have an accessible name and a tooltip, never a
  caption; exactly one carries `aria-current="page"`. The list beside it keeps
  a New chat row, projects with their chats, the account chip and Settings. In
  a narrow window the rail stays and only the list becomes a drawer.
- Show one contextual inspector. Chat details belong to chats; agent settings
  belong to the selected graph node. Do not stack unrelated inspectors.
- Projects have folder icons, consistent rows, hover and selection. Chats use
  a conversation icon. Remove duplicate captions and status noise.
- Use explicit labels: Library, Instructions, Input, Permissions, Resources.
  Do not hide the only configuration path behind Advanced. Secondary details
  can use named sections in the same editor.
- Options come from native catalogs. Select model is a placeholder, not a valid
  choice. Set both text and background for native options in every theme.
- Unsupported resources are visibly read-only. Errors are local and preserve
  drafts. Do not render internal transport events as repeated chat messages.
- Visible UI copy belongs in the locale catalog, English by default with Russian
  support. Do not translate model IDs, prompts, history or user names.
- Keep visible focus, labels, keyboard access and modal focus return. Respect
  reduced motion. Hover cannot be the only way to discover an action.

Verify flows in the native WebView at the user's scale: dropdown contrast,
scrolling, resizing, keyboard access and saved-state restoration. A screenshot
does not prove that a setting reaches the harness.

## Picker tabs and the reasoning gauge

- Pickers that split their list (executor: Direct / Pipelines; model: Favorites /
  All models) use `Segmented size="sm"` placed after the search field, so the
  search keeps initial focus. A non-empty search spans every tab. `ArrowLeft`
  and `ArrowRight` in an empty search switch tabs.
- The reasoning control is a gauge: the group is a `radiogroup` named
  "Reasoning" with radios in order (Auto first), roving tabindex and arrow,
  Home and End selection. Auto is a button with the Sparkles icon docked before
  the rail. Every level is a stop on a tapered rail that thickens toward the
  highest level; each stop keeps a full-height hit area as wide as its share of
  the rail. The rail is filled from its first stop to the selection and a thumb
  sits on the selected stop. Auto, or no selection, leaves the rail empty and
  hides the thumb. A zero level (`off`, `none`) is a hollow stop. One mono
  readout shows the hovered, focused or selected level. Per-stop labels are
  visually hidden but kept for screen readers, and every stop has a tooltip.
- A press can slide along the rail: an outlined ghost thumb and the readout
  preview the stop under the pointer and the release picks it. Hover and
  keyboard focus preview the same way. The thumb itself moves only when the
  level changes. Only the pointer that pressed steers or ends a slide, and the
  click that trails a slide is ignored so it cannot undo the pick.
- Nano and plain plugin ornaments draw a capsule thumb, a round Auto button and
  upright ticks. Chaos and slanted plugin ornaments lean the rail, the ticks,
  the thumb and the Auto button by the existing 12 degrees and square them.
  Tilt and radii come from semantic decoration tokens. The buttons are never
  transformed, and the Auto icon cancels the lean to stay upright.
- Motion on the gauge uses only opacity and transform, at most 180 ms, with a
  reduced-motion guard; no keyframe loops, blur or filters. Set custom
  properties with `style:` directives because the CSP forbids inline `style`
  attributes.

## Chat activity

- A turn reads as replies with one line of work between them (ADR-071). Every
  adjacent reasoning and tool block is one group. Only a reply, a message, an
  error or a compatibility block ends it. Reasoning is a row inside its group,
  never a control of its own.
- A group that is working names the action and its detail ("Running a
  command · pnpm test"). A finished group names what was done, with counts
  and diff totals. Failed and stopped calls are marked on the group.
- A finished turn with two or more groups folds behind one control ("Worked
  for 2m 14s · edited 1 file, ran 4 commands"). Replies stay visible. A turn
  that is running, failed or stopped stays open.
- An opened group is capped at `min(420px, 55vh)` and scrolls inside the
  transcript. A new kind of call gets an icon in `toolIcons.ts` and its
  phrases in `toolKinds.ts`; an unknown tool stays generic.

## Chat details

- The panel leads with what the session runs now (ADR-072), then the chat's
  other agents and context: Activity, Linked chats, origin and worktree, agent
  mode, the pipeline run, plugin panels. Facts and capabilities come last,
  behind the closed native disclosure "About this chat". Capabilities are
  demoted, never deleted: enforcement is part of the trust model.
- Activity groups are Agents, Commands and Other, shown only when they have
  rows; a chat with none says "Nothing is running". A row is a state glyph, a
  one-line title (commands in the mono font), the elapsed time and, for a
  running task the harness can stop, a stop button. Below it a muted line gives
  the detail, tool uses and tokens, and at most two lines say what the task is
  doing now or how it ended. Running rows come first, oldest first, then at most
  six finished ones, latest first; finished rows are dimmed.
- State is never colour alone: a spinner, a check, a cross or a square, each
  with an accessible name (Running, Completed, Failed, Stopped). The glyph is an
  image with that name, not a live region per row. The stop
  button is always visible on a stoppable row, never hover-only; a run member,
  a Fusion sidekick, safe mode and a remote viewer have none. It stays
  focusable and shows a spinner until the harness reports the task stopped;
  when it leaves, focus stays on its row. The list changes only through the
  host's `tasks` event.
- While the panel is closed, a 7px accent dot on its toolbar button and a
  visually hidden status ("2 running in this chat") say that work is running.
  They count native tasks and running agents, not every tool call of a turn.
  The button's name does not change.

## Execution workbench

Use dependency levels for graph layout and group parallel work in the same column.
Selection never follows streaming events automatically. Show details only for the
selected agent; native history is loaded on selection without reopening execution.
Keep the inspector resizable by pointer and keyboard, with persisted width.
Attempts are explicitly selectable; old inputs remain in their native conversation.
Use native token counters with an unavailable dash, including for incomplete totals.
Keep recovery records collapsed except when reconciliation needs attention.

Library menu entries show only their names. Codex editors expose a checked-by-default
Use base prompt checkbox: checked omits baseInstructions (native defaults), unchecked
sends an empty string (no built-in base text). Additional instructions remain separate.
There is no base-prompt text editor; existing imported custom replacements remain in
the portable contract and are preserved until the user changes this setting.

Graph ports support dragging and two-step activation with Enter or Space; Escape
cancels. The selected connection type and direction apply to both ports and the
connection form. Two-way edges persist as two existing directed permissions,
shown with arrowheads at both ends. Each agent pair has one visible line even
when several connection types apply; its tooltip and Connections list retain
the exact type and direction of every permission. Result dependencies remain acyclic and
one-way. Messaging permits sending to the target; observation permits reading
the target's activity; delegation permits spawning the target profile subject
to the existing host permission checks.

Start and Output are blocks of every pipeline with steps: one each, never
steps, never deleted. They are dragged, moved with arrow keys, box-selected,
undone and arranged like step cards and stay where they are until the person
moves them or uses Arrange; their places are editor metadata kept with the step
positions and are not part of the saved definition or of a system file.

Start's wires state a fact: a dashed wire goes to every scheduled step with
nothing before it. They are never drawn or deleted by hand; a wire dragged to
or from Start explains why that step does or does not start with the run. A
dashed wire to Output marks a final scheduled step (routers excluded) and is
drawn whether or not outputs are declared. Clicking a dashed wire selects its
block. None of these wires is saved as a connection or selects a result.

Dragging a scheduled step's result port to Output declares its whole result
text and opens the output settings, where a named field can be chosen instead.
The declared result is a solid wire, selected and deleted like any connection;
deleting it removes the outputs declared from that step as one undoable edit.
Reconnecting the same source preserves its declarations. Collaboration links,
callable agents and router branches are refused. Delete on Start or Output says
that they stay.

Tab opens the Add menu after a click on the empty canvas; with focus on a card
or control it moves focus. New steps are placed beside existing cards, never on
top of them.
Russian interface copy calls a pipeline «конвейер».


Library lists show the saved name and useful summary: model, members/coordinator,
or tasks/dependencies. Empty lists explain the first action; saved launches use
a named expandable section. Agent role/result metadata, resource permissions and
subagent permissions remain available in named sections. Pipeline tasks have
expandable summaries. Keep refresh secondary to Save, and preserve drafts on
validation or native catalog failures. Model selection in the chat stays a
labelled button without a decorative downward arrow.
