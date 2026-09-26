/**
 * PiUI workspace extension UI surface, version 1 (additive; workspace v15 is
 * unchanged). Native extensions can show transient UI without asking a
 * question: Pi RPC `extension_ui_request` methods `notify`, `setStatus`,
 * `setWidget`, `setTitle` and `set_editor_text`. The host projects each one
 * to bounded plain text with opaque ids and keys and emits it on
 * `piui://workspace-extension-ui` for the owning opaque session.
 *
 * Events are ephemeral presentation state: they are not persisted, not
 * replayed and not part of the session revision stream. No field carries
 * HTML, a native path, a raw request id or a native value; renderers show
 * the text as text. Dialog methods (`select`, `confirm`, `input`, `editor`)
 * are answerable requests and stay workspace v15 approvals.
 */
export const WORKSPACE_EXTENSION_UI_PROTOCOL = 1 as const;
export const WORKSPACE_EXTENSION_UI_EVENT = 'piui://workspace-extension-ui';

export type WorkspaceExtensionUiAction =
  /** A notice; `id` is opaque and repeats for a repeated request. */
  | { action: 'notify'; id: string; message: string; level: 'info' | 'warning' | 'error' }
  /** Sets (text present) or clears (text absent) one keyed status line. */
  | { action: 'status'; key: string; text?: string }
  /** Sets (lines present) or clears (lines absent) one keyed widget. */
  | { action: 'widget'; key: string; lines?: string[]; placement: 'aboveEditor' | 'belowEditor' }
  /** The window title the extension asks for; empty text resets it. */
  | { action: 'title'; title: string }
  /** Text the extension prepared for the composer; never sent without the user. */
  | { action: 'editorText'; text: string }
  /** A request PiUI cannot show safely; only a fixed summary crosses. */
  | { action: 'unsupported'; id: string; method: string; safeSummary: string };

export interface WorkspaceExtensionUiEventV1 {
  protocol: 1;
  /** Opaque PiUI session id (workspace v15). */
  sessionId: string;
  action: WorkspaceExtensionUiAction;
}
