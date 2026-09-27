import type { HostToPanelMessage, PanelChatContext, PanelMethodsV1, PanelRendererActivity, PanelTheme } from '../../../contracts/plugin-panel-v1';
import type { PluginValue } from '../../../contracts/piui-plugin-v2';

type InitMessage = Extract<HostToPanelMessage, { type: 'init' }>;

export interface PiuiPanel {
  /** Resolves with the init message: plugin, panel, permissions, theme, locale and, in a chat renderer, `renderer`. */
  readonly ready: Promise<InitMessage>;
  request<M extends keyof PanelMethodsV1>(method: M, params?: PanelMethodsV1[M]['params']): Promise<PanelMethodsV1[M]['result']>;
  on(event: 'theme', listener: (theme: PanelTheme) => void): () => void;
  on(event: 'context', listener: (context: PanelChatContext) => void): () => void;
  /** Chat renderers: the tool activity changed (streaming output, a new status). */
  on(event: 'activity', listener: (activity: PanelRendererActivity) => void): () => void;
  getContext(): Promise<PanelChatContext>;
  runCommand(commandId: string): Promise<{ text?: string; notice?: string }>;
  getSettings(): Promise<Record<string, PluginValue>>;
  setSettings(values: Record<string, PluginValue>): Promise<Record<string, PluginValue>>;
  showNotice(message: string, level?: 'info' | 'warning' | 'error'): Promise<null>;
  /** Chat renderers (`ui.renderer`): the frame height in CSS pixels, clamped to 48-600. */
  resize(height: number): Promise<null>;
  /** Chat renderers: follows the content's height; returns a stop function. */
  autoResize(): () => void;
}

declare global {
  interface Window {
    piuiPanel: PiuiPanel;
  }
}
