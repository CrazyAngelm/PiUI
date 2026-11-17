/**
 * Nano Desktop chat files v1 (ADR-074): files the agent writes, reads,
 * generates or returns, shown in the chat with a preview or a file card and
 * the actions Open, Save as and Open containing folder.
 *
 * Independently versioned (`protocol: 1`) beside workspace v15 and composer
 * inputs v1. The WebView never names a path: it sends a session id and an
 * opaque file id the host handed out. The host keeps, per session, a registry
 * of the files that session's own native events (or its native history)
 * reported (at most 200), re-canonicalizes the path on every call, serves
 * regular files only and refuses symlinks and other reparse points. Preview
 * bytes come from the host (base64), are identified by their magic bytes and
 * never by a name, and the frontend turns them into a `blob:` URL it revokes
 * on unmount. Open, Save as and Reveal run in the host; every command refuses
 * safe mode (`SAFE_MODE`). Unknown fields are rejected.
 */
export const CHAT_FILES_PROTOCOL = 1 as const;
export const CHAT_FILES_ROUTE = 'workspace_chat_files_v1';

/** What the bytes are, decided by their first bytes (SVG is a `file`, never an image). */
export type ChatFileKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'file';

/** How the agent used the file in the block that reported it. */
export type ChatFileOrigin = 'written' | 'read' | 'generated' | 'returned';

/**
 * One file shown with one block. A file several blocks touched appears once per
 * block with the same `id`, so every action on it addresses the same file.
 */
export interface ChatFileV1 {
  /** Opaque host id (random, per session). The only handle the WebView holds. */
  id: string;
  /** The timeline block that reported the file (a tool block, usually). */
  blockId: string;
  /** Display name only (the base name, no directories). */
  name: string;
  kind: ChatFileKind;
  /** Media type proven by the bytes (or a short list of text types by extension). */
  mediaType?: string;
  /** Bytes, when the file could be read. */
  size?: number;
  origin: ChatFileOrigin;
  /** False for executable and script types (`.exe`, `.bat`, `.ps1`, ...): Save and Reveal stay. */
  openable: boolean;
  /** True when `preview` can return the bytes: an image up to 20 MB, audio or video up to 64 MB. */
  previewable: boolean;
  /** False for files the host stored itself (inline bytes): there is no folder to show. */
  revealable: boolean;
  /** The file was deleted, moved or replaced by a link since it was reported. */
  unavailable?: boolean;
}

export type ChatFilesCommand =
  /** The files the session's registry holds (at most 200 files), oldest first. */
  | { type: 'list'; sessionId: string }
  /** The bytes of a previewable file, for an inline image, audio or video player. */
  | { type: 'preview'; sessionId: string; fileId: string }
  /** Opens the native Save as dialog and copies the file where the person chooses. */
  | { type: 'save'; sessionId: string; fileId: string }
  /** Shows the file in its folder (Explorer, Finder or the file manager). */
  | { type: 'reveal'; sessionId: string; fileId: string }
  /** Opens the file with the system default application. Refused for executable types. */
  | { type: 'open'; sessionId: string; fileId: string }
  /**
   * Finds a file the agent mentions by `name` (a file name, or a path relative to
   * the session's workspace root): first the registry by base name (the latest
   * wins), then a relative path inside the workspace root, which is registered.
   * Absolute paths, drive letters, UNC paths and `..` are refused (`INVALID_ARGUMENT`).
   * An unknown name is `null`, not an error.
   */
  | { type: 'resolve'; sessionId: string; name: string };

export interface ChatFilesListResult {
  type: 'files';
  protocol: 1;
  sessionId: string;
  files: ChatFileV1[];
}

export interface ChatFilesPreviewResult {
  type: 'preview';
  protocol: 1;
  sessionId: string;
  fileId: string;
  mediaType: string;
  /** Base64 bytes. */
  data: string;
}

export interface ChatFilesSavedResult {
  type: 'saved';
  protocol: 1;
  sessionId: string;
  fileId: string;
  /** False when the person cancelled the dialog: nothing was written. */
  saved: boolean;
}

export interface ChatFilesRevealedResult {
  type: 'revealed';
  protocol: 1;
  sessionId: string;
  fileId: string;
}

export interface ChatFilesOpenedResult {
  type: 'opened';
  protocol: 1;
  sessionId: string;
  fileId: string;
}

export interface ChatFilesResolvedResult {
  type: 'resolved';
  protocol: 1;
  sessionId: string;
  /** Its `blockId` is empty (`""`): a resolved mention belongs to no block. */
  file: ChatFileV1 | null;
}

export type ChatFilesResult =
  | ChatFilesListResult
  | ChatFilesPreviewResult
  | ChatFilesSavedResult
  | ChatFilesRevealedResult
  | ChatFilesOpenedResult
  | ChatFilesResolvedResult;

/**
 * Typed refusals (`{code, message, recoverable}`): `SAFE_MODE`, `NOT_FOUND`
 * (unknown session), `NOT_TRUSTED`, `INVALID_ARGUMENT`, and
 * `CHAT_FILE_UNAVAILABLE` (an unknown or forged id, a deleted or replaced
 * file, a link), `CHAT_FILE_NOT_PREVIEWABLE` (too large or not media),
 * `CHAT_FILE_OPEN_REFUSED` (an executable type) and `CHAT_FILE_FAILED`
 * (the system action did not start).
 */
export type ChatFilesErrorCode =
  | 'CHAT_FILE_UNAVAILABLE'
  | 'CHAT_FILE_NOT_PREVIEWABLE'
  | 'CHAT_FILE_OPEN_REFUSED'
  | 'CHAT_FILE_FAILED';

/** Largest image the host previews. */
export const CHAT_FILE_MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;
/** Largest audio or video file the host previews. */
export const CHAT_FILE_MAX_MEDIA_PREVIEW_BYTES = 64 * 1024 * 1024;
/** Most files one session's registry holds. */
export const CHAT_FILE_MAX_PER_SESSION = 200;
