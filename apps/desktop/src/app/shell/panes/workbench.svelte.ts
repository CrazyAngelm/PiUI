import { MAX_PANES, closePane, paneOf, panes, parseLayout, resizeSplit, splitPane, withSession, type PaneEdge, type PaneNode, type SplitPath } from './paneLayout';

export const MAX_TABS = 12;
export const WORKBENCH_STORAGE_KEY = 'piui.shell.workbench.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

interface Persisted {
  tabs: string[];
  layout: PaneNode | undefined;
  activePaneId: string;
}

/** A stored value is used whole or not at all: a broken part means the layout starts empty. */
function parsePersisted(raw: string | null): Persisted | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { tabs, layout, activePaneId } = value as Record<string, unknown>;
  if (!Array.isArray(tabs) || !tabs.every((id) => typeof id === 'string' && id !== '')) return undefined;
  if (typeof activePaneId !== 'string') return undefined;
  const parsed = layout === null || layout === undefined ? undefined : parseLayout(layout);
  if (layout !== null && layout !== undefined && !parsed) return undefined;
  return { tabs: [...new Set(tabs as string[])].slice(-MAX_TABS), layout: parsed, activePaneId };
}

/**
 * The chats kept open as tabs and the panes that show some of them. The selected
 * chat is still the route; this only decides what else is on screen.
 */
export class Workbench {
  /** Open chats, in strip order. */
  tabs = $state.raw<readonly string[]>([]);
  layout = $state.raw<PaneNode | undefined>(undefined);
  activePaneId = $state('');
  private storage: StorageLike | undefined;

  constructor(storage: StorageLike | undefined = browserStorage()) {
    this.storage = storage;
    let stored: Persisted | undefined;
    try {
      stored = parsePersisted(storage?.getItem(WORKBENCH_STORAGE_KEY) ?? null);
    } catch {
      stored = undefined;
    }
    if (!stored) return;
    this.layout = stored.layout;
    this.activePaneId = stored.activePaneId;
    // Every chat in a pane has its tab.
    const tabs = [...stored.tabs];
    for (const leaf of panes(stored.layout)) if (!tabs.includes(leaf.sessionId)) tabs.push(leaf.sessionId);
    this.tabs = tabs;
    this.settle();
  }

  /** Chat ids in panes, in reading order. */
  get shown(): string[] {
    return panes(this.layout).map((leaf) => leaf.sessionId);
  }

  /** Four panes are on screen. */
  get full(): boolean {
    return panes(this.layout).length >= MAX_PANES;
  }

  /** The chat of the active pane. */
  get activeSessionId(): string | undefined {
    return panes(this.layout).find((leaf) => leaf.id === this.activePaneId)?.sessionId;
  }

  /** The selected chat: focus the pane that shows it, else show it in the active pane (or the first pane). Adds its tab. */
  show(sessionId: string): void {
    this.addTab(sessionId);
    if (!this.layout) {
      const id = crypto.randomUUID();
      this.layout = { kind: 'pane', id, sessionId };
      this.activePaneId = id;
    } else {
      const existing = paneOf(this.layout, sessionId);
      if (existing) {
        this.activePaneId = existing.id;
      } else {
        const all = panes(this.layout);
        const target = all.find((leaf) => leaf.id === this.activePaneId) ?? all[0];
        if (!target) return;
        this.layout = withSession(this.layout, target.id, sessionId);
        this.activePaneId = target.id;
      }
    }
    this.save();
  }

  activate(paneId: string): void {
    if (paneId === this.activePaneId || !panes(this.layout).some((leaf) => leaf.id === paneId)) return;
    this.activePaneId = paneId;
    this.save();
  }

  /**
   * A new pane beside `paneId` (default: the active pane). A chat already shown elsewhere moves.
   * With no layout it behaves like show. False at the pane limit.
   */
  openBeside(sessionId: string, edge: PaneEdge = 'right', paneId: string = this.activePaneId): boolean {
    if (!this.layout) {
      this.show(sessionId);
      return true;
    }
    const existing = paneOf(this.layout, sessionId);
    if (existing?.id === paneId) return false;
    if (!existing && this.full) return false;
    const base = existing ? closePane(this.layout, existing.id) : this.layout;
    if (!base) return false;
    const id = crypto.randomUUID();
    const next = splitPane(base, paneId, edge, sessionId, id);
    if (!next) return false;
    this.addTab(sessionId);
    this.layout = next;
    this.activePaneId = id;
    this.save();
    return true;
  }

