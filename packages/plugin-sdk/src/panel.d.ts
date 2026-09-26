import type { HostToPanelMessage, PanelChatContext, PanelMethodsV1, PanelTheme } from '../../../contracts/plugin-panel-v1';
import type { PluginValue } from '../../../contracts/piui-plugin-v1';

type InitMessage = Extract<HostToPanelMessage, { type: 'init' }>;

export interface PiuiPanel {
  /** Resolves with the init message: plugin, panel, permissions, theme, locale. */
  readonly ready: Promise<InitMessage>;
  request<M extends keyof PanelMethodsV1>(method: M, params?: PanelMethodsV1[M]['params']): Promise<PanelMethodsV1[M]['result']>;
  on(event: 'theme', listener: (theme: PanelTheme) => void): () => void;
  on(event: 'context', listener: (context: PanelChatContext) => void): () => void;
  getContext(): Promise<PanelChatContext>;
  runCommand(commandId: string): Promise<{ text?: string; notice?: string }>;
  getSettings(): Promise<Record<string, PluginValue>>;
  setSettings(values: Record<string, PluginValue>): Promise<Record<string, PluginValue>>;
  showNotice(message: string, level?: 'info' | 'warning' | 'error'): Promise<null>;
}

declare global {
  interface Window {
    piuiPanel: PiuiPanel;
  }
}
