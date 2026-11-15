import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARKS_STORAGE_KEY, Marks, parseMarks, validMark, type Mark } from './marks.svelte';

const blue: Mark = { kind: 'shape', shape: 'square', color: 'blue' };
const rocket: Mark = { kind: 'emoji', value: '🚀' };

function memoryStorage(initial: Record<string, string> = {}): { store: Map<string, string>; failing: boolean } {
  const store = new Map(Object.entries(initial));
  const state = { store, failing: false };
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (state.failing) throw new Error('quota');
      store.set(key, value);
    },
  });
  return state;
}

afterEach(() => vi.unstubAllGlobals());

describe('validMark', () => {
  it('accepts a known shape in a known color and a single emoji', () => {
    expect(validMark(blue)).toEqual(blue);
    expect(validMark(rocket)).toEqual(rocket);
    expect(validMark({ kind: 'emoji', value: '❤️' })).toEqual({ kind: 'emoji', value: '❤️' });
    expect(validMark({ kind: 'emoji', value: '👨‍👩‍👧' })).toBeDefined();
  });

  it('drops an unknown shape or color, extra graphemes, blanks and long text', () => {
    expect(validMark({ kind: 'shape', shape: 'blob', color: 'blue' })).toBeUndefined();
    expect(validMark({ kind: 'shape', shape: 'circle', color: 'mauve' })).toBeUndefined();
    expect(validMark({ kind: 'shape', shape: 'circle' })).toBeUndefined();
    expect(validMark({ kind: 'emoji', value: '🚀🔥' })).toBeUndefined();
    expect(validMark({ kind: 'emoji', value: 'ab' })).toBeUndefined();
    expect(validMark({ kind: 'emoji', value: '' })).toBeUndefined();
    expect(validMark({ kind: 'emoji', value: ' ' })).toBeUndefined();
    expect(validMark({ kind: 'emoji', value: '🚀 ' })).toBeUndefined();
    expect(validMark({ kind: 'emoji', value: 'x'.repeat(17) })).toBeUndefined();
    expect(validMark({ kind: 'emoji', value: 7 })).toBeUndefined();
    expect(validMark({ kind: 'star' })).toBeUndefined();
    expect(validMark(null)).toBeUndefined();
    expect(validMark('circle')).toBeUndefined();
  });
});

describe('parseMarks', () => {
  it('reads valid entries and drops bad ones', () => {
    const raw = JSON.stringify({
      projects: { p1: rocket, p2: { kind: 'shape', shape: 'x', color: 'red' }, '': blue },
      sessions: { s1: blue, s2: 5 },
    });
    expect(parseMarks(raw)).toEqual({ projects: { p1: rocket }, sessions: { s1: blue } });
  });

  it('survives missing, broken and wrongly shaped storage', () => {
    const empty = { projects: {}, sessions: {} };
    expect(parseMarks(null)).toEqual(empty);
    expect(parseMarks('')).toEqual(empty);
    expect(parseMarks('{oops')).toEqual(empty);
    expect(parseMarks('[1]')).toEqual(empty);
    expect(parseMarks('"text"')).toEqual(empty);
    expect(parseMarks(JSON.stringify({ projects: [rocket], sessions: 'x' }))).toEqual(empty);
  });

  it('ignores a prototype key', () => {
    const parsed = parseMarks('{"sessions":{"__proto__":{"kind":"emoji","value":"x"},"s":{"kind":"emoji","value":"x"}}}');
    expect(Object.keys(parsed.sessions)).toEqual(['s']);
    expect(({} as Record<string, unknown>).kind).toBeUndefined();
  });
});

