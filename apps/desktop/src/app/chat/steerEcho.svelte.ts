import { SvelteMap } from 'svelte/reactivity';
import type { TimelineBlock } from '../../host-api/types';
import { splitImageMarkers } from './composer/mentions';

/**
 * A send is visible while the composer prepares and submits it. The outbox
 * or the runtime transcript takes over when it reports the message.
 * A steered message can also wait here until the agent reads it.
 * An echo is presentation only: it is never stored or sent.
 */
export interface SteerEcho {
  /** The composer request id of the message. */
  readonly id: string;
  readonly text: string;
  readonly images: number;
  /** The chat's user messages when this one was sent: none of them is it. */
  readonly known: ReadonlySet<string>;
  readonly submission?: 'preparing' | 'sending';
}

const ECHO_ID = 'piui-steer-echo:';
const NONE: readonly SteerEcho[] = [];

/** Ids of the chat's user messages. Taken before a steer is sent. */
export function userBlockIds(blocks: readonly TimelineBlock[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) if (block.kind === 'user') ids.add(block.id);
  return ids;
}

/** Runtimes may re-wrap whitespace; the words are what identifies a message. */
function words(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(' ');
}

/**
 * The echoes the runtime has not reported yet (the same array when all are
 * waiting). A user message that is new since an echo was sent and carries its
 * text is that message; each one settles one echo, the oldest first.
 */
export function waitingEchoes(echoes: readonly SteerEcho[], blocks: readonly TimelineBlock[]): readonly SteerEcho[] {
  if (echoes.length === 0) return echoes;
  const claimed = new Set<string>();
  const waiting: SteerEcho[] = [];
  for (const echo of echoes) {
    const sent = words(echo.text);
    const reported = echo.submission === 'preparing' ? undefined : blocks.find(
      (block) => block.kind === 'user' && !echo.known.has(block.id) && !claimed.has(block.id) && words(splitImageMarkers(block.text ?? '').text) === sent,
    );
    if (reported) {
      claimed.add(reported.id);
      continue;
    }
    // A later observation must not match the same transcript row to another send.
    waiting.push(claimed.size ? { ...echo, known: new Set([...echo.known, ...claimed]) } : echo);
  }
  return claimed.size ? waiting : echoes;
}

export function visibleEchoes(echoes: readonly SteerEcho[], blocks: readonly TimelineBlock[], turnActive: boolean, terminal: boolean): readonly SteerEcho[] {
  const candidates = echoes.filter((echo) => echo.submission ? !terminal : turnActive);
  return waitingEchoes(candidates.length === echoes.length ? echoes : candidates, blocks);
}

/** The echoes as the chat's last messages, marked as still on their way. */
export function echoBlocks(echoes: readonly SteerEcho[]): TimelineBlock[] {
  return echoes.map((echo) => {
    const markers = Array.from({ length: echo.images }, () => '[image]').join('\n');
    return { id: `${ECHO_ID}${echo.id}`, kind: 'user', label: 'You', text: markers ? `${echo.text}\n\n${markers}` : echo.text, status: 'streaming' };
  });
}

class SteerEchoes {
  private bySession = new SvelteMap<string, readonly SteerEcho[]>();
  private submitting = new SvelteMap<string, { id: string; requestId?: string }>();

  isSubmitting(sessionId: string): boolean {
    return this.submitting.has(sessionId);
  }

  beginSubmission(sessionId: string, echo: SteerEcho): void {
    this.submitting.set(sessionId, { id: echo.id });
    this.add(sessionId, echo);
  }

  finishSubmission(sessionId: string, id: string): void {
    if (this.submitting.get(sessionId)?.id === id) this.submitting.delete(sessionId);
  }

  /** A newly mounted editor can observe the outbox before the send reply. */
  observeQueue(sessionId: string, items: readonly { id: string }[]): void {
    const active = this.submitting.get(sessionId);
    if (active?.requestId && items.some((item) => item.id === active.requestId)) {
      this.remove(sessionId, active.id);
    }
  }

  /** After a post-acknowledgement refresh, only an active turn needs an echo. */
  accepted(sessionId: string, id: string, blocks: readonly TimelineBlock[], turnActive: boolean): void {
    const current = this.bySession.get(sessionId);
    if (!current?.some((echo) => echo.id === id)) return;
    if (!turnActive) {
      this.remove(sessionId, id);
      return;
    }
    this.bySession.set(sessionId, current.map((echo) => {
      if (echo.id !== id) return echo;
      const { submission: _submission, ...reply } = echo;
      return reply;
    }));
    this.settle(sessionId, blocks, true);
  }

  /** The echoes of a chat, oldest first. */
  list(sessionId: string): readonly SteerEcho[] {
    return this.bySession.get(sessionId) ?? NONE;
  }

  /** Remembers a message the agent's runtime accepted into its running turn. */
  add(sessionId: string, echo: SteerEcho): void {
    const current = this.list(sessionId);
    if (current.some((item) => item.id === echo.id)) return;
    this.bySession.set(sessionId, [...current, echo]);
  }

  submit(sessionId: string, id: string, requestId: string, text: string, latest: ReadonlySet<string>, first: ReadonlySet<string>): void {
    if (this.submitting.get(sessionId)?.id === id) this.submitting.set(sessionId, { id, requestId });
    const current = this.bySession.get(sessionId);
    if (!current) return;
    this.bySession.set(sessionId, current.map((echo) => {
      if (echo.id !== id) return echo;
      const known = first === latest ? echo.known : new Set([...first, ...[...echo.known].filter((blockId) => !latest.has(blockId))]);
      return { ...echo, text, known, submission: 'sending' };
    }));
  }

  remove(sessionId: string, id: string): void {
    const remaining = this.list(sessionId).filter((echo) => echo.id !== id);
    if (remaining.length) this.bySession.set(sessionId, remaining);
    else this.bySession.delete(sessionId);
  }

  /** Forgets reported echoes even if the matching history later scrolls out of the loaded window. */
  settle(sessionId: string, blocks: readonly TimelineBlock[], turnActive: boolean, terminal = false): void {
    const current = this.bySession.get(sessionId);
    if (!current) return;
    const waiting = visibleEchoes(current, blocks, turnActive, terminal);
    if (waiting === current) return;
    if (waiting.length) this.bySession.set(sessionId, waiting);
    else this.bySession.delete(sessionId);
  }
}

export const steerEchoes = new SteerEchoes();
