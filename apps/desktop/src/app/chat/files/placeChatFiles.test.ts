import { describe, expect, it } from 'vitest';
import type { ChatFileV1 } from '../../../host-api/chatFilesClient';
import type { TimelineBlock } from '../../../host-api/types';
import { MAX_FILES_PER_ANSWER, createChatFilePlacer, formatFileSize, placeChatFiles } from './placeChatFiles';

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

  it('keeps an explicit result visible even when a tool wrote it in the same turn', () => {
    const written = file('report', 't2', { origin: 'written' });
    const returned = file('report', 't3', { origin: 'returned' });
    for (const files of [[written, returned], [returned, written]]) {
      const cards = placeChatFiles(turns, files, same);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ id: 'report', detail: 'Returned', downloadable: true });
      expect(cards[0]?.group).toBeUndefined();
    }
  });

  it('counts every distinct write without using the standalone card limit', () => {
    const writes = Array.from({ length: MAX_FILES_PER_ANSWER + 6 }, (_, index) => file(`f${index}`, 't2', { origin: 'written' }));
    const read = file('f0', 't2', { origin: 'read' });
    const duplicate = file('f0', 't3', { origin: 'written' });
    const result = file('result', 't3');
    const cards = placeChatFiles(turns, [read, ...writes, duplicate, result], same);
    expect(cards.filter((card) => card.group === 'changed-files').map((card) => card.id)).toEqual(writes.map((write) => write.id));
    expect(cards.find((card) => card.id === 'result')?.group).toBeUndefined();
  });

  it('leaves out a turn with no answer yet and a file whose block is not loaded', () => {
    const running = [block('u1', 'user'), block('t1', 'tool')];
    expect(placeChatFiles(running, [file('f1', 't1')], same)).toEqual([]);
    expect(placeChatFiles(turns, [file('f1', 'older')], same)).toEqual([]);
    expect(placeChatFiles([], [file('f1', 't1')], same)).toEqual([]);
    expect(placeChatFiles(turns, [], same)).toEqual([]);
  });

  it('keeps the files of a stopped turn with that turn, never with the next answer', () => {
    // The first turn was stopped before it answered; the person then wrote again.
    const stopped = [
      { ...block('u1', 'user') },
      { ...block('t1', 'tool'), status: 'interrupted' as const },
      block('u2', 'user'),
      block('t2', 'tool'),
      block('a2', 'assistant'),
    ];
    const cards = placeChatFiles(stopped, [file('f1', 't1'), file('f2', 't2')], same);
    expect(cards.map((card) => [card.id, card.blockId])).toEqual([['f2', 'a2']]);
    // A stopped turn that ended on an error keeps its files with that error.
    const failed = [block('u1', 'user'), block('t1', 'tool'), block('e1', 'error'), block('u2', 'user'), block('t2', 'tool'), block('a2', 'assistant')];
    expect(placeChatFiles(failed, [file('f1', 't1'), file('f2', 't2')], same).map((card) => [card.id, card.blockId])).toEqual([['f1', 'e1'], ['f2', 'a2']]);
    // A stopped turn that had started answering keeps its files with its own answer.
    const partial = [block('u1', 'user'), block('t1', 'tool'), { ...block('a1', 'assistant'), status: 'interrupted' as const, text: 'Half an' }, block('u2', 'user'), block('a2', 'assistant')];
    expect(placeChatFiles(partial, [file('f1', 't1')], same).map((card) => card.blockId)).toEqual(['a1']);
  });

  it('lets a message steered into a working turn join it, as the transcript does', () => {
    const steered = [block('u1', 'user'), block('t1', 'tool'), { ...block('u2', 'user'), status: 'streaming' as const }, block('a1', 'assistant')];
    expect(placeChatFiles(steered, [file('f1', 't1')], same, true).map((card) => card.blockId)).toEqual(['a1']);
    // Not working: the pending message is a new turn of its own.
    expect(placeChatFiles(steered, [file('f1', 't1')], same, false)).toEqual([]);
  });

  it('prefers the last reply that has text over an empty placeholder', () => {
    const blocks = [block('u1', 'user'), { ...block('a1', 'assistant'), text: 'Done' }, block('t1', 'tool'), block('a2', 'assistant')];
    expect(placeChatFiles(blocks, [file('f1', 't1')], same).map((card) => card.blockId)).toEqual(['a1']);
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

describe('createChatFilePlacer', () => {
  const answered = (text: string): TimelineBlock[] => [block('u1', 'user'), block('t1', 'tool'), { ...block('a1', 'assistant'), text }];
  const files = [file('f1', 't1')];

  it('returns the same cards while only the streamed text changes', () => {
    const place = createChatFilePlacer();
    const first = place(answered('Hel'), files, same, true);
    expect(first.map((card) => card.blockId)).toEqual(['a1']);
    for (const text of ['Hell', 'Hello', 'Hello world']) {
      expect(place(answered(text), files, same, true)).toBe(first);
    }
  });

  it('recomputes when a turn starts, a status changes, the registry changes or the language does', () => {
    const place = createChatFilePlacer();
    const first = place(answered('Hi'), files, same, true);
    const next = [...answered('Hi'), block('u2', 'user')];
    expect(place(next, files, same, true)).not.toBe(first);
    const settled = place(answered('Hi'), files, same, true);
    const stopped = answered('Hi');
    stopped[1] = { ...stopped[1]!, status: 'interrupted' };
    expect(place(stopped, files, same, true)).not.toBe(settled);
    const again = place(answered('Hi'), files, same, true);
    expect(place(answered('Hi'), [...files], same, true)).not.toBe(again);
    const translated = place(answered('Hi'), files, same, true);
    expect(place(answered('Hi'), files, (value) => `${value}!`, true)).not.toBe(translated);
    const running = place(answered('Hi'), files, same, true);
    expect(place(answered('Hi'), files, same, false)).not.toBe(running);
  });

  it('notices the first text of a reply, which can move the files to it', () => {
    const place = createChatFilePlacer();
    const blocks = (second: string): TimelineBlock[] => [block('u1', 'user'), { ...block('a1', 'assistant'), text: 'Plan' }, block('t1', 'tool'), { ...block('a2', 'assistant'), text: second }];
    expect(place(blocks(''), files, same, true).map((card) => card.blockId)).toEqual(['a1']);
    expect(place(blocks('Result'), files, same, true).map((card) => card.blockId)).toEqual(['a2']);
  });
});
