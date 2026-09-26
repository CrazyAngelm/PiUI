import { hostInvoke, hostListen } from './transport';
import { workspaceError } from './workspaceClient';
import {
  COMPOSER_DROP_EVENT,
  COMPOSER_INPUTS_ROUTE,
  type ComposerAttachmentsResult,
  type ComposerCatalogResult,
  type ComposerDropEvent,
  type ComposerFileReference,
  type ComposerFilesResult,
  type ComposerImage,
  type ComposerImageType,
  type ComposerInputsCommand,
  type ComposerInputsResult,
  type ComposerPreviewResult,
  type ComposerRejection,
  type ComposerRejectionReason,
  type NativeCommand,
  type NativeCommandSource,
  type NativeSkill,
} from '../../../../contracts/workspace-composer-inputs-v1';

export type * from '../../../../contracts/workspace-composer-inputs-v1';

/**
 * Client of composer inputs v1: attachments, `@` project files and native
 * `/` commands and `$` skills. Results outside the contract are refused, and
 * host refusals map to the shared workspace copy without host details.
 */
export const IMAGE_TYPES: readonly ComposerImageType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Largest image the host accepts; checked here only to answer early. */
export const MAX_IMAGE_BYTES = 5_000_000;
const REJECTION_REASONS: readonly ComposerRejectionReason[] = ['not-a-file', 'too-large', 'unreadable', 'not-an-image', 'limit'];
const COMMAND_SOURCES: readonly NativeCommandSource[] = ['command', 'extension', 'prompt', 'skill'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const isImage = (value: unknown): value is ComposerImage =>
  isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
  && IMAGE_TYPES.includes(value.mimeType as ComposerImageType)
  && Number.isSafeInteger(value.size) && (value.size as number) >= 0 && (value.size as number) <= MAX_IMAGE_BYTES;
const isReference = (value: unknown): value is ComposerFileReference =>
  isRecord(value) && typeof value.name === 'string' && typeof value.reference === 'string' && value.reference.length > 0
  && typeof value.inProject === 'boolean';
const isRejection = (value: unknown): value is ComposerRejection =>
  isRecord(value) && typeof value.name === 'string' && REJECTION_REASONS.includes(value.reason as ComposerRejectionReason);
const isCommand = (value: unknown): value is NativeCommand =>
  isRecord(value) && typeof value.name === 'string' && value.name.length > 0 && optionalString(value.description)
  && optionalString(value.hint) && COMMAND_SOURCES.includes(value.source as NativeCommandSource);
const isSkill = (value: unknown): value is NativeSkill =>
  isRecord(value) && typeof value.name === 'string' && optionalString(value.description)
  && typeof value.mention === 'string' && /^[$/]\S+$/.test(value.mention);
const everyItem = <T>(value: unknown, check: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(check);

/** The result exactly as the contract describes it for `command`, or undefined. */
export function decodeComposerInputsResult(command: ComposerInputsCommand, value: unknown): ComposerInputsResult | undefined {
  if (!isRecord(value) || value.protocol !== 1) return undefined;
  switch (command.type) {
    case 'pick':
    case 'paste':
    case 'drop':
      return value.type === 'attachments' && everyItem(value.images, isImage) && everyItem(value.files, isReference)
        && everyItem(value.rejected, isRejection)
        ? (value as unknown as ComposerAttachmentsResult)
        : undefined;
    case 'preview':
      return value.type === 'preview' && value.attachmentId === command.attachmentId
        && IMAGE_TYPES.includes(value.mimeType as ComposerImageType) && typeof value.data === 'string'
        ? (value as unknown as ComposerPreviewResult)
        : undefined;
    case 'discard':
      return value.type === 'discarded' ? { type: 'discarded', protocol: 1 } : undefined;
    case 'files':
      return value.type === 'files' && value.workspaceId === command.workspaceId && value.query === command.query
        && everyItem(value.files, (item): item is string => typeof item === 'string') && typeof value.truncated === 'boolean'
        ? (value as unknown as ComposerFilesResult)
        : undefined;
    case 'catalog':
      return value.type === 'catalog' && value.sessionId === command.sessionId && everyItem(value.commands, isCommand)
        && everyItem(value.skills, isSkill)
        ? (value as unknown as ComposerCatalogResult)
        : undefined;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export async function composerInputs(command: ComposerInputsCommand): Promise<ComposerInputsResult> {
  let raw: unknown;
  try {
    raw = await hostInvoke<unknown>(COMPOSER_INPUTS_ROUTE, { command });
  } catch (error) {
    throw workspaceError(error);
  }
  const result = decodeComposerInputsResult(command, raw);
  if (!result) throw workspaceError(undefined);
  return result;
}

async function attachments(command: Extract<ComposerInputsCommand, { type: 'pick' | 'paste' | 'drop' }>): Promise<ComposerAttachmentsResult> {
  return (await composerInputs(command)) as ComposerAttachmentsResult;
}

/** Opens the native file dialog in the project folder. */
export function pickAttachments(workspaceId: string): Promise<ComposerAttachmentsResult> {
  return attachments({ type: 'pick', workspaceId });
}

/** Redeems one host-observed drop (the paths never reach the WebView). */
export function redeemDrop(workspaceId: string, dropId: string): Promise<ComposerAttachmentsResult> {
  return attachments({ type: 'drop', workspaceId, dropId });
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * Pasted (or browser-dropped) image bytes. A file over the size bound is
 * answered here without sending it; the host sniffs and bounds the rest.
 */
export async function pasteImage(workspaceId: string, file: Blob, name: string): Promise<ComposerAttachmentsResult> {
  if (file.size > MAX_IMAGE_BYTES) {
    return { type: 'attachments', protocol: 1, images: [], files: [], rejected: [{ name, reason: 'too-large' }] };
  }
  const data = base64(new Uint8Array(await file.arrayBuffer()));
  return attachments({ type: 'paste', workspaceId, name, data });
}

export async function previewImage(attachmentId: string): Promise<ComposerPreviewResult> {
  return (await composerInputs({ type: 'preview', attachmentId })) as ComposerPreviewResult;
}

export async function discardImages(attachmentIds: readonly string[]): Promise<void> {
  if (attachmentIds.length) await composerInputs({ type: 'discard', attachmentIds: [...attachmentIds] });
}

export async function projectFiles(workspaceId: string, query: string): Promise<ComposerFilesResult> {
  return (await composerInputs({ type: 'files', workspaceId, query })) as ComposerFilesResult;
}

export async function composerCatalog(sessionId: string): Promise<ComposerCatalogResult> {
  return (await composerInputs({ type: 'catalog', sessionId })) as ComposerCatalogResult;
}

function isDropEvent(value: unknown): value is ComposerDropEvent {
  return isRecord(value) && value.protocol === 1 && ['enter', 'leave', 'drop'].includes(value.type as string)
    && (value.type !== 'drop' || typeof value.dropId === 'string')
    && (value.count === undefined || (Number.isSafeInteger(value.count) && (value.count as number) >= 0));
}

/** OS file drags over the window, as observed by the host. */
export function listenComposerDrops(handler: (event: ComposerDropEvent) => void): Promise<() => void> {
  return hostListen<unknown>(COMPOSER_DROP_EVENT, (payload) => {
    if (isDropEvent(payload)) handler(payload);
  });
}
