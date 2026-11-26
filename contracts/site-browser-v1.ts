/** Local browser commands. Never exposed by the remote workbench. */
export const SITE_BROWSER_OPEN_LINK = 'site_browser_open_link_v1';

/** Only a trusted local chat view can open a validated link in the browser. */
export interface SiteBrowserOpenLinkRequestV1 {
  url: string;
  language: 'en' | 'ru';
}

/** true: built-in tab opened. false: the OS has no built-in browser. Errors carry a refusal. */
export type SiteBrowserOpenLinkResultV1 = boolean;

export const SITE_BROWSER_OPEN = 'site_browser_open_v1';
export const SITE_BROWSER_ACTION = 'site_browser_action_v1';
export const SITE_BROWSER_CHANGED = 'piui://site-browser-changed-v1';
export const SITE_BROWSER_POPUP_BLOCKED = 'piui://site-browser-popup-blocked-v1';
export const SITE_BROWSER_DOWNLOAD_BLOCKED = 'piui://site-browser-download-blocked-v1';

export type SiteBrowserAction =
  | { action: 'read' | 'new' }
  | { action: 'select' | 'close' | 'back' | 'forward' | 'reload'; tab: number }
  | { action: 'navigate'; tab: number; address: string }
  | { action: 'external'; tab: number; language: 'ru' | 'en' };

export interface SiteBrowserTab {
  readonly id: number;
  readonly url: string | null;
  readonly host: string | null;
}

export interface SiteBrowserSnapshot {
  readonly tabs: readonly SiteBrowserTab[];
  readonly active: number | null;
}
