import { describe, expect, it } from 'vitest';
import { panes, type PaneNode } from './paneLayout';
import { MAX_TABS, WORKBENCH_STORAGE_KEY, Workbench } from './workbench.svelte';

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, String(value)) };
}

const make = (storage = memoryStorage()): Workbench => new Workbench(storage);
const withChats = (...ids: string[]): Workbench => {
  const bench = make();
  for (const id of ids) bench.show(id);
  return bench;
};
const paneId = (bench: Workbench, sessionId: string): string => {
  const leaf = panes(bench.layout).find((item) => item.sessionId === sessionId);
  if (!leaf) throw new Error(`No pane shows ${sessionId}.`);
  return leaf.id;
};

describe('show', () => {
  it('opens the first chat in a pane and gives it a tab', () => {
    const bench = make();
    bench.show('A');
    expect(bench.tabs).toEqual(['A']);
    expect(bench.shown).toEqual(['A']);
    expect(bench.activePaneId).toBe(paneId(bench, 'A'));
  });

  it('replaces the chat of the active pane and keeps older tabs', () => {
    const bench = withChats('A', 'B');
    expect(bench.shown).toEqual(['B']);
    expect(bench.tabs).toEqual(['A', 'B']);
  });

  it('focuses the pane that already shows the chat', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    expect(bench.activePaneId).toBe(paneId(bench, 'B'));
    bench.show('A');
    expect(bench.activePaneId).toBe(paneId(bench, 'A'));
    expect(bench.shown).toEqual(['A', 'B']);
    expect(bench.tabs).toEqual(['A', 'B']);
  });

  it('replaces in the active pane when a split exists', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    bench.show('C');
    expect(bench.shown).toEqual(['A', 'C']);
    expect(bench.tabs).toEqual(['A', 'B', 'C']);
  });

  it('falls back to the first pane when the active one is unknown', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    bench.activePaneId = 'gone';
    bench.show('C');
    expect(bench.shown).toEqual(['C', 'B']);
  });
});

describe('moveToPane', () => {
  it('restores an on-screen chat to the left without closing the target chat or the third pane', () => {
    const storage = memoryStorage();
    const bench = make(storage);
    bench.show('A');
    bench.openBeside('B');
    bench.openBeside('C', 'bottom');
    const left = paneId(bench, 'A');

    expect(bench.moveToPane('C', left)).toBe(true);
    expect(bench.shown).toEqual(['C', 'B', 'A']);
    expect(bench.activePaneId).toBe(left);
    expect(bench.tabs).toEqual(['A', 'B', 'C']);
    expect(make(storage).shown).toEqual(bench.shown);
    expect(bench.moveToPane('C', left)).toBe(false);
    expect(bench.moveToPane('A', 'missing')).toBe(false);
  });

  it('replaces the target pane with a hidden chat and leaves its previous chat in the tab strip', () => {
    const bench = withChats('A', 'B');
    expect(bench.moveToPane('A', paneId(bench, 'B'))).toBe(true);
    expect(bench.shown).toEqual(['A']);
    expect(bench.tabs).toEqual(['A', 'B']);
  });
});

describe('openBeside', () => {
  it('behaves like show when nothing is open', () => {
    const bench = make();
    expect(bench.openBeside('A')).toBe(true);
    expect(bench.shown).toEqual(['A']);
  });

  it('puts the chat on the asked edge and activates the new pane', () => {
    const bench = withChats('A');
    expect(bench.openBeside('B', 'left')).toBe(true);
    expect(bench.shown).toEqual(['B', 'A']);
    expect(bench.activePaneId).toBe(paneId(bench, 'B'));
  });

  it('builds one left, one right and a third bottom-left', () => {
    const bench = withChats('A');
    bench.openBeside('B', 'right');
    bench.openBeside('C', 'bottom', paneId(bench, 'A'));
    const layout = bench.layout as PaneNode & { kind: 'split' };
    expect(layout.direction).toBe('row');
    expect(layout.first).toMatchObject({ kind: 'split', direction: 'column' });
    expect(bench.shown).toEqual(['A', 'C', 'B']);
  });

  it('moves a chat that is shown elsewhere instead of duplicating it', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    bench.openBeside('C');
    expect(bench.shown).toEqual(['A', 'B', 'C']);
    expect(bench.openBeside('A', 'bottom', paneId(bench, 'C'))).toBe(true);
    expect(bench.shown.sort()).toEqual(['A', 'B', 'C']);
    expect(bench.shown.filter((id) => id === 'A')).toHaveLength(1);
    expect(bench.activePaneId).toBe(paneId(bench, 'A'));
  });

  it('refuses a chat beside its own pane', () => {
    const bench = withChats('A');
    expect(bench.openBeside('B')).toBe(true);
    expect(bench.openBeside('B', 'right', paneId(bench, 'B'))).toBe(false);
    expect(bench.shown).toEqual(['A', 'B']);
  });

  it('stops at four panes, but still moves a chat that is on screen', () => {
    const bench = withChats('A');
    for (const id of ['B', 'C', 'D']) expect(bench.openBeside(id)).toBe(true);
    expect(bench.shown).toHaveLength(4);
    expect(bench.full).toBe(true);
    expect(bench.openBeside('E')).toBe(false);
    expect(bench.tabs).not.toContain('E');
    expect(bench.shown).toHaveLength(4);
    expect(bench.openBeside('A', 'bottom', paneId(bench, 'D'))).toBe(true);
    expect(bench.shown).toHaveLength(4);
    expect(new Set(bench.shown).size).toBe(4);
  });

  it('refuses an unknown pane', () => {
    const bench = withChats('A');
    expect(bench.openBeside('B', 'right', 'gone')).toBe(false);
    expect(bench.shown).toEqual(['A']);
  });
});

