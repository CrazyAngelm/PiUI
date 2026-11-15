import type { DesktopTimelineBlock } from '../../../../../contracts/runtime-protocol';
import type { ConversationMessageControls } from '../../../../../contracts/conversation-presentation-v1';
import type { BranchCut } from './branchChat';

/**
 * Per-message controls of a chat. A person's message can be copied and, in a
 * live chat, edited and sent again (a branch cut before it). The answer that
 * ends a turn can be copied and branched into a new chat.
 */
type MessageBlock = Pick<DesktopTimelineBlock, 'id' | 'kind' | 'text' | 'status'>;

export interface MessageControlOptions {
  /** Copy only: read-only views and chats that cannot branch. */
  readOnly?: boolean | undefined;
  /** The chat is working on a turn: its last answer is not final yet. */
  running?: boolean | undefined;
  /** Edit and branch are unavailable (safe mode, a branch being created). */
  locked?: boolean | undefined;
  /** The block whose text was just copied. */
  copiedId?: string | undefined;
}

const hasText = (block: MessageBlock): boolean => (block.text ?? '').trim() !== '';

/** Ids of the assistant blocks that end a turn: the last one with text before the next user message, or of the chat when it is idle. */
function turnEnds(blocks: readonly MessageBlock[], running: boolean): Set<string> {
  const ends = new Set<string>();
  let nextUser = false;
  let covered = false;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    if (block.kind === 'user') {
      nextUser = true;
      covered = false;
    } else if (block.kind === 'assistant' && hasText(block) && !covered) {
      covered = true;
      if ((nextUser || !running) && block.status !== 'streaming') ends.add(block.id);
    }
  }
  return ends;
}

export function buildMessageControls(blocks: readonly MessageBlock[], options: MessageControlOptions = {}): ConversationMessageControls[] {
  const ends = turnEnds(blocks, options.running === true);
  const controls: ConversationMessageControls[] = [];
  for (const block of blocks) {
    const user = block.kind === 'user' && hasText(block);
    if (!user && !ends.has(block.id)) continue;
    const actions: ConversationMessageControls['actions'] = [{ kind: 'copy' }];
    if (options.readOnly !== true) {
      // A message still waiting for the agent has nothing to cut before yet.
      if (user && block.status !== 'streaming') actions.push({ kind: 'edit', ...(options.locked ? { disabled: true } : {}) });
      if (!user) actions.push({ kind: 'branch', ...(options.locked ? { disabled: true } : {}) });
    }
    controls.push({ id: block.id, blockId: block.id, actions, ...(options.copiedId === block.id ? { copied: true } : {}) });
  }
  return controls;
}

/** Where a branch from the answer `answerId` starts: before the next user message, else the chat's end. */
export function branchCutAfter(blocks: readonly MessageBlock[], answerId: string): BranchCut | undefined {
  const index = blocks.findIndex((block) => block.id === answerId);
  if (index < 0) return undefined;
  const next = blocks.slice(index + 1).find((block) => block.kind === 'user');
  return next === undefined ? { at: 'end' } : { at: 'before', blockId: next.id };
}

/** The text to copy: a cut-short answer is read in full from the saved history. */
export async function messageText(
  block: Pick<DesktopTimelineBlock, 'id' | 'kind' | 'text' | 'truncated'>,
  readHistory: (() => Promise<readonly Pick<DesktopTimelineBlock, 'id' | 'kind' | 'text' | 'truncated'>[]>) | undefined = undefined,
): Promise<string> {
  if (!block.truncated || readHistory === undefined) return block.text ?? '';
  const history = await readHistory();
  const full = history.find((candidate) => candidate.id === block.id && candidate.kind === block.kind && !candidate.truncated);
  if (!full?.text) throw new Error('Full message unavailable');
  return full.text;
}

/** The draft of "Edit and send again": the person's whole message, or undefined when a cut-short one could not be read in full. */
export async function editDraft(
  block: Parameters<typeof messageText>[0],
  readHistory: Parameters<typeof messageText>[1] = undefined,
): Promise<string | undefined> {
  try {
    return await messageText(block, readHistory);
  } catch {
    return undefined;
  }
}
