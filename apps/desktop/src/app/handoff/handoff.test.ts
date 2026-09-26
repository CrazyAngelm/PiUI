import { describe, expect, it } from 'vitest';
import type { DesktopTimelineBlock } from '../../../../../contracts/runtime-protocol';
import { buildHandoffDraft } from './handoff';

const block = (kind: DesktopTimelineBlock['kind'], text: string, id = `${kind}-${text.length}`): DesktopTimelineBlock => ({
  id, kind, label: kind, text, status: 'complete',
});

describe('handoff draft', () => {
  it('uses the last request, a short answer excerpt and the reviewed files', () => {
    const draft = buildHandoffDraft({
      title: 'Route host calls',
      harnessLabel: 'Codex',
      blocks: [
        block('user', 'First request'),
        block('assistant', 'First answer'),
        block('user', 'Now make the lab lazy.\nKeep the API.'),
        block('tool', 'npm test'),
        block('assistant', `Done. ${'word '.repeat(300)}`),
      ],
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });
    expect(draft).toContain('I am continuing work from a Codex chat, "Route host calls".');
    expect(draft).toContain('The last request there was:\n> Now make the lab lazy.\n> Keep the API.');
    expect(draft).not.toContain('First request');
    expect(draft).toMatch(/The last answer began:\n> Done\.( word)+…\n/);
    expect(draft.length).toBeLessThan(1200);
    expect(draft).toContain('Files changed so far:\n- `src/a.ts`\n- `src/b.ts`');
    expect(draft.trimEnd().endsWith('Please continue from here:')).toBe(true);
  });

  it('works without history or files and caps long file lists', () => {
    const empty = buildHandoffDraft({ title: 'Empty', harnessLabel: 'Pi', blocks: [] });
    expect(empty).toBe('I am continuing work from a Pi chat, "Empty".\n\nPlease continue from here:\n');
    const many = buildHandoffDraft({
      title: 'Many',
      harnessLabel: 'Pi',
      blocks: [],
      changedFiles: Array.from({ length: 25 }, (_, index) => `f${index}.ts`),
    });
    expect(many).toContain('- …and 5 more');
    expect(many).not.toContain('f20.ts');
  });

  it('fills a translated template without translating the history', () => {
    const draft = buildHandoffDraft(
      { title: 'Plan', harnessLabel: 'Pi', blocks: [block('user', 'Keep English text')] },
      {
        intro: 'Продолжаю из чата {0} «{1}».',
        lastRequest: 'Последний запрос:',
        lastAnswer: 'Ответ:',
        changedFiles: 'Файлы:',
        moreFiles: '…и ещё {0}',
        next: 'Продолжи:',
      },
    );
    expect(draft).toBe('Продолжаю из чата Pi «Plan».\n\nПоследний запрос:\n> Keep English text\n\nПродолжи:\n');
  });
});
