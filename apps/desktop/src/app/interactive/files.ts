import type { ChatFileV1 } from '../../../../../contracts/chat-files-v1';

/**
 * What an answer's `file` names resolve through (ADR-074 chat files, ADR-077). The host never
 * receives a path from here: `resolve` sends a name, the host answers with an opaque file id, and
 * `preview` returns the bytes of a file the host proved to be an image, audio or video.
 */
export interface InteractiveFileSource {
  /** `null` when no such file exists (yet); a rejection when the name is refused or the host failed. */
  resolve(name: string): Promise<ChatFileV1 | null>;
  preview(fileId: string): Promise<{ mediaType: string; data: string }>;
}

export interface InteractiveFiles {
  /** A `blob:` URL for the file, `null` while it is not there yet. Rejects when it can never be shown. */
  resolve(name: string): Promise<string | null>;
  /** Revokes every URL this owner created. Later resolves return `null`. */
  dispose(): void;
}

/** Previews held for one message: more bytes than this are refused instead of exhausting memory. */
export const MAX_HELD_BYTES = 192 * 1024 * 1024;
const MEDIA_TYPE = /^(?:image|audio|video)\/[a-z0-9.+-]+$/i;
const SHOWN_KINDS: ReadonlySet<ChatFileV1['kind']> = new Set(['image', 'audio', 'video']);

/** Bytes of standard base64 text. Throws on text that is not base64. */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * One message's media: resolves names through the host, turns the preview bytes into a `blob:` URL
 * and keeps it for as long as the message lives, so a re-render or a repeated look-up does not read
 * the file again. A file that changed (another size) gets a new URL; the old one stays valid until
 * `dispose`, because it may still be on screen.
 */
export function createInteractiveFiles(source: InteractiveFileSource, maxHeldBytes: number = MAX_HELD_BYTES): InteractiveFiles {
  const urls = new Map<string, string>();
  const pending = new Map<string, Promise<string | null>>();
  let held = 0;
  let disposed = false;

  async function load(file: ChatFileV1, key: string): Promise<string | null> {
    const preview = await source.preview(file.id);
    if (!MEDIA_TYPE.test(preview.mediaType)) throw new Error('Not a media file');
    const bytes = decodeBase64(preview.data);
    if (disposed) return null;
    if (held + bytes.byteLength > maxHeldBytes) throw new Error('Too much media for one message');
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: preview.mediaType }));
    held += bytes.byteLength;
    urls.set(key, url);
    return url;
  }

  return {
    async resolve(name) {
      if (disposed) return null;
      const file = await source.resolve(name);
      if (file === null || file.unavailable === true) return null;
      if (!file.previewable || !SHOWN_KINDS.has(file.kind)) throw new Error('This file cannot be shown inline');
      const key = `${file.id}:${file.size ?? ''}`;
      const known = urls.get(key);
      if (known !== undefined) return known;
      let running = pending.get(key);
      if (running === undefined) {
        running = load(file, key).finally(() => pending.delete(key));
        pending.set(key, running);
      }
      return running;
    },
    dispose() {
      disposed = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      pending.clear();
      held = 0;
    },
  };
}
