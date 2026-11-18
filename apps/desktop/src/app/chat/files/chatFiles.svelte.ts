import type { ConversationMedia } from '../../../../../../contracts/conversation-presentation-v1';
import {
  CHAT_FILE_MAX_MEDIA_PREVIEW_BYTES,
  chatFileBlob,
  listChatFiles,
  listenChatFilesChanged,
  openChatFile,
  revealChatFile,
  saveChatFile,
  type ChatFileV1,
} from '../../../host-api/chatFilesClient';
import { MediaGate } from './mediaGate';

/** The wait that lets a burst of events (a tool block and its output) settle into one listing. */
const REFRESH_DELAY_MS = 400;

const sameFiles = (left: readonly ChatFileV1[], right: readonly ChatFileV1[]): boolean =>
  left.length === right.length && left.every((file, index) => JSON.stringify(file) === JSON.stringify(right[index]));

/** One preview a card or a widget holds: its `blob:` URL, the bytes reserved for it and who still shows it. */
interface Held {
  url: Promise<string>;
  reserved: number;
  holders: number;
}

/**
 * The files of one open chat (ADR-074): the host's listing, the `blob:` URLs of
 * the previews it served, and the actions on a file id. The WebView holds ids
 * only. The listing follows the host's "files changed" event, so a file that
 * finishes writing after its block shows up without another message. Previews
 * share one memory budget and one transfer queue (`gate`) with the answers'
 * galleries and widgets: a card reserves a file's listed size before it asks for
 * the bytes, lets the URL go when it scrolls far away or is collapsed, and
 * fetches it again when it is needed. Every URL is revoked when the chat is
 * closed or another one is bound.
 */
export class ChatFilesStore {
  files = $state.raw<ChatFileV1[]>([]);
  /** The chat's media memory budget and transfer queue, shared with its Intelligent UI answers. */
  readonly gate = new MediaGate();

  private sessionId = '';
  /** Changes with every bind and dispose: a late reply for an earlier chat is dropped. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private again = false;
  private held = new Map<string, Held>();
  private unlisten: (() => void) | undefined;
  private disposed = false;

  /** Shows the files of `sessionId`; the same chat again changes nothing. */
  bind(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.reset();
    this.sessionId = sessionId;
    if (sessionId === '') return;
    void this.listen();
    void this.refresh();
  }

  /** Follows the host's "files changed" event for the bound chat (one listener for the store's life). */
  private async listen(): Promise<void> {
    if (this.unlisten !== undefined || this.disposed) return;
    try {
      const stop = await listenChatFilesChanged((sessionId) => {
        if (sessionId === this.sessionId) this.scheduleRefresh();
      });
      if (this.disposed) stop();
      else this.unlisten = stop;
    } catch {
      // No event route (the host refused or is not there): the listing still follows the chat's own blocks.
    }
  }

  /** Asks the host for the listing again after a short wait; repeated calls share one request. */
  scheduleRefresh(delay: number = REFRESH_DELAY_MS): void {
    if (this.sessionId === '') return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  refresh(): Promise<void> {
    if (this.sessionId === '') return Promise.resolve();
    if (this.inFlight) {
      this.again = true;
      return Promise.resolve();
    }
    return this.run();
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    try {
      do {
        this.again = false;
        const generation = this.generation;
        const sessionId = this.sessionId;
        if (sessionId === '') break;
        try {
          const files = await listChatFiles(sessionId);
          if (generation === this.generation && !sameFiles(this.files, files)) this.files = files;
        } catch {
          // A failed listing keeps what is shown; the next event asks again.
        }
      } while (this.again);
    } finally {
      this.inFlight = false;
    }
  }

  /** The bytes to reserve for a preview: the size the host listed, else the largest preview it serves. */
  private reservation(fileId: string): number {
    return this.files.find((file) => file.id === fileId)?.size ?? CHAT_FILE_MAX_MEDIA_PREVIEW_BYTES;
  }

  /** Lets one holder's hold go; the last holder revokes the URL and gives the budget back. */
  private drop(fileId: string, hold: Held): void {
    hold.holders -= 1;
    if (hold.holders > 0 || this.held.get(fileId) !== hold) return;
    this.held.delete(fileId);
    this.gate.release(hold.reserved);
    hold.url.then((src) => URL.revokeObjectURL(src), () => undefined);
  }

  /**
   * The preview of one file as a `blob:` URL. The budget is reserved first (from the listed size), so a
   * chat that holds too much refuses instead of growing; the URL is shared by the cards that show the
   * same file and revoked when the last one calls `release`.
   */
  resolve = (fileId: string): Promise<ConversationMedia> => {
    const sessionId = this.sessionId;
    if (sessionId === '') return Promise.reject(new Error('No chat is open.'));
    const generation = this.generation;
    let hold = this.held.get(fileId);
    if (hold === undefined) {
      const reserved = this.reservation(fileId);
      if (!this.gate.reserve(reserved)) return Promise.reject(new Error('This chat holds too much media.'));
      const created: Held = { url: Promise.resolve(''), reserved, holders: 0 };
      created.url = this.gate.run(async () => {
        const blob = await chatFileBlob(sessionId, fileId);
        // The chat was closed while the bytes travelled: nothing may keep them.
        if (generation !== this.generation) throw new Error('The chat was closed.');
        // The reservation was an estimate (the listed size, or the largest preview): settle it to the bytes
        // that arrived, taking the difference or refusing when the file grew.
        if (blob.size > created.reserved) {
          if (!this.gate.reserve(blob.size - created.reserved)) throw new Error('This chat holds too much media.');
        } else {
          this.gate.release(created.reserved - blob.size);
        }
        created.reserved = blob.size;
        return URL.createObjectURL(blob);
      });
      created.url.catch(() => {
        if (this.held.get(fileId) === created) {
          this.held.delete(fileId);
          this.gate.release(created.reserved);
        }
      });
      this.held.set(fileId, created);
      hold = created;
    }
    const mine = hold;
    mine.holders += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.drop(fileId, mine);
    };
    return mine.url.then(
      (src) => ({ src, release }),
      (error: unknown) => {
        release();
        throw error;
      },
    );
  };

  open = async (fileId: string): Promise<void> => {
    await openChatFile(this.sessionId, fileId);
  };

  /** True when the file was saved; false when the person cancelled the dialog. */
  save = (fileId: string): Promise<boolean> => saveChatFile(this.sessionId, fileId);

  reveal = async (fileId: string): Promise<void> => {
    await revealChatFile(this.sessionId, fileId);
  };

  private reset(): void {
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const hold of this.held.values()) hold.url.then((src) => URL.revokeObjectURL(src), () => undefined);
    this.held.clear();
    this.gate.reset();
    this.again = false;
    this.files = [];
    this.sessionId = '';
  }

  /** Revokes every preview URL, stops listing and stops following the host's event. */
  dispose(): void {
    this.disposed = true;
    this.reset();
    this.unlisten?.();
    this.unlisten = undefined;
  }
}
