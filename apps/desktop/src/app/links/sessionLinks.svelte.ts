import { SvelteMap } from 'svelte/reactivity';
import {
  SessionLinksOperationError,
  sessionLinksHost,
  type LinkedChatV1,
  type SessionLinksClient,
  type SessionLinksCommandV1,
  type SessionLinksErrorCodeV1,
} from '../../host-api/sessionLinksClient';
import { remoteMode } from '../nano/remoteMode';

/** Fixed English copy per error code of the contract; the interface translates it. */
export const LINK_ERROR_COPY: Readonly<Record<SessionLinksErrorCodeV1, string>> = {
  'invalid-operation': 'This request is not valid.',
  'unknown-session': 'These chats are no longer linked.',
  'authority-denied': 'This is not allowed for these chats.',
  'depth-limit': 'These linked chats are nested too deeply.',
  'child-limit': 'This chat has reached its limit of linked chats.',
  'harness-unavailable': 'The agent of that chat is not available.',
  'not-allowed': 'Linked chats are not available for this chat.',
  busy: 'That chat is busy. Try again in a moment.',
  unavailable: 'Linked chats are unavailable right now.',
  'read-only': 'Linked chats are read-only in safe mode.',
  io: 'The change could not be saved. Nothing was changed.',
};

/** The copy for a failed operation: its code's text, or the unavailable text for anything else. */
export function linkErrorCopy(cause: unknown): string {
  return cause instanceof SessionLinksOperationError ? (LINK_ERROR_COPY[cause.code] ?? LINK_ERROR_COPY.unavailable) : LINK_ERROR_COPY.unavailable;
}

export type LinkOutcome = { ok: true } | { ok: false; error: string };

/** A sent message is `queued` when the host kept it for the peer instead of handing it over. */
export type SendOutcome = { ok: true; queued: boolean } | { ok: false; error: string };

interface Entry {
  chats: readonly LinkedChatV1[];
  revision: number;
}

/** A failed first read is not asked again by `load` for this long. */
const RETRY_AFTER_MS = 10_000;

/**
 * Per-chat cache of `session_links_command_v1` `find`, kept fresh by the change
 * event. Every chat asks once through `load`; only chats that were loaded are
 * refreshed by an event, so an unopened chat costs nothing. A failed read keeps
 * what was known. The linked-chats preference lives here too.
 */
export class SessionLinks {
  private entries = new SvelteMap<string, Entry>();
  private reads = new Map<string, { again: boolean; done: Promise<void> }>();
  private failedAt = new Map<string, number>();
  private listening = false;

  /** The "Linked chats" preference of Settings. */
  settings = $state({ enabled: true, readOnly: false, loaded: false, error: '' });
  private settingsLoading: Promise<void> | undefined;

  private readonly client: SessionLinksClient;

  constructor(client: SessionLinksClient = sessionLinksHost) {
    this.client = client;
  }

  /** The known linked chats of a chat; `undefined` until the host answered. */
  peek(sessionId: string): readonly LinkedChatV1[] | undefined {
    return this.entries.get(sessionId)?.chats;
  }

  /** The revision of the last answer for a chat. */
  revisionOf(sessionId: string): number | undefined {
    return this.entries.get(sessionId)?.revision;
  }

  /** The chat this one is a child of, when an agent started it or a person branched it. */
  parentOf(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.chats.find((chat) => chat.relation === 'parent' && (chat.kind === 'agent' || chat.kind === 'branch'))?.sessionId;
  }

  /** A chat an agent started: its report goes to the parent chat. */
  isAgentChild(sessionId: string): boolean {
    return this.entries.get(sessionId)?.chats.some((chat) => chat.relation === 'parent' && chat.kind === 'agent') ?? false;
  }

  /** Reads a chat's links once; later calls reuse the answer. A remote browser has no linked chats. */
  load(sessionId: string): Promise<void> {
    if (remoteMode) return Promise.resolve();
    this.listen();
    if (this.entries.has(sessionId)) return Promise.resolve();
    const running = this.reads.get(sessionId);
    if (running) return running.done;
    const failed = this.failedAt.get(sessionId);
    if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return Promise.resolve();
    return this.refresh(sessionId);
  }

  /** Reads a chat's links again. A call while a read is in flight is joined by one more read that starts after it. */
  refresh(sessionId: string): Promise<void> {
    if (remoteMode) return Promise.resolve();
    const running = this.reads.get(sessionId);
    if (running) {
      running.again = true;
      return running.done;
    }
    const read = { again: false, done: Promise.resolve() };
    read.done = (async () => {
      try {
        do {
          read.again = false;
          await this.read(sessionId);
        } while (read.again);
      } finally {
        this.reads.delete(sessionId);
      }
    })();
    this.reads.set(sessionId, read);
    return read.done;
  }