describe('closePane', () => {
  it('closes the pane, keeps its tab and activates the neighbour', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    bench.openBeside('C');
    expect(bench.closePane(paneId(bench, 'C'))).toBe('B');
    expect(bench.shown).toEqual(['A', 'B']);
    expect(bench.tabs).toEqual(['A', 'B', 'C']);
    expect(bench.activePaneId).toBe(paneId(bench, 'B'));
  });

  it('collapses to a single pane', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    expect(bench.closePane(paneId(bench, 'B'))).toBe('A');
    expect(bench.layout?.kind).toBe('pane');
  });

  it('keeps the active pane when another one closes', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    expect(bench.closePane(paneId(bench, 'A'))).toBe('B');
    expect(bench.activePaneId).toBe(paneId(bench, 'B'));
  });

  it('returns nothing when the last pane closes', () => {
    const bench = withChats('A');
    expect(bench.closePane(paneId(bench, 'A'))).toBeUndefined();
    expect(bench.layout).toBeUndefined();
    expect(bench.activePaneId).toBe('');
    expect(bench.tabs).toEqual(['A']);
  });
});

describe('closeTab', () => {
  it('gives the pane the tab on its right that is not on screen', () => {
    const bench = withChats('A', 'B', 'C');
    bench.show('B');
    expect(bench.closeTab('B')).toBe('C');
    expect(bench.shown).toEqual(['C']);
    expect(bench.tabs).toEqual(['A', 'C']);
  });

  it('takes the left tab when there is none on the right', () => {
    const bench = withChats('A', 'B');
    expect(bench.closeTab('B')).toBe('A');
    expect(bench.shown).toEqual(['A']);
  });

  it('skips tabs that are on screen and closes the pane when none is left', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    expect(bench.closeTab('B')).toBe('A');
    expect(bench.shown).toEqual(['A']);
    expect(bench.layout?.kind).toBe('pane');
    expect(bench.tabs).toEqual(['A']);
  });

  it('leaves the panes alone when the chat is not on screen', () => {
    const bench = withChats('A', 'B');
    bench.show('A');
    expect(bench.closeTab('B')).toBe('A');
    expect(bench.shown).toEqual(['A']);
    expect(bench.tabs).toEqual(['A']);
  });

  it('returns nothing when the last tab closes', () => {
    const bench = withChats('A');
    expect(bench.closeTab('A')).toBeUndefined();
    expect(bench.tabs).toEqual([]);
    expect(bench.layout).toBeUndefined();
  });

  it('ignores an unknown chat', () => {
    const bench = withChats('A');
    expect(bench.closeTab('Z')).toBe('A');
    expect(bench.tabs).toEqual(['A']);
  });
});

describe('closeOthers', () => {
  it('keeps the chosen tab and the chats on screen', () => {
    const bench = withChats('A', 'B', 'C', 'D');
    bench.show('B');
    bench.openBeside('C');
    bench.closeOthers('B');
    expect(bench.tabs).toEqual(['B', 'C']);
    expect(bench.shown).toEqual(['B', 'C']);
  });
});

describe('moveTab', () => {
  it('reorders tabs and clamps the index', () => {
    const bench = withChats('A', 'B', 'C');
    bench.moveTab('C', 0);
    expect(bench.tabs).toEqual(['C', 'A', 'B']);
    bench.moveTab('C', 99);
    expect(bench.tabs).toEqual(['A', 'B', 'C']);
    bench.moveTab('Z', 0);
    expect(bench.tabs).toEqual(['A', 'B', 'C']);
  });
});

describe('resize', () => {
  it('stores a clamped ratio for a split', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    bench.resize([], 0.3);
    expect(bench.layout).toMatchObject({ ratio: 0.3 });
    bench.resize([], 0.95);
    expect(bench.layout).toMatchObject({ ratio: 0.8 });
  });
});

