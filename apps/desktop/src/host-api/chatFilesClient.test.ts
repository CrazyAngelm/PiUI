import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../contracts/fixtures/chat-files-v1.json';
import type { ChatFilesCommand, ChatFilesResult } from '../../../../contracts/chat-files-v1';

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock('./transport', () => ({ hostInvoke: invoke, hostListen: listen, desktopAvailable: true }));
import {
  chatFileBlob,
  decodeChatFilesResult,
  isChatFile,
  isChatFilesChangedEvent,
  listChatFiles,
  listenChatFilesChanged,
  openChatFile,
  previewChatFile,
  resolveChatFile,
  revealChatFile,
  saveChatFile,
} from './chatFilesClient';

const SESSION = '8d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const FILE = '0f8e5a4c-1b2d-4e6f-8a9b-7c6d5e4f3a2b';

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe('chat files v1 contract', () => {
  it('keeps the golden fixture in the TypeScript contract shape', () => {
    const commands = fixture.commands as ChatFilesCommand[];
    expect(commands.map((command) => command.type)).toEqual(['list', 'preview', 'save', 'reveal', 'open', 'resolve']);
    const [list, preview, save, reveal, open, resolve] = commands;
    const results = fixture.results as unknown as Record<string, ChatFilesResult>;
    expect(decodeChatFilesResult(list!, results.files)).toEqual(results.files);
    expect(decodeChatFilesResult(preview!, results.preview)).toEqual(results.preview);
    expect(decodeChatFilesResult(save!, results.saved)).toEqual(results.saved);
    expect(decodeChatFilesResult(reveal!, results.revealed)).toEqual(results.revealed);
    expect(decodeChatFilesResult(open!, results.opened)).toEqual(results.opened);
    expect(decodeChatFilesResult(resolve!, results.resolved)).toEqual(results.resolved);
    expect(decodeChatFilesResult(resolve!, results.resolvedNone)).toEqual(results.resolvedNone);
    const files = (results.files as { files: unknown[] }).files;
    expect(files.every(isChatFile)).toBe(true);
    // The unavailable entry carries no media type or size.
    expect(files[3]).toMatchObject({ unavailable: true, openable: false, revealable: false });
  });

  it('refuses results outside the contract instead of trusting them', () => {
    const [list, preview, save, reveal, open, resolve] = fixture.commands as ChatFilesCommand[];
    const results = fixture.results as unknown as Record<string, Record<string, unknown> & { files?: Record<string, unknown>[] }>;
    const first = results.files!.files![0]!;
    for (const change of [
      { protocol: 2 },
      { type: 'preview' },
      { sessionId: 'another-session' },
      { files: [{ ...first, kind: 'executable' }] },
      { files: [{ ...first, origin: 'downloaded' }] },
      { files: [{ ...first, size: -1 }] },
      { files: [{ ...first, openable: 'yes' }] },
      { files: [{ ...first, name: '' }] },
      { files: [{ ...first, id: undefined }] },
      { files: [{ ...first, previewable: undefined }] },
      { files: [{ ...first, unavailable: 1 }] },
    ]) {
      expect(decodeChatFilesResult(list!, { ...results.files, ...change }), JSON.stringify(change)).toBeUndefined();
    }
    expect(decodeChatFilesResult(preview!, { ...results.preview, fileId: 'other' })).toBeUndefined();
    expect(decodeChatFilesResult(preview!, { ...results.preview, mediaType: 'image/svg+xml' })).toBeUndefined();
    expect(decodeChatFilesResult(preview!, { ...results.preview, mediaType: 'text/html' })).toBeUndefined();
    expect(decodeChatFilesResult(preview!, { ...results.preview, data: 'not base64!' })).toBeUndefined();
    expect(decodeChatFilesResult(save!, { ...results.saved, saved: 'yes' })).toBeUndefined();
    expect(decodeChatFilesResult(reveal!, { ...results.revealed, fileId: 'other' })).toBeUndefined();
    expect(decodeChatFilesResult(open!, results.revealed)).toBeUndefined();
    expect(decodeChatFilesResult(resolve!, { ...results.resolved, file: { id: 'x' } })).toBeUndefined();
    expect(decodeChatFilesResult(resolve!, { ...results.resolved, file: undefined })).toBeUndefined();
    expect(decodeChatFilesResult(list!, null)).toBeUndefined();
    expect(decodeChatFilesResult(list!, results.saved)).toBeUndefined();
  });
});

