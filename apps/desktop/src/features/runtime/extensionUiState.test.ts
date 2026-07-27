import { describe, expect, it } from 'vitest';
import type { ExtensionUiAction } from '../../host-api/types';
import {
  applyEditorSuggestion,
  emptyExtensionUiViewState,
  reduceExtensionUiState,
  removeExtensionDialog,
} from './extensionUiState';

describe('extension UI view state', () => {
  it('applies editor text only when the user draft is empty', () => {
    const action: ExtensionUiAction = { action: 'editorText', text: 'extension draft' };
    const empty = reduceExtensionUiState(emptyExtensionUiViewState(), action, '');
    expect(empty.draft).toBe('extension draft');
    expect(empty.state.editorSuggestion).toBeUndefined();

    const occupied = reduceExtensionUiState(emptyExtensionUiViewState(), action, 'user draft');
    expect(occupied.draft).toBe('user draft');
    expect(occupied.state.editorSuggestion).toBe('extension draft');
    expect(applyEditorSuggestion(occupied.state)).toEqual({
      state: { ...occupied.state, editorSuggestion: undefined },
      draft: 'extension draft',
    });
  });

  it('updates and clears keyed status and widget leases', () => {
    const status = reduceExtensionUiState(
      emptyExtensionUiViewState(),
      { action: 'status', key: 'status-a', text: 'LSP ready' },
      '',
    ).state;
    const widget = reduceExtensionUiState(
      status,
      { action: 'widget', key: 'widget-a', lines: ['Coordinator', 'Ready'], placement: 'aboveEditor' },
      '',
    ).state;
    expect(widget.statuses).toEqual([{ key: 'status-a', text: 'LSP ready' }]);
    expect(widget.widgets).toEqual([{ key: 'widget-a', lines: ['Coordinator', 'Ready'], placement: 'aboveEditor' }]);

    const clearedStatus = reduceExtensionUiState(widget, { action: 'status', key: 'status-a' }, '').state;
    const clearedWidget = reduceExtensionUiState(clearedStatus, { action: 'widget', key: 'widget-a', placement: 'aboveEditor' }, '').state;
    expect(clearedWidget.statuses).toEqual([]);
    expect(clearedWidget.widgets).toEqual([]);
  });

  it('deduplicates dialogs and bounds the notification queue', () => {
    let state = emptyExtensionUiViewState();
    const dialog: ExtensionUiAction = {
      action: 'dialog',
      request: { kind: 'confirm', id: 'dialog-a', title: 'Continue?', message: 'Confirm action' },
    };
    state = reduceExtensionUiState(state, dialog, '').state;
    state = reduceExtensionUiState(state, dialog, '').state;
    expect(state.dialogs).toHaveLength(1);
    const invalidated = reduceExtensionUiState(
      state,
      { action: 'unsupported', id: 'dialog-a', method: 'confirm', safeSummary: 'Dialog expired.' },
      '',
    ).state;
    expect(invalidated.dialogs).toEqual([]);
    expect(invalidated.notifications[0]?.message).toBe('Dialog expired.');

    let boundedDialogs = emptyExtensionUiViewState();
    for (let index = 0; index < 33; index += 1) {
      boundedDialogs = reduceExtensionUiState(
        boundedDialogs,
        {
          action: 'dialog',
          request: { kind: 'confirm', id: `dialog-${index}`, title: 'Continue?', message: 'Confirm action' },
        },
        '',
      ).state;
    }
    expect(boundedDialogs.dialogs).toHaveLength(32);
    expect(boundedDialogs.dialogs[0]?.id).toBe('dialog-0');
    expect(boundedDialogs.dialogs.at(-1)?.id).toBe('dialog-31');

    for (let index = 0; index < 8; index += 1) {
      state = reduceExtensionUiState(
        state,
        { action: 'notify', id: `notice-${index}`, message: `Notice ${index}`, level: 'info' },
        '',
      ).state;
    }
    expect(state.notifications.map((notice) => notice.message)).toEqual([
      'Notice 3',
      'Notice 4',
      'Notice 5',
      'Notice 6',
      'Notice 7',
    ]);
    expect(removeExtensionDialog(state, 'dialog-a').dialogs).toEqual([]);
  });
});
