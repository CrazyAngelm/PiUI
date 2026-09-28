import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lookupRussian } from '../../features/locale/ruCatalog';
import { boardRu } from '../../features/locale/ru/board';
import { teamRu } from '../../features/locale/ru/team';
import { BOARD_ERROR_COPY } from '../../host-api/boardClient';
import { TEAMMATES_ERROR_COPY } from '../../host-api/teammatesClient';
import { PERMISSION_COPY, PRIORITY_LABEL, STATUS_LABEL, TIMELINE_COPY } from './boardModel';

const here = dirname(fileURLToPath(import.meta.url));
/** Every `$t('…')` literal of the board and team screens and the shared screens they touch. */
const FILES = [
  'BoardView.svelte',
  'BoardSettings.svelte',
  'CardDrawer.svelte',
  'CardTimeline.svelte',
  'BoardInboxSections.svelte',
  'ActiveCardChip.svelte',
  'ChatBoardActivity.svelte',
  'HandoffChips.svelte',
  '../team/TeamView.svelte',
  '../team/TeammateDialog.svelte',
  '../team/MentionTextarea.svelte',
  '../chatPipelines/ExecutorPicker.svelte',
  '../shell/Sidebar.svelte',
  '../shell/CommandPalette.svelte',
  '../shell/InboxView.svelte',
  '../runs/RunTriggerLabel.svelte',
];
/** Copy built outside `$t('…')` literals that reaches `$t` later. */
const MESSAGES = [
  ...Object.values(STATUS_LABEL),
  ...Object.values(PRIORITY_LABEL),
  ...PERMISSION_COPY.flatMap((item) => [item.label, item.description]),
  ...TIMELINE_COPY,
  ...Object.values(BOARD_ERROR_COPY),
  ...Object.values(TEAMMATES_ERROR_COPY),
  'Who is it?',
  'What runs it?',
  'When does it work?',
  'Working',
  'Queued',
  'Idle',
  'Could not accept the proposal',
  'Could not reject the proposal',
  'Could not start the run',
  'Could not dismiss the start',
  'Could not change the assignee',
  'Could not undo the change',
  'Could not unlink the chat',
  'Could not update the card',
  'Could not release the claim',
  'Could not delete the card',
  'Could not link the card',
  'Could not unlink the card',
];

function literals(file: string): string[] {
  const source = readFileSync(join(here, file), 'utf8');
  return [...source.matchAll(/\$t\('((?:[^'\\]|\\.)*)'/gu)].map((match) => (match[1] ?? '').replace(/\\'/gu, "'"));
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{\d+\}/gu)].map((match) => match[0]).sort();

describe('board and team in Russian', () => {
  it('translate every visible string', () => {
    const copy = [...new Set([...FILES.flatMap(literals), ...MESSAGES])];
    expect(copy.length).toBeGreaterThan(200);
    expect(copy.filter((value) => lookupRussian(value) === undefined)).toEqual([]);
  });

  it('keep placeholders and trimmed, non-empty values', () => {
    for (const [key, value] of Object.entries({ ...boardRu, ...teamRu })) {
      expect(value.trim(), key).not.toBe('');
      expect(value.trim(), key).toBe(value);
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
