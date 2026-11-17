import type { ChatFileV1, ChatFilesCommand, ChatFilesResult } from './labContracts';
import { workspaceFailure } from './labErrors';
import { requireRecord } from './labGuards';
import type { LabHandlers } from './labHandlers';
import { isUuid, labUuid } from './labRandom';
import { decodeArgument } from './labSchema';
import { chatFilesCommandSchema } from './labSchemas';
import { verifiedProject, type LabState } from './labState';
import { LAB_PROJECT_FILES, LAB_SCREENSHOT_PNG } from './composerInputsFake';
import type { LabSessions } from './sessionRuntime';

/**
 * Chat files v1 (`workspace_chat_files_v1`, ADR-074) for the UI Lab. It mirrors
 * the host rules (safe mode, ids the host handed out, previews only for media,
 * Open refused for programs, mentions that are plain relative names) with fixed
 * synthetic bytes: no file is read, no dialog opens and nothing is started.
 * Every call is recorded on `window.__piuiLabChatFiles` for the e2e specs,
 * because Save as and Reveal have no visible effect in a browser.
 */
export const LAB_CHAT_FILES_SESSION_TITLE = 'Route host calls through one transport';

export interface LabChatFilesRecord {
  calls: { type: ChatFilesCommand['type']; fileId?: string; name?: string }[];
}

declare global {
  interface Window {
    /** Read by Playwright; the Lab is the only writer. */
    __piuiLabChatFiles?: LabChatFilesRecord;
  }
}

/** A tiny silent WAV (8 kHz, 8-bit, 0.1 s), built here so no binary is checked in. */
function silentWav(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return btoa(String.fromCharCode(...bytes));
}

interface LabFile {
  file: ChatFileV1;
  /** Base64 bytes of a previewable file. */
  data?: string;
}

/** A name the host would accept as a mention: relative, no drive, no `..`, no control characters. */
function mentionComponents(name: string): string[] | undefined {
  const unified = name.trim().replaceAll('\\', '/');
  if (unified === '' || name.length > 512 || /[\u0000-\u001f\u007f]/u.test(name)) return undefined;
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified) || unified.includes(':')) return undefined;
  const parts = unified.split('/').filter((part) => part !== '' && part !== '.');
  return parts.length === 0 || parts.includes('..') ? undefined : parts;
}

/** The files the lab's one demo chat reports, each with the tool block that "wrote" it. */
function demoFiles(state: LabState, sessionId: string): LabFile[] {
  const record = requireRecord(state, sessionId);
  if (record.title !== LAB_CHAT_FILES_SESSION_TITLE) return [];
  const block = record.blocks.find((candidate) => candidate.kind === 'tool' && candidate.toolName === 'fileChange')
    ?? record.blocks.find((candidate) => candidate.kind === 'tool');
  if (block === undefined) return [];
  const make = (name: string, rest: Omit<ChatFileV1, 'id' | 'blockId' | 'name' | 'revealable'>, data?: string): LabFile => ({
    file: { id: labUuid(`chat-files:${sessionId}:${name}`), blockId: block.id, name, revealable: true, ...rest },
    data,
  });
  return [
    make('transport-diagram.png', { kind: 'image', mediaType: 'image/png', size: 156, origin: 'generated', openable: true, previewable: true }, LAB_SCREENSHOT_PNG),
    make('narration.wav', { kind: 'audio', mediaType: 'audio/wav', size: 844, origin: 'generated', openable: true, previewable: true }, silentWav()),
    make('transport.ts', { kind: 'text', mediaType: 'text/plain', size: 2048, origin: 'written', openable: true, previewable: false }),
    make('install-helper.exe', { kind: 'file', mediaType: 'application/octet-stream', size: 4096, origin: 'written', openable: false, previewable: false }),
  ];
}

/** Files a mention registered, like the host's block-less registry entries. */
const mentioned = new WeakMap<LabState, Map<string, LabFile[]>>();
function mentionedFiles(state: LabState, sessionId: string): LabFile[] {
  let bySession = mentioned.get(state);
  if (bySession === undefined) {
    bySession = new Map();
    mentioned.set(state, bySession);
  }
  let files = bySession.get(sessionId);
  if (files === undefined) {
    files = [];
    bySession.set(sessionId, files);
  }
  return files;
}

