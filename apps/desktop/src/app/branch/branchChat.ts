import type { DesktopTimelineBlock } from '../../../../../contracts/runtime-protocol';
import type { SessionSnapshot } from '../../../../../contracts/workspace-v15';
import { harnessConfiguration } from '../../harness-adapters';
import { SESSION_TOOL_ERROR_COPY } from '../../host-api/sessionToolErrors';
import { CHAT_TITLE_LIMIT } from '../chat/chatTitle';
import { buildHandoffDraft } from '../handoff/handoff';
import { harnessMeta } from '../harnessMeta';
import type { WorkspaceStore } from '../workspaceStore.svelte';
import { placements } from '../worktrees/placements.svelte';
import { openBesideChat } from './openBeside';

/**
 * A branch of a chat: a new chat on the same agent, model, permission mode and
 * project. The host opens it with the source's own history when the agent can
 * branch natively (Claude Code, Codex). Otherwise it is an ordinary chat
 * that is only recorded as a branch and starts from a text digest of what the
 * source showed, as "Continue in another harness" does. The source is never
 * changed and no history is converted.
 */
export type BranchCut = { at: 'end' } | { at: 'before'; blockId: string };

export interface BranchOptions {
  /** Sent as the new chat's first message. */
  prompt?: string | undefined;
  /** Put into the new chat's composer; nothing is sent. */
  draft?: string | undefined;
  /** `beside` opens in place where panes are not drawn, and leaves the branch unopened when four panes leave no room. */
  open: 'here' | 'beside' | 'none';
  /** Translates the title suffix. */
  translate?: ((value: string) => string) | undefined;
}

/**
 * What opening a chat beside the current one came to: `opened` in a new pane,
 * `in-place` where panes are not drawn (the chat replaces the shown one, which
 * is what the person gets everywhere there), `full` when four panes leave no room.
 */
export type BesideOutcome = 'opened' | 'in-place' | 'full';

export type BranchResult =
  | {
      ok: true;
      sessionId: string;
      /** The title the branch was created with. */
      title: string;
      mode: 'native' | 'linked';
      /** A linked branch with nothing before its cut: it starts without any summary. */
      empty?: true;
      /** `beside` was asked and no pane was free: the branch exists but nothing was opened. */
      noRoom?: true;
      /** The chat exists, but its first message was not sent. */
      error?: string;
    }
  | { ok: false; error: string };

export type BranchStore = Pick<WorkspaceStore, 'createChat' | 'updateDraft' | 'openSession' | 'safeMode'>;

export interface BranchDeps {
  openBeside(sessionId: string): Promise<BesideOutcome>;
  worktreeReady(sessionId: string): boolean;
}

const BRANCH_SUFFIX = ' (branch)';
const GENERIC_ERROR = 'The branch could not be created.';

export const BRANCH_POINT_COPY = SESSION_TOOL_ERROR_COPY.BRANCH_POINT_NOT_FOUND ?? GENERIC_ERROR;

const defaultDeps: BranchDeps = {
  openBeside: openBesideChat,
  worktreeReady: (sessionId) => placements.get(sessionId)?.worktree?.state === 'ready',
};

/** `{title} (branch)`, the source title cut so the whole name stays within the chat title limit. */
export function branchTitle(title: string, suffix: string = BRANCH_SUFFIX): string {
  const clean = title.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
  const room = CHAT_TITLE_LIMIT - [...suffix].length;
  const characters = [...clean];
  if (characters.length <= room) return `${clean}${suffix}`;
  return `${characters.slice(0, room - 1).join('').trimEnd()}…${suffix}`;
}

/** The blocks a branch at `cut` keeps, or undefined when the cut is not a user message of `blocks`. */
export function blocksBefore<T extends Pick<DesktopTimelineBlock, 'id' | 'kind'>>(blocks: readonly T[], cut: BranchCut): readonly T[] | undefined {
  if (cut.at === 'end') return blocks;
  const index = blocks.findIndex((block) => block.id === cut.blockId && block.kind === 'user');
  return index < 0 ? undefined : blocks.slice(0, index);
}

