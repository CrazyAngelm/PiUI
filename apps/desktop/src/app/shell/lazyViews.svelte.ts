import type BoardView from '../board/BoardView.svelte';
import type ChatView from './ChatView.svelte';
import type CommandPalette from './CommandPalette.svelte';
import type HistoryView from '../history/HistoryView.svelte';
import type InboxView from './InboxView.svelte';
import type PipelinesView from './PipelinesView.svelte';
import type SettingsView from './SettingsView.svelte';
import type TeamView from '../team/TeamView.svelte';

/**
 * Route views load on first use so first paint only ships the sidebar and
 * home composer. Loaded modules are kept, so revisiting a view never flashes
 * a loading state.
 */
interface Views {
  chat: typeof ChatView;
  inbox: typeof InboxView;
  pipelines: typeof PipelinesView;
  settings: typeof SettingsView;
  palette: typeof CommandPalette;
  history: typeof HistoryView;
  board: typeof BoardView;
  team: typeof TeamView;
}

export type LazyView = keyof Views;

const loaders: { [K in LazyView]: () => Promise<{ default: Views[K] }> } = {
  chat: () => import('./ChatView.svelte'),
  inbox: () => import('./InboxView.svelte'),
  pipelines: () => import('./PipelinesView.svelte'),
  settings: () => import('./SettingsView.svelte'),
  palette: () => import('./CommandPalette.svelte'),
  history: () => import('../history/HistoryView.svelte'),
  board: () => import('../board/BoardView.svelte'),
  team: () => import('../team/TeamView.svelte'),
};

class LazyViews {
  loaded = $state.raw<Partial<Views>>({});
  failed = $state.raw<Partial<Record<LazyView, string>>>({});
  private pending = new Map<LazyView, Promise<void>>();

  load(view: LazyView): Promise<void> {
    if (this.loaded[view]) return Promise.resolve();
    const existing = this.pending.get(view);
    if (existing) return existing;
    const promise = loaders[view]()
      .then((module) => {
        this.loaded = { ...this.loaded, [view]: module.default };
        const { [view]: _failed, ...rest } = this.failed;
        this.failed = rest;
      })
      .catch((error: unknown) => {
        this.failed = { ...this.failed, [view]: error instanceof Error ? error.message : 'Load failed' };
      })
      .finally(() => this.pending.delete(view));
    this.pending.set(view, promise);
    return promise;
  }

  /** Warm the likely next views after first paint without blocking it. */
  prefetch(): void {
    const schedule =
      typeof requestIdleCallback === 'function'
        ? (callback: () => void) => requestIdleCallback(callback)
        : (callback: () => void) => setTimeout(callback, 400);
    schedule(() => {
      void this.load('chat');
      void this.load('palette');
    });
  }
}

export const lazyViews = new LazyViews();
