import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Macro, MacroDraft } from './macro';

const saved: Macro = { id: 'saved', name: 'review', description: '', prompt: 'Review.', skills: [] };
const draft: MacroDraft = { name: 'fix', description: '', prompt: 'Fix.', skills: ['test-runner'] };
let storage: Map<string, string>;
let setItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  storage = new Map();
  setItem = vi.fn((key: string, value: string) => storage.set(key, value));
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem });
});
afterEach(() => vi.unstubAllGlobals());

describe('local macro preference', () => {
  it('loads stored macros on first use', async () => {
    storage.set('piui.macros.v1', JSON.stringify([saved]));
    const { macros } = await import('./macros.svelte');
    expect(macros.list).toEqual([saved]);
    expect(macros.sessionOnly).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });
  it('saves a new macro and reloads it', async () => {
    const { macros } = await import('./macros.svelte');
    const result = macros.save(draft);
    expect(result).toHaveProperty('macro');
    expect(macros.list).toEqual([{ ...draft, id: expect.any(String) }]);
    expect(JSON.parse(storage.get('piui.macros.v1') ?? 'null')).toEqual(macros.list);
    vi.resetModules();
    expect((await import('./macros.svelte')).macros.list).toEqual(macros.list);
  });
  it('edits in place, keeping the identity', async () => {
    storage.set('piui.macros.v1', JSON.stringify([saved]));
    const { macros } = await import('./macros.svelte');
    expect(macros.save({ ...draft, id: saved.id })).toEqual({ macro: { ...draft, id: saved.id } });
    expect(macros.list).toEqual([{ ...draft, id: saved.id }]);
  });
  it('an invalid draft changes neither list nor storage', async () => {
    storage.set('piui.macros.v1', JSON.stringify([saved]));
    const { macros } = await import('./macros.svelte');
    const before = macros.list;
    expect(macros.save({ ...draft, name: 'review' })).toEqual({ errors: { name: 'Another macro already has this name.' } });
    expect(macros.list).toBe(before);
    expect(setItem).not.toHaveBeenCalled();
  });
  it('remove and undo restore the original position exactly once', async () => {
    const entries = ['a', 'b', 'c'].map((name) => ({ ...saved, id: name, name }));
    storage.set('piui.macros.v1', JSON.stringify(entries));
    const { macros } = await import('./macros.svelte');
    const undo = macros.remove('b');
    expect(macros.list.map((macro) => macro.name)).toEqual(['a', 'c']);
    expect(undo).toBeTypeOf('function');
    undo?.();
    undo?.();
    expect(macros.list).toEqual(entries);
    expect(macros.remove('absent')).toBeUndefined();
  });
  it('undo refuses when the removed name was taken', async () => {
    storage.set('piui.macros.v1', JSON.stringify([saved]));
    const { macros } = await import('./macros.svelte');
    const undo = macros.remove(saved.id);
    macros.save({ ...draft, name: 'review' });
    const before = macros.list;
    undo?.();
    expect(macros.list).toBe(before);
    expect(macros.list).toHaveLength(1);
    expect(macros.list[0]?.id).not.toBe(saved.id);
  });
  it('keeps edits for this session if storage refuses a write, then recovers', async () => {
    const { macros } = await import('./macros.svelte');
    setItem.mockImplementationOnce(() => { throw new Error('Storage refused'); });
    macros.save(draft);
    expect(macros.list).toHaveLength(1);
    expect(macros.sessionOnly).toBe(true);
    macros.save({ ...draft, name: 'next' });
    expect(macros.sessionOnly).toBe(false);
  });
  it('takes each edit request once', async () => {
    const { macros } = await import('./macros.svelte');
    expect(macros.takeEditRequest()).toBeUndefined();
    macros.requestEdit(saved.id);
    expect(macros.editRequest).toBe(saved.id);
    expect(macros.takeEditRequest()).toBe(saved.id);
    expect(macros.takeEditRequest()).toBeUndefined();
    macros.requestEdit('new');
    expect(macros.takeEditRequest()).toBe('new');
  });
});
