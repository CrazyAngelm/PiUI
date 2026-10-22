import { describe, expect, it } from 'vitest';
import { diffTotals, parseDiff } from './diff';
import { activityDiffTotals, activitySummary, looksLikeDiff, toolKind } from './toolKinds';
import type { TimelineBlock } from '../../../host-api/types';

const block = (patch: Partial<TimelineBlock>): TimelineBlock => ({ id: 'b', kind: 'tool', label: 'Tool', status: 'complete', ...patch });

describe('diff parsing', () => {
  it('parses git diffs with line numbers and totals', () => {
    const files = parseDiff(
      ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' keep', '-old', '+new', ' tail'].join('\n'),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/a.ts');
    expect(diffTotals(files)).toEqual({ added: 1, removed: 1 });
    const added = files[0]?.lines.find((line) => line.kind === 'add');
    expect(added?.newNumber).toBe(2);
  });

  it('splits Codex file-change text into files', () => {
    const files = parseDiff(['update: src/main.rs', '@@ -1 +1 @@', '-a', '+b', 'add: docs/new.md', '@@ -0,0 +1 @@', '+hello'].join('\n'));
    expect(files.map((file) => file.path)).toEqual(['src/main.rs', 'docs/new.md']);
    expect(files[1]?.change).toBe('add');
  });

  it('recognises diffs only when markers are present', () => {
    expect(looksLikeDiff('@@ -1 +1 @@\n-a\n+b')).toBe(true);
    expect(looksLikeDiff('plain output')).toBe(false);
  });
});

describe('activity summary', () => {

  it('counts categories with Russian plural forms', () => {
    const blocks = [
      block({ toolName: 'bash' }),
      block({ toolName: 'bash' }),
      block({ toolName: 'edit' }),
      block({ toolName: 'read' }),
      block({ toolName: 'read' }),
      block({ toolName: 'read' }),
      block({ toolName: 'read' }),
      block({ toolName: 'read' }),
    ];
    expect(activitySummary(blocks, 'ru')).toBe('Изменил 1 файл, выполнил 2 команды, прочитал 5 файлов');
    expect(activitySummary(blocks, 'en')).toBe('Edited 1 file, ran 2 commands, read 5 files');
  });

  it('omits thought noise when another activity is present and keeps thought-only summaries', () => {
    expect(activitySummary([block({ kind: 'thinking' }), block({ toolName: 'bash' }), block({ toolName: 'read' })], 'en')).toBe(
      'Ran 1 command, read 1 file',
    );
    expect(activitySummary([block({ kind: 'thinking' })], 'en')).toBe('Thought');
  });

  it('localizes overflow with one, few and many Russian action forms', () => {
    const summarizeWithOverflow = (extraReads: number) =>
      activitySummary(
        [block({ toolName: 'edit' }), block({ toolName: 'bash' }), block({ title: 'workspace.spawn_agent' }), ...Array.from({ length: extraReads }, () => block({ toolName: 'read' }))],
        'ru',
      );
    expect(summarizeWithOverflow(1)).toBe('Изменил 1 файл, выполнил 1 команду, поручил 1 задачу, и ещё 1 действие');
    expect(summarizeWithOverflow(2)).toBe('Изменил 1 файл, выполнил 1 команду, поручил 1 задачу, и ещё 2 действия');
    expect(summarizeWithOverflow(5)).toBe('Изменил 1 файл, выполнил 1 команду, поручил 1 задачу, и ещё 5 действий');
  });

  it('sums only edit diffs for a group badge', () => {
    const first = ['diff --git a/a.txt b/a.txt', '@@ -1,2 +1,3 @@', ' old', '-gone', '+new', '+extra'].join('\n');
    const second = ['@@ -1 +1 @@', '-before', '+after'].join('\n');
    expect(
      activityDiffTotals([
        block({ toolName: 'edit', text: first }),
        block({ label: 'File change', text: second }),
        block({ toolName: 'bash', text: second }),
        block({ toolName: 'edit', text: 'plain output' }),
      ]),
    ).toEqual({ added: 3, removed: 2 });
    expect(activityDiffTotals([block({ toolName: 'edit', text: 'plain output' })])).toBeUndefined();
  });

  it('classifies coordinator tools as delegation', () => {
    expect(toolKind(block({ title: 'workspace.spawn_agent' }))).toBe('agent');
    expect(toolKind(block({ kind: 'thinking' }))).toBe('thinking');
    expect(toolKind(block({ toolName: 'mystery' }))).toBe('tool');
  });
});
