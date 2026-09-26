/**
 * PiUI composer inputs v1: attachments, `@` project file mentions and
 * harness-native `/` commands and `$` skills for the chat composers.
 *
 * Independently versioned (`protocol: 1`) beside workspace v15 and composer
 * v19. Native ids, session paths, credentials and file contents never cross
 * this boundary. The host reads only a file the user picked in the native
 * dialog or dropped on the window, keeps image bytes in PiUI's app data until
 * their message is delivered or removed, and never copies anything into a
 * project. Nothing here executes a native command: `/` and `$` entries are
 * text the harness itself interprets when the message is sent.
 */
export const COMPOSER_INPUTS_PROTOCOL = 1 as const;
export const COMPOSER_INPUTS_ROUTE = 'workspace_composer_inputs_v1';
/** Host-observed OS file drops on the main window (paths stay in the host). */
export const COMPOSER_DROP_EVENT = 'piui://composer-drop-v1';

/** Image formats sent natively. The host sniffs the bytes; a file name never decides. */
export type ComposerImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** An image held in PiUI's app data for a pending send. */
export interface ComposerImage {
  /** Opaque host id (a UUID); send it in composer v19 `send.attachments`. */
  id: string;
  /** Display name only (no directories). */
  name: string;
  mimeType: ComposerImageType;
  /** Bytes, at most 5,000,000. */
  size: number;
}

/**
 * A picked or dropped non-image file. It is inserted as a path reference in
 * the message text after the user confirms; nothing is read, uploaded or copied.
 */
export interface ComposerFileReference {
  name: string;
  /** Text to insert: `@relative/path` inside the project, else the absolute path. */
  reference: string;
  inProject: boolean;
}

export type ComposerRejectionReason =
  /** A folder, device or other non-regular file. */
  | 'not-a-file'
  /** An image above 5,000,000 bytes. */
  | 'too-large'
  | 'unreadable'
  /** Pasted bytes that are not a PNG, JPEG, GIF or WebP image. */
  | 'not-an-image'
  /** More than 10 files in one pick or drop, or PiUI's pending image store is full. */
  | 'limit';

export interface ComposerRejection {
  name: string;
  reason: ComposerRejectionReason;
}

export type ComposerInputsCommand =
  /** Opens the native file dialog (several files, starting in the project folder). */
  | { type: 'pick'; workspaceId: string }
  /** Clipboard image bytes (base64). Only PNG, JPEG, GIF or WebP are accepted. */
  | { type: 'paste'; workspaceId: string; name: string; data: string }
  /** Files of one host-observed OS drop (`ComposerDropEvent.dropId`), at most once. */
  | { type: 'drop'; workspaceId: string; dropId: string }
  /** The bytes of a pending image, for its thumbnail. */
  | { type: 'preview'; attachmentId: string }
  /** Deletes pending images that were not sent. */
  | { type: 'discard'; attachmentIds: string[] }
  /**
   * Project-relative file paths for `@` mentions of a trusted project:
   * `.gitignore`d, hidden and dependency folders are skipped, links are not
   * followed, no contents are read. `query` (at most 256 characters) narrows
   * the walk by a case-insensitive subsequence match; the UI ranks the result.
   */
  | { type: 'files'; workspaceId: string; query: string }
  /** Native `/` commands and `$` skills a live session reports. */
  | { type: 'catalog'; sessionId: string };

export interface ComposerAttachmentsResult {
  type: 'attachments';
  protocol: 1;
  images: ComposerImage[];
  files: ComposerFileReference[];
  rejected: ComposerRejection[];
}

export interface ComposerPreviewResult {
  type: 'preview';
  protocol: 1;
  attachmentId: string;
  mimeType: ComposerImageType;
  /** Base64 image bytes. */
  data: string;
}

export interface ComposerDiscardResult {
  type: 'discarded';
  protocol: 1;
}

export interface ComposerFilesResult {
  type: 'files';
  protocol: 1;
  workspaceId: string;
  query: string;
  /** `/`-separated project-relative paths, at most 2,000. */
  files: string[];
  /** More files matched, or the walk stopped at its bound. */
  truncated: boolean;
}

/**
 * Where a native command comes from. Pi reports `extension`, `prompt` and
 * `skill`; Claude Code and ACP agents report plain `command`s.
 */
export type NativeCommandSource = 'command' | 'extension' | 'prompt' | 'skill';

/** A slash command the harness runs itself when a message starts with `/<name>`. */
export interface NativeCommand {
  /** Without the leading slash, e.g. `review` or `skill:release-notes`. */
  name: string;
  description?: string;
  /** Native argument hint, e.g. `<file>`. */
  hint?: string;
  source: NativeCommandSource;
}

/** A skill the harness resolves from its own mention syntax in the message text. */
export interface NativeSkill {
  name: string;
  description?: string;
  /** The exact text to insert, e.g. Codex `$skill-name`. */
  mention: string;
}

export interface ComposerCatalogResult {
  type: 'catalog';
  protocol: 1;
  sessionId: string;
  /** At most 500. */
  commands: NativeCommand[];
  /** At most 500. */
  skills: NativeSkill[];
}

export type ComposerInputsResult =
  | ComposerAttachmentsResult
  | ComposerPreviewResult
  | ComposerDiscardResult
  | ComposerFilesResult
  | ComposerCatalogResult;

/** An OS drag over or drop on the window. Paths never leave the host. */
export interface ComposerDropEvent {
  protocol: 1;
  type: 'enter' | 'leave' | 'drop';
  /** Present on `drop`: redeem once with `{type:'drop'}` within a minute. */
  dropId?: string;
  /** Number of dropped paths (on `enter` and `drop`). */
  count?: number;
}
