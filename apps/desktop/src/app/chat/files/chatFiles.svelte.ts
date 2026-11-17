import type { ConversationMedia } from '../../../../../../contracts/conversation-presentation-v1';
import {
  chatFileBlob,
  listChatFiles,
  openChatFile,
  revealChatFile,
  saveChatFile,
  type ChatFileV1,
} from '../../../host-api/chatFilesClient';

/** Previews fetched at once; each one crosses the host boundary as base64. */
const MAX_PARALLEL_PREVIEWS = 2;
/** The wait that lets a burst of events (a tool block and its output) settle into one listing. */
const REFRESH_DELAY_MS = 400;

const sameFiles = (left: readonly ChatFileV1[], right: readonly ChatFileV1[]): boolean =>
  left.length === right.length && left.every((file, index) => JSON.stringify(file) === JSON.stringify(right[index]));

/**
 * The files of one open chat (ADR-074): the host's listing, the `blob:` URLs of
 * the previews it served, and the actions on a file id. The WebView holds ids
 * only; a preview URL lives until the chat is closed or another one is bound,
 * and is then revoked.
 */
export class ChatFilesStore {
  files = $state.raw<ChatFileV1[]>([]);

  private sessionId = '';
  /** Changes with every bind and dispose: a late reply for an earlier chat is dropped. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private again = false;
  private urls = new Map<string, Promise<string>>();
  private active = 0;
  private waiting: (() => void)[] = [];

  /** Shows the files of `sessionId`; the same chat again changes nothing. */
  bind(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.reset();
    this.sessionId = sessionId;
    void this.refresh();
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

  /** Runs at most `MAX_PARALLEL_PREVIEWS` transfers at a time. */
  private limited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.waiting.shift()?.();
          });
      };
      if (this.active < MAX_PARALLEL_PREVIEWS) start();
      else this.waiting.push(start);
    });
  }

  /** The preview of one file as a `blob:` URL, made once per chat. */
  resolve = (fileId: string): Promise<ConversationMedia> => {
    const sessionId = this.sessionId;
    if (sessionId === '') return Promise.reject(new Error('No chat is open.'));
    const generation = this.generation;
    let url = this.urls.get(fileId);
    if (url === undefined) {
      url = this.limited(async () => {
        const blob = await chatFileBlob(sessionId, fileId);
        // The chat was closed while the bytes travelled: nothing may keep them.
        if (generation !== this.generation) throw new Error('The chat was closed.');
        return URL.createObjectURL(blob);
      });
      this.urls.set(fileId, url);
      url.catch(() => {
        if (this.urls.get(fileId) === url) this.urls.delete(fileId);
      });
    }
    return url.then((src) => ({ src }));
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
    for (const url of this.urls.values()) url.then((src) => URL.revokeObjectURL(src), () => undefined);
    this.urls.clear();
    this.waiting = [];
    this.again = false;
    this.files = [];
    this.sessionId = '';
  }

  /** Revokes every preview URL and stops listing. */
  dispose(): void {
    this.reset();
  }
}