describe('Marks', () => {
  it('sets, replaces and clears a mark per kind', () => {
    memoryStorage();
    const marks = new Marks();
    marks.setSession('s1', blue);
    marks.setProject('p1', rocket);
    expect(marks.session('s1')).toEqual(blue);
    expect(marks.project('p1')).toEqual(rocket);
    expect(marks.session('p1')).toBeUndefined();
    marks.setSession('s1', rocket);
    expect(marks.session('s1')).toEqual(rocket);
    marks.setSession('s1', undefined);
    expect(marks.session('s1')).toBeUndefined();
    expect(marks.project('p1')).toEqual(rocket);
  });

  it('forgets a chat and a project', () => {
    memoryStorage();
    const marks = new Marks();
    marks.setSession('s1', blue);
    marks.setSession('s2', blue);
    marks.setProject('p1', rocket);
    marks.forgetSession('s1');
    marks.forgetProject('p1');
    expect(marks.session('s1')).toBeUndefined();
    expect(marks.session('s2')).toEqual(blue);
    expect(marks.project('p1')).toBeUndefined();
  });

  it('refuses a malformed mark and a prototype id', () => {
    memoryStorage();
    const marks = new Marks();
    marks.setSession('s1', { kind: 'emoji', value: 'too long' } as Mark);
    marks.setSession('__proto__', blue);
    expect(marks.session('s1')).toBeUndefined();
    expect(marks.session('__proto__')).toBeUndefined();
    expect(marks.session('constructor')).toBeUndefined();
  });

  it('persists and restores across a reload', () => {
    const state = memoryStorage();
    const first = new Marks();
    first.setSession('s1', blue);
    first.setProject('p1', rocket);
    expect(JSON.parse(state.store.get(MARKS_STORAGE_KEY) ?? '{}')).toEqual({ projects: { p1: rocket }, sessions: { s1: blue } });
    const second = new Marks();
    expect(second.session('s1')).toEqual(blue);
    expect(second.project('p1')).toEqual(rocket);
  });

  it('starts empty from garbage storage and keeps working when writes fail', () => {
    const state = memoryStorage({ [MARKS_STORAGE_KEY]: '{not json' });
    const marks = new Marks();
    expect(marks.session('s1')).toBeUndefined();
    state.failing = true;
    marks.setSession('s1', blue);
    expect(marks.session('s1')).toEqual(blue);
  });

  it('works without any storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    const marks = new Marks();
    marks.setProject('p1', rocket);
    expect(marks.project('p1')).toEqual(rocket);
  });

  it('writes back an entry it does not understand, untouched', () => {
    const future = { kind: 'sticker', id: 'x9', extra: [1, 2] };
    const state = memoryStorage({ [MARKS_STORAGE_KEY]: JSON.stringify({ projects: { p9: future }, sessions: { s9: future, s1: blue } }) });
    const marks = new Marks();
    expect(marks.session('s9')).toBeUndefined();
    marks.setSession('s2', rocket);
    marks.forgetSession('s1');
    expect(JSON.parse(state.store.get(MARKS_STORAGE_KEY) ?? '{}')).toEqual({ projects: { p9: future }, sessions: { s9: future, s2: rocket } });
  });

  it('lets a new mark replace an unknown entry of the same id', () => {
    const state = memoryStorage({ [MARKS_STORAGE_KEY]: JSON.stringify({ sessions: { s9: { kind: 'sticker' } } }) });
    const marks = new Marks();
    marks.setSession('s9', blue);
    expect(JSON.parse(state.store.get(MARKS_STORAGE_KEY) ?? '{}').sessions).toEqual({ s9: blue });
  });

  it('refuses at the limit, then drops marks of gone chats once the catalog is known', () => {
    const sessions: Record<string, Mark | object> = {};
    for (let i = 0; i < 5000; i += 1) sessions[`s${i}`] = i % 2 ? blue : { kind: 'sticker' };
    memoryStorage({ [MARKS_STORAGE_KEY]: JSON.stringify({ sessions }) });
    const marks = new Marks();
    marks.setSession('fresh', rocket);
    expect(marks.session('fresh')).toBeUndefined();
    marks.liveIds = () => undefined;
    marks.setSession('fresh', rocket);
    expect(marks.session('fresh')).toBeUndefined();
    marks.liveIds = () => ({ projects: new Set(), sessions: new Set(['s1', 's2']) });
    marks.setSession('fresh', rocket);
    expect(marks.session('fresh')).toEqual(rocket);
    expect(marks.session('s1')).toEqual(blue);
    expect(marks.session('s3')).toBeUndefined();
  });
});
