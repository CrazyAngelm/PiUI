import { hostInvoke, hostListen } from './transport';
import { workspaceError } from './workspaceClient';
import {
  CHAT_FILES_EVENT,
  CHAT_FILES_ROUTE,
  type ChatFileKind,
  type ChatFileOrigin,
  type ChatFileV1,
  type ChatFilesChangedEventV1,
  type ChatFilesCommand,
  type ChatFilesListResult,
  type ChatFilesOpenedResult,
  type ChatFilesPreviewResult,
  type ChatFilesResolvedResult,
  type ChatFilesResult,
  type ChatFilesRevealedResult,
  type ChatFilesSavedResult,
} from '../../../../contracts/chat-files-v1';

export type * from '../../../../contracts/chat-files-v1';
export {
  CHAT_FILES_EVENT,
  CHAT_FILES_PROTOCOL,
  CHAT_FILES_ROUTE,
  CHAT_FILE_MAX_IMAGE_PREVIEW_BYTES,
  CHAT_FILE_MAX_MEDIA_PREVIEW_BYTES,
  CHAT_FILE_MAX_PER_SESSION,
} from '../../../../contracts/chat-files-v1';

/**
 * Client of chat files v1 (ADR-074). The WebView never holds a path: it asks
 * for a session's files, then acts on an opaque file id. Results outside the
 * contract are refused, and host refusals map to the shared workspace copy
 * without host details.
 */
const KINDS: readonly ChatFileKind[] = ['image', 'audio', 'video', 'pdf', 'text', 'file'];
const ORIGINS: readonly ChatFileOrigin[] = ['written', 'read', 'generated', 'returned'];
/** Media types a preview may carry: what the host sniffs for an inline player. */
const PREVIEW_TYPES = /^(?:image\/(?:png|jpeg|gif|webp)|audio\/(?:wav|mpeg|ogg|flac|mp4)|video\/(?:mp4|webm|quicktime))$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isFlag = (value: unknown): value is boolean => typeof value === 'boolean';

/** One entry exactly as the contract describes it, or false. */
export function isChatFile(value: unknown): value is ChatFileV1 {
  return isRecord(value)
    && isText(value.id) && typeof value.blockId === 'string' && isText(value.name)
    && KINDS.includes(value.kind as ChatFileKind) && ORIGINS.includes(value.origin as ChatFileOrigin)
    && (value.mediaType === undefined || isText(value.mediaType))
    && (value.size === undefined || (Number.isSafeInteger(value.size) && (value.size as number) >= 0))
    && isFlag(value.openable) && isFlag(value.previewable) && isFlag(value.revealable)
    && (value.unavailable === undefined || isFlag(value.unavailable));
}

/** The result exactly as the contract describes it for `command`, or undefined. */
export function decodeChatFilesResult(command: ChatFilesCommand, value: unknown): ChatFilesResult | undefined {
  if (!isRecord(value) || value.protocol !== 1 || value.sessionId !== command.sessionId) return undefined;
  switch (command.type) {
    case 'list':
      return value.type === 'files' && Array.isArray(value.files) && value.files.every(isChatFile)
        ? (value as unknown as ChatFilesListResult)
        : undefined;
    case 'preview':
      return value.type === 'preview' && value.fileId === command.fileId
        && typeof value.mediaType === 'string' && PREVIEW_TYPES.test(value.mediaType)
        && typeof value.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
        ? (value as unknown as ChatFilesPreviewResult)
        : undefined;
    case 'save':
      return value.type === 'saved' && value.fileId === command.fileId && isFlag(value.saved)
        ? (value as unknown as ChatFilesSavedResult)
        : undefined;
    case 'reveal':
      return value.type === 'revealed' && value.fileId === command.fileId ? (value as unknown as ChatFilesRevealedResult) : undefined;
    case 'open':
      return value.type === 'opened' && value.fileId === command.fileId ? (value as unknown as ChatFilesOpenedResult) : undefined;
    case 'resolve':
      return value.type === 'resolved' && (value.file === null || isChatFile(value.file))
        ? (value as unknown as ChatFilesResolvedResult)
        : undefined;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export async function chatFilesCommand(command: ChatFilesCommand): Promise<ChatFilesResult> {
  let raw: unknown;
  try {
    raw = await hostInvoke<unknown>(CHAT_FILES_ROUTE, { command });
  } catch (error) {
    throw workspaceError(error);
  }
  const result = decodeChatFilesResult(command, raw);
  if (!result) throw workspaceError(undefined);
  return result;
}

/** A host "files changed" event exactly as the contract describes it, or false. */
export function isChatFilesChangedEvent(value: unknown): value is ChatFilesChangedEventV1 {
  return isRecord(value) && value.protocol === 1 && value.type === 'changed' && isText(value.sessionId);
}

/**
 * Calls `handler` with the session id whenever the host says that session's chat files changed (a file
 * was reported, or inline bytes finished writing). The event carries no file: list again. Resolves to
 * the function that stops listening.
 */
export function listenChatFilesChanged(handler: (sessionId: string) => void): Promise<() => void> {
  return hostListen<unknown>(CHAT_FILES_EVENT, (payload) => {
    if (isChatFilesChangedEvent(payload)) handler(payload.sessionId);
  });
}

/** The files a session's registry holds: one entry per reporting block. */
export async function listChatFiles(sessionId: string): Promise<ChatFileV1[]> {
  return ((await chatFilesCommand({ type: 'list', sessionId })) as ChatFilesListResult).files;
}

/** The bytes of a previewable file (base64) and the media type the host proved. */
export async function previewChatFile(sessionId: string, fileId: string): Promise<ChatFilesPreviewResult> {
  return (await chatFilesCommand({ type: 'preview', sessionId, fileId })) as ChatFilesPreviewResult;
}

/** The preview as a `Blob`; the caller makes (and revokes) its `blob:` URL. */
export async function chatFileBlob(sessionId: string, fileId: string): Promise<Blob> {
  const preview = await previewChatFile(sessionId, fileId);
  const binary = atob(preview.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: preview.mediaType });
}

/** Opens the native Save as dialog; false when the person cancelled it. */
export async function saveChatFile(sessionId: string, fileId: string): Promise<boolean> {
  return ((await chatFilesCommand({ type: 'save', sessionId, fileId })) as ChatFilesSavedResult).saved;
}

/** Shows the file in its folder. */
export async function revealChatFile(sessionId: string, fileId: string): Promise<void> {
  await chatFilesCommand({ type: 'reveal', sessionId, fileId });
}

/** Opens the file with the system default application (refused for executable types). */
export async function openChatFile(sessionId: string, fileId: string): Promise<void> {
  await chatFilesCommand({ type: 'open', sessionId, fileId });
}

/**
 * Finds a file the agent mentions by `name`: a file name or a path relative to
 * the session's workspace. The latest reported file of that name wins, then a
 * regular file inside the workspace. `null` when there is none; a name that is
 * absolute, has a drive letter or `..` is refused (`INVALID_ARGUMENT`).
 */
export async function resolveChatFile(sessionId: string, name: string): Promise<ChatFileV1 | null> {
  return ((await chatFilesCommand({ type: 'resolve', sessionId, name })) as ChatFilesResolvedResult).file;
}