  /** Closes a pane; the tab stays. Returns the chat of the pane that becomes active, if any. */
  closePane(paneId: string): string | undefined {
    const before = panes(this.layout);
    const index = before.findIndex((leaf) => leaf.id === paneId);
    if (!this.layout || index < 0) return this.activeSessionId;
    this.layout = closePane(this.layout, paneId);
    if (this.activePaneId === paneId) {
      const after = panes(this.layout);
      // The neighbour after it, else the one before.
      this.activePaneId = after[Math.min(index, after.length - 1)]?.id ?? '';
    }
    this.settle();
    this.save();
    return this.activeSessionId;
  }

  /**
   * Closes a tab. A pane that showed it takes the neighbouring tab that is not on screen
   * (right first, then left), else the pane closes. Returns the chat of the active pane afterwards, if any.
   */
  closeTab(sessionId: string): string | undefined {
    const index = this.tabs.indexOf(sessionId);
    const pane = paneOf(this.layout, sessionId);
    if (index < 0 && !pane) return this.activeSessionId;
    const onScreen = new Set(this.shown);
    const candidates = [...this.tabs.slice(index + 1), ...this.tabs.slice(0, Math.max(index, 0)).reverse()];
    const replacement = candidates.find((id) => id !== sessionId && !onScreen.has(id));
    if (index >= 0) this.tabs = this.tabs.filter((id) => id !== sessionId);
    if (pane && this.layout) {
      if (replacement) this.layout = withSession(this.layout, pane.id, replacement);
      else {
        const all = panes(this.layout);
        const position = all.findIndex((leaf) => leaf.id === pane.id);
        this.layout = closePane(this.layout, pane.id);
        if (this.activePaneId === pane.id) {
          const after = panes(this.layout);
          this.activePaneId = after[Math.min(position, after.length - 1)]?.id ?? '';
        }
      }
    }
    this.settle();
    this.save();
    return this.activeSessionId;
  }

  /** Keeps chats that are on screen. */
  closeOthers(sessionId: string): void {
    const onScreen = new Set(this.shown);
    this.tabs = this.tabs.filter((id) => id === sessionId || onScreen.has(id));
    this.save();
  }

  moveTab(sessionId: string, toIndex: number): void {
    const from = this.tabs.indexOf(sessionId);
    if (from < 0) return;
    const rest = this.tabs.filter((id) => id !== sessionId);
    const to = Math.min(Math.max(Math.trunc(toIndex), 0), rest.length);
    if (to === from) return;
    rest.splice(to, 0, sessionId);
    this.tabs = rest;
    this.save();
  }

  resize(path: SplitPath, ratio: number): void {
    if (!this.layout) return;
    const next = resizeSplit(this.layout, path, ratio);
    if (next === this.layout) return;
    this.layout = next;
    this.save();
  }

  /** Drops tabs and panes of chats that no longer exist. */
  prune(exists: (sessionId: string) => boolean): void {
    const tabs = this.tabs.filter(exists);
    const tabsChanged = tabs.length !== this.tabs.length;
    let layout = this.layout;
    for (const leaf of panes(this.layout)) {
      if (!exists(leaf.sessionId) && layout) layout = closePane(layout, leaf.id);
    }
    if (!tabsChanged && layout === this.layout) return;
    if (tabsChanged) this.tabs = tabs;
    if (layout !== this.layout) this.layout = layout;
    this.settle();
    this.save();
  }

  /** The tab of a chat that is added: a 13th drops the oldest tab that is not on screen. */
  private addTab(sessionId: string): void {
    if (this.tabs.includes(sessionId)) return;
    let tabs = [...this.tabs, sessionId];
    if (tabs.length > MAX_TABS) {
      const onScreen = new Set(this.shown);
      const drop = tabs.find((id) => id !== sessionId && !onScreen.has(id));
      if (drop) tabs = tabs.filter((id) => id !== drop);
    }
    this.tabs = tabs;
  }

  /** The active pane always exists while there is a layout. */
  private settle(): void {
    const all = panes(this.layout);
    if (all.length === 0) {
      if (this.activePaneId !== '') this.activePaneId = '';
    } else if (!all.some((leaf) => leaf.id === this.activePaneId)) {
      this.activePaneId = all[0]?.id ?? '';
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ tabs: this.tabs, layout: this.layout ?? null, activePaneId: this.activePaneId }));
    } catch {
      // UI metadata is optional; chats stay host-owned.
    }
  }
}

export const workbench = new Workbench();
