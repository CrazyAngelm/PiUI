/** Images offered by WebView2 and WebKitGTK may be in different clipboard representations. */

/** The narrow slice of `navigator.clipboard` the fallback reads. */
export interface ClipboardReader {
  read(): Promise<readonly { readonly types: readonly string[]; getType(type: string): Promise<Blob> }[]>;
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const supportsImage = (type: string): boolean => Object.hasOwn(EXTENSIONS, type);

export const unreadableClipboardImage = 'Could not read the image from the clipboard.';

/** Takes files first and only intercepts ordinary text or links if actual files are present. */
export function readPastedAttachments(
  event: Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>,
  allowImageFallback: boolean,
  reader?: ClipboardReader,
): { files: Promise<File[]>; reportEmpty: boolean } | undefined {
  const data = event.clipboardData;
  if (!data) return undefined;
  const files = [...data.files];
  if (!files.length) {
    for (const item of data.items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) {
    event.preventDefault();
    return { files: Promise.resolve(files), reportEmpty: false };
  }
  if (!allowImageFallback) return undefined;

  // WebKitGTK can offer a screenshot with no synchronous data, or list an image type with no file.
  const empty = !data.types.length && !data.items.length;
  const image = data.types.some(supportsImage)
    || [...data.items].some((item) => item.kind === 'file' && supportsImage(item.type))
    || (data.types.includes('text/html') && /<img(?:\s|>)/i.test(data.getData('text/html')));
  if (!empty && (!image || data.getData('text/plain') || data.getData('text/uri-list'))) return undefined;
  if (image) event.preventDefault();
  return { files: clipboardImages(reader), reportEmpty: image };
}

/** Read during the paste gesture. An unreadable representation must not discard other images. */
export async function clipboardImages(
  reader: ClipboardReader | undefined = typeof navigator === 'undefined' ? undefined : (navigator.clipboard as ClipboardReader | undefined),
): Promise<File[]> {
  if (!reader || typeof reader.read !== 'function') return [];
  let items;
  try {
    items = await reader.read();
  } catch {
    return [];
  }
  const images: File[] = [];
  for (const item of items) {
    for (const type of item.types.filter(supportsImage)) {
      try {
        const blob = await item.getType(type);
        if (!blob.size) continue;
        images.push(new File([blob], `image.${EXTENSIONS[type]}`, { type }));
        break;
      } catch {
        // Try the other representations and items the source provided.
      }
    }
  }
  return images;
}
