import { hostListen, type HostListen } from './transport';
import {
  WORKSPACE_EXTENSION_UI_EVENT,
  type WorkspaceExtensionUiAction,
  type WorkspaceExtensionUiEventV1,
} from '../../../../contracts/workspace-extension-ui-v1';

export type { WorkspaceExtensionUiAction, WorkspaceExtensionUiEventV1 } from '../../../../contracts/workspace-extension-ui-v1';

/**
 * Ephemeral extension UI surfaces of native sessions (workspace extension UI
 * v1). The host already bounds and redacts every value; this guard only
 * admits the exact contract shapes, so a malformed payload is dropped rather
 * than rendered. Renderers still treat every value as plain text.
 */
const MAX_TEXT = 128 * 1024;
const MAX_LINES = 100;

const isText = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.length <= max;
const isOptionalText = (value: unknown): boolean => value === undefined || isText(value);

export function isExtensionUiAction(value: unknown): value is WorkspaceExtensionUiAction {
  if (typeof value !== 'object' || value === null) return false;
  const action = value as Record<string, unknown>;
  switch (action.action) {
    case 'notify':
      return isText(action.id, 512) && isText(action.message) && ['info', 'warning', 'error'].includes(action.level as string);
    case 'status':
      return isText(action.key, 512) && isOptionalText(action.text);
    case 'widget':
      return isText(action.key, 512)
        && ['aboveEditor', 'belowEditor'].includes(action.placement as string)
        && (action.lines === undefined || (Array.isArray(action.lines) && action.lines.length <= MAX_LINES && action.lines.every((line) => isText(line))));
    case 'title':
      return isText(action.title, 1024);
    case 'editorText':
      return isText(action.text);
    case 'unsupported':
      return isText(action.id, 512) && isText(action.method, 64) && isText(action.safeSummary, 512);
    default:
      return false;
  }
}

export function isExtensionUiEvent(value: unknown): value is WorkspaceExtensionUiEventV1 {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return event.protocol === 1 && isText(event.sessionId, 512) && event.sessionId !== '' && isExtensionUiAction(event.action);
}

export interface ExtensionUiClient {
  listen(handler: (event: WorkspaceExtensionUiEventV1) => void): Promise<() => void>;
}

export function createExtensionUiClient(listen: HostListen): ExtensionUiClient {
  return {
    listen(handler) {
      return listen<unknown>(WORKSPACE_EXTENSION_UI_EVENT, (payload) => {
        if (isExtensionUiEvent(payload)) handler(payload);
      });
    },
  };
}

export const extensionUiHost: ExtensionUiClient = createExtensionUiClient(hostListen);
