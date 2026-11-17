import type { ConversationAttachment } from '../../../../../../contracts/conversation-presentation-v1';
import type { ChatFileOrigin, ChatFileV1 } from '../../../host-api/chatFilesClient';
import type { TimelineBlock } from '../../../host-api/types';

type Translate = (value: string, parameters?: readonly unknown[]) => string;

/** Cards one answer carries; the most recent files win. */
export const MAX_FILES_PER_ANSWER = 24;

export const ORIGIN_LABELS: Readonly<Record<ChatFileOrigin, string>> = {
  written: 'Written',
  read: 'Read',
  generated: 'Generated',
  returned: 'Returned',
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
 * Re-targets the files of a turn's tool blocks to the turn's final answer, so
 * they show with the answer while the work folds behind one control (ADR-073).
 * A turn starts at a person's message once the previous turn has an answer; a
 * turn with no answer yet shows nothing, and a file whose block is not in the
 * transcript (older history not loaded) is left out. A file several blocks of
 * one turn touched is one card.
 */
export function placeChatFiles(
  blocks: readonly TimelineBlock[],
  files: readonly ChatFileV1[],
  translate: Translate,
): ConversationAttachment[] {
  if (files.length === 0 || blocks.length === 0) return [];
  const turnOf = new Map<string, number>();
  const answers: (string | undefined)[] = [undefined];
  let turn = 0;
  for (const block of blocks) {
    if (block.kind === 'user' && answers[turn] !== undefined) {
      turn += 1;
      answers[turn] = undefined;
    }
    turnOf.set(block.id, turn);
    if (block.kind === 'assistant') answers[turn] = block.id;
  }
  const perAnswer = new Map<string, ConversationAttachment[]>();
  const seen = new Set<string>();
  for (const file of files) {
    if (!shown(file)) continue;
    const index = turnOf.get(file.blockId);
    const answer = index === undefined ? undefined : answers[index];
    if (answer === undefined) continue;
    const key = `${answer}:${file.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = perAnswer.get(answer) ?? [];
    list.push(describeFile(file, answer, translate));
    perAnswer.set(answer, list);
  }
  return [...perAnswer.values()].flatMap((list) => list.slice(-MAX_FILES_PER_ANSWER));
}