describe('chat files client', () => {
  it('lists, previews, saves, reveals, opens and resolves through the host transport', async () => {
    const results = fixture.results as unknown as Record<string, unknown>;
    invoke.mockResolvedValueOnce(results.files);
    await expect(listChatFiles(SESSION)).resolves.toHaveLength(4);
    expect(invoke).toHaveBeenLastCalledWith('workspace_chat_files_v1', { command: { type: 'list', sessionId: SESSION } });

    invoke.mockResolvedValueOnce(results.preview);
    await expect(previewChatFile(SESSION, FILE)).resolves.toMatchObject({ mediaType: 'image/png' });
    expect(invoke).toHaveBeenLastCalledWith('workspace_chat_files_v1', { command: { type: 'preview', sessionId: SESSION, fileId: FILE } });

    invoke.mockResolvedValueOnce(results.saved);
    await expect(saveChatFile(SESSION, FILE)).resolves.toBe(true);
    invoke.mockResolvedValueOnce({ ...(results.saved as object), saved: false });
    await expect(saveChatFile(SESSION, FILE)).resolves.toBe(false);

    invoke.mockResolvedValueOnce(results.revealed);
    await expect(revealChatFile(SESSION, FILE)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith('workspace_chat_files_v1', { command: { type: 'reveal', sessionId: SESSION, fileId: FILE } });
    invoke.mockResolvedValueOnce(results.opened);
    await expect(openChatFile(SESSION, FILE)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith('workspace_chat_files_v1', { command: { type: 'open', sessionId: SESSION, fileId: FILE } });

    invoke.mockResolvedValueOnce(results.resolved);
    await expect(resolveChatFile(SESSION, 'docs/render.png')).resolves.toMatchObject({ name: 'render.png', blockId: '' });
    expect(invoke).toHaveBeenLastCalledWith('workspace_chat_files_v1', { command: { type: 'resolve', sessionId: SESSION, name: 'docs/render.png' } });
    invoke.mockResolvedValueOnce(results.resolvedNone);
    await expect(resolveChatFile(SESSION, 'missing.png')).resolves.toBeNull();
  });

  it('turns the preview into a Blob of the proven media type', async () => {
    invoke.mockResolvedValueOnce({ ...(fixture.results.preview as object), data: btoa('\x89PNG\r\n') });
    const blob = await chatFileBlob(SESSION, FILE);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(6);
  });

  it('maps host refusals to safe copy and rejects a reply for another file', async () => {
    invoke.mockRejectedValueOnce({ code: 'CHAT_FILE_OPEN_REFUSED', message: 'C:\\Users\\me\\secret.exe', recoverable: true });
    await expect(openChatFile(SESSION, FILE)).rejects.toMatchObject({
      code: 'CHAT_FILE_OPEN_REFUSED',
      message: 'Nano Desktop does not open this kind of file. Save a copy or show it in its folder.',
    });
    invoke.mockRejectedValueOnce({ code: 'SAFE_MODE', message: 'x', recoverable: true });
    await expect(listChatFiles(SESSION)).rejects.toMatchObject({ code: 'SAFE_MODE' });
    invoke.mockResolvedValueOnce({ ...(fixture.results.revealed as object), fileId: 'another-file' });
    await expect(revealChatFile(SESSION, FILE)).rejects.toMatchObject({ code: 'UNKNOWN' });
    invoke.mockResolvedValueOnce({ ...(fixture.results.files as object), sessionId: 'another-session' });
    await expect(listChatFiles(SESSION)).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});

describe('chat files changed event', () => {
  it('keeps the golden fixture in the TypeScript contract shape', () => {
    const events = fixture.events as unknown[];
    expect(events).toHaveLength(1);
    expect(events.every(isChatFilesChangedEvent)).toBe(true);
    for (const bad of [null, 'changed', { protocol: 1, type: 'changed' }, { protocol: 2, type: 'changed', sessionId: SESSION }, { protocol: 1, type: 'list', sessionId: SESSION }]) {
      expect(isChatFilesChangedEvent(bad)).toBe(false);
    }
  });

  it('hands the handler the session of a well-formed event on the host channel and drops anything else', async () => {
    let deliver!: (payload: unknown) => void;
    const stop = vi.fn();
    listen.mockImplementation(async (_channel: string, handler: (payload: unknown) => void) => {
      deliver = handler;
      return stop;
    });
    const seen: string[] = [];
    const unlisten = await listenChatFilesChanged((sessionId) => seen.push(sessionId));
    expect(listen).toHaveBeenCalledWith('piui://chat-files-v1', expect.any(Function));
    deliver((fixture.events as unknown[])[0]);
    deliver({ protocol: 1, type: 'changed' });
    deliver({ protocol: 1, type: 'changed', sessionId: '' });
    deliver('changed');
    expect(seen).toEqual([SESSION]);
    expect(unlisten).toBe(stop);
  });
});
