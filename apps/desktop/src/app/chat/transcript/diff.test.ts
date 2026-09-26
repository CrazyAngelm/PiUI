import { describe, expect, it } from 'vitest';
import { diffTotals, parseDiff } from './diff';
import { activitySummary, looksLikeDiff, toolKind } from './toolKinds';
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
    expect(activitySummary(blocks, 'ru')).toBe('Изменил 1 файл · Выполнил 2 команды · Прочитал 5 файлов');
    expect(activitySummary(blocks, 'en')).toBe('Edited 1 file · Ran 2 commands · Read 5 files');
  });

  it('classifies coordinator tools as delegation', () => {
    expect(toolKind(block({ title: 'workspace.spawn_agent' }))).toBe('agent');
    expect(toolKind(block({ kind: 'thinking' }))).toBe('thinking');
    expect(toolKind(block({ toolName: 'mystery' }))).toBe('tool');
  });
});
