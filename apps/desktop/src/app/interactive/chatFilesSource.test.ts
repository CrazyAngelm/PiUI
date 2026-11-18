import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ resolveChatFile: vi.fn(), previewChatFile: vi.fn() }));
vi.mock('../../host-api/chatFilesClient', () => client);

beforeEach(() => { client.resolveChatFile.mockReset(); client.previewChatFile.mockReset(); });

describe('chat files as an answer file source', () => {
  it('reads the session at each call, so a transcript shown for another chat never asks the previous one', async () => {
    const { chatFilesSource } = await import('./chatFilesSource');
    let session: string | undefined = 's1';
    const source = chatFilesSource(() => session);
    client.resolveChatFile.mockResolvedValue(null);
    await source.resolve('clip.mp4');
    session = 's2';
    await source.resolve('clip.mp4');
    expect(client.resolveChatFile.mock.calls).toEqual([['s1', 'clip.mp4'], ['s2', 'clip.mp4']]);
  });

  it('finds nothing without a chat and refuses a preview', async () => {
    const { chatFilesSource } = await import('./chatFilesSource');
    const source = chatFilesSource(() => undefined);
    expect(await source.resolve('clip.mp4')).toBeNull();
    await expect(source.preview('f1')).rejects.toThrow();
    expect(client.resolveChatFile).not.toHaveBeenCalled();
  });

  it('passes only the media type and the bytes of a preview on', async () => {
    const { chatFilesSource } = await import('./chatFilesSource');
    client.previewChatFile.mockResolvedValue({ type: 'preview', protocol: 1, sessionId: 's1', fileId: 'f1', mediaType: 'image/png', data: 'AQID' });
    expect(await chatFilesSource(() => 's1').preview('f1')).toEqual({ mediaType: 'image/png', data: 'AQID' });
    expect(client.previewChatFile).toHaveBeenCalledWith('s1', 'f1');
  });
});
