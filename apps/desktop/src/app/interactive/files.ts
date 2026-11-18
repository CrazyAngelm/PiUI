import type { ChatFileV1 } from '../../../../../contracts/chat-files-v1';
import { CHAT_FILE_MAX_MEDIA_PREVIEW_BYTES } from '../../../../../contracts/chat-files-v1';
import { MediaGate } from '../chat/files/mediaGate';

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
  /**
   * The caller stopped showing the URL `resolve(name)` gave it (its place scrolled far away or was
   * collapsed). When the last caller lets go, the URL is revoked and its budget goes back to the chat;
   * a later `resolve` fetches the file again.
   */
  release(name: string): void;
  /** Revokes every URL this owner created. Later resolves return `null`. */
  dispose(): void;
}

const MEDIA_TYPE = /^(?:image|audio|video)\/[a-z0-9.+-]+$/i;
const SHOWN_KINDS: ReadonlySet<ChatFileV1['kind']> = new Set(['image', 'audio', 'video']);

/** Bytes of standard base64 text. Throws on text that is not base64. */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

interface Held {
  url: string;
  reserved: number;
  holders: number;
}

/**
 * One message's media: resolves names through the host, turns the preview bytes into a `blob:` URL
 * and keeps it while a place shows it, so a re-render or a repeated look-up does not read the file
 * again. A file that changed (another size) gets a new URL; the old one stays valid until its places
 * let go, because it may still be on screen. The memory budget and the transfer queue are the chat's
 * (`gate`), shared with its file cards and its other answers: a file's listed size is reserved before
 * its bytes are requested, and given back when the last place lets the URL go or the message ends.
 */
export function createInteractiveFiles(source: InteractiveFileSource, gate: MediaGate = new MediaGate()): InteractiveFiles {
  const held = new Map<string, Held>();
  const pending = new Map<string, Promise<string | null>>();
  const keyOfName = new Map<string, string>();
  let disposed = false;

  async function load(file: ChatFileV1, key: string): Promise<string | null> {
    let reserved = file.size ?? CHAT_FILE_MAX_MEDIA_PREVIEW_BYTES;
    if (!gate.reserve(reserved)) throw new Error('Too much media for this chat');
    let kept = false;
    try {
      const preview = await gate.run(() => source.preview(file.id));
      if (!MEDIA_TYPE.test(preview.mediaType)) throw new Error('Not a media file');
      const bytes = decodeBase64(preview.data);
      if (disposed) return null;
      // The reservation was an estimate (the listed size, or the largest preview): settle it to the bytes
      // that arrived, taking the difference or refusing when the file grew.
      if (bytes.byteLength > reserved) {
        if (!gate.reserve(bytes.byteLength - reserved)) throw new Error('Too much media for this chat');
      } else {
        gate.release(reserved - bytes.byteLength);
      }
      reserved = bytes.byteLength;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: preview.mediaType }));
      held.set(key, { url, reserved, holders: 0 });
      kept = true;
      return url;
    } finally {
      if (!kept) gate.release(reserved);
    }
  }

  return {
    async resolve(name) {
      if (disposed) return null;
      const file = await source.resolve(name);
      if (file === null || file.unavailable === true) return null;
      if (!file.previewable || !SHOWN_KINDS.has(file.kind)) throw new Error('This file cannot be shown inline');
      const key = `${file.id}:${file.size ?? ''}`;
      let url = held.get(key)?.url;
      if (url === undefined) {
        let running = pending.get(key);
        if (running === undefined) {
          running = load(file, key).finally(() => pending.delete(key));
          pending.set(key, running);
        }
        const loaded = await running;
        if (loaded === null || disposed) return null;
        url = loaded;
      }
      const entry = held.get(key);
      if (entry === undefined) return null;
      entry.holders += 1;
      keyOfName.set(name, key);
      return entry.url;
    },
    release(name) {
      const key = keyOfName.get(name);
      const entry = key === undefined ? undefined : held.get(key);
      if (key === undefined || entry === undefined) return;
      entry.holders -= 1;
      if (entry.holders > 0) return;
      URL.revokeObjectURL(entry.url);
      gate.release(entry.reserved);
      held.delete(key);
    },
    dispose() {
      disposed = true;
      for (const entry of held.values()) {
        URL.revokeObjectURL(entry.url);
        gate.release(entry.reserved);
      }
      held.clear();
      pending.clear();
      keyOfName.clear();
    },
  };
}
