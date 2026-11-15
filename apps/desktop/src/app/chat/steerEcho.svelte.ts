import { SvelteMap } from 'svelte/reactivity';
import type { TimelineBlock } from '../../host-api/types';
import { splitImageMarkers } from './composer/mentions';

/**
 * A message steered into a running turn is written to the agent at once, but
 * the agent's runtime reports it only when the agent reads it, at its next
 * step, and the outbox has settled it as sent by then. Until that report the
 * chat shows an echo as its last message, so a sent message never disappears.
 * An echo is presentation only: it is never stored, sent or part of history.
 */
export interface SteerEcho {
  /** The composer request id of the message. */
  readonly id: string;
  readonly text: string;
  readonly images: number;
  /** The chat's user messages when this one was sent: none of them is it. */
  readonly known: ReadonlySet<string>;
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
  const waiting = echoes.filter((echo) => {
    const sent = words(echo.text);
    const reported = blocks.find(
      (block) => block.kind === 'user' && !echo.known.has(block.id) && !claimed.has(block.id) && words(splitImageMarkers(block.text ?? '').text) === sent,
    );
    if (reported) claimed.add(reported.id);
    return !reported;
  });
  return waiting.length === echoes.length ? echoes : waiting;
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

  /**
   * Forgets the echoes the runtime has reported, for good: a message that later
   * leaves the loaded part of the chat does not bring its echo back. Once no
   * turn runs, every echo goes: an unread steer is not kept as a claim.
   */
  settle(sessionId: string, blocks: readonly TimelineBlock[], turnActive: boolean): void {
    const current = this.bySession.get(sessionId);
    if (!current) return;
    const waiting = turnActive ? waitingEchoes(current, blocks) : NONE;
    if (waiting === current) return;
    if (waiting.length) this.bySession.set(sessionId, waiting);
    else this.bySession.delete(sessionId);
  }
}

export const steerEchoes = new SteerEchoes();
