import { describe, expect, it } from 'vitest';
import type { ChatFileV1 } from '../../../host-api/chatFilesClient';
import type { TimelineBlock } from '../../../host-api/types';
import { MAX_FILES_PER_ANSWER, formatFileSize, placeChatFiles } from './placeChatFiles';

const same = (value: string, parameters?: readonly unknown[]): string =>
  (parameters ?? []).reduce<string>((text, item, index) => text.replace(`{${index}}`, String(item)), value);

function block(id: string, kind: TimelineBlock['kind']): TimelineBlock {
  return { id, kind, status: 'complete' };
}

function file(id: string, blockId: string, patch: Partial<ChatFileV1> = {}): ChatFileV1 {
  return { id, blockId, name: `${id}.png`, kind: 'image', origin: 'generated', openable: true, previewable: true, revealable: true, ...patch };
}

const turns = [
  block('u1', 'user'),
  block('t1', 'tool'),
  block('a1', 'assistant'),
  block('u2', 'user'),
  block('t2', 'tool'),
  block('t3', 'tool'),
  block('a2', 'assistant'),
];

describe('placeChatFiles', () => {
  it('moves the files of a turn to its final answer', () => {
    const cards = placeChatFiles(turns, [file('f1', 't1'), file('f2', 't2'), file('f3', 't3')], same);
    expect(cards.map((card) => [card.id, card.blockId])).toEqual([['f1', 'a1'], ['f2', 'a2'], ['f3', 'a2']]);
  });

  it('shows one card for a file several blocks of a turn touched', () => {
    const cards = placeChatFiles(turns, [file('f1', 't2'), file('f1', 't3')], same);
    expect(cards.map((card) => card.id)).toEqual(['f1']);
  });

  it('leaves out a turn with no answer yet and a file whose block is not loaded', () => {
    const running = [block('u1', 'user'), block('t1', 'tool')];
    expect(placeChatFiles(running, [file('f1', 't1')], same)).toEqual([]);
    expect(placeChatFiles(turns, [file('f1', 'older')], same)).toEqual([]);
    expect(placeChatFiles([], [file('f1', 't1')], same)).toEqual([]);
    expect(placeChatFiles(turns, [], same)).toEqual([]);
  });

  it('keeps the answer of a turn that continues after a second assistant block', () => {
    const blocks = [block('u1', 'user'), block('a1', 'assistant'), block('t1', 'tool'), block('a2', 'assistant')];
    expect(placeChatFiles(blocks, [file('f1', 't1')], same).map((card) => card.blockId)).toEqual(['a2']);
  });

  it('shows a file the agent only read when it is media or a document, never source text', () => {
    const files = [
      file('image', 't1', { origin: 'read' }),
      file('pdf', 't1', { origin: 'read', kind: 'pdf', previewable: false }),
      file('code', 't1', { origin: 'read', kind: 'text', previewable: false }),
      file('other', 't1', { origin: 'read', kind: 'file', previewable: false }),
      file('written', 't1', { origin: 'written', kind: 'text', previewable: false }),
    ];
    expect(placeChatFiles(turns, files, same).map((card) => card.id)).toEqual(['image', 'pdf', 'written']);
  });

  it('shows a file that has gone only when the agent produced it, without actions', () => {
    const files = [
      file('gone-written', 't1', { origin: 'written', unavailable: true, openable: false, revealable: false }),
      file('gone-read', 't1', { origin: 'read', unavailable: true, openable: false, revealable: false }),
    ];
    const cards = placeChatFiles(turns, files, same);
    expect(cards.map((card) => card.id)).toEqual(['gone-written']);
    expect(cards[0]).toMatchObject({ unavailable: true, openable: false, downloadable: false, revealable: false });
  });

  it('describes a card: preview kind, origin and size, with the save and reveal actions and a deferred preview', () => {
    const [image, audio, text] = placeChatFiles(
      turns,
      [
        file('img', 't1', { size: 3_500 }),
        file('snd', 't1', { kind: 'audio', name: 'narration.wav', mediaType: 'audio/wav', origin: 'returned', size: 90 }),
        file('txt', 't1', { kind: 'text', name: 'notes.txt', previewable: false, origin: 'written' }),
      ],
      same,
    );
    expect(image).toMatchObject({ id: 'img', label: 'img.png', presentation: 'image', detail: 'Generated · 3.4 KB', revealable: true, saveAs: true, deferPreview: true, downloadable: true });
    expect(audio).toMatchObject({ presentation: 'audio', mediaType: 'audio/wav', detail: 'Returned · 90 B' });
    expect(text).toMatchObject({ presentation: 'file', detail: 'Written' });
    expect(text?.unavailable).toBeUndefined();
  });

  it('shows a media file that cannot be previewed as a plain card', () => {
    const [card] = placeChatFiles(turns, [file('big', 't1', { kind: 'video', previewable: false })], same);
    expect(card?.presentation).toBe('file');
  });

  it('keeps the most recent files of one answer', () => {
    const files = Array.from({ length: MAX_FILES_PER_ANSWER + 6 }, (_, index) => file(`f${index}`, 't1'));
    const cards = placeChatFiles(turns, files, same);
    expect(cards).toHaveLength(MAX_FILES_PER_ANSWER);
    expect(cards[0]?.id).toBe('f6');
    expect(cards.at(-1)?.id).toBe(`f${MAX_FILES_PER_ANSWER + 5}`);
  });
});

describe('formatFileSize', () => {
  it('rounds to one decimal below ten units and to whole units above', () => {
    expect(formatFileSize(0, same)).toBe('0 B');
    expect(formatFileSize(1023, same)).toBe('1023 B');
    expect(formatFileSize(1024, same)).toBe('1 KB');
    expect(formatFileSize(1536, same)).toBe('1.5 KB');
    expect(formatFileSize(12 * 1024 * 1024, same)).toBe('12 MB');
    expect(formatFileSize(5 * 1024 ** 3, same)).toBe('5 GB');
  });
});
