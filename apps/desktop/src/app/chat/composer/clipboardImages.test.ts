import { describe, expect, it, vi } from 'vitest';
import { clipboardImages, readPastedAttachments, type ClipboardReader } from './clipboardImages';

function clipboardEvent(types: string[], values: Record<string, string> = {}, items: object[] = [], files: File[] = []) {
  return {
    clipboardData: { types, files, items, getData: (type: string) => values[type] ?? '' } as unknown as DataTransfer,
    preventDefault: vi.fn(),
  };
}

const image = (type: string): Blob => new Blob([new Uint8Array(144)], { type });
const pngReader: ClipboardReader = { read: async () => [{ types: ['image/png'], getType: async () => image('image/png') }] };

describe('clipboard images', () => {
  it('uses a synchronous file item even if WebKit elides the file list', async () => {
    const jpeg = new File([image('image/jpeg')], 'copied.jpg', { type: 'image/jpeg' });
    const event = clipboardEvent(['text/html'], {}, [{ kind: 'file', type: 'image/jpeg', getAsFile: () => jpeg }]);
    const read = vi.fn(pngReader.read);
    const paste = readPastedAttachments(event, true, { read });
    expect(await paste?.files).toEqual([jpeg]);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the local image in the gesture for an empty or image-advertising event', async () => {
    const empty = clipboardEvent([]);
    const explicit = clipboardEvent(['image/png']);
    const markup = clipboardEvent(['text/html'], { 'text/html': '<img src="https://example.invalid/image.png">' });
    for (const event of [empty, explicit, markup]) {
      const read = vi.fn(pngReader.read);
      const paste = readPastedAttachments(event, true, { read });
      expect(read).toHaveBeenCalledOnce();
      expect((await paste?.files)?.[0].name).toBe('image.png');
      expect(paste?.reportEmpty).toBe(event !== empty);
      expect(event.preventDefault).toHaveBeenCalledTimes(event === empty ? 0 : 1);
    }
  });

  it('leaves plain text and links to the browser', () => {
    const read = vi.fn(pngReader.read);
    const text = clipboardEvent(['text/plain'], { 'text/plain': 'A pasted draft' });
    const link = clipboardEvent(['text/html', 'text/uri-list'], {
      'text/html': '<img src="https://example.invalid/image.png">',
      'text/uri-list': 'https://example.invalid/image.png',
    });
    for (const event of [text, link]) {
      expect(readPastedAttachments(event, true, { read })).toBeUndefined();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps readable items and tries another supported representation when the first read fails', async () => {
    const reader: ClipboardReader = {
      read: async () => [
        { types: ['image/png'], getType: async () => image('image/png') },
        { types: ['image/png'], getType: async () => { throw new DOMException('denied', 'NotAllowedError'); } },
        { types: ['text/html', 'image/jpeg', 'image/webp'], getType: async (type) => type === 'image/jpeg' ? new Blob([]) : image(type) },
      ],
    };
    expect((await clipboardImages(reader)).map((file) => [file.name, file.type, file.size]))
      .toEqual([['image.png', 'image/png', 144], ['image.webp', 'image/webp', 144]]);
  });

  it('reports empty data when an image was advertised but permission was denied', async () => {
    const reader: ClipboardReader = { read: async () => { throw new DOMException('denied', 'NotAllowedError'); } };
    const paste = readPastedAttachments(clipboardEvent(['image/png']), true, reader);
    expect(paste?.reportEmpty).toBe(true);
    expect(await paste?.files).toEqual([]);
  });
});