/** `/btw question` or `/btw` alone: the question (possibly empty), else undefined. */
export function btwQuestion(text: string): string | undefined {
  const match = /^\/btw(?:\s+([\s\S]*))?$/u.exec(text.trim());
  return match === null ? undefined : (match[1] ?? '').trim();
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function errorText(error: unknown): string {
  if (errorCode(error) === 'BRANCH_POINT_NOT_FOUND') return BRANCH_POINT_COPY;
  return error instanceof Error && error.message !== '' ? error.message : GENERIC_ERROR;
}

export async function startBranch(
  store: BranchStore,
  snapshot: SessionSnapshot,
  cut: BranchCut,
  options: BranchOptions,
  deps: BranchDeps = defaultDeps,
): Promise<BranchResult> {
  if (store.safeMode) return { ok: false, error: SESSION_TOOL_ERROR_COPY.SAFE_MODE ?? GENERIC_ERROR };
  const title = branchTitle(snapshot.session.title, options.translate ? ` (${options.translate('branch')})` : BRANCH_SUFFIX);
  const prompt = options.prompt?.trim() ? options.prompt : undefined;
  return create(store, snapshot, cut, options, deps, title, prompt);
}

async function create(
  store: BranchStore,
  snapshot: SessionSnapshot,
  cut: BranchCut,
  options: BranchOptions,
  deps: BranchDeps,
  title: string,
  prompt: string | undefined,
): Promise<BranchResult> {
  const { session } = snapshot;
  const base = {
    workspaceId: session.workspaceId,
    harness: session.harness,
    // The host gives a branch on the same harness its source's permission mode; this value only fills the contract.
    permissionMode: harnessConfiguration(session.harness).defaultPermission,
    ...(session.model ? { model: session.model } : {}),
  };
  let mode: 'native' | 'linked' = 'native';
  let empty = false;
  let text = prompt ?? '';
  let draft = options.draft ?? '';
  let outcome: { sessionId: string; error?: string };
  try {
    outcome = await store.createChat(
      { ...base, text, placement: { continuedFrom: session.id, branch: { mode: 'native', ...cut } } },
      { open: false, title },
    );
  } catch (error) {
    if (errorCode(error) !== 'BRANCH_UNSUPPORTED') return { ok: false, error: errorText(error) };
    const kept = blocksBefore(snapshot.blocks, cut);
    if (kept === undefined) return { ok: false, error: BRANCH_POINT_COPY };
    mode = 'linked';
    const worktree = deps.worktreeReady(session.id);
    // A cut before the first message has nothing to summarise: the first message is only the person's own text.
    empty = kept.length === 0;
    if (!empty) {
      const digest = buildHandoffDraft({
        title: session.title,
        harnessLabel: harnessMeta(session.harness).label,
        blocks: kept,
      });
      // With no prompt nothing is sent: the digest waits in the composer for the person to finish.
      if (prompt === undefined) draft = `${digest}${draft}`;
      else text = `${digest}\n${prompt}`;
    }
    try {
      outcome = await store.createChat(
        {
          ...base,
          text,
          placement: {
            continuedFrom: session.id,
            branch: { mode: 'linked' },
            ...(worktree ? { worktree: { type: 'shared' as const, sessionId: session.id } } : {}),
          },
        },
        { open: false, title },
      );
    } catch (linkedError) {
      return { ok: false, error: errorText(linkedError) };
    }
  }
  const sessionId = outcome.sessionId;
  // A first message that was refused is already kept as the chat's draft.
  if (draft !== '' && outcome.error === undefined) store.updateDraft(sessionId, draft);
  let noRoom = false;
  if (options.open === 'beside') noRoom = (await deps.openBeside(sessionId)) === 'full';
  // With no room the screen is left as it is: opening the branch would replace a chat the person is using.
  if (options.open !== 'none' && !noRoom) await store.openSession(sessionId);
  return {
    ok: true,
    sessionId,
    title,
    mode,
    ...(empty ? { empty: true as const } : {}),
    ...(noRoom ? { noRoom: true as const } : {}),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}
