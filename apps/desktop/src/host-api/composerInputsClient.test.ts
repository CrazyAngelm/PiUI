import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../contracts/fixtures/workspace-composer-inputs-v1.json';
import type {
  ComposerAttachmentsResult,
  ComposerCatalogResult,
  ComposerDropEvent,
  ComposerFilesResult,
  ComposerInputsCommand,
  ComposerPreviewResult,
} from '../../../../contracts/workspace-composer-inputs-v1';
import type { ComposerCommand, ComposerSnapshot } from '../../../../contracts/workspace-composer-v19';

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock('./transport', () => ({ hostInvoke: invoke, hostListen: listen, desktopAvailable: true }));
import {
  composerCatalog,
  decodeComposerInputsResult,
  listenComposerDrops,
  pasteImage,
  pickAttachments,
  projectFiles,
} from './composerInputsClient';

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe('composer inputs v1 contract', () => {
  it('keeps the golden fixture in the TypeScript contract shape', () => {
    const commands = fixture.commands as ComposerInputsCommand[];
    expect(commands.map((command) => command.type)).toEqual(['pick', 'paste', 'drop', 'preview', 'discard', 'files', 'catalog']);
    const [pick, paste, drop, preview, discard, files, catalog] = commands;
    expect(decodeComposerInputsResult(pick!, fixture.results.attachments)).toEqual(fixture.results.attachments as ComposerAttachmentsResult);
    expect(decodeComposerInputsResult(paste!, fixture.results.attachments)).toBeDefined();
    expect(decodeComposerInputsResult(drop!, fixture.results.attachments)).toBeDefined();
    expect(decodeComposerInputsResult(preview!, fixture.results.preview)).toEqual(fixture.results.preview as ComposerPreviewResult);
    expect(decodeComposerInputsResult(discard!, fixture.results.discarded)).toEqual({ type: 'discarded', protocol: 1 });
    expect(decodeComposerInputsResult(files!, fixture.results.files)).toEqual(fixture.results.files as ComposerFilesResult);
    expect(decodeComposerInputsResult(catalog!, fixture.results.catalog)).toEqual(fixture.results.catalog as ComposerCatalogResult);
    const events = fixture.dropEvents as ComposerDropEvent[];
    expect(events.map((event) => event.type)).toEqual(['enter', 'drop', 'leave']);
    const send = fixture.composer.send as ComposerCommand;
    expect(send.type === 'send' ? send.attachments : undefined).toEqual(['0f8e5a4c-1b2d-4e6f-8a9b-7c6d5e4f3a2b']);
    const snapshot = fixture.composer.snapshot as ComposerSnapshot;
    expect(snapshot.capabilities.images).toBe(true);
    expect(snapshot.queue.items[0]?.attachments?.[0]?.mimeType).toBe('image/png');
    expect(snapshot.queue.items[1]?.attachments).toBeUndefined();
  });

  it('refuses results outside the contract instead of trusting them', () => {
    const [pick, , , preview, , files, catalog] = fixture.commands as ComposerInputsCommand[];
    const attachments = fixture.results.attachments;
    for (const change of [
      { protocol: 2 },
      { type: 'files' },
      { images: [{ ...attachments.images[0], mimeType: 'image/svg+xml' }] },
      { images: [{ ...attachments.images[0], size: 6_000_000 }] },
      { files: [{ name: 'x', reference: '', inProject: true }] },
      { rejected: [{ name: 'x', reason: 'virus' }] },
    ]) {
      expect(decodeComposerInputsResult(pick!, { ...attachments, ...change }), JSON.stringify(change)).toBeUndefined();
    }
    expect(decodeComposerInputsResult(preview!, { ...fixture.results.preview, attachmentId: 'other' })).toBeUndefined();
    expect(decodeComposerInputsResult(files!, { ...fixture.results.files, query: 'other' })).toBeUndefined();
    expect(decodeComposerInputsResult(files!, { ...fixture.results.files, files: [7] })).toBeUndefined();
    expect(decodeComposerInputsResult(catalog!, { ...fixture.results.catalog, skills: [{ name: 'x', mention: 'x y' }] })).toBeUndefined();
    expect(decodeComposerInputsResult(catalog!, { ...fixture.results.catalog, commands: [{ name: 'x', source: 'shell' }] })).toBeUndefined();
  });
});

describe('composer inputs client', () => {
  it('routes commands through the host transport and validates the reply', async () => {
    invoke.mockResolvedValueOnce(fixture.results.attachments);
    await expect(pickAttachments('workspace-1')).resolves.toEqual(fixture.results.attachments);
    expect(invoke).toHaveBeenCalledWith('workspace_composer_inputs_v1', { command: { type: 'pick', workspaceId: 'workspace-1' } });
    invoke.mockResolvedValueOnce({ ...fixture.results.files, query: 'src/app' });
    await expect(projectFiles('workspace-1', 'src/app')).resolves.toMatchObject({ files: ['src/app/App.svelte', 'src/app/shell/AppShell.svelte'] });
    invoke.mockResolvedValueOnce({ ...fixture.results.catalog, sessionId: 'other-session' });
    await expect(composerCatalog('8d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).rejects.toThrow();
  });

  it('keeps refusals actionable without leaking host details', async () => {
    invoke.mockRejectedValueOnce({ code: 'NOT_TRUSTED', message: 'C:\\secret path' });
    await expect(projectFiles('workspace-1', '')).rejects.toThrow('Trust this project before starting or controlling its agents.');
    invoke.mockRejectedValueOnce({ code: 'IMAGES_UNSUPPORTED', message: 'native detail' });
    await expect(pickAttachments('workspace-1')).rejects.toThrow('does not accept images');
  });

  it('sends pasted bytes as base64 and answers an oversized image without sending it', async () => {
    invoke.mockResolvedValueOnce(fixture.results.attachments);
    await pasteImage('workspace-1', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), 'clip.png');
    expect(invoke).toHaveBeenCalledWith('workspace_composer_inputs_v1', {
      command: { type: 'paste', workspaceId: 'workspace-1', name: 'clip.png', data: 'iVBORw==' },
    });
    invoke.mockReset();
    const big = await pasteImage('workspace-1', new Blob([new Uint8Array(5_000_001)]), 'big.png');
    expect(big.rejected).toEqual([{ name: 'big.png', reason: 'too-large' }]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('forwards only well-formed drop events', async () => {
    const stop = vi.fn();
    listen.mockResolvedValue(stop);
    const handler = vi.fn();
    expect(await listenComposerDrops(handler)).toBe(stop);
    expect(listen).toHaveBeenCalledWith('piui://composer-drop-v1', expect.any(Function));
    const deliver = listen.mock.calls[0]?.[1] as (payload: unknown) => void;
    deliver({ protocol: 1, type: 'drop' });
    deliver({ protocol: 2, type: 'enter', count: 1 });
    deliver({ protocol: 1, type: 'drop', dropId: 'id', paths: undefined, count: -1 });
    expect(handler).not.toHaveBeenCalled();
    deliver(fixture.dropEvents[1]);
    expect(handler).toHaveBeenCalledWith(fixture.dropEvents[1]);
  });
});
