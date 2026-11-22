/**
 * Images from a paste. WebView2 and Chromium put a copied screenshot in the
 * paste event's `files`; WebKitGTK (Linux) hands an empty event for one and
 * exposes the image only through the async Clipboard API. Text stays a plain
 * paste: the fallback runs only for an event that carries nothing at all.
 */

/** The narrow slice of `navigator.clipboard` the fallback reads. */
export interface ClipboardReader {
  read(): Promise<readonly { readonly types: readonly string[]; getType(type: string): Promise<Blob> }[]>;
}

/** True when a paste event arrived without any data: the Linux WebView's image paste. */
export function pasteCarriesNothing(data: Pick<DataTransfer, 'types' | 'files'> | null | undefined): boolean {
  return data !== null && data !== undefined && data.files.length === 0 && data.types.length === 0;
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The images on the clipboard, read through the async Clipboard API; none when it is unavailable or refuses. */
export async function clipboardImages(
  reader: ClipboardReader | undefined = typeof navigator === 'undefined' ? undefined : (navigator.clipboard as ClipboardReader | undefined),
): Promise<File[]> {
  if (!reader || typeof reader.read !== 'function') return [];
  try {
    const images: File[] = [];
    for (const item of await reader.read()) {
      const type = item.types.find((entry) => entry in EXTENSIONS);
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob.size > 0) images.push(new File([blob], `image.${EXTENSIONS[type]}`, { type }));
    }
    return images;
  } catch {
    return [];
  }
}
