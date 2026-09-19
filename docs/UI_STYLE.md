# PiUI interface rules

PiUI is a focused desktop workbench. Use charcoal surfaces, restrained burgundy
actions and warm neutral text. Keep the graph and conversation as the main
content. These rules apply to chat, systems, library, settings and dialogs.

- Use `styles/tokens.css` for colors, typography, spacing and radii. The existing
  13px UI base, 4px spacing unit, 6px control radius and 10/16px surface radii are
  the shared scale. Larger text is for conversation reading and page titles.
  Do not add another font, palette or component framework per screen.
- Reserve solid burgundy for the primary action. Use a quiet tinted surface for
  selection; hover, selection and keyboard focus remain distinguishable.
  Avoid decorative gradients, neon glows, oversized cards and heavy outlines.
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


Library lists show the saved name and useful summary: model, members/coordinator,
or tasks/dependencies. Empty lists explain the first action; saved launches use
a named expandable section. Agent role/result metadata, resource permissions and
subagent permissions remain available in named sections. Pipeline tasks have
expandable summaries. Keep refresh secondary to Save, and preserve drafts on
validation or native catalog failures. Model selection in the chat stays a
labelled button without a decorative downward arrow.
