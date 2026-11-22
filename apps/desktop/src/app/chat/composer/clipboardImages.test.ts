import { describe, expect, it } from 'vitest';
import { clipboardImages, pasteCarriesNothing, type ClipboardReader } from './clipboardImages';

const data = (types: string[], files = 0) => ({ types, files: { length: files } as FileList });

describe('clipboard images', () => {
  it('falls back only for a paste event that carries nothing (WebKitGTK screenshot)', () => {
    expect(pasteCarriesNothing(data([]))).toBe(true);
    expect(pasteCarriesNothing(data(['text/plain']))).toBe(false);
    expect(pasteCarriesNothing(data(['Files'], 1))).toBe(false);
    expect(pasteCarriesNothing(null)).toBe(false);
  });

  it('reads the image items and names them like a browser paste', async () => {
    const reader: ClipboardReader = {
      read: async () => [
        { types: ['text/plain'], getType: async () => new Blob(['hi']) },
        { types: ['text/html', 'image/png'], getType: async (type) => new Blob([new Uint8Array(144)], { type }) },
      ],
    };
    const images = await clipboardImages(reader);
    expect(images.map((file) => [file.name, file.type, file.size])).toEqual([['image.png', 'image/png', 144]]);
  });

  it('gives nothing when the Clipboard API is missing or refuses', async () => {
    expect(await clipboardImages(undefined)).toEqual([]);
    expect(await clipboardImages({ read: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) })).toEqual([]);
    expect(await clipboardImages({ read: async () => [{ types: ['image/png'], getType: async () => new Blob([]) }] })).toEqual([]);
  });
});
