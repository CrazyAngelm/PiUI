import { describe, expect, it } from 'vitest';
import type { ChatFileV1, ChatFilesResult } from './labContracts';
import type { LabHost } from './labHost';
import { LAB_CHAT_FILES_SESSION_TITLE } from './chatFilesFake';
import { labUuid } from './labRandom';
import { labHost, rejection } from './labTestKit';

function files<T extends ChatFilesResult>(host: LabHost, command: Record<string, unknown>): Promise<T> {
  return host.invoke<T>('workspace_chat_files_v1', { command });
}

function sessionId(host: LabHost, title: string): string {
  const session = [...host.state.sessions.values()].find((candidate) => candidate.title === title);
  if (session === undefined) throw new Error(`No session ${title}`);
  return session.id;
}

const code = async (promise: Promise<unknown>): Promise<unknown> => ((await rejection(promise)) as { code?: unknown }).code;

async function listed(host: LabHost, id: string): Promise<ChatFileV1[]> {
  const result = await files<Extract<ChatFilesResult, { type: 'files' }>>(host, { type: 'list', sessionId: id });
  expect(result).toMatchObject({ type: 'files', protocol: 1, sessionId: id });
  return result.files;
}

describe('UI Lab chat files', () => {
  it('reports the demo chat files against its file-change block and previews the media', async () => {
    const host = labHost();
    const id = sessionId(host, LAB_CHAT_FILES_SESSION_TITLE);
    const block = host.state.sessions.get(id)?.blocks.find((candidate) => candidate.toolName === 'fileChange');
    const all = await listed(host, id);
    expect(all.map((file) => file.name)).toEqual(['transport-diagram.png', 'narration.wav', 'transport.ts', 'install-helper.exe']);
    expect(all.every((file) => file.blockId === block?.id && file.id.length === 36)).toBe(true);
    const [image, audio, source, program] = all;
    expect([image?.kind, image?.previewable]).toEqual(['image', true]);
    expect([audio?.kind, audio?.previewable]).toEqual(['audio', true]);
    expect([source?.kind, source?.previewable, source?.openable]).toEqual(['text', false, true]);
    expect([program?.openable, program?.previewable, program?.revealable]).toEqual([false, false, true]);

    const preview = await files<Extract<ChatFilesResult, { type: 'preview' }>>(host, { type: 'preview', sessionId: id, fileId: image?.id });
    expect(preview).toMatchObject({ type: 'preview', protocol: 1, fileId: image?.id, mediaType: 'image/png' });
    expect(atob(preview.data).startsWith('\x89PNG')).toBe(true);
    const sound = await files<Extract<ChatFilesResult, { type: 'preview' }>>(host, { type: 'preview', sessionId: id, fileId: audio?.id });
    expect(sound.mediaType).toBe('audio/wav');
    expect(atob(sound.data).startsWith('RIFF')).toBe(true);
    // A document is a card: no preview, but Open, Save as and Reveal work. A program is never opened.
    expect(await code(files(host, { type: 'preview', sessionId: id, fileId: source?.id }))).toBe('CHAT_FILE_NOT_PREVIEWABLE');
    expect(await files(host, { type: 'save', sessionId: id, fileId: source?.id })).toMatchObject({ type: 'saved', saved: true });
    expect(await files(host, { type: 'reveal', sessionId: id, fileId: program?.id })).toMatchObject({ type: 'revealed' });
    expect(await files(host, { type: 'open', sessionId: id, fileId: source?.id })).toMatchObject({ type: 'opened' });
    expect(await code(files(host, { type: 'open', sessionId: id, fileId: program?.id }))).toBe('CHAT_FILE_OPEN_REFUSED');
  });

  it('lists nothing for a chat that reported no files and refuses forged ids', async () => {
    const host = labHost();
    const other = sessionId(host, 'Fix flaky scheduler test');
    expect(await listed(host, other)).toEqual([]);
    const demo = sessionId(host, LAB_CHAT_FILES_SESSION_TITLE);
    const forged = labUuid('never-reported');
    expect(await code(files(host, { type: 'preview', sessionId: demo, fileId: forged }))).toBe('CHAT_FILE_UNAVAILABLE');
    // An id of another chat's registry does not work in this one.
    const foreign = (await listed(host, demo))[0]?.id;
    expect(await code(files(host, { type: 'reveal', sessionId: other, fileId: foreign }))).toBe('CHAT_FILE_UNAVAILABLE');
    expect(await code(files(host, { type: 'preview', sessionId: demo, fileId: 'C:\\secret.png' }))).toBe('INVALID_ARGUMENT');
    expect(await code(files(host, { type: 'list', sessionId: 'not-a-session' }))).toBe('INVALID_ARGUMENT');
    expect(await code(files(host, { type: 'list', sessionId: labUuid('missing') }))).toBe('NOT_FOUND');
    // The host refuses fields the contract does not have.
    await expect(files(host, { type: 'list', sessionId: demo, path: 'C:\\x' })).rejects.toBeDefined();
  });

  it('resolves a mention by name, then by a project-relative path, and refuses anything else', async () => {
    const host = labHost();
    const id = sessionId(host, LAB_CHAT_FILES_SESSION_TITLE);
    const resolve = (name: string) => files<Extract<ChatFilesResult, { type: 'resolved' }>>(host, { type: 'resolve', sessionId: id, name });
    const reported = await resolve('Transport-Diagram.PNG');
    expect(reported.file).toMatchObject({ name: 'transport-diagram.png', blockId: '', previewable: true });
    const [first] = await listed(host, id);
    expect(reported.file?.id).toBe(first?.id);
    const project = await resolve('docs\\lab-spec.pdf');
    expect(project.file).toMatchObject({ name: 'lab-spec.pdf', kind: 'pdf', origin: 'returned', blockId: '' });
    expect((await resolve('./docs/lab-spec.pdf')).file?.id).toBe(project.file?.id);
    // A mention names no message: the list does not grow.
    expect((await listed(host, id)).length).toBe(4);
    expect((await resolve('missing.png')).file).toBeNull();
    for (const name of ['../x.png', 'docs/../../x.png', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\a.png', '', 'a\u0000b.png']) {
      expect(await code(files(host, { type: 'resolve', sessionId: id, name })), JSON.stringify(name)).toBe('INVALID_ARGUMENT');
    }
  });

  it('records every call for the specs and refuses everything in safe mode', async () => {
    const host = labHost();
    const id = sessionId(host, LAB_CHAT_FILES_SESSION_TITLE);
    const [image] = await listed(host, id);
    await files(host, { type: 'reveal', sessionId: id, fileId: image?.id });
    if (typeof window !== 'undefined') {
      expect(window.__piuiLabChatFiles?.calls.at(-1)).toEqual({ type: 'reveal', fileId: image?.id });
    }
    const safe = labHost('safe');
    const first = [...safe.state.sessions.values()][0]?.id ?? labUuid('none');
    expect(await code(files(safe, { type: 'list', sessionId: first }))).toBe('SAFE_MODE');
    expect(await code(files(safe, { type: 'resolve', sessionId: first, name: 'a.png' }))).toBe('SAFE_MODE');
  });
});
