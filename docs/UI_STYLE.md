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
