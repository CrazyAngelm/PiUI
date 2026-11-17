import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFileV1 } from '../../../../../contracts/chat-files-v1';
import { MAX_HELD_BYTES, createInteractiveFiles, decodeBase64 } from './files';

const file = (patch: Partial<ChatFileV1> = {}): ChatFileV1 => ({
  id: 'f1', blockId: '', name: 'clip.mp4', kind: 'video', mediaType: 'video/mp4', size: 3, origin: 'generated',
  openable: true, previewable: true, revealable: true, ...patch,
});
const preview = { mediaType: 'video/mp4', data: 'AQID' };

let counter = 0;
const createObjectURL = vi.fn(() => `blob:media-${++counter}`);
const revokeObjectURL = vi.fn();
beforeEach(() => {
  counter = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('URL', Object.assign(function URLStub() {}, { createObjectURL, revokeObjectURL }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('interactive chat files', () => {
  it('decodes base64 bytes', () => {
    expect([...decodeBase64('AQID')]).toEqual([1, 2, 3]);
    expect(() => decodeBase64('***')).toThrow();
  });

  it('turns a resolved file into one blob URL per file and size', async () => {
    const source = { resolve: vi.fn().mockResolvedValue(file()), preview: vi.fn().mockResolvedValue(preview) };
    const files = createInteractiveFiles(source);
    const [first, second] = await Promise.all([files.resolve('clip.mp4'), files.resolve('clip.mp4')]);
    expect(first).toBe('blob:media-1');
    expect(second).toBe('blob:media-1');
    expect(source.preview).toHaveBeenCalledOnce();
    expect(source.preview).toHaveBeenCalledWith('f1');
    expect(await files.resolve('clip.mp4')).toBe('blob:media-1');
    source.resolve.mockResolvedValue(file({ size: 4 }));
    expect(await files.resolve('clip.mp4')).toBe('blob:media-2');
    files.dispose();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('reports a file that is not there yet as null and a gone one the same way', async () => {
    const source = { resolve: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(file({ unavailable: true })), preview: vi.fn() };
    const files = createInteractiveFiles(source);
    expect(await files.resolve('later.png')).toBeNull();
    expect(await files.resolve('later.png')).toBeNull();
    expect(source.preview).not.toHaveBeenCalled();
  });

  it('rejects what can never be shown inline', async () => {
    const files = createInteractiveFiles({ resolve: vi.fn().mockResolvedValue(file({ kind: 'pdf', previewable: false })), preview: vi.fn() });
    await expect(files.resolve('a.pdf')).rejects.toThrow();
    const refused = createInteractiveFiles({ resolve: vi.fn().mockRejectedValue(new Error('INVALID_ARGUMENT')), preview: vi.fn() });
    await expect(refused.resolve('../secret')).rejects.toThrow();
    const wrongType = createInteractiveFiles({ resolve: vi.fn().mockResolvedValue(file()), preview: vi.fn().mockResolvedValue({ mediaType: 'text/html', data: 'AQID' }) });
    await expect(wrongType.resolve('clip.mp4')).rejects.toThrow();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('refuses media beyond what one message may hold', async () => {
    expect(MAX_HELD_BYTES).toBe(192 * 1024 * 1024);
    const source = { resolve: vi.fn().mockResolvedValue(file()), preview: vi.fn().mockResolvedValue(preview) };
    const files = createInteractiveFiles(source, 5);
    expect(await files.resolve('clip.mp4')).toBe('blob:media-1');
    source.resolve.mockResolvedValue(file({ id: 'f2', size: 3 }));
    await expect(files.resolve('other.mp4')).rejects.toThrow();
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it('makes no URL after disposal, even for a preview that was already in flight', async () => {
    let finish!: (value: typeof preview) => void;
    const source = { resolve: vi.fn().mockResolvedValue(file()), preview: vi.fn(() => new Promise<typeof preview>(done => { finish = done; })) };
    const files = createInteractiveFiles(source);
    const running = files.resolve('clip.mp4');
    await vi.waitFor(() => expect(source.preview).toHaveBeenCalled());
    files.dispose();
    finish(preview);
    expect(await running).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(await files.resolve('clip.mp4')).toBeNull();
  });
});