describe('tab cap', () => {
  it('drops the oldest tab that is not on screen when a 13th opens', () => {
    const bench = make();
    for (let index = 0; index < MAX_TABS; index += 1) bench.show(`c${index}`);
    expect(bench.tabs).toHaveLength(MAX_TABS);
    bench.openBeside('c0');
    bench.show('c0');
    bench.show('new');
    expect(bench.tabs).toHaveLength(MAX_TABS);
    expect(bench.tabs).toContain('new');
    expect(bench.tabs).toContain('c0');
    expect(bench.tabs).not.toContain('c1');
  });

  it('never drops a chat that is on screen', () => {
    const bench = withChats('c0');
    bench.openBeside('c1');
    for (let index = 2; index < MAX_TABS + 3; index += 1) bench.openBeside(`c${index}`, 'right', bench.activePaneId) || bench.show(`c${index}`);
    expect(bench.tabs).toHaveLength(MAX_TABS);
    for (const id of bench.shown) expect(bench.tabs).toContain(id);
  });
});

describe('prune', () => {
  it('drops tabs and panes of chats that are gone', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    bench.openBeside('C');
    bench.show('D');
    bench.prune((id) => id !== 'B' && id !== 'D');
    expect(bench.tabs).toEqual(['A', 'C']);
    expect(bench.shown).toEqual(['A']);
    expect(panes(bench.layout).map((leaf) => leaf.id)).toContain(bench.activePaneId);
  });

  it('changes nothing when every chat exists', () => {
    const bench = withChats('A');
    bench.openBeside('B');
    const layout = bench.layout;
    const tabs = bench.tabs;
    bench.prune(() => true);
    expect(bench.layout).toBe(layout);
    expect(bench.tabs).toBe(tabs);
  });

  it('empties everything when no chat exists', () => {
    const bench = withChats('A', 'B');
    bench.prune(() => false);
    expect(bench.tabs).toEqual([]);
    expect(bench.layout).toBeUndefined();
    expect(bench.activePaneId).toBe('');
  });
});

describe('persistence', () => {
  it('writes every change and restores tabs, panes and the active pane', () => {
    const storage = memoryStorage();
    const bench = make(storage);
    bench.show('A');
    bench.openBeside('B');
    bench.openBeside('C', 'bottom');
    bench.show('D');
    bench.resize([], 0.35);
    const saved = JSON.parse(storage.values.get(WORKBENCH_STORAGE_KEY) ?? 'null');
    expect(saved.tabs).toEqual(['A', 'B', 'C', 'D']);

    const restored = make(storage);
    expect(restored.tabs).toEqual(bench.tabs);
    expect(restored.layout).toEqual(bench.layout);
    expect(restored.activePaneId).toBe(bench.activePaneId);
    expect(restored.shown).toEqual(bench.shown);
  });

  it('adds a tab for a pane whose tab is missing from the stored value', () => {
    const storage = memoryStorage({
      [WORKBENCH_STORAGE_KEY]: JSON.stringify({ tabs: ['B'], layout: { kind: 'pane', id: 'p', sessionId: 'A' }, activePaneId: 'p' }),
    });
    const bench = make(storage);
    expect(bench.tabs).toEqual(['B', 'A']);
  });

  it('repairs an active pane that does not exist', () => {
    const storage = memoryStorage({
      [WORKBENCH_STORAGE_KEY]: JSON.stringify({ tabs: ['A'], layout: { kind: 'pane', id: 'p', sessionId: 'A' }, activePaneId: 'nope' }),
    });
    expect(make(storage).activePaneId).toBe('p');
  });

  it.each([
    ['text that is not JSON', '{nope'],
    ['an array', '[]'],
    ['tabs that are not strings', JSON.stringify({ tabs: [1], layout: null, activePaneId: '' })],
    ['a missing active pane', JSON.stringify({ tabs: [], layout: null })],
    ['a layout with a repeated chat', JSON.stringify({ tabs: ['A'], activePaneId: 'a', layout: { kind: 'split', direction: 'row', ratio: 0.5, first: { kind: 'pane', id: 'a', sessionId: 'A' }, second: { kind: 'pane', id: 'b', sessionId: 'A' } } })],
    ['a layout of an unknown shape', JSON.stringify({ tabs: [], activePaneId: '', layout: { kind: 'grid' } })],
  ])('ignores %s', (_name, value) => {
    const bench = make(memoryStorage({ [WORKBENCH_STORAGE_KEY]: value }));
    expect(bench.tabs).toEqual([]);
    expect(bench.layout).toBeUndefined();
    expect(bench.activePaneId).toBe('');
  });

  it('works without storage and when storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const bench = new Workbench(throwing);
    bench.show('A');
    expect(bench.tabs).toEqual(['A']);
    const none = new Workbench(undefined);
    none.show('B');
    expect(none.shown).toEqual(['B']);
  });
});