function logCall(command: ChatFilesCommand): void {
  if (typeof window === 'undefined') return;
  const log = (window.__piuiLabChatFiles ??= { calls: [] });
  if ('fileId' in command) log.calls.push({ type: command.type, fileId: command.fileId });
  else if (command.type === 'resolve') log.calls.push({ type: 'resolve', name: command.name });
  else log.calls.push({ type: command.type });
}

function resolveMention(state: LabState, sessionId: string, name: string): ChatFileV1 | null {
  const parts = mentionComponents(name);
  if (parts === undefined) throw workspaceFailure('INVALID_ARGUMENT');
  const last = (parts[parts.length - 1] ?? '').toLowerCase();
  const known = [...demoFiles(state, sessionId), ...mentionedFiles(state, sessionId)];
  // The registry first: the latest file with this name wins; a mention belongs to no block.
  // The demo files live in no folder, so only a bare name can match one.
  const match = parts.length === 1 ? [...known].reverse().find((candidate) => candidate.file.name.toLowerCase() === last) : undefined;
  if (match !== undefined) return { ...match.file, blockId: '' };
  // Then a regular file of the project.
  const path = parts.join('/');
  if (!LAB_PROJECT_FILES.includes(path)) return null;
  const pdf = path.endsWith('.pdf');
  const file: LabFile = {
    file: {
      id: labUuid(`chat-files:${sessionId}:mention:${path}`),
      blockId: '',
      name: parts[parts.length - 1] ?? path,
      kind: pdf ? 'pdf' : 'text',
      mediaType: pdf ? 'application/pdf' : 'text/plain',
      size: 1024,
      origin: 'returned',
      openable: true,
      previewable: false,
      revealable: true,
    },
  };
  const files = mentionedFiles(state, sessionId);
  if (!files.some((candidate) => candidate.file.id === file.file.id)) files.push(file);
  return file.file;
}

function chatFiles(runtime: LabSessions, command: ChatFilesCommand): ChatFilesResult {
  const { state } = runtime;
  if (state.safeMode) throw workspaceFailure('SAFE_MODE');
  if (!isUuid(command.sessionId)) throw workspaceFailure('INVALID_ARGUMENT');
  const session = requireRecord(state, command.sessionId);
  verifiedProject(state, session.workspaceId, true);
  logCall(command);
  const sessionId = command.sessionId;
  if (command.type === 'list') {
    return { type: 'files', protocol: 1, sessionId, files: demoFiles(state, sessionId).map((candidate) => candidate.file) };
  }
  if (command.type === 'resolve') {
    return { type: 'resolved', protocol: 1, sessionId, file: resolveMention(state, sessionId, command.name) };
  }
  if (!isUuid(command.fileId)) throw workspaceFailure('INVALID_ARGUMENT');
  const found = [...demoFiles(state, sessionId), ...mentionedFiles(state, sessionId)].find((candidate) => candidate.file.id === command.fileId);
  if (found === undefined) throw workspaceFailure('CHAT_FILE_UNAVAILABLE');
  const fileId = command.fileId;
  switch (command.type) {
    case 'preview':
      if (!found.file.previewable || found.data === undefined || found.file.mediaType === undefined) throw workspaceFailure('CHAT_FILE_NOT_PREVIEWABLE');
      return { type: 'preview', protocol: 1, sessionId, fileId, mediaType: found.file.mediaType, data: found.data };
    case 'save':
      // The lab's "dialog" always accepts.
      return { type: 'saved', protocol: 1, sessionId, fileId, saved: true };
    case 'reveal':
      return { type: 'revealed', protocol: 1, sessionId, fileId };
    case 'open':
      if (!found.file.openable) throw workspaceFailure('CHAT_FILE_OPEN_REFUSED');
      return { type: 'opened', protocol: 1, sessionId, fileId };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function chatFilesHandlers(runtime: LabSessions): LabHandlers {
  return {
    workspace_chat_files_v1: (args) => chatFiles(runtime, decodeArgument<ChatFilesCommand>(args, 'command', chatFilesCommandSchema)),
  };
}
