import { describe, expect, it } from 'vitest';
import { createMemoryStorage, createScopedStorage, installStorageScope, storageScopePrefix } from './storageScope';

/** The shell's own keys, as the desktop workspace store writes them. */
const DRAFTS = 'piui.shell.drafts.v1';
const ROUTE = 'piui.shell.route.v1';

function fakeStorage(): Storage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get length() {
      return raw.size;
    },
    key: (index: number) => [...raw.keys()][index] ?? null,
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: (key: string, value: string) => void raw.set(key, value),
    removeItem: (key: string) => void raw.delete(key),
    clear: () => raw.clear(),
  } as Storage & { raw: Map<string, string> };
}

describe('scoped storage', () => {
  it('keeps a draft typed for device A away from device B, and gives it back to A', () => {
    const base = fakeStorage();
    const a = () => createScopedStorage(base, storageScopePrefix('dev_a'));
    const b = () => createScopedStorage(base, storageScopePrefix('dev_b'));

    a().setItem(DRAFTS, JSON.stringify({ 'session-1': 'secret for A' }));
    a().setItem(ROUTE, JSON.stringify({ name: 'chat' }));
    expect(b().getItem(DRAFTS)).toBeNull();
    expect(b().getItem(ROUTE)).toBeNull();
    expect(b().length).toBe(0);

    b().setItem(DRAFTS, JSON.stringify({ 'session-1': 'text for B' }));
    expect(a().getItem(DRAFTS)).toBe(JSON.stringify({ 'session-1': 'secret for A' }));
    expect(b().getItem(DRAFTS)).toBe(JSON.stringify({ 'session-1': 'text for B' }));

    // A again, from a view created later (a reload of the frame).
    expect(a().getItem(DRAFTS)).toBe(JSON.stringify({ 'session-1': 'secret for A' }));
    expect([...base.raw.keys()].sort()).toEqual([
      `nano-remote:dev_a:${DRAFTS}`, `nano-remote:dev_a:${ROUTE}`, `nano-remote:dev_b:${DRAFTS}`,
    ]);
  });

  it('lists, counts and clears only its own keys', () => {
    const base = fakeStorage();
    base.setItem('other-page-key', 'x');
    const a = createScopedStorage(base, storageScopePrefix('dev_a'));
    const b = createScopedStorage(base, storageScopePrefix('dev_b'));
    a.setItem('one', '1');
    a.setItem('two', '2');
    b.setItem('one', 'b');

    expect(a.length).toBe(2);
    expect([a.key(0), a.key(1), a.key(2)]).toEqual(['one', 'two', null]);
    a.removeItem('one');
    expect(a.getItem('one')).toBeNull();
    expect(b.getItem('one')).toBe('b');
    a.clear();
    expect(a.length).toBe(0);
    expect(b.getItem('one')).toBe('b');
    expect(base.getItem('other-page-key')).toBe('x');
  });

  it('does not let one device id reach into another through a shared prefix', () => {
    const base = fakeStorage();
    const short = createScopedStorage(base, storageScopePrefix('dev_a'));
    const long = createScopedStorage(base, storageScopePrefix('dev_a_long'));
    long.setItem('k', 'long');
    short.setItem('k', 'short');
    expect(short.length).toBe(1);
    expect(short.getItem('k')).toBe('short');
    expect(long.getItem('k')).toBe('long');
  });

  it('stores values as strings, like the platform does', () => {
    const view = createScopedStorage(fakeStorage(), storageScopePrefix('dev_a'));
    view.setItem('n', 5 as unknown as string);
    expect(view.getItem('n')).toBe('5');
  });
});

describe('memory storage', () => {
  it('behaves like a storage that vanishes with the page', () => {
    const store = createMemoryStorage();
    store.setItem('a', '1');
    expect(store.getItem('a')).toBe('1');
    expect(store.length).toBe(1);
    expect(store.key(0)).toBe('a');
    store.removeItem('a');
    expect(store.getItem('a')).toBeNull();
    store.setItem('b', '2');
    store.clear();
    expect(store.length).toBe(0);
  });
});

describe('installStorageScope', () => {
  function fakeWindow(): { target: Window; local: ReturnType<typeof fakeStorage>; session: ReturnType<typeof fakeStorage> } {
    const local = fakeStorage();
    const session = fakeStorage();
    return { target: { localStorage: local, sessionStorage: session } as unknown as Window, local, session };
  }

  it('replaces both storages with views of the device', () => {
    const { target, local, session } = fakeWindow();
    expect(installStorageScope(target, 'dev_a')).toBe(true);
    target.localStorage.setItem(DRAFTS, 'draft');
    target.sessionStorage.setItem('nano-remote.retry', '1');
    expect([...local.raw.keys()]).toEqual([`nano-remote:dev_a:${DRAFTS}`]);
    expect([...session.raw.keys()]).toEqual(['nano-remote:dev_a:nano-remote.retry']);
    expect(local.getItem(DRAFTS)).toBeNull();
  });

  it('shows device B an empty store after device A saved, on the same underlying storage', () => {
    const { local, session } = fakeWindow();
    const a = { localStorage: local, sessionStorage: session } as unknown as Window;
    const b = { localStorage: local, sessionStorage: session } as unknown as Window;
    installStorageScope(a, 'dev_a');
    a.localStorage.setItem(DRAFTS, 'for A');
    installStorageScope(b, 'dev_b');
    expect(b.localStorage.getItem(DRAFTS)).toBeNull();
    const again = { localStorage: local, sessionStorage: session } as unknown as Window;
    installStorageScope(again, 'dev_a');
    expect(again.localStorage.getItem(DRAFTS)).toBe('for A');
  });

  it('uses memory when there is no device or the browser denies its storage', () => {
    const { target, local } = fakeWindow();
    expect(installStorageScope(target, undefined)).toBe(true);
    target.localStorage.setItem(DRAFTS, 'draft');
    expect(local.raw.size).toBe(0);

    const blocked = {} as Window;
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(blocked, name, {
        configurable: true,
        get() {
          throw new Error('SecurityError');
        },
      });
    }
    expect(installStorageScope(blocked, 'dev_a')).toBe(true);
    blocked.localStorage.setItem('k', 'v');
    expect(blocked.localStorage.getItem('k')).toBe('v');
  });

  it('reports a window that refuses the replacement', () => {
    const target = {} as Window;
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(target, name, { value: fakeStorage(), configurable: false });
    expect(installStorageScope(target, 'dev_a')).toBe(false);
  });
});
