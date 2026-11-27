import type { ConversationAttachment } from '../../../../../../contracts/conversation-presentation-v1';
import type { ChatFileOrigin, ChatFileV1 } from '../../../host-api/chatFilesClient';
import type { TimelineBlock } from '../../../host-api/types';
import { splitTurns } from '../../../features/sessions/timelineView';

type Translate = (value: string, parameters?: readonly unknown[]) => string;

/** Standalone cards one answer carries; the most recent files win. */
export const MAX_FILES_PER_ANSWER = 24;

export const ORIGIN_LABELS: Readonly<Record<ChatFileOrigin, string>> = {
  written: 'Written',
  read: 'Read',
  generated: 'Generated',
  returned: 'Returned',
};

const ORIGIN_PRIORITY: Readonly<Record<ChatFileOrigin, number>> = {
  read: 0,
  written: 1,
  generated: 2,
  returned: 3,
};

/** A file size for a card: `812 B`, `3.4 KB`, `12 MB`. */
export function formatFileSize(bytes: number, translate: Translate): string {
  const units: readonly [number, string][] = [
    [1024 ** 3, '{0} GB'],
    [1024 ** 2, '{0} MB'],
    [1024, '{0} KB'],
  ];
  for (const [size, key] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return translate(key, [value >= 10 ? Math.round(value) : Math.round(value * 10) / 10]);
    }
  }
  return translate('{0} B', [bytes]);
}

/**
 * Which cards a turn shows. Reading ordinary source files would bury the
 * answer in cards, so a file the agent only read is shown when it is media or
 * a document; a file it wrote, generated or returned always is. A file that has
 * gone shows only if the agent produced it.
 */
function shown(file: ChatFileV1): boolean {
  if (file.unavailable === true) return file.origin === 'written' || file.origin === 'generated';
  if (file.origin === 'read') return file.kind === 'image' || file.kind === 'audio' || file.kind === 'video' || file.kind === 'pdf';
  return true;
}

function describeFile(file: ChatFileV1, blockId: string, translate: Translate): ConversationAttachment {
  const media = file.previewable && (file.kind === 'image' || file.kind === 'audio' || file.kind === 'video') ? file.kind : 'file';
  const detail = [translate(ORIGIN_LABELS[file.origin]), file.size === undefined ? undefined : formatFileSize(file.size, translate)]
    .filter((part) => part !== undefined)
    .join(' · ');
  return {
    id: file.id,
    blockId,
    label: file.name,
    mediaType: file.mediaType,
    presentation: media,
    ...(file.origin === 'written' ? { group: 'changed-files' as const } : {}),
    detail,
    unavailable: file.unavailable === true ? true : undefined,
    openable: file.openable && file.unavailable !== true,
    downloadable: file.unavailable !== true,
    revealable: file.revealable && file.unavailable !== true,
    saveAs: true,
    deferPreview: true,
  };
}

/**
 * The block a turn's files show with: its last reply that has text, else its
 * last reply, else its last error (a stopped turn with no reply keeps its files
 * with the error it ended on). A turn that has none shows no card.
 */
function answerOf(turn: readonly TimelineBlock[]): string | undefined {
  let withText: string | undefined;
  let reply: string | undefined;
  let error: string | undefined;
  for (const block of turn) {
    if (block.kind === 'assistant') {
      reply = block.id;
      if (hasText(block)) withText = block.id;
    } else if (block.kind === 'error') error = block.id;
  }
  return withText ?? reply ?? error;
}

const hasText = (block: TimelineBlock): boolean => (block.text ?? '').trim() !== '';

/**
 * Re-targets the files of a turn's tool blocks to the turn's final answer, so
 * they show with the answer while the work folds behind one control (ADR-073).
 * Turns are the transcript's own (`splitTurns`): each person's message starts
 * one, so a turn that was stopped or failed keeps its files and never lends
 * them to the next turn's answer. A turn with no reply yet shows nothing, and
 * a file whose block is not in the transcript (older history not loaded) is
 * left out. A file several blocks of one turn touched is one card. `running`
 * tells whether a message steered into a working turn joins it.
 */
export function placeChatFiles(
  blocks: readonly TimelineBlock[],
  files: readonly ChatFileV1[],
  translate: Translate,
  running: boolean | 'unknown' = false,
): ConversationAttachment[] {
  if (files.length === 0 || blocks.length === 0) return [];
  const turnOf = new Map<string, number>();
  const answers: (string | undefined)[] = [];
  splitTurns(blocks, running).forEach((turn, index) => {
    for (const block of turn) turnOf.set(block.id, index);
    answers.push(answerOf(turn));
  });
  const perAnswer = new Map<string, Map<string, ChatFileV1>>();
  for (const file of files) {
    if (!shown(file)) continue;
    const index = turnOf.get(file.blockId);
    const answer = index === undefined ? undefined : answers[index];
    if (answer === undefined) continue;
    const found = perAnswer.get(answer) ?? new Map<string, ChatFileV1>();
    const previous = found.get(file.id);
    if (previous === undefined || ORIGIN_PRIORITY[file.origin] > ORIGIN_PRIORITY[previous.origin]) found.set(file.id, file);
    perAnswer.set(answer, found);
  }
  return [...perAnswer].flatMap(([answer, found]) => {
    const changed: ChatFileV1[] = [];
    const standalone: ChatFileV1[] = [];
    for (const file of found.values()) (file.origin === 'written' ? changed : standalone).push(file);
    return [...standalone.slice(-MAX_FILES_PER_ANSWER), ...changed].map((file) => describeFile(file, answer, translate));
  });
}

/** What decides where a block's files go: its identity, kind, status and whether it has text. */
function sameShape(left: readonly TimelineBlock[], right: readonly TimelineBlock[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    if (a.id !== b.id || a.kind !== b.kind || a.status !== b.status || hasText(a) !== hasText(b)) return false;
  }
  return true;
}

/**
 * `placeChatFiles` for a live chat. A streamed token changes a block's text and
 * nothing that decides where a file goes, so the previous cards (the same array)
 * are returned until the turns, a block's status, the registry or the language
 * change.
 */
export function createChatFilePlacer(): (
  blocks: readonly TimelineBlock[],
  files: readonly ChatFileV1[],
  translate: Translate,
  running?: boolean | 'unknown',
) => ConversationAttachment[] {
  let knownBlocks: readonly TimelineBlock[] | undefined;
  let knownFiles: readonly ChatFileV1[] | undefined;
  let knownTranslate: Translate | undefined;
  let knownRunning: boolean | 'unknown' | undefined;
  let cards: ConversationAttachment[] = [];
  return (blocks, files, translate, running = false) => {
    if (knownBlocks !== undefined && files === knownFiles && translate === knownTranslate && running === knownRunning && sameShape(knownBlocks, blocks)) {
      // Keep the newest array so the next comparison is by identity again.
      knownBlocks = blocks;
      return cards;
    }
    knownBlocks = blocks;
    knownFiles = files;
    knownTranslate = translate;
    knownRunning = running;
    cards = placeChatFiles(blocks, files, translate, running);
    return cards;
  };
}
