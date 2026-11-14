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

## Picker tabs and the reasoning ramp

- Pickers that split their list (executor: Direct / Pipelines; model: Favorites /
  All models) use `Segmented size="sm"` placed after the search field, so the
  search keeps initial focus. A non-empty search spans every tab. `ArrowLeft`
  and `ArrowRight` in an empty search switch tabs.
- The reasoning control is a rising ramp: the group is a `radiogroup`
  named "Reasoning" with radios in order (Auto first), roving tabindex and
  arrow, Home and End selection. Each radio keeps a full-height hit area; the
  visible bar is anchored to the bottom, its height growing with rank. Nano and
  plain plugin ornaments use straight bars with the selected corner radius; Chaos and slanted plugin
  ornaments use the existing 12-degree slant. Tilt, overhang and radii come from
  semantic decoration tokens; the hit area shares the bar's transform and the
  Auto label cancels that transform to stay upright. Every bar up to the
  selection is lit, the selected bar has the style's accent cap,
  and zero levels (`off`, `none`) are a short dash that a higher selection never
  lights. One mono readout shows the hovered, focused or selected level.
  Per-step labels are visually hidden but kept for screen readers.
- Motion on the ramp uses only opacity and transform, at most 180 ms, with a
  reduced-motion guard; no keyframe loops, blur or filters. Set custom
  properties with `style:` directives because the CSP forbids inline `style`
  attributes.

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

With no declared outputs, the graph draws completion links from scheduled
steps with no downstream result dependency, excluding routers. These links
are visual only; they are not saved as connections and do not select results.
When there are declared outputs, the graph shows links from their sources.

Dragging a scheduled step's result port to the pipeline Output block declares
its whole result text and opens the output settings, where a named field can be
chosen instead. Reconnecting the same source preserves its declarations. This
is one undoable edit to the pipeline outputs, not a dependency or executable
step; collaboration links, callable agents and router branches are refused.
Russian interface copy calls a pipeline «конвейер».


Library lists show the saved name and useful summary: model, members/coordinator,
or tasks/dependencies. Empty lists explain the first action; saved launches use
a named expandable section. Agent role/result metadata, resource permissions and
subagent permissions remain available in named sections. Pipeline tasks have
expandable summaries. Keep refresh secondary to Save, and preserve drafts on
validation or native catalog failures. Model selection in the chat stays a
labelled button without a decorative downward arrow.
