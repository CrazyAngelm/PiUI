import { previewImage } from '../../../host-api/composerInputsClient';

/**
 * Decoded composer image previews. Bytes are decoded in memory
 * (`createImageBitmap`) and drawn on a canvas, so no `blob:` or `data:` URL
 * is needed under the desktop CSP (`img-src 'self' asset:`). Pasted images
 * reuse the clipboard blob; picked ones read their bytes from the host once.
 */
const cache = new Map<string, Promise<ImageBitmap | undefined>>();

async function decode(blob: Blob): Promise<ImageBitmap | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  try {
    return await createImageBitmap(blob);
  } catch {
    return undefined;
  }
}

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

/** Uses bytes the WebView already holds (a pasted or browser-dropped image). */
export function rememberThumbnail(id: string, blob: Blob): void {
  cache.set(id, decode(blob));
}

/** The decoded image of a pending attachment, or `undefined` when it cannot be shown. */
export function thumbnail(id: string): Promise<ImageBitmap | undefined> {
  let entry = cache.get(id);
  if (entry === undefined) {
    entry = previewImage(id)
      .then((preview) => decode(new Blob([bytes(preview.data)], { type: preview.mimeType })))
      .catch(() => undefined);
    cache.set(id, entry);
  }
  return entry;
}

/** Releases a preview once its attachment is sent or removed. */
export function forgetThumbnail(id: string): void {
  const entry = cache.get(id);
  cache.delete(id);
  void entry?.then((bitmap) => bitmap?.close());
}
