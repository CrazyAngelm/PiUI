import type {
  ExtensionDialogRequest,
  ExtensionUiAction,
} from '../../host-api/types';

const MAX_VISIBLE_NOTIFICATIONS = 5;
const MAX_QUEUED_DIALOGS = 32;

export interface ExtensionNotificationView {
  id: string;
  message: string;
  level: 'info' | 'warning' | 'error';
}

export interface ExtensionStatusView {
  key: string;
  text: string;
}

export interface ExtensionWidgetView {
  key: string;
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor';
}

export interface ExtensionUiViewState {
  dialogs: ExtensionDialogRequest[];
  notifications: ExtensionNotificationView[];
  statuses: ExtensionStatusView[];
  widgets: ExtensionWidgetView[];
  title?: string;
  editorSuggestion?: string;
}

export interface ExtensionUiReduction {
  state: ExtensionUiViewState;
  draft: string;
}

export function emptyExtensionUiViewState(): ExtensionUiViewState {
  return {
    dialogs: [],
    notifications: [],
    statuses: [],
    widgets: [],
  };
}

function replaceKeyed<T extends { key: string }>(items: readonly T[], next: T): T[] {
  const index = items.findIndex((item) => item.key === next.key);
  if (index < 0) return [...items, next];
  return items.map((item, itemIndex) => itemIndex === index ? next : item);
}

export function reduceExtensionUiState(
  state: ExtensionUiViewState,
  action: ExtensionUiAction,
  draft: string,
): ExtensionUiReduction {
  switch (action.action) {
    case 'dialog': {
      if (
        state.dialogs.some((request) => request.id === action.request.id)
        || state.dialogs.length >= MAX_QUEUED_DIALOGS
      ) return { state, draft };
      return {
        state: { ...state, dialogs: [...state.dialogs, action.request] },
        draft,
      };
    }
    case 'notify': {
      const withoutDuplicate = state.notifications.filter((notice) => notice.id !== action.id);
      const notifications = [...withoutDuplicate, {
        id: action.id,
        message: action.message,
        level: action.level,
      }].slice(-MAX_VISIBLE_NOTIFICATIONS);
      return { state: { ...state, notifications }, draft };
    }
    case 'status': {
      const statuses = action.text === undefined
        ? state.statuses.filter((status) => status.key !== action.key)
        : replaceKeyed(state.statuses, { key: action.key, text: action.text });
      return { state: { ...state, statuses }, draft };
    }
    case 'widget': {
      const widgets = action.lines === undefined
        ? state.widgets.filter((widget) => widget.key !== action.key)
        : replaceKeyed(state.widgets, {
            key: action.key,
            lines: action.lines,
            placement: action.placement,
          });
      return { state: { ...state, widgets }, draft };
    }
    case 'title':
      return { state: { ...state, title: action.title || undefined }, draft };
    case 'editorText':
      return draft.length === 0
        ? { state: { ...state, editorSuggestion: undefined }, draft: action.text }
        : { state: { ...state, editorSuggestion: action.text }, draft };
    case 'unsupported': {
      const dialogs = state.dialogs.filter((dialog) => dialog.id !== action.id);
      const notifications = [...state.notifications, {
        id: action.id,
        message: action.safeSummary,
        level: 'warning' as const,
      }].slice(-MAX_VISIBLE_NOTIFICATIONS);
      return { state: { ...state, dialogs, notifications }, draft };
    }
  }
}

export function removeExtensionDialog(
  state: ExtensionUiViewState,
  requestId: string,
): ExtensionUiViewState {
  return { ...state, dialogs: state.dialogs.filter((request) => request.id !== requestId) };
}

export function dismissExtensionNotification(
  state: ExtensionUiViewState,
  notificationId: string,
): ExtensionUiViewState {
  return { ...state, notifications: state.notifications.filter((notice) => notice.id !== notificationId) };
}

export function applyEditorSuggestion(state: ExtensionUiViewState): ExtensionUiReduction {
  return {
    state: { ...state, editorSuggestion: undefined },
    draft: state.editorSuggestion ?? '',
  };
}

export function discardEditorSuggestion(state: ExtensionUiViewState): ExtensionUiViewState {
  return { ...state, editorSuggestion: undefined };
}