  private async read(sessionId: string): Promise<void> {
    try {
      const result = await this.client.request({ op: 'find', sessionId });
      if (result.type !== 'links') throw new SessionLinksOperationError('unavailable', LINK_ERROR_COPY.unavailable);
      this.entries.set(sessionId, { chats: result.chats, revision: result.revision });
      this.failedAt.delete(sessionId);
    } catch {
      // The previous answer stays; the chat is an ordinary one until the host answers.
      this.failedAt.set(sessionId, Date.now());
    }
  }

  /** One listener for the app's life. */
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.client
      .onChanged((event) => {
        if (this.entries.has(event.sessionId) || this.reads.has(event.sessionId)) void this.refresh(event.sessionId);
      })
      .catch(() => {
        // Without events the links are read again on the next open.
        this.listening = false;
      });
  }

  /** Links two chats as peers. */
  link(sessionId: string, otherSessionId: string): Promise<LinkOutcome> {
    return this.act({ op: 'link', sessionId, otherSessionId }, [sessionId, otherSessionId]);
  }

  /** Removes a peer link. */
  unlink(sessionId: string, otherSessionId: string): Promise<LinkOutcome> {
    return this.act({ op: 'unlink', sessionId, otherSessionId }, [sessionId, otherSessionId]);
  }

  /**
   * A person's message from one chat to a linked chat. The host answers success also when it only queued the text
   * because the peer cannot take it now, so the peer's waiting count before and after tells the two apart.
   */
  async send(fromSessionId: string, toSessionId: string, text: string): Promise<SendOutcome> {
    await this.load(toSessionId);
    const before = this.waitingFor(toSessionId, fromSessionId);
    const outcome = await this.act({ op: 'send', fromSessionId, toSessionId, text }, [fromSessionId, toSessionId]);
    if (!outcome.ok) return outcome;
    const after = this.waitingFor(toSessionId, fromSessionId);
    return { ok: true, queued: before !== undefined && after !== undefined && after > before };
  }

  /** How many texts of `fromSessionId` wait in `sessionId`; `undefined` while unknown. */
  private waitingFor(sessionId: string, fromSessionId: string): number | undefined {
    return this.peek(sessionId)?.find((chat) => chat.sessionId === fromSessionId)?.pending;
  }

  /** Hands over the texts that wait in a chat for a linked chat because the automatic limit was reached. */
  deliver(sessionId: string, fromSessionId: string): Promise<LinkOutcome> {
    return this.act({ op: 'deliver', sessionId, fromSessionId }, [sessionId, fromSessionId]);
  }

  private async act(command: SessionLinksCommandV1, affected: readonly string[]): Promise<LinkOutcome> {
    try {
      await this.client.request(command);
    } catch (cause) {
      return { ok: false, error: linkErrorCopy(cause) };
    }
    await Promise.all(affected.map((id) => this.refresh(id)));
    return { ok: true };
  }

  /** Reads the preference once. A failed read leaves it read-only. */
  loadSettings(): Promise<void> {
    if (remoteMode) {
      this.settings.readOnly = true;
      this.settings.loaded = true;
      return Promise.resolve();
    }
    this.settingsLoading ??= this.client
      .request({ op: 'settings' })
      .then((result) => {
        if (result.type !== 'settings') throw new SessionLinksOperationError('unavailable', LINK_ERROR_COPY.unavailable);
        this.settings.enabled = result.enabled;
        this.settings.readOnly = result.readOnly;
      })
      .catch((cause: unknown) => {
        this.settings.readOnly = true;
        this.settings.error = linkErrorCopy(cause);
      })
      .finally(() => {
        this.settings.loaded = true;
      });
    return this.settingsLoading;
  }

  /** Writes the preference; a refusal restores the previous value and says why. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.settings.loaded || this.settings.readOnly) return;
    const previous = this.settings.enabled;
    this.settings.enabled = enabled;
    this.settings.error = '';
    try {
      const result = await this.client.request({ op: 'update', enabled });
      if (result.type !== 'settings') throw new SessionLinksOperationError('unavailable', LINK_ERROR_COPY.unavailable);
      this.settings.enabled = result.enabled;
      this.settings.readOnly = result.readOnly;
    } catch (cause) {
      this.settings.enabled = previous;
      this.settings.error = linkErrorCopy(cause);
    }
  }
}

export const sessionLinks = new SessionLinks();
