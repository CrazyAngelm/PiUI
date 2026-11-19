/**
 * Which chat continues which run (ADR-078). A run started from a chat names that chat in its trigger;
 * a run continued from the Runs screen has no trigger, so the screen remembers the pair it created.
 * This is local UI metadata (the host keeps the chat's own record of its runs): it may be lost or
 * edited, and a missing or stale link only means the screen offers to start a new chat.
 */
import type { RunTrigger } from '../../host-api/orchestrationClient';

const KEY = 'piui.run.chat.v1';
/** Most pairs kept; the oldest are dropped first. */
export const MAX_RUN_CHAT_LINKS = 200;

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;

function linkKey(workspaceId: string, runId: string): string {
  return `${workspaceId}:${runId}`;
}

function readAll(storage: Reader | undefined): Record<string, string> {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(KEY) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  } catch {
    return {};
  }
}

/** The chat remembered for a run, if any. */
export function rememberedRunChat(workspaceId: string, runId: string, storage: Reader | undefined = undefined): string | undefined {
  return readAll(storage)[linkKey(workspaceId, runId)];
}

/** Remembers the chat created for a run. A refused write is ignored: the link is a convenience. */
export function rememberRunChat(workspaceId: string, runId: string, sessionId: string, storage: (Reader & Writer) | undefined = undefined): void {
  const key = linkKey(workspaceId, runId);
  const known = readAll(storage);
  delete known[key];
  const entries = [...Object.entries(known), [key, sessionId] as const].slice(-MAX_RUN_CHAT_LINKS);
  try {
    (storage ?? localStorage).setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // The next visit offers a new chat instead of the remembered one.
  }
}

const continuing = new Set<string>();

/**
 * Takes the right to continue a run, once at a time per run for the whole window (the Runs screen
 * remounts as the person moves between runs, a pending continuation outlives it). False while one is
 * already under way.
 */
export function claimContinuation(workspaceId: string, runId: string): boolean {
  const key = linkKey(workspaceId, runId);
  if (continuing.has(key)) return false;
  continuing.add(key);
  return true;
}

export function releaseContinuation(workspaceId: string, runId: string): void {
  continuing.delete(linkKey(workspaceId, runId));
}

/**
 * The chat a run belongs to: the one that started it, else the one this screen created for it. `exists`
 * tells whether the chat is still in the project (a closed or deleted chat is no link).
 */
export function chatOfRun(
  workspaceId: string,
  run: { readonly id: string; readonly trigger?: RunTrigger | undefined },
  exists: (sessionId: string) => boolean,
  storage: Reader | undefined = undefined,
): string | undefined {
  const started = run.trigger?.kind === 'chat' ? run.trigger.sessionId : undefined;
  if (started && exists(started)) return started;
  const remembered = rememberedRunChat(workspaceId, run.id, storage);
  return remembered && exists(remembered) ? remembered : undefined;
}
